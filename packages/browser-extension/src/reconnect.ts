// Bounded reconnect policy for the native port (pure; clock injected).
//
// A series is one run of the schedule: after a disconnect the policy waits
// 1, 2, 4, 8, 16, 30 s between attempts, then stops ("exhausted"). Nothing
// retries on its own after that. The next tab or focus event (`trigger`)
// starts one fresh series, but at most one series starts per 60 s. The
// popup's Reconnect (`manual`) starts one at once. A disconnect after a
// healthy connection starts a fresh series only under the same 60 s limit;
// otherwise it continues the current schedule. So there is never an
// unbounded loop: at most 7 attempts per series, one series per 60 s.

export const RECONNECT_DELAYS_MS: readonly number[] = Object.freeze([1000, 2000, 4000, 8000, 16000, 30000]);
export const SERIES_MIN_INTERVAL_MS = 60_000;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ReconnectPolicy {
  /** First connection at startup: starts a series. */
  start(): void;
  /** The port went away. `healthy` = it had been working (acked or up long enough). */
  disconnected(healthy: boolean): void;
  /** A tab or focus event. Starts a series only when idle and the 60 s limit allows. */
  trigger(): boolean;
  /** The popup's Reconnect: starts a series at once. */
  manual(): void;
  /** A retry is scheduled. */
  readonly pending: boolean;
  /** The schedule is spent and nothing is scheduled. */
  readonly exhausted: boolean;
  readonly seriesStarted: number;
  readonly attempts: number;
}

export function createReconnectPolicy(opts: { clock: Clock; attempt: () => void; delays?: readonly number[]; seriesMinIntervalMs?: number }): ReconnectPolicy {
  const { clock, attempt } = opts;
  const delays = opts.delays ?? RECONNECT_DELAYS_MS;
  const minInterval = opts.seriesMinIntervalMs ?? SERIES_MIN_INTERVAL_MS;
  let step = 0;
  let timer: unknown = null;
  let exhausted = false;
  let seriesStartedAt = Number.NEGATIVE_INFINITY;
  let seriesStarted = 0;
  let attempts = 0;

  const clear = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };
  const fire = () => {
    attempts++;
    attempt();
  };
  const newSeries = () => {
    clear();
    step = 0;
    exhausted = false;
    seriesStartedAt = clock.now();
    seriesStarted++;
  };
  const seriesAllowed = () => clock.now() - seriesStartedAt >= minInterval;

  return {
    start() {
      newSeries();
      fire();
    },
    disconnected(healthy) {
      clear();
      if (healthy && seriesAllowed()) newSeries();
      const d = delays[step];
      if (d === undefined) {
        exhausted = true;
        return;
      }
      step++;
      timer = clock.setTimeout(() => {
        timer = null;
        fire();
      }, d);
    },
    trigger() {
      if (!exhausted || timer !== null || !seriesAllowed()) return false;
      newSeries();
      fire();
      return true;
    },
    manual() {
      newSeries();
      fire();
    },
    get pending() {
      return timer !== null;
    },
    get exhausted() {
      return exhausted;
    },
    get seriesStarted() {
      return seriesStarted;
    },
    get attempts() {
      return attempts;
    },
  };
}
