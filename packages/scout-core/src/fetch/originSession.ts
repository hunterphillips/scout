import { createPacedCatalogFetch, type PacedFetch, type Sleep, withoutWindowControl } from "../catalog/pacing.js";
import type { Clock } from "../clock.js";
import { type GuardedFetchOptions, type GuardedFetchResult, guardedFetch } from "./guardedFetch.js";
import { createCoalescingFetch } from "./inflight.js";

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
 *
 * The session owns the pacing window. Whoever creates it calls `startWindow()` once before
 * running the pass's callers (the CLI, and later the coordinator once per settled visit);
 * callers handed the session never open a window of their own, so everything in the pass
 * shares one request budget and one deadline (`MAX_REQUESTS_PER_RUN`, `RUN_DEADLINE_MS`).
 *
 * Sharing across callers needs identical requests: the same URL, `Accept`, and validators.
 * The catalog and resource discovery send the same `Accept` for `/robots.txt` and
 * `/llms.txt` and keep validators by the same rule (`nextValidators`), so on a warm pass
 * their conditional requests for `/llms.txt` match and go out once. Requests that differ
 * (one conditional, one not) are separate.
 */
export interface OriginFetchSession {
  readonly origin: string;
  /** The paced, coalesced fetch. It has no window control; use the session's `startWindow`. */
  readonly fetch: PacedFetch;
  /** Open a new pacing window: refill the request budget and restart the deadline. */
  startWindow(): void;
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
  return {
    origin,
    fetch: withoutWindowControl(paced, createCoalescingFetch),
    startWindow: () => paced.startWindow(),
    stats: () => ({ requests: paced.requests, refused: paced.refused, bytesReceived }),
  };
}
