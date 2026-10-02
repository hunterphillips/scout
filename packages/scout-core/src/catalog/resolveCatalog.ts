import { join } from "node:path";
import type { Clock } from "../clock.js";
import type { Diagnostics } from "../diagnostics.js";
import type { GuardedFetchOptions, GuardedFetchResult } from "../fetch/guardedFetch.js";
import { createOriginFetchSession, type OriginFetchSession } from "../fetch/originSession.js";
import { type CatalogCacheResult, createCatalogCache } from "./cache.js";
import type { Sleep } from "./pacing.js";
import type { CatalogParsers } from "./resolver.js";

export interface CatalogResolverOptions {
  /** Scout's home directory; the cache lives in `<scoutHome>/cache/catalog`. */
  scoutHome: string;
  clock: Clock;
  diagnostics?: Diagnostics;
  /** Test hook; defaults to the real `guardedFetch`. */
  guardedFetch?: (url: string, options: GuardedFetchOptions) => Promise<GuardedFetchResult>;
  /** Test hook; defaults to `setTimeout`. */
  sleep?: Sleep;
  /** Off-thread parsers (the core's parse worker); without them files are parsed inline, as the CLI does. */
  parsers?: CatalogParsers;
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
   * `createOriginFetchSession`); the session's owner has opened its pacing window, and the
   * resolve opens none. Without one, the resolve gets a private session and opens its own
   * windows (one for revalidation, one for rediscovery). With a shared session, `stats`
   * also count requests other callers made during this resolve.
   */
  resolve(origin: string, options?: { refresh?: boolean; session?: OriginFetchSession }): Promise<CatalogResolution>;
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
      let session = shared;
      let startWindow: (() => void) | undefined;
      if (!session) {
        session = createOriginFetchSession({
          origin,
          clock,
          ...(options.guardedFetch ? { guardedFetch: options.guardedFetch } : {}),
          ...(options.sleep ? { sleep: options.sleep } : {}),
        });
        startWindow = session.startWindow;
      }
      if (session.origin !== new URL(origin).origin) throw new TypeError("session is for another origin");
      const before = session.stats();
      const started = clock.now();
      const result = await cache.resolve({
        origin,
        fetch: session.fetch,
        refresh,
        isCancelled: session.isCancelled,
        ...(startWindow ? { startWindow } : {}),
        ...(options.parsers ? { parsers: options.parsers } : {}),
      });
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
