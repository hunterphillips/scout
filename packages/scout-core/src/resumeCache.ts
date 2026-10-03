import { createHash } from "node:crypto";
import type { Clock } from "./clock.js";
import type { Diagnostics } from "./diagnostics.js";

export interface ResumeCacheOptions {
  clock: Clock;
  ttlMs?: number;
  diagnostics?: Diagnostics;
}

export const RESUME_TTL_MS = 30_000;
/** Upper bound on entries; storing past it evicts the oldest-stored entry. */
export const RESUME_MAX_ENTRIES = 8;

function stripFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

// The recommendation jobs' resume cache (pivot Phase 3; the legacy rank client's cache went
// in P4.4): a finished job's answer, reused for 30 s when everything it was built from
// is unchanged, so a brief switch away and back (A, B, back to A) skips a model call. The key
// names every input of the answer: the core start, the origin and page, the catalog, the
// activity the job saw (a hash), the approvals, the browser-context grant, the agent profile,
// and its tools. An answer made without the user's optional tools (they were selected but
// failed, so it rests on Scout's browser context alone) is never reused by a job that has them.
// Only `ok` and `empty` answers are stored. At most RESUME_MAX_ENTRIES entries.

export interface JobResumeKey {
  coreInstanceId: string;
  origin: string;
  /** The visit's page URL; the fragment is ignored. */
  url: string;
  catalogHash: string;
  /** A hash of the activity entries the job's snapshot carried (activityHash). */
  activityHash: string;
  approvalRevision: number;
  grantRevision: number;
  profileFingerprint: string;
  /** The agent profile's tools revision (0 without selected tools). */
  toolsRevision: number;
}

export interface JobResumeEntry<T> {
  result: T;
  /** The answer rests on Scout's browser context alone: a selected optional tool failed. */
  browserOnly: boolean;
}

export interface JobResumeCache<T> {
  store(key: JobResumeKey, entry: JobResumeEntry<T>): void;
  /** The stored answer if one is under the TTL for exactly this key and usable by a job with (or without) user tools. */
  restore(key: JobResumeKey, opts: { hasUserTools: boolean }): T | null;
  clear(): void;
  readonly size: number;
}

/** A hash of activity entries (url, title, text, in order). */
export function activityHash(entries: readonly { url: string; title: string; text?: string | undefined }[]): string {
  const h = createHash("sha256");
  for (const e of entries) h.update(JSON.stringify([e.url, e.title, e.text ?? null]), "utf8");
  return h.digest("hex").slice(0, 32);
}

export function createJobResumeCache<T>(options: ResumeCacheOptions): JobResumeCache<T> {
  const ttlMs = options.ttlMs ?? RESUME_TTL_MS;
  const entries = new Map<string, JobResumeEntry<T> & { storedAt: number }>();
  const expired = (storedAt: number): boolean => {
    const age = options.clock.now() - storedAt;
    return age < 0 || age >= ttlMs;
  };
  const id = (k: JobResumeKey): string =>
    JSON.stringify([k.coreInstanceId, k.origin, stripFragment(k.url), k.catalogHash, k.activityHash, k.approvalRevision, k.grantRevision, k.profileFingerprint, k.toolsRevision]);
  return {
    get size() {
      return entries.size;
    },
    store(key, entry) {
      for (const [k, e] of entries) if (expired(e.storedAt)) entries.delete(k);
      const k = id(key);
      entries.delete(k);
      entries.set(k, { ...entry, storedAt: options.clock.now() });
      while (entries.size > RESUME_MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
    },
    restore(key, opts) {
      const k = id(key);
      const e = entries.get(k);
      if (e === undefined) {
        options.diagnostics?.event("resume_miss", { reason: entries.size === 0 ? "empty" : "key" });
        return null;
      }
      if (expired(e.storedAt)) {
        entries.delete(k);
        options.diagnostics?.event("resume_miss", { reason: "expired" });
        return null;
      }
      if (e.browserOnly && opts.hasUserTools) {
        options.diagnostics?.event("resume_miss", { reason: "browser_only" });
        return null;
      }
      options.diagnostics?.event("resume_hit", { ageMs: options.clock.now() - e.storedAt });
      return e.result;
    },
    clear() {
      entries.clear();
    },
  };
}
