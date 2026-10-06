// The capability store's state and every decision that changes it, as pure functions.
// No file system, no clock reads: callers pass `now` and get a new state back. store.ts
// persists the result; nothing here mutates its input.
//
// Content hash (a version's name on the wire, `ResourceVersion.hash`): lowercase hex SHA-256 of
//   "scout-content-v1\0" + <len>:<descriptor JSON> + <len>:<raw bytes>
// where <len> is the decimal byte length followed by ":", and the descriptor JSON is built in
// this fixed key order with absent keys omitted:
//   {"kind", "sourceUrl", "contentType"?, "skill"?: {"name", "description"?, "digest"}}
// The descriptor is what the preview shows beside the text (a skill's index name and
// description end up in its exported wrapper), so changing any of it is a new version.
// `contentType` enters it normalized (normalizeContentType): parameters dropped, whitespace
// around the "/" removed, type/subtype lowercased, so a charset or case flip by the publisher is
// not a new version; an empty value (or parameters with no type) counts as absent. The stored
// `meta.contentType` keeps the value as served.
//
// Approval is per resource revision: every change to a resource (a new version, any decision)
// bumps its `revision`, and approve/decline must name the revision the user saw. A click on a
// preview that has since changed is a StaleApprovalError, never an approval of other content.

import { createHash } from "node:crypto";
import {
  ContentHashSchema,
  HttpsOriginSchema,
  isHttpsOrigin,
  RESOURCE_MAX_VERSIONS,
  ResourceIdSchema,
  ResourceSchema,
  SHA256_HEX_PATTERN,
  type Resource,
  type ResourceKind,
  type ResourceVersion,
} from "@scout/contracts";
import { z } from "zod";
import { pruneResource, type PinnedVersions } from "./garbageCollection.js";

export const STORE_SCHEMA_VERSION = 1;
/** At most this many resources, counting blocked ones (they hold the user's revocation). */
export const MAX_RESOURCES = 256;
/** At most this many bytes of distinct blobs. */
export const MAX_BLOB_BYTES = 64 * 1024 * 1024;

export const CONTENT_HASH_TAG = "scout-content-v1\0";

/** What a version's preview showed besides its text. */
export interface VersionMeta {
  contentType?: string;
  skill?: { name: string; description?: string; digest: string };
  /** Last time discovery saw these exact bytes and descriptor; drives the seven-day expiry. */
  lastSeenAt: number;
}

export interface StoredResource {
  /** The contract record agent.sock serves from. */
  resource: Resource;
  /** Bumped on every change to this resource; approval commands must name it. */
  revision: number;
  /** Keyed by version hash; exactly one entry per version. */
  meta: Record<string, VersionMeta>;
}

/** Present only while auto-acquire is on for the origin. */
export interface OriginPolicy {
  origin: string;
  autoAcquire: true;
  riskAcknowledgedAt: number;
}

export interface StoreState {
  schemaVersion: typeof STORE_SCHEMA_VERSION;
  /** Bumped by every approve, decline, revoke, auto-acceptance, policy change, and collection of a readable version. Cache keys use it. */
  approvalRevision: number;
  resources: StoredResource[];
  policies: OriginPolicy[];
}

export const emptyState = (): StoreState => ({ schemaVersion: STORE_SCHEMA_VERSION, approvalRevision: 0, resources: [], policies: [] });

const VersionMetaSchema = z.strictObject({
  contentType: z.string().max(256).optional(),
  skill: z
    .strictObject({ name: z.string().max(256), description: z.string().max(4096).optional(), digest: z.string().regex(SHA256_HEX_PATTERN) })
    .optional(),
  lastSeenAt: z.number(),
});

export const StoreStateSchema = z.strictObject({
  schemaVersion: z.literal(STORE_SCHEMA_VERSION),
  approvalRevision: z.int().min(0),
  resources: z
    .array(
      z.strictObject({
        resource: ResourceSchema,
        revision: z.int().min(0),
        meta: z.record(ContentHashSchema, VersionMetaSchema),
      }),
    )
    .max(MAX_RESOURCES),
  policies: z.array(z.strictObject({ origin: HttpsOriginSchema, autoAcquire: z.literal(true), riskAcknowledgedAt: z.number() })),
});

/** Cross-record checks the schema cannot express. Returns a short code, or null. */
export function stateInvariantError(state: StoreState): string | null {
  const ids = new Set<string>();
  for (const r of state.resources) {
    if (ids.has(r.resource.id)) return "duplicate_resource";
    ids.add(r.resource.id);
    const hashes = r.resource.versions.map((v) => v.hash);
    const keys = Object.keys(r.meta);
    if (keys.length !== hashes.length || !hashes.every((h) => Object.hasOwn(r.meta, h))) return "meta_mismatch";
    if (hashes.some((h) => (r.resource.kind === "skill") !== (r.meta[h]!.skill !== undefined))) return "skill_meta";
  }
  if (new Set(state.policies.map((p) => p.origin)).size !== state.policies.length) return "duplicate_policy";
  return null;
}

/**
 * A media type as the content hash sees it: `Text / Markdown; charset=UTF-8` -> `text/markdown`.
 * Empty, whitespace-only, or parameters with no type (`;charset=x`) -> undefined (absent).
 */
export function normalizeContentType(contentType: string): string | undefined {
  const type = contentType.split(";")[0]!.trim().replace(/\s*\/\s*/g, "/").toLowerCase();
  return type === "" ? undefined : type;
}

/** The content hash defined at the top of this file. */
export function contentHash(kind: ResourceKind, sourceUrl: string, meta: Omit<VersionMeta, "lastSeenAt">, bytes: Uint8Array): string {
  const descriptor: Record<string, unknown> = { kind, sourceUrl };
  const contentType = meta.contentType === undefined ? undefined : normalizeContentType(meta.contentType);
  if (contentType !== undefined) descriptor.contentType = contentType;
  if (meta.skill !== undefined) {
    const skill: Record<string, string> = { name: meta.skill.name };
    if (meta.skill.description !== undefined) skill.description = meta.skill.description;
    skill.digest = meta.skill.digest;
    descriptor.skill = skill;
  }
  const d = Buffer.from(JSON.stringify(descriptor), "utf8");
  return createHash("sha256").update(CONTENT_HASH_TAG).update(`${d.length}:`).update(d).update(`${bytes.byteLength}:`).update(bytes).digest("hex");
}

export type DecisionErrorCode = "not_found" | "invalid_state" | "risk_not_acknowledged" | "invalid_origin";

export class DecisionError extends Error {
  constructor(readonly code: DecisionErrorCode) {
    super(`capability decision: ${code}`);
    this.name = "DecisionError";
  }
}

/** The version or the resource revision the command names is no longer what the user saw. */
export class StaleApprovalError extends Error {
  constructor(readonly code: "revision" | "version") {
    super(`capability decision: stale ${code}`);
    this.name = "StaleApprovalError";
  }
}

/** Approve or decline exactly the version the user previewed, at the resource revision shown. */
export interface DecisionCommand {
  resourceId: string;
  /** The previewed version's content hash (versions are named by it). */
  version: string;
  expectedRevision: number;
}

/** One discovered resource, already hashed and identified by the store. */
export interface IngestCandidate {
  resourceId: string;
  kind: ResourceKind;
  siteOrigin: string;
  publisherOrigin: string;
  sourceUrl: string;
  hash: string;
  blobRef: string;
  byteLength: number;
  fetchedAt: number;
  meta: Omit<VersionMeta, "lastSeenAt">;
}

export type IngestOutcome =
  /** A new version waiting for the user; the last approved one stays the default. */
  | "new_pending"
  /** Auto-acquire accepted it; it is the new default. */
  | "auto_approved"
  /** Seen before and already decided (approved, superseded) or still pending: no new prompt. */
  | "unchanged"
  /** Seen before and declined: never prompts again for these exact bytes and descriptor. */
  | "declined"
  /** The resource is revoked: recorded, never offered, exported, or auto-approved. */
  | "blocked"
  /** Over a storage cap: not recorded. Nothing approved was evicted. */
  | "storage_limit";

export interface IngestItemResult {
  resourceId: string;
  version: string;
  outcome: IngestOutcome;
  limit?: "resources" | "blob_bytes" | "versions";
}

export interface IngestContext {
  origin: string;
  /** Chrome currently grants this origin. Auto-acquire needs it at ingestion time. */
  chromePermitted: boolean;
  now: number;
  pinned: PinnedVersions;
  maxResources?: number;
  maxBlobBytes?: number;
}

const clone = (s: StoreState): StoreState => structuredClone(s);

export function findResource(state: StoreState, id: string): StoredResource | undefined {
  return state.resources.find((r) => r.resource.id === id);
}

/** Bytes of distinct blobs every version of every resource refers to. */
export function blobBytes(state: StoreState): number {
  const seen = new Map<string, number>();
  for (const r of state.resources) for (const v of r.resource.versions) seen.set(v.blobRef, v.byteLength);
  let total = 0;
  for (const n of seen.values()) total += n;
  return total;
}

export function referencedBlobs(state: StoreState): Set<string> {
  const out = new Set<string>();
  for (const r of state.resources) for (const v of r.resource.versions) out.add(v.blobRef);
  return out;
}

export function autoAcquireAllowed(state: StoreState, origin: string, chromePermitted: boolean): boolean {
  const p = state.policies.find((x) => x.origin === origin);
  return chromePermitted === true && p !== undefined && p.autoAcquire === true && Number.isFinite(p.riskAcknowledgedAt);
}

function approveIn(r: StoredResource, v: ResourceVersion, actor: "user" | "auto_acquire", now: number): void {
  const prev = r.resource.defaultVersion;
  if (prev !== undefined && prev !== v.hash) {
    const p = r.resource.versions.find((x) => x.hash === prev);
    if (p) p.state = "superseded";
  }
  v.state = "approved";
  v.decision = { actor, at: now };
  r.resource.defaultVersion = v.hash;
  r.resource.blocked = false;
}

/** Record what discovery found. Pure; see IngestOutcome for what each item can become. */
export function ingestCandidates(input: StoreState, candidates: readonly IngestCandidate[], ctx: IngestContext): { state: StoreState; results: IngestItemResult[] } {
  if (!isHttpsOrigin(ctx.origin)) throw new DecisionError("invalid_origin");
  const maxResources = ctx.maxResources ?? MAX_RESOURCES;
  const maxBlobBytes = ctx.maxBlobBytes ?? MAX_BLOB_BYTES;
  let state = clone(input);
  const auto = autoAcquireAllowed(state, ctx.origin, ctx.chromePermitted);
  const results: IngestItemResult[] = [];
  let autoChanged = false;
  let readableDropped = false;

  for (const c of candidates) {
    const before = state;
    state = clone(state);
    let r = findResource(state, c.resourceId);
    const created = r === undefined;
    if (!r) {
      r = {
        resource: { id: c.resourceId, kind: c.kind, siteOrigin: c.siteOrigin, publisherOrigin: c.publisherOrigin, sourceUrl: c.sourceUrl, versions: [], blocked: false },
        revision: 0,
        meta: {},
      };
      state.resources.push(r);
    }
    const existing = r.resource.versions.find((v) => v.hash === c.hash);
    if (existing) {
      r.meta[c.hash]!.lastSeenAt = Math.max(r.meta[c.hash]!.lastSeenAt, ctx.now);
      let outcome: IngestOutcome = existing.state === "declined" ? "declined" : r.resource.blocked || existing.state === "revoked" ? "blocked" : "unchanged";
      // Auto-acquire turned on after this version was offered: accept it if it is still the newest.
      if (outcome === "unchanged" && existing.state === "pending" && auto && r.resource.versions.at(-1) === existing) {
        approveIn(r, existing, "auto_acquire", ctx.now);
        r.revision++;
        autoChanged = true;
        outcome = "auto_approved";
      }
      results.push({ resourceId: c.resourceId, version: c.hash, outcome });
      continue;
    }

    const version: ResourceVersion = { hash: c.hash, blobRef: c.blobRef, byteLength: c.byteLength, fetchedAt: c.fetchedAt, state: "pending" };
    r.resource.versions.push(version);
    r.meta[c.hash] = { ...c.meta, lastSeenAt: ctx.now };
    r.revision++;
    let outcome: IngestOutcome;
    if (r.resource.blocked) outcome = "blocked";
    else if (auto) {
      approveIn(r, version, "auto_acquire", ctx.now);
      outcome = "auto_approved";
    } else outcome = "new_pending";

    const pruned = pruneResource(r, ctx.pinned.get(r.resource.id) ?? new Set(), ctx.now);
    let limit: IngestItemResult["limit"];
    if (created && state.resources.length > maxResources) limit = "resources";
    else if (r.resource.versions.length > RESOURCE_MAX_VERSIONS || !r.resource.versions.includes(version)) limit = "versions";
    else if (blobBytes(state) > maxBlobBytes) limit = "blob_bytes";
    if (limit) {
      state = before;
      results.push({ resourceId: c.resourceId, version: c.hash, outcome: "storage_limit", limit });
      continue;
    }
    if (outcome === "auto_approved") autoChanged = true;
    if (pruned.readableDropped) readableDropped = true;
    results.push({ resourceId: c.resourceId, version: c.hash, outcome });
  }
  // Trimming a superseded version changes what agents may read, like an approval does.
  if (autoChanged || readableDropped) state.approvalRevision++;
  return { state, results };
}

function commandTarget(state: StoreState, cmd: DecisionCommand): { r: StoredResource; v: ResourceVersion } {
  if (!ResourceIdSchema.safeParse(cmd.resourceId).success) throw new DecisionError("not_found");
  const r = findResource(state, cmd.resourceId);
  if (!r) throw new DecisionError("not_found");
  const v = r.resource.versions.find((x) => x.hash === cmd.version);
  if (!v) throw new StaleApprovalError("version");
  return { r, v };
}

/**
 * Approve exactly `cmd.version`. Clears a revocation block: this is the explicit re-approval.
 * Approving the version that is already the unblocked default is a no-op (a retried click).
 */
export function applyApprove(input: StoreState, cmd: DecisionCommand, now: number): { state: StoreState; changed: boolean } {
  const cur = commandTarget(input, cmd);
  if (!cur.r.resource.blocked && cur.r.resource.defaultVersion === cmd.version) return { state: input, changed: false };
  if (cur.r.revision !== cmd.expectedRevision) throw new StaleApprovalError("revision");
  const state = clone(input);
  const { r, v } = commandTarget(state, cmd);
  approveIn(r, v, "user", now);
  r.revision++;
  state.approvalRevision++;
  return { state, changed: true };
}

/** Decline a pending version; those exact bytes and descriptor never prompt again. */
export function applyDecline(input: StoreState, cmd: DecisionCommand, now: number): { state: StoreState; changed: boolean } {
  const cur = commandTarget(input, cmd);
  if (cur.v.state === "declined") return { state: input, changed: false };
  if (cur.r.revision !== cmd.expectedRevision) throw new StaleApprovalError("revision");
  if (cur.v.state !== "pending") throw new DecisionError("invalid_state");
  const state = clone(input);
  const { r, v } = commandTarget(state, cmd);
  v.state = "declined";
  v.decision = { actor: "user", at: now };
  r.revision++;
  state.approvalRevision++;
  return { state, changed: true };
}

/**
 * Revoke a resource: every version except declined ones becomes `revoked`, the default is
 * cleared and the resource is blocked until the user explicitly approves a version again.
 * Returns the versions that were readable before (approved or superseded).
 */
export function applyRevoke(
  input: StoreState,
  resourceId: string,
  now: number,
  expectedRevision?: number,
): { state: StoreState; changed: boolean; revokedVersions: string[] } {
  const found = findResource(input, resourceId);
  if (!found) throw new DecisionError("not_found");
  // An already-blocked resource is revoked again whatever revision the caller saw.
  if (expectedRevision !== undefined && !found.resource.blocked && found.revision !== expectedRevision) throw new StaleApprovalError("revision");
  const state = clone(input);
  const r = findResource(state, resourceId)!;
  const revokedVersions: string[] = [];
  let changed = !r.resource.blocked;
  for (const v of r.resource.versions) {
    if (v.state === "declined" || v.state === "revoked") continue;
    if (v.state === "approved" || v.state === "superseded") revokedVersions.push(v.hash);
    v.state = "revoked";
    v.decision = { actor: "user", at: now };
    changed = true;
  }
  delete r.resource.defaultVersion;
  r.resource.blocked = true;
  if (!changed) return { state: input, changed: false, revokedVersions };
  r.revision++;
  state.approvalRevision++;
  return { state, changed: true, revokedVersions };
}

export interface PolicyCommand {
  origin: string;
  autoAcquire: boolean;
  /** Required (true) to turn auto-acquire on: the user saw and accepted the risk text. */
  acknowledgeRisk?: boolean;
  /** When given, the setting the user saw: a different current setting is a StaleApprovalError and nothing changes. */
  expectedAutoAcquire?: boolean;
}

/** Turn auto-acquire on (needs the risk acknowledgement) or off (forgets the acknowledgement). */
export function applyPolicy(input: StoreState, cmd: PolicyCommand, now: number): { state: StoreState; changed: boolean } {
  if (typeof cmd.origin !== "string" || !isHttpsOrigin(cmd.origin)) throw new DecisionError("invalid_origin");
  const has = input.policies.some((p) => p.origin === cmd.origin);
  if (cmd.expectedAutoAcquire !== undefined && cmd.expectedAutoAcquire !== has) throw new StaleApprovalError("revision");
  if (cmd.autoAcquire && cmd.acknowledgeRisk !== true) throw new DecisionError("risk_not_acknowledged");
  if (cmd.autoAcquire === has) return { state: input, changed: false };
  const state = clone(input);
  state.policies = state.policies.filter((p) => p.origin !== cmd.origin);
  if (cmd.autoAcquire) state.policies.push({ origin: cmd.origin, autoAcquire: true, riskAcknowledgedAt: now });
  state.approvalRevision++;
  return { state, changed: true };
}
