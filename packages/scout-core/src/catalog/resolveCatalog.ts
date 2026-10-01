import { join } from "node:path";
import type { Clock } from "../clock.js";
import type { Diagnostics } from "../diagnostics.js";
import { type GuardedFetchOptions, type GuardedFetchResult, guardedFetch } from "../fetch/guardedFetch.js";
import { type CatalogCacheResult, createCatalogCache } from "./cache.js";
import { createCoalescingFetch } from "../fetch/inflight.js";
import { createPacedCatalogFetch, type PacedCatalogFetch, type Sleep } from "./pacing.js";

export interface CatalogResolverOptions {
  /** Scout's home directory; the cache lives in `<scoutHome>/cache/catalog`. */
  scoutHome: string;
  clock: Clock;
  diagnostics?: Diagnostics;
  /** Test hook; defaults to the real `guardedFetch`. */
  guardedFetch?: (url: string, options: GuardedFetchOptions) => Promise<GuardedFetchResult>;
  /** Test hook; defaults to `setTimeout`. */
  sleep?: Sleep;
}

/** What one resolve cost on the network. */
export interface CatalogResolveStats {
  /** Requests that reached `guardedFetch` (revalidation and rediscovery together). */
  requests: number;
  /** Requests the paced fetch refused (budget, deadline, or origin). */
  refused: number;
  /** Decoded bytes of every `ok` body. */
  bytesReceived: number;
  ms: number;
}

export interface CatalogResolution {
  result: CatalogCacheResult;
  stats: CatalogResolveStats;
}

export interface CatalogResolver {
  /**
   * `session` runs the resolve on a caller's shared origin fetch (see
   * `createOriginFetchSession`); without one, the resolve gets a private session. With a
   * shared session, `stats` also count requests other callers made during this resolve.
   */
  resolve(origin: string, options?: { refresh?: boolean; session?: OriginFetchSession }): Promise<CatalogResolution>;
}

/** Network totals of one session so far. */
export interface OriginFetchStats {
  requests: number;
  refused: number;
  bytesReceived: number;
}

/**
 * One origin's outbound fetch for one pass, shared by every caller in that pass (catalog
 * resolution and capability discovery). Requests go through one paced queue (crawl delay,
 * budget, deadline, origin check), and identical requests share one network call and one
 * decoded body (`createCoalescingFetch`). Make a new session per pass.
 */
export interface OriginFetchSession {
  readonly origin: string;
  readonly fetch: PacedCatalogFetch;
  stats(): OriginFetchStats;
}

export interface OriginFetchSessionOptions {
  origin: string;
  clock: Clock;
  /** Test hook; defaults to the real `guardedFetch`. */
  guardedFetch?: (url: string, options: GuardedFetchOptions) => Promise<GuardedFetchResult>;
  /** Test hook; defaults to `setTimeout`. */
  sleep?: Sleep;
}

export function createOriginFetchSession(options: OriginFetchSessionOptions): OriginFetchSession {
  const origin = new URL(options.origin).origin;
  const baseFetch = options.guardedFetch ?? guardedFetch;
  let bytesReceived = 0;
  const countingFetch = async (url: string, fetchOptions: GuardedFetchOptions): Promise<GuardedFetchResult> => {
    const result = await baseFetch(url, fetchOptions);
    if (result.kind === "ok") bytesReceived += result.bytes.byteLength;
    return result;
  };
  const paced = createPacedCatalogFetch({ origin, clock: options.clock, guardedFetch: countingFetch, ...(options.sleep ? { sleep: options.sleep } : {}) });
  const fetch = createCoalescingFetch(paced) as PacedCatalogFetch;
  fetch.setCrawlDelay = paced.setCrawlDelay;
  fetch.startWindow = paced.startWindow;
  Object.defineProperty(fetch, "refused", { get: () => paced.refused });
  Object.defineProperty(fetch, "requests", { get: () => paced.requests });
  return { origin, fetch, stats: () => ({ requests: paced.requests, refused: paced.refused, bytesReceived }) };
}

/**
 * The catalog pipeline for one caller: the on-disk cache plus, per resolve, a fresh paced
 * fetch bound to that origin (so pacing, budget, and deadline are per origin and per run).
 * The CLI uses it now; the coordinator will in Phase 4.
 */
export function createCatalogResolver(options: CatalogResolverOptions): CatalogResolver {
  const { clock, diagnostics } = options;
  const cache = createCatalogCache({ clock, dir: join(options.scoutHome, "cache", "catalog"), ...(diagnostics ? { diagnostics } : {}) });

  return {
    async resolve(origin, { refresh = false, session: shared } = {}) {
      const session =
        shared ??
        createOriginFetchSession({
          origin,
          clock,
          ...(options.guardedFetch ? { guardedFetch: options.guardedFetch } : {}),
          ...(options.sleep ? { sleep: options.sleep } : {}),
        });
      if (session.origin !== new URL(origin).origin) throw new TypeError("session is for another origin");
      const before = session.stats();
      const started = clock.now();
      const result = await cache.resolve({ origin, fetch: session.fetch, refresh });
      const after = session.stats();
      return {
        result,
        stats: {
          requests: after.requests - before.requests,
          refused: after.refused - before.refused,
          bytesReceived: after.bytesReceived - before.bytesReceived,
          ms: clock.now() - started,
        },
      };
    },
  };
}
