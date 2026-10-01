import type { Clock } from "../clock.js";
import { DEFAULT_TIMEOUT_MS, type GuardedFetchOptions, type GuardedFetchResult, guardedFetch } from "../fetch/guardedFetch.js";
import type { CatalogFetch, CatalogFetchOptions } from "./catalogFetch.js";

/**
 * Most requests one run window makes. A discovery run needs at most 62 (robots, 6
 * `llms.txt` files, 55 sitemap files) and a cache revalidation pass at most as many, each
 * in its own window, so 128 is a safety net against a bug or a hostile site, not a normal
 * limit. This budget is Scout's own addition; the plan does not specify one.
 */
export const MAX_REQUESTS_PER_RUN = 128;

/**
 * Longest one run window keeps making requests, measured from its first request. With
 * the 10 s crawl-delay ceiling and 8 s timeouts, the request budget alone could stretch a
 * run past half an hour; after this deadline further requests are refused like budget
 * overruns. Scout's own addition, like the budget.
 */
export const RUN_DEADLINE_MS = 90_000;

export type Sleep = (ms: number) => Promise<void>;

/** A paced fetch as seen by a caller that runs inside a window someone else controls. */
export interface PacedFetch extends CatalogFetch {
  /** Minimum gap between the end of one request and the start of the next (robots `Crawl-delay`). */
  setCrawlDelay(ms: number | undefined): void;
  /** Requests refused because the budget was spent, the run deadline passed, the URL left the origin, or the run was cancelled. Counts across windows. */
  readonly refused: number;
  /** Requests that reached `guardedFetch`, across windows. */
  readonly requests: number;
}

export interface PacedCatalogFetch extends PacedFetch {
  /**
   * Start a new run window: the deadline restarts from the next request and the request
   * budget is refilled. The crawl delay and the end time of the last request are kept, so
   * the next request still waits out the delay. The cache opens one window for
   * revalidation and another for rediscovery.
   */
  startWindow(): void;
  /**
   * Refuse every request from now on, in every window. A request already at the network
   * finishes; queued ones and any made later get a refusal (`isRefusal`), as for a spent
   * budget. Irreversible.
   */
  cancel(): void;
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

/** Results a paced fetch refused without touching the network. */
const refusals = new WeakSet<GuardedFetchResult>();

/**
 * Whether `result` is a paced-fetch refusal (budget, deadline, or origin) rather than an
 * answer from the site. A refusal says nothing about the resource, so callers must not
 * record it as the resource's state.
 */
export function isRefusal(result: GuardedFetchResult): boolean {
  return refusals.has(result);
}

/**
 * Bind `guardedFetch` for one origin's catalog run.
 *
 * Policy: requests run one at a time, in call order. Once a crawl delay is set, each
 * request starts at least that long after the previous one finished; nothing waits
 * before the first request (robots.txt, which is where the delay comes from). Only the
 * named options are forwarded to `guardedFetch`, with its default 8 s timeout. Requests
 * beyond `maxRequests`, after the run deadline (counted from the first request), or to
 * another origin return a `policy` error without touching the network; `isRefusal` tells
 * those apart from the site's own answers. `startWindow` restarts the deadline and the
 * budget without dropping the crawl delay. After `cancel` every request is refused the
 * same way.
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
  let requests = 0;
  let cancelled = false;
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
      const result: GuardedFetchResult = { kind: "error", reason: "policy", message };
      refusals.add(result);
      return result;
    };
    if (cancelled) return refuse("catalog run cancelled");
    if (!sameOrigin) return refuse("catalog request left the origin");
    if (made >= maxRequests) return refuse("catalog request budget spent");
    if (pastDeadline()) return refuse("catalog run deadline passed");
    if (lastEndedAt !== null && crawlDelayMs > 0) {
      const wait = lastEndedAt + crawlDelayMs - options.clock.now();
      if (wait > 0) await sleep(wait);
      if (cancelled) return refuse("catalog run cancelled");
      if (pastDeadline()) return refuse("catalog run deadline passed");
    }
    made += 1;
    requests += 1;
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
  fetch.startWindow = () => {
    startedAt = null;
    made = 0;
  };
  fetch.cancel = () => {
    cancelled = true;
  };
  Object.defineProperty(fetch, "refused", { get: () => refused });
  Object.defineProperty(fetch, "requests", { get: () => requests });
  return fetch;
}

/**
 * `paced` without its window control, for callers that share a window someone else owns.
 * Requests go through `wrap(paced)` (coalescing, say); the crawl delay and the counters are
 * `paced`'s own.
 */
export function withoutWindowControl(paced: PacedCatalogFetch, wrap: (fetch: CatalogFetch) => CatalogFetch = (fetch) => fetch): PacedFetch {
  const call = wrap(paced);
  const view = ((url: string, opts?: CatalogFetchOptions) => call(url, opts)) as PacedFetch;
  view.setCrawlDelay = (ms) => paced.setCrawlDelay(ms);
  Object.defineProperty(view, "refused", { get: () => paced.refused });
  Object.defineProperty(view, "requests", { get: () => paced.requests });
  return view;
}
