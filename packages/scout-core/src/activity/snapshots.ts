// Immutable per-job snapshots: everything a background job may read, fixed when the job is
// created. `take` copies the activity entries and candidates it is given, records every
// approved default version at that moment (pinning each in the capability store so
// collection keeps it), stamps the approval, permission and profile revisions, and issues
// the job's token, scoped to that snapshot and expiring at the job's deadline. The snapshot
// is deep-frozen; nothing changes it afterwards, so a job never sees data move underneath it.
// A replacement job takes a new snapshot (new id, new token); the old one stays readable
// until it is released.
//
// `take` refuses (throws) while Scout is paused (the injected `paused`) and for good after
// `releaseAll("shutdown")`. Those are its only checks: whether the visit is still current and
// the job may see browser context is the caller's to decide before it calls `take`.
//
// `release` revokes the job's token (its connected adapter is refused on the next read) and
// drops the pins. `releaseAll` does that for every snapshot (pause, shutdown),
// `releasePinning` for every snapshot that pinned a revoked resource (the agent socket's
// `resourceRevoked`), and `sweepExpired` for every snapshot past its deadline (main runs it
// before each collection). Diagnostics carry counts and reason codes only.

import { randomBytes } from "node:crypto";
import type { ActivityEntry, Candidate, JobCandidate } from "@scout/contracts";
import type { AgentAuth } from "../agentApi/auth.js";
import type { CapabilityStore } from "../capabilities/store.js";
import type { Clock } from "../clock.js";
import type { Diagnostics } from "../diagnostics.js";

/** A candidate as the job sees it, plus the link `site_links` serves for it. */
export type SnapshotCandidate = JobCandidate & { readonly href: string };

export interface SnapshotVersion {
  readonly resourceId: string;
  readonly version: string;
}

export interface JobSnapshot {
  /** Random, 16 bytes base64url; the job request's `browserSnapshot.id`. */
  readonly id: string;
  /** Monotonic per core; the job request's `browserSnapshot.revision`. */
  readonly revision: number;
  readonly jobId: string;
  readonly origin: string;
  readonly visitEpoch: number;
  readonly activity: readonly ActivityEntry[];
  readonly candidates: readonly SnapshotCandidate[];
  readonly catalogHash: string;
  /** Every approved default version when the snapshot was taken, each pinned until release. */
  readonly approved: readonly SnapshotVersion[];
  readonly approvalRevision: number;
  readonly permissionsRevision: number;
  readonly profileFingerprint: string;
  /** Absolute time on the registry clock; the token expires then. */
  readonly deadline: number;
}

export interface TakeSnapshotInput {
  jobId: string;
  origin: string;
  visitEpoch: number;
  /** The activity store's current entries (or none, when the job may not see them). */
  activity: readonly ActivityEntry[];
  candidates: readonly SnapshotCandidate[];
  catalogHash: string;
  permissionsRevision: number;
  profileFingerprint: string;
  deadline: number;
}

export type SnapshotReleaseReason = "released" | "cancelled" | "paused" | "shutdown" | "expired" | "revoked";

export interface SnapshotRegistry {
  /**
   * Take a snapshot and issue its job token. Throws when `jobId` already holds a snapshot,
   * while paused, or after `releaseAll("shutdown")`. The caller owns the visit and
   * permission checks.
   */
  take(input: TakeSnapshotInput): { snapshot: JobSnapshot; token: string };
  get(id: string): JobSnapshot | undefined;
  /** The live snapshot of a job, for the agent handlers. */
  getForJob(jobId: string): JobSnapshot | undefined;
  /** Revoke the job's token and release the snapshot's pins. Idempotent. */
  release(id: string, reason?: SnapshotReleaseReason): void;
  /** Release every snapshot and revoke every job token (pause, shutdown). */
  releaseAll(reason: SnapshotReleaseReason): void;
  /** Release every snapshot that pinned `resourceId` (it was revoked). Synchronous and idempotent. */
  releasePinning(resourceId: string, reason: SnapshotReleaseReason): void;
  /** Release every snapshot whose deadline has passed. */
  sweepExpired(): void;
  readonly size: number;
}

export interface SnapshotRegistryOptions {
  store: Pick<CapabilityStore, "listApproved" | "pinVersion" | "releasePins" | "approvalRevision">;
  auth: Pick<AgentAuth, "issueJobToken" | "revokeJobToken" | "revokeAllJobTokens">;
  clock: Clock;
  /** Scout is paused: no snapshot may be taken. Defaults to never paused. */
  paused?: () => boolean;
  diagnostics?: Diagnostics;
}

const pinId = (snapshotId: string): string => `snapshot:${snapshotId}`;

/** The job's view of catalog candidates: the model-facing fields plus the link to serve (verified human page first). */
export function snapshotCandidates(candidates: readonly Candidate[]): SnapshotCandidate[] {
  return candidates.map((c) => ({
    id: c.id,
    title: c.title,
    ...(c.description !== undefined ? { description: c.description } : {}),
    labelQuality: c.labelQuality,
    href: c.humanHref ?? c.sourceUrl,
  }));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export function createSnapshotRegistry(options: SnapshotRegistryOptions): SnapshotRegistry {
  const { store, auth, clock, diagnostics } = options;
  const snapshots = new Map<string, JobSnapshot>();
  const byJob = new Map<string, string>();
  let revision = 0;
  /** Set by `releaseAll("shutdown")`: no snapshot is taken from then on. */
  let shutDown = false;

  const drop = (snapshot: JobSnapshot): void => {
    snapshots.delete(snapshot.id);
    byJob.delete(snapshot.jobId);
    auth.revokeJobToken(snapshot.jobId);
    store.releasePins(pinId(snapshot.id));
  };

  return {
    take(input) {
      if (shutDown) throw new Error("scout: snapshot registry is shut down");
      if (options.paused?.()) throw new Error("scout: paused");
      if (byJob.has(input.jobId)) throw new Error("scout: job already holds a snapshot");
      const id = randomBytes(16).toString("base64url");
      const approved: SnapshotVersion[] = [];
      for (const listing of store.listApproved()) {
        const pinned = store.pinVersion(pinId(id), listing.resource.id, listing.version.hash);
        if (pinned.ok) approved.push({ resourceId: listing.resource.id, version: listing.version.hash });
      }
      const snapshot: JobSnapshot = deepFreeze({
        id,
        revision: ++revision,
        jobId: input.jobId,
        origin: input.origin,
        visitEpoch: input.visitEpoch,
        activity: input.activity.map((e) => ({
          origin: e.origin,
          url: e.url,
          observedAt: e.observedAt,
          title: e.title,
          ...(e.text !== undefined ? { text: e.text } : {}),
          textTruncated: e.textTruncated,
        })),
        candidates: input.candidates.map((c) => ({
          id: c.id,
          title: c.title,
          ...(c.description !== undefined ? { description: c.description } : {}),
          labelQuality: c.labelQuality,
          href: c.href,
        })),
        catalogHash: input.catalogHash,
        approved,
        approvalRevision: store.approvalRevision,
        permissionsRevision: input.permissionsRevision,
        profileFingerprint: input.profileFingerprint,
        deadline: input.deadline,
      });
      let token: string;
      try {
        token = auth.issueJobToken({
          jobId: input.jobId,
          resourceIds: approved.map((a) => a.resourceId),
          expiresAt: input.deadline,
          origin: input.origin,
          visitEpoch: input.visitEpoch,
        });
      } catch (e) {
        store.releasePins(pinId(id));
        throw e;
      }
      snapshots.set(id, snapshot);
      byJob.set(input.jobId, id);
      diagnostics?.event("snapshot_taken", {
        activity: snapshot.activity.length,
        candidates: snapshot.candidates.length,
        approved: approved.length,
      });
      return { snapshot, token };
    },
    get: (id) => snapshots.get(id),
    getForJob(jobId) {
      const id = byJob.get(jobId);
      return id === undefined ? undefined : snapshots.get(id);
    },
    release(id, reason = "released") {
      const snapshot = snapshots.get(id);
      if (!snapshot) return;
      drop(snapshot);
      diagnostics?.event("job_token_revoked", { reason });
    },
    releaseAll(reason) {
      if (reason === "shutdown") shutDown = true;
      const count = snapshots.size;
      for (const snapshot of [...snapshots.values()]) drop(snapshot);
      // Tokens issued outside the registry go too.
      auth.revokeAllJobTokens();
      if (count > 0) diagnostics?.event("job_token_revoked", { reason, count });
    },
    releasePinning(resourceId, reason) {
      for (const snapshot of [...snapshots.values()]) {
        if (!snapshot.approved.some((a) => a.resourceId === resourceId)) continue;
        drop(snapshot);
        diagnostics?.event("job_token_revoked", { reason });
      }
    },
    sweepExpired() {
      const now = clock.now();
      for (const snapshot of [...snapshots.values()]) {
        if (snapshot.deadline > now) continue;
        drop(snapshot);
        diagnostics?.event("job_token_revoked", { reason: "expired" });
      }
    },
    get size() {
      return snapshots.size;
    },
  };
}
