// The capability store: versioned website resources, the user's decisions, and per-origin
// auto-acquire policies, under `<scoutHome>/capabilities/`:
//   store.json          the state (decisions.ts), schema-versioned, replaced atomically
//   blobs/<sha256>.txt  immutable public website text, content-addressed by its bytes
// Directories are 0700 and files 0600.
//
// Mutations run one at a time through a queue. Each computes a new state with the pure
// functions in decisions.ts, writes any new blobs, replaces store.json (temp + fsync +
// rename + directory fsync), and only then swaps the in-memory state, so a failed write
// leaves both the file and the reads unchanged. Blobs the committed state no longer refers
// to are deleted afterwards, by exact recorded hash only.
//
// Opening never resets: a store.json that is unreadable, unsafe, or fails its schema is a
// StoreCorruptError for the caller to surface. Text comes in only from discovery results;
// the store never reads approved text from the discovery cache.
//
// Revocation, in order: (1) the blocked state is committed, then the resource's pins are
// dropped; (2) `onRevoked` runs (P2.4 invalidates job tokens, P3 cancels jobs), bounded by
// ON_REVOKED_TIMEOUT_MS; (3) `revoke()` resolves; (4) export cleanup runs (`cleanup` on the
// result). A cleanup failure is recorded there and never restores access: reads check the
// committed state. A committed approval, and an ingest that auto-approved anything, start
// the same deferred export sync; its failure never undoes the approval.
//
// One writer process at a time: opening takes `capabilities/store.lock` (storeLock.ts) and
// `close()` releases it after the queued mutations and in-flight export syncs have settled; a
// mutation that reaches its commit after `close()` is refused, and an export sync scheduled to
// start after it is skipped (resolves `ok: false`). A `readOnly` open takes no lock and refuses every
// mutation; it reads a consistent store.json because writers replace it by rename.
//
// Opening a writable store also repairs what a crash can leave: it deletes blob files no
// version refers to (a crash between a blob write and the store.json replace) and
// atomicWrite temp files in `capabilities/` and `blobs/`, by exact name pattern only, and
// it starts an export sync (`startupExportSync`) so a revocation committed by another
// process (the dev CLI) still removes its wrapper.

import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  deriveResourceId,
  isCanonicalSourceUrl,
  RESOURCE_MAX_BYTES,
  SHA256_HEX_PATTERN,
  type Resource,
  type ResourceVersion,
} from "@scout/contracts";
import { PrivateFileError, readPrivateFile } from "../agents/privateFile.js";
import type { Clock } from "../clock.js";
import type { Diagnostics } from "../diagnostics.js";
import { checkPrivateDir, fsErrorCode } from "../privateCacheFile.js";
import { fsyncDir, sweepTempFiles, tempNamePattern, writeFileAtomic } from "./atomicWrite.js";
import {
  applyApprove,
  applyDecline,
  applyPolicy,
  applyRevoke,
  blobBytes,
  contentHash,
  type DecisionCommand,
  emptyState,
  findResource,
  type IngestCandidate,
  type IngestItemResult,
  ingestCandidates,
  type OriginPolicy,
  type PolicyCommand,
  referencedBlobs,
  stateInvariantError,
  type StoredResource,
  type StoreState,
  StoreStateSchema,
  STORE_SCHEMA_VERSION,
} from "./decisions.js";
import type { DiscoveryResult } from "./discovery.js";
import { collect, type PinnedVersions } from "./garbageCollection.js";
import { acquireStoreLock, type StoreLock } from "./storeLock.js";
import { sha256Hex } from "./textValidation.js";

/** store.json larger than this is refused unread. 256 resources x 16 versions fit well under it. */
export const STORE_FILE_MAX_BYTES = 16 * 1024 * 1024;
/** `onRevoked` running longer than this counts as a failed hook; reads are blocked regardless. */
export const ON_REVOKED_TIMEOUT_MS = 5000;

export type StoreCorruptCode =
  | "dir_symlink"
  | "dir_not_directory"
  | "dir_wrong_owner"
  | "dir_not_private"
  | "file_not_regular"
  | "file_not_private"
  | "file_too_large"
  | "unreadable"
  | "parse"
  | "schema_version"
  | "schema"
  | "resource_id"
  | "invariant"
  | "blob_missing"
  | "blob_hash";

/** The persisted store cannot be trusted. Never silently replaced: the caller surfaces it. */
export class StoreCorruptError extends Error {
  constructor(readonly code: StoreCorruptCode) {
    super(`capability store: ${code}`);
    this.name = "StoreCorruptError";
  }
}

export type ReadResolution =
  | { ok: true; resource: Resource; version: ResourceVersion; approval: "approved" | "superseded" }
  | { ok: false; code: "not_found" | "revoked" };

export interface ApprovedListing {
  resource: Resource;
  /** The default version reads get. */
  version: ResourceVersion;
  /** Older approved versions still readable by explicit version. */
  superseded: ResourceVersion[];
}

/**
 * The deferred export sync a change started. Never rejects. `ok: false` means the sync failed
 * (recorded) or was skipped because the store closed before it started; the next writable
 * open's startup sync reconciles the wrappers.
 */
export type ExportSync = Promise<{ ok: boolean }>;

export interface IngestReport {
  origin: string;
  results: IngestItemResult[];
  /** Found items not ingested: cross-origin, non-canonical, or bytes not matching their hash. */
  skipped: number;
  /** Export sync, started only when something was auto-approved (otherwise resolves `ok` at once). */
  cleanup: ExportSync;
}

export interface DecisionResult {
  changed: boolean;
  approvalRevision: number;
  /** The resource's revision after the decision. */
  revision: number;
}

export interface ApproveResult extends DecisionResult {
  /** Export sync, started after this result resolved when the approval changed anything. */
  cleanup: ExportSync;
}

export interface RevokeResult extends DecisionResult {
  /** Versions that were readable before the revocation. */
  revokedVersions: string[];
  /** `onRevoked` threw or timed out: tokens or jobs may not have been invalidated. Reads are blocked regardless. */
  hookFailed: boolean;
  hookError?: "on_revoked_failed" | "on_revoked_timeout";
  /** Export cleanup, started after this result resolved. */
  cleanup: ExportSync;
}

/** A mutation on a store opened `readOnly` or already closed. */
export class StoreReadOnlyError extends Error {
  readonly code = "read_only";
  constructor() {
    super("capability store: read-only");
    this.name = "StoreReadOnlyError";
  }
}

export interface GcReport {
  versions: number;
  resources: number;
  blobs: number;
}

export interface CapabilityStoreOptions {
  scoutHome: string;
  clock: Clock;
  diagnostics?: Diagnostics;
  /**
   * Called after a revocation is committed and before `revoke()` resolves. Errors and timeouts
   * are recorded on the result, not rethrown. Runs inside the mutation queue: it must not await
   * a store mutation or `close()`, which would wait on the revoke itself (until the timeout).
   */
  onRevoked?: (resourceId: string, versions: readonly string[]) => void | Promise<void>;
  /**
   * Export sync after a revocation, an approval, an auto-approving ingest, and a writable open
   * (normally `exporter.sync`). Receives a copy of the committed state at the moment the sync
   * starts (after the triggering mutation answered), so it never needs the store object.
   */
  syncExports?: (state: StoreState) => Promise<unknown>;
  /** Open without the writer lock; every mutation throws StoreReadOnlyError. */
  readOnly?: boolean;
  /** Test hooks for the caps and the `onRevoked` bound (default ON_REVOKED_TIMEOUT_MS). */
  limits?: { maxResources?: number; maxBlobBytes?: number; onRevokedTimeoutMs?: number };
}

export interface CapabilityStore {
  readonly dir: string;
  readonly readOnly: boolean;
  /**
   * Refuse new mutations, wait for queued ones to settle (any that reaches its commit is
   * refused), wait for export syncs already running (unstarted ones are skipped), then release
   * the writer lock. Idempotent.
   */
  close(): Promise<void>;
  /** The export sync a writable open started (resolves `ok` at once when read-only or without `syncExports`). */
  readonly startupExportSync: ExportSync;
  /** Bumped on every approval-affecting change; persisted, so it never goes back. */
  readonly approvalRevision: number;
  /** A copy of the whole state. */
  snapshot(): StoreState;
  getResource(resourceId: string): StoredResource | undefined;
  /** The default approved version, or undefined when blocked or never approved. */
  getApprovedDefault(resourceId: string): ResourceVersion | undefined;
  /** Any recorded version, in any state; callers check `state`. Use `resolveRead` for agent reads. */
  getVersion(resourceId: string, version: string): ResourceVersion | undefined;
  /** What an agent read may see: the default (no version) or an approved/superseded version, never while blocked. */
  resolveRead(resourceId: string, version?: string): ReadResolution;
  /** Unblocked resources with a default version, optionally for one site origin. */
  listApproved(siteOrigin?: string): ApprovedListing[];
  originPolicy(origin: string): OriginPolicy | undefined;
  /** The blob's bytes, re-hashed: a missing (`blob_missing`), mismatched (`blob_hash`), or unusable (`unreadable`) blob is a StoreCorruptError. */
  readBlob(blobRef: string): Buffer;
  /** Keep a readable version from collection while a request uses it. Returns the read check. */
  pinVersion(requestId: string, resourceId: string, version: string): ReadResolution;
  releasePins(requestId: string): void;
  ingest(discovery: DiscoveryResult, context: { chromePermitted: boolean }): Promise<IngestReport>;
  approve(command: DecisionCommand): Promise<ApproveResult>;
  decline(command: DecisionCommand): Promise<DecisionResult>;
  /**
   * Block every version of the resource; see the file header for the order of effects. When the
   * resource is already blocked and nothing changes (`changed: false`), nothing is committed but `onRevoked` still
   * runs (with `revokedVersions: []`) and export cleanup is still scheduled, so re-revoking
   * retries a wrapper removal that failed before. `onRevoked` runs inside the mutation queue:
   * it must not await a store mutation or `close()`.
   */
  revoke(resourceId: string): Promise<RevokeResult>;
  setOriginPolicy(command: PolicyCommand): Promise<{ changed: boolean; approvalRevision: number }>;
  collectGarbage(): Promise<GcReport>;
}

const BLOB_NAME_RE = /^[0-9a-f]{64}\.txt$/;
/** writeFileAtomic leftovers: store.json and exports.json temps beside them, blob temps in blobs/. */
const CAP_TEMP_RE = tempNamePattern("store\\.json|exports\\.json");
const BLOB_TEMP_RE = tempNamePattern("[0-9a-f]{64}\\.txt");

function ensurePrivateDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (fsErrorCode(error) === "not_directory") throw new StoreCorruptError("dir_not_directory");
    throw error;
  }
  const refusal = checkPrivateDir(dir);
  if (refusal) throw new StoreCorruptError(`dir_${refusal}`);
}

async function loadState(path: string): Promise<StoreState> {
  let raw: Buffer;
  try {
    raw = readPrivateFile(path, STORE_FILE_MAX_BYTES, { private: true });
  } catch (error) {
    if (error instanceof PrivateFileError) {
      if (error.code === "missing") return emptyState();
      if (error.code === "not_regular") throw new StoreCorruptError("file_not_regular");
      if (error.code === "not_private") throw new StoreCorruptError("file_not_private");
      if (error.code === "too_large") throw new StoreCorruptError("file_too_large");
    }
    throw new StoreCorruptError("unreadable");
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new StoreCorruptError("parse");
  }
  if ((json as { schemaVersion?: unknown } | null)?.schemaVersion !== STORE_SCHEMA_VERSION) throw new StoreCorruptError("schema_version");
  const parsed = StoreStateSchema.safeParse(json);
  if (!parsed.success) throw new StoreCorruptError("schema");
  // zod omits absent optional keys, so the parsed value satisfies the exact-optional types.
  const state = parsed.data as StoreState;
  if (stateInvariantError(state)) throw new StoreCorruptError("invariant");
  for (const r of state.resources) {
    if ((await deriveResourceId(r.resource.kind, r.resource.sourceUrl)) !== r.resource.id) throw new StoreCorruptError("resource_id");
  }
  return state;
}

export async function createCapabilityStore(options: CapabilityStoreOptions): Promise<CapabilityStore> {
  const { clock, diagnostics } = options;
  const dir = join(options.scoutHome, "capabilities");
  const blobDir = join(dir, "blobs");
  const storePath = join(dir, "store.json");

  const readOnly = options.readOnly === true;
  let state: StoreState;
  let lock: StoreLock | undefined;
  try {
    ensurePrivateDir(dir);
    ensurePrivateDir(blobDir);
    if (!readOnly) lock = acquireStoreLock(dir, { now: () => clock.now() });
    state = await loadState(storePath);
  } catch (error) {
    lock?.release();
    if (error instanceof StoreCorruptError) diagnostics?.event("capability_store_invalid", { code: error.code });
    throw error;
  }
  let closed = false;
  const assertWritable = () => {
    if (readOnly || closed) throw new StoreReadOnlyError();
  };

  if (!readOnly) {
    const referenced = referencedBlobs(state);
    const orphanBlobs = sweepTempFiles(blobDir, (name) => BLOB_NAME_RE.test(name) && !referenced.has(name.slice(0, 64)));
    const tempFiles = sweepTempFiles(dir, CAP_TEMP_RE) + sweepTempFiles(blobDir, BLOB_TEMP_RE);
    if (orphanBlobs > 0 || tempFiles > 0) diagnostics?.event("capability_gc", { orphanBlobs, tempFiles });
  }

  /** requestId → pinned "resourceId\0version" keys. In memory: requests do not survive a restart. */
  const pins = new Map<string, Set<string>>();
  const pinKey = (resourceId: string, version: string) => `${resourceId}\0${version}`;
  const pinnedVersions = (): PinnedVersions => {
    const out = new Map<string, Set<string>>();
    for (const keys of pins.values()) {
      for (const k of keys) {
        const [id, v] = k.split("\0") as [string, string];
        if (!out.has(id)) out.set(id, new Set());
        out.get(id)!.add(v);
      }
    }
    return out;
  };

  let tail: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = tail.then(fn);
    tail = run.catch(() => undefined);
    return run;
  }

  const blobPath = (ref: string) => join(blobDir, `${ref}.txt`);

  function writeBlob(ref: string, bytes: Uint8Array): void {
    try {
      const existing = readPrivateFile(blobPath(ref), RESOURCE_MAX_BYTES, { private: true });
      if (sha256Hex(existing) === ref) return; // content-addressed: already there
    } catch {
      // Missing or unusable: write it.
    }
    writeFileAtomic(blobPath(ref), bytes);
  }

  /** Write new blobs, then replace store.json, then swap; afterwards delete blobs the new state dropped. */
  function commit(next: StoreState, newBlobs: ReadonlyMap<string, Uint8Array> = new Map()): number {
    // A mutation already past its own check when close() ran must not write after it.
    if (closed) throw new StoreReadOnlyError();
    for (const [ref, bytes] of newBlobs) writeBlob(ref, bytes);
    writeFileAtomic(storePath, JSON.stringify(next));
    const kept = referencedBlobs(next);
    const dropped = [...referencedBlobs(state)].filter((ref) => !kept.has(ref));
    state = next;
    let deleted = 0;
    for (const ref of dropped) {
      try {
        unlinkSync(blobPath(ref));
        deleted++;
      } catch {
        // Already gone; nothing refers to it.
      }
    }
    if (deleted > 0) fsyncDir(blobDir);
    return deleted;
  }

  function resolveRead(resourceId: string, version?: string): ReadResolution {
    const r = findResource(state, resourceId);
    if (!r) return { ok: false, code: "not_found" };
    if (r.resource.blocked) return { ok: false, code: "revoked" };
    const target = version ?? r.resource.defaultVersion;
    const v = target === undefined ? undefined : r.resource.versions.find((x) => x.hash === target);
    if (!v) return { ok: false, code: "not_found" };
    if (v.state === "revoked") return { ok: false, code: "revoked" };
    if (v.state !== "approved" && v.state !== "superseded") return { ok: false, code: "not_found" };
    return { ok: true, resource: structuredClone(r.resource), version: structuredClone(v), approval: v.state };
  }

  const resourceRevision = (id: string) => findResource(state, id)?.revision ?? 0;

  /** Export syncs scheduled or running; close() waits for them before releasing the lock. */
  const pendingSyncs = new Set<ExportSync>();

  /** Start the export sync after the current mutation has answered. Never rejects. */
  function scheduleExportSync(reason: string, resourceId?: string): ExportSync {
    const sync: ExportSync = new Promise((resolve) => {
      setImmediate(() => {
        if (!options.syncExports) return resolve({ ok: true });
        if (closed) return resolve({ ok: false });
        Promise.resolve()
          .then(() => options.syncExports!(structuredClone(state)))
          .then(
            () => resolve({ ok: true }),
            () => {
              // Settle first: a throwing diagnostics sink must not leave close() waiting on this sync.
              resolve({ ok: false });
              diagnostics?.event("capability_export_failed", { reason, ...(resourceId ? { resource: shortId(resourceId) } : {}) });
            },
          );
      });
    });
    pendingSyncs.add(sync);
    void sync.then(() => pendingSyncs.delete(sync));
    return sync;
  }
  const shortId = (id: string) => id.slice(4, 20);

  /** Run `onRevoked`, bounded by ON_REVOKED_TIMEOUT_MS. Never rejects. */
  async function runOnRevoked(resourceId: string, versions: readonly string[]): Promise<"ok" | "on_revoked_failed" | "on_revoked_timeout"> {
    if (!options.onRevoked) return "ok";
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"on_revoked_timeout">((resolve) => {
      timer = setTimeout(() => resolve("on_revoked_timeout"), options.limits?.onRevokedTimeoutMs ?? ON_REVOKED_TIMEOUT_MS);
    });
    try {
      const hook = Promise.resolve()
        .then(() => options.onRevoked!(resourceId, versions))
        .then(
          () => "ok" as const,
          () => "on_revoked_failed" as const,
        );
      return await Promise.race([hook, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function toCandidates(discovery: DiscoveryResult): Promise<{ candidates: IngestCandidate[]; bytes: Map<string, Uint8Array>; skipped: number }> {
    const candidates: IngestCandidate[] = [];
    const bytes = new Map<string, Uint8Array>();
    let skipped = 0;
    for (const item of discovery.items) {
      const res = item.resource;
      if (item.status !== "found" || !res || item.kind === "skills_index") continue;
      const body = Buffer.from(res.text, "utf8");
      if (
        res.kind !== item.kind ||
        res.siteOrigin !== discovery.origin ||
        res.publisherOrigin !== discovery.origin ||
        !isCanonicalSourceUrl(res.sourceUrl) ||
        new URL(res.sourceUrl).origin !== discovery.origin ||
        body.length > RESOURCE_MAX_BYTES ||
        sha256Hex(body) !== res.sha256 ||
        (res.kind === "skill") !== (res.skill !== undefined)
      ) {
        skipped++;
        continue;
      }
      const meta: IngestCandidate["meta"] = {};
      if (res.contentType !== undefined) meta.contentType = res.contentType;
      if (res.skill) {
        meta.skill = { name: res.skill.name, digest: res.skill.sha256 };
        if (res.skill.description !== undefined) meta.skill.description = res.skill.description;
      }
      candidates.push({
        resourceId: await deriveResourceId(res.kind, res.sourceUrl),
        kind: res.kind,
        siteOrigin: discovery.origin,
        publisherOrigin: discovery.origin,
        sourceUrl: res.sourceUrl,
        hash: contentHash(res.kind, res.sourceUrl, meta, body),
        blobRef: res.sha256,
        byteLength: body.length,
        fetchedAt: res.fetchedAt,
        meta,
      });
      bytes.set(res.sha256, body);
    }
    return { candidates, bytes, skipped };
  }

  const startupExportSync: ExportSync = readOnly ? Promise.resolve({ ok: true }) : scheduleExportSync("startup");

  return {
    dir,
    readOnly,
    async close() {
      closed = true;
      await tail;
      // A sync already running finishes; one scheduled but not started resolves `ok: false`.
      await Promise.all([...pendingSyncs]);
      lock?.release();
    },
    startupExportSync,
    get approvalRevision() {
      return state.approvalRevision;
    },
    snapshot: () => structuredClone(state),
    getResource: (id) => {
      const r = findResource(state, id);
      return r && structuredClone(r);
    },
    getApprovedDefault(id) {
      const r = findResource(state, id);
      if (!r || r.resource.blocked || r.resource.defaultVersion === undefined) return undefined;
      const v = r.resource.versions.find((x) => x.hash === r.resource.defaultVersion);
      return v && structuredClone(v);
    },
    getVersion(id, version) {
      const v = findResource(state, id)?.resource.versions.find((x) => x.hash === version);
      return v && structuredClone(v);
    },
    resolveRead,
    listApproved(siteOrigin) {
      const out: ApprovedListing[] = [];
      for (const r of state.resources) {
        if (r.resource.blocked || r.resource.defaultVersion === undefined) continue;
        if (siteOrigin !== undefined && r.resource.siteOrigin !== siteOrigin) continue;
        const version = r.resource.versions.find((v) => v.hash === r.resource.defaultVersion)!;
        out.push({
          resource: structuredClone(r.resource),
          version: structuredClone(version),
          superseded: structuredClone(r.resource.versions.filter((v) => v.state === "superseded")),
        });
      }
      return out;
    },
    originPolicy: (origin) => {
      const p = state.policies.find((x) => x.origin === origin);
      return p && structuredClone(p);
    },
    readBlob(ref) {
      if (typeof ref !== "string" || !SHA256_HEX_PATTERN.test(ref)) throw new StoreCorruptError("blob_missing");
      let bytes: Buffer;
      try {
        bytes = readPrivateFile(blobPath(ref), RESOURCE_MAX_BYTES, { private: true });
      } catch (error) {
        const code = error instanceof PrivateFileError && error.code === "missing" ? "blob_missing" : "unreadable";
        diagnostics?.event("capability_store_invalid", { code });
        throw new StoreCorruptError(code);
      }
      if (sha256Hex(bytes) !== ref) {
        diagnostics?.event("capability_store_invalid", { code: "blob_hash" });
        throw new StoreCorruptError("blob_hash");
      }
      return bytes;
    },
    pinVersion(requestId, resourceId, version) {
      const check = resolveRead(resourceId, version);
      if (!check.ok) return check;
      if (!pins.has(requestId)) pins.set(requestId, new Set());
      pins.get(requestId)!.add(pinKey(resourceId, version));
      return check;
    },
    releasePins: (requestId) => void pins.delete(requestId),

    ingest: (discovery, context) =>
      serialize(async () => {
        assertWritable();
        const { candidates, bytes, skipped } = await toCandidates(discovery);
        const { state: next, results } = ingestCandidates(state, candidates, {
          origin: discovery.origin,
          chromePermitted: context.chromePermitted === true,
          now: clock.now(),
          pinned: pinnedVersions(),
          ...(options.limits?.maxResources !== undefined ? { maxResources: options.limits.maxResources } : {}),
          ...(options.limits?.maxBlobBytes !== undefined ? { maxBlobBytes: options.limits.maxBlobBytes } : {}),
        });
        const known = referencedBlobs(state);
        const wanted = referencedBlobs(next);
        const newBlobs = new Map([...bytes].filter(([ref]) => wanted.has(ref) && !known.has(ref)));
        commit(next, newBlobs);
        const count = (o: IngestItemResult["outcome"]) => results.filter((r) => r.outcome === o).length;
        diagnostics?.event("capability_ingest", {
          origin: discovery.origin,
          found: candidates.length,
          skipped,
          pending: count("new_pending"),
          autoApproved: count("auto_approved"),
          unchanged: count("unchanged"),
          declined: count("declined"),
          blocked: count("blocked"),
          limited: count("storage_limit"),
        });
        for (const r of results) {
          if (r.outcome === "storage_limit") diagnostics?.event("capability_store_limit", { origin: discovery.origin, code: r.limit ?? "unknown", bytes: blobBytes(state) });
        }
        const autoApproved = results.some((r) => r.outcome === "auto_approved");
        const cleanup: ExportSync = autoApproved ? scheduleExportSync("auto_approve") : Promise.resolve({ ok: true });
        return { origin: discovery.origin, results, skipped, cleanup };
      }),

    approve: (command) =>
      serialize(() => {
        assertWritable();
        const { state: next, changed } = applyApprove(state, command, clock.now());
        if (changed) commit(next);
        diagnostics?.event("capability_decision", { resource: shortId(command.resourceId), action: "approve", changed, revision: state.approvalRevision });
        const cleanup: ExportSync = changed ? scheduleExportSync("approve", command.resourceId) : Promise.resolve({ ok: true });
        return { changed, approvalRevision: state.approvalRevision, revision: resourceRevision(command.resourceId), cleanup };
      }),

    decline: (command) =>
      serialize(() => {
        assertWritable();
        const { state: next, changed } = applyDecline(state, command, clock.now());
        if (changed) commit(next);
        diagnostics?.event("capability_decision", { resource: shortId(command.resourceId), action: "decline", changed, revision: state.approvalRevision });
        return { changed, approvalRevision: state.approvalRevision, revision: resourceRevision(command.resourceId) };
      }),

    revoke: (resourceId) =>
      serialize(async () => {
        assertWritable();
        // (1) Commit the block, then drop the resource's pins so no later collection keeps them.
        // A failed commit throws before the pins are touched.
        const { state: next, changed, revokedVersions } = applyRevoke(state, resourceId, clock.now());
        if (changed) commit(next);
        for (const keys of pins.values()) for (const k of [...keys]) if (k.startsWith(`${resourceId}\0`)) keys.delete(k);
        diagnostics?.event("capability_decision", { resource: shortId(resourceId), action: "revoke", changed, revision: state.approvalRevision });
        // (2) Invalidate tokens and cancel jobs before answering.
        const hook = await runOnRevoked(resourceId, revokedVersions);
        const hookFailed = hook !== "ok";
        if (hookFailed) diagnostics?.event("capability_revoke_hook_failed", { resource: shortId(resourceId), code: hook });
        // (4) Clean up exports after the caller has its answer.
        const cleanup = scheduleExportSync("revoke", resourceId);
        return {
          changed,
          approvalRevision: state.approvalRevision,
          revision: resourceRevision(resourceId),
          revokedVersions,
          hookFailed,
          ...(hook !== "ok" ? { hookError: hook } : {}),
          cleanup,
        };
      }),

    setOriginPolicy: (command) =>
      serialize(() => {
        assertWritable();
        const { state: next, changed } = applyPolicy(state, command, clock.now());
        if (changed) commit(next);
        diagnostics?.event("capability_decision", { origin: command.origin, action: command.autoAcquire ? "auto_acquire_on" : "auto_acquire_off", changed, revision: state.approvalRevision });
        return { changed, approvalRevision: state.approvalRevision };
      }),

    collectGarbage: () =>
      serialize(() => {
        assertWritable();
        const { state: next, versions, resources, readableDropped } = collect(state, pinnedVersions(), clock.now());
        if (readableDropped) next.approvalRevision++;
        const blobs = versions + resources > 0 ? commit(next) : 0;
        diagnostics?.event("capability_gc", { versions, resources, blobs });
        return { versions, resources, blobs };
      }),
  };
}

/** Blob file names currently on disk (for tests and diagnostics). */
export function listBlobFiles(store: CapabilityStore): string[] {
  try {
    return readdirSync(join(store.dir, "blobs")).filter((n) => BLOB_NAME_RE.test(n));
  } catch {
    return [];
  }
}

export type { StoreState, StoredResource, DecisionCommand, PolicyCommand, OriginPolicy };
