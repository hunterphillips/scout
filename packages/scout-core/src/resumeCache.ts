import type { ContextStatus } from "@scout/contracts";
import type { Clock } from "./clock.js";
import type { Diagnostics } from "./diagnostics.js";

export type { ContextStatus };

export interface ResumeKey {
  tabId: number;
  documentId?: string;
  /** The page URL. The fragment is ignored; path and query are part of the key. */
  url: string;
  catalogVersion: string;
  /** Scout's contextRevision at rank time. */
  contextRevision: number;
}

export type ResumeMissReason = "empty" | "key" | "expired" | "replaced" | "status_failed" | "status_mismatch";

export interface ResumeCache<T> {
  /** Store a finished rank's result under its key, replacing any entry with the same key. */
  store(key: ResumeKey, result: T, status: ContextStatus): void;
  /**
   * Return the stored result if an entry exists for the key, it is under the TTL, and a
   * fresh `context_status` matches all three stored values. Expiry, a failed status call,
   * or a status mismatch discards that key's entry only. A key with no entry returns null
   * and leaves the other entries alone.
   */
  restore(key: ResumeKey, fetchStatus: () => Promise<ContextStatus>): Promise<T | null>;
  /** Discard every entry. */
  clear(): void;
  readonly size: number;
}

export interface ResumeCacheOptions {
  clock: Clock;
  ttlMs?: number;
  diagnostics?: Diagnostics;
}

interface Entry<T> {
  result: T;
  status: ContextStatus;
  storedAt: number;
}

export const RESUME_TTL_MS = 30_000;
/** Upper bound on entries; storing past it evicts the oldest-stored entry. */
export const RESUME_MAX_ENTRIES = 8;

/**
 * The one in-memory result cache. It lets a brief app or tab switch (A, B, back to A)
 * skip a model call. It is not a cross-visit ranking cache: every entry lives at most
 * 30 s, matches only its exact key, and the map holds at most eight entries.
 */
export function createResumeCache<T>(options: ResumeCacheOptions): ResumeCache<T> {
  const ttlMs = options.ttlMs ?? RESUME_TTL_MS;
  // Insertion order is store order: store() re-inserts, so the first entry is the oldest.
  const entries = new Map<string, Entry<T>>();

  const expired = (e: Entry<T>): boolean => {
    const age = options.clock.now() - e.storedAt;
    // A clock that went backwards makes the age unknowable; treat it as expired.
    return age < 0 || age >= ttlMs;
  };

  const miss = (reason: ResumeMissReason, id: string, discard: Entry<T> | null): null => {
    // Only discard the entry we examined; a store() for this key during the await must survive.
    if (discard !== null && entries.get(id) === discard) entries.delete(id);
    options.diagnostics?.event("resume_miss", { reason });
    return null;
  };

  return {
    get size() {
      return entries.size;
    },
    store(key, result, status) {
      for (const [id, e] of entries) if (expired(e)) entries.delete(id);
      const id = keyId(key);
      entries.delete(id);
      entries.set(id, { result, status: { ...status }, storedAt: options.clock.now() });
      while (entries.size > RESUME_MAX_ENTRIES) {
        const oldest = entries.keys().next().value as string;
        entries.delete(oldest);
      }
    },
    clear() {
      entries.clear();
    },
    async restore(key, fetchStatus) {
      const id = keyId(key);
      if (entries.size === 0) return miss("empty", id, null);
      const candidate = entries.get(id);
      // A key with no entry leaves the others alone: A, then B (unranked), then A still hits.
      if (candidate === undefined) return miss("key", id, null);
      if (expired(candidate)) return miss("expired", id, candidate);

      let status: ContextStatus;
      try {
        status = await fetchStatus();
      } catch {
        return miss("status_failed", id, candidate);
      }
      // Re-check expiry: the status call itself takes time.
      if (expired(candidate)) return miss("expired", id, candidate);
      if (!sameStatus(candidate.status, status)) return miss("status_mismatch", id, candidate);
      if (entries.get(id) !== candidate) return miss("replaced", id, null);

      options.diagnostics?.event("resume_hit", { ageMs: options.clock.now() - candidate.storedAt });
      return candidate.result;
    },
  };
}

/**
 * Exact serialized key; a missing documentId is distinct from any string. The URL is part
 * of the key because documentId survives same-document (pushState) navigation.
 */
function keyId(key: ResumeKey): string {
  return JSON.stringify([key.tabId, key.documentId ?? null, stripFragment(key.url), key.catalogVersion, key.contextRevision]);
}

function stripFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

function sameStatus(a: ContextStatus, b: ContextStatus): boolean {
  return (
    a.serviceInstanceId === b.serviceInstanceId &&
    a.activityRevision === b.activityRevision &&
    a.sourceGrantRevision === b.sourceGrantRevision
  );
}
