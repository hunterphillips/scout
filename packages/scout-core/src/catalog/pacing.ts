import type { Clock } from "../clock.js";
import { DEFAULT_TIMEOUT_MS, type GuardedFetchOptions, type GuardedFetchResult, guardedFetch } from "../fetch/guardedFetch.js";
import type { CatalogFetch, CatalogFetchOptions } from "./catalogFetch.js";

/**
 * Most requests one paced fetch makes. A discovery run needs at most 62 (robots, 6
 * `llms.txt` files, 55 sitemap files) and a cache revalidation pass at most as many
 * again, so 128 is a safety net against a bug or a hostile site, not a normal limit.
 * This budget is Scout's own addition; the plan does not specify one.
 */
export const MAX_REQUESTS_PER_RUN = 128;

/**
 * Longest one paced fetch keeps making requests, measured from its first request. With
 * the 10 s crawl-delay ceiling and 8 s timeouts, the request budget alone could stretch a
 * run past half an hour; after this deadline further requests are refused like budget
 * overruns. Scout's own addition, like the budget.
 */
export const RUN_DEADLINE_MS = 90_000;

export type Sleep = (ms: number) => Promise<void>;

export interface PacedCatalogFetch extends CatalogFetch {
  /** Minimum gap between the end of one request and the start of the next (robots `Crawl-delay`). */
  setCrawlDelay(ms: number | undefined): void;
  /** Requests refused because the budget was spent, the run deadline passed, or the URL left the origin. */
  readonly refused: number;
}

export interface PacedCatalogFetchOptions {
  /** `https://host[:port]`; requests to any other origin are refused without a network call. */
  origin: string;
  clock: Clock;
  /** Injected for tests; defaults to the real `guardedFetch`. */
  guardedFetch?: (url: string, options: GuardedFetchOptions) => Promise<GuardedFetchResult>;
  /** Injected for tests; defaults to `setTimeout`. */
  sleep?: Sleep;
  maxRequests?: number;
  /** Defaults to `RUN_DEADLINE_MS`. */
  runDeadlineMs?: number;
}

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bind `guardedFetch` for one origin's catalog run.
 *
 * Policy: requests run one at a time, in call order. Once a crawl delay is set, each
 * request starts at least that long after the previous one finished; nothing waits
 * before the first request (robots.txt, which is where the delay comes from). Only the
 * named options are forwarded to `guardedFetch`, with its default 8 s timeout. Requests
 * beyond `maxRequests`, after the run deadline (counted from the first request), or to
 * another origin return a `policy` error without touching the network.
 */
export function createPacedCatalogFetch(options: PacedCatalogFetchOptions): PacedCatalogFetch {
  const doFetch = options.guardedFetch ?? guardedFetch;
  const sleep = options.sleep ?? realSleep;
  const maxRequests = options.maxRequests ?? MAX_REQUESTS_PER_RUN;
  const runDeadlineMs = options.runDeadlineMs ?? RUN_DEADLINE_MS;
  const origin = new URL(options.origin).origin;
  let crawlDelayMs = 0;
  let lastEndedAt: number | null = null;
  let made = 0;
  let startedAt: number | null = null;
  let refused = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const run = async (url: string, opts: CatalogFetchOptions): Promise<GuardedFetchResult> => {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url).origin === origin;
    } catch {
      // Unparseable: refused below.
    }
    startedAt ??= options.clock.now();
    const pastDeadline = () => options.clock.now() - (startedAt ?? 0) >= runDeadlineMs;
    const refuse = (message: string): GuardedFetchResult => {
      refused += 1;
      return { kind: "error", reason: "policy", message };
    };
    if (!sameOrigin) return refuse("catalog request left the origin");
    if (made >= maxRequests) return refuse("catalog request budget spent");
    if (pastDeadline()) return refuse("catalog run deadline passed");
    if (lastEndedAt !== null && crawlDelayMs > 0) {
      const wait = lastEndedAt + crawlDelayMs - options.clock.now();
      if (wait > 0) await sleep(wait);
      if (pastDeadline()) return refuse("catalog run deadline passed");
    }
    made += 1;
    const guarded: GuardedFetchOptions = { timeoutMs: DEFAULT_TIMEOUT_MS };
    if (opts.maxBytes !== undefined) guarded.maxBytes = opts.maxBytes;
    if (opts.accept !== undefined) guarded.accept = opts.accept;
    if (opts.ifNoneMatch !== undefined) guarded.ifNoneMatch = opts.ifNoneMatch;
    if (opts.ifModifiedSince !== undefined) guarded.ifModifiedSince = opts.ifModifiedSince;
    try {
      return await doFetch(url, guarded);
    } finally {
      lastEndedAt = options.clock.now();
    }
  };

  const fetch = ((url: string, opts: CatalogFetchOptions = {}) => {
    const result = queue.then(() => run(url, opts));
    queue = result.catch(() => undefined);
    return result;
  }) as PacedCatalogFetch;
  fetch.setCrawlDelay = (ms) => {
    crawlDelayMs = ms !== undefined && ms > 0 ? ms : 0;
  };
  Object.defineProperty(fetch, "refused", { get: () => refused });
  return fetch;
}
