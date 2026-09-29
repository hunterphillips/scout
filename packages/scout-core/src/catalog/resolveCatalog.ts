import { join } from "node:path";
import type { Clock } from "../clock.js";
import type { Diagnostics } from "../diagnostics.js";
import { type GuardedFetchOptions, type GuardedFetchResult, guardedFetch } from "../fetch/guardedFetch.js";
import { type CatalogCacheResult, createCatalogCache } from "./cache.js";
import { createPacedCatalogFetch, type Sleep } from "./pacing.js";

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
  resolve(origin: string, options?: { refresh?: boolean }): Promise<CatalogResolution>;
}

/**
 * The catalog pipeline for one caller: the on-disk cache plus, per resolve, a fresh paced
 * fetch bound to that origin (so pacing, budget, and deadline are per origin and per run).
 * The CLI uses it now; the coordinator will in Phase 4.
 */
export function createCatalogResolver(options: CatalogResolverOptions): CatalogResolver {
  const { clock, diagnostics } = options;
  const baseFetch = options.guardedFetch ?? guardedFetch;
  const cache = createCatalogCache({ clock, dir: join(options.scoutHome, "cache", "catalog"), ...(diagnostics ? { diagnostics } : {}) });

  return {
    async resolve(origin, { refresh = false } = {}) {
      let bytesReceived = 0;
      const countingFetch = async (url: string, fetchOptions: GuardedFetchOptions): Promise<GuardedFetchResult> => {
        const result = await baseFetch(url, fetchOptions);
        if (result.kind === "ok") bytesReceived += result.bytes.byteLength;
        return result;
      };
      const fetch = createPacedCatalogFetch({ origin, clock, guardedFetch: countingFetch, ...(options.sleep ? { sleep: options.sleep } : {}) });
      const started = clock.now();
      const result = await cache.resolve({ origin, fetch, refresh });
      return { result, stats: { requests: fetch.requests, refused: fetch.refused, bytesReceived, ms: clock.now() - started } };
    },
  };
}
