import type { Clock } from "./clock.js";
import type { Diagnostics } from "./diagnostics.js";

/** `context_status` output; every rank response carries the same three fields. */
export interface ContextStatus {
  /** Random per personal-context service process start. */
  serviceInstanceId: string;
  /** Bumps on each accepted activity observation or expiry. */
  activityRevision: number;
  /** Hash of the enabled source config. */
  sourceGrantRevision: string;
}

export interface ResumeKey {
  tabId: number;
  documentId?: string;
  catalogVersion: string;
  /** Scout's contextRevision at rank time. */
  contextRevision: number;
}

export type ResumeMissReason = "empty" | "key" | "expired" | "replaced" | "status_failed" | "status_mismatch";

export interface ResumeCache<T> {
  /** Store a finished rank's result, replacing any previous entry. */
  store(key: ResumeKey, result: T, status: ContextStatus): void;
  /**
   * Return the stored result if the key matches, it is under the TTL, and a fresh
   * `context_status` matches all three stored values. Expiry, a failed status call, or a
   * status mismatch discards the entry. A different key returns null and keeps the entry.
   */
  restore(key: ResumeKey, fetchStatus: () => Promise<ContextStatus>): Promise<T | null>;
  /** Discard the entry, if any. */
  clear(): void;
  readonly size: number;
}

export interface ResumeCacheOptions {
  clock: Clock;
  ttlMs?: number;
  diagnostics?: Diagnostics;
}

interface Entry<T> {
  key: ResumeKey;
  result: T;
  status: ContextStatus;
  storedAt: number;
}

export const RESUME_TTL_MS = 30_000;

/**
 * The one in-memory result cache. It lets a brief app or tab switch skip a model call.
 * It is not a cross-visit ranking cache: it holds at most one entry.
 */
export function createResumeCache<T>(options: ResumeCacheOptions): ResumeCache<T> {
  const ttlMs = options.ttlMs ?? RESUME_TTL_MS;
  let entry: Entry<T> | null = null;

  const miss = (reason: ResumeMissReason, discard: Entry<T> | null): null => {
    // Only discard the entry we examined; a store() during the await must survive.
    if (discard !== null && entry === discard) entry = null;
    options.diagnostics?.event("resume_miss", { reason });
    return null;
  };

  return {
    get size() {
      return entry === null ? 0 : 1;
    },
    store(key, result, status) {
      entry = { key: { ...key }, result, status: { ...status }, storedAt: options.clock.now() };
    },
    clear() {
      entry = null;
    },
    async restore(key, fetchStatus) {
      const candidate = entry;
      if (candidate === null) return miss("empty", null);
      // A different page's lookup leaves the entry alone: A, then B (unranked), then A still hits.
      if (!sameKey(candidate.key, key)) return miss("key", null);
      if (options.clock.now() - candidate.storedAt >= ttlMs) return miss("expired", candidate);

      let status: ContextStatus;
      try {
        status = await fetchStatus();
      } catch {
        return miss("status_failed", candidate);
      }
      // Re-check expiry: the status call itself takes time.
      if (options.clock.now() - candidate.storedAt >= ttlMs) return miss("expired", candidate);
      if (!sameStatus(candidate.status, status)) return miss("status_mismatch", candidate);
      if (entry !== candidate) return miss("replaced", null);

      options.diagnostics?.event("resume_hit", { ageMs: options.clock.now() - candidate.storedAt });
      return candidate.result;
    },
  };
}

function sameKey(a: ResumeKey, b: ResumeKey): boolean {
  return (
    a.tabId === b.tabId &&
    a.documentId === b.documentId &&
    a.catalogVersion === b.catalogVersion &&
    a.contextRevision === b.contextRevision
  );
}

function sameStatus(a: ContextStatus, b: ContextStatus): boolean {
  return (
    a.serviceInstanceId === b.serviceInstanceId &&
    a.activityRevision === b.activityRevision &&
    a.sourceGrantRevision === b.sourceGrantRevision
  );
}
