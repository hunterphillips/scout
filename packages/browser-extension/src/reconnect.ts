// Bounded reconnect policy for the native port (pure; clock and store injected).
//
// A series is one run of the schedule: after a disconnect the policy waits
// 1, 2, 4, 8, 16, 30 s between attempts, then stops ("exhausted"). Nothing
// retries on its own after that. The next tab or focus event (`trigger`)
// starts one fresh series, but at most one series starts per 60 s. The
// popup's Reconnect (`manual`) starts one at once. A disconnect after a
// healthy connection starts a fresh series only under the same 60 s limit;
// otherwise it continues the current schedule. So there is never an
// unbounded loop: at most 7 attempts per series, one series per 60 s.
//
// MV3 kills an idle service worker after ~30 s, so the series state lives in
// the injected store (chrome.storage.session in production) and survives
// worker restarts. `start()` reads it: a retry that was pending when the
// worker died is resumed at its step; otherwise a connection is made only if
// the 60 s rule allows a new series. Retries use setTimeout, not
// chrome.alarms (Phase 1): the 30 s step can race idle termination, but the
// persisted state means the next wake resumes the same series correctly.

export const RECONNECT_DELAYS_MS: readonly number[] = Object.freeze([1000, 2000, 4000, 8000, 16000, 30000]);
export const SERIES_MIN_INTERVAL_MS = 60_000;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** What survives a worker restart. */
export interface SeriesState {
  seriesStartedAt: number;
  /** Delays consumed so far in this series. */
  step: number;
  exhausted: boolean;
  /** When the pending retry is due; null when none is scheduled. */
  retryAt: number | null;
}

export interface SeriesStore {
  load(): Promise<SeriesState | undefined>;
  save(s: SeriesState): void;
}

export interface ReconnectPolicy {
  /** Worker startup: resume a persisted series, or connect if the 60 s rule allows. */
  start(): Promise<void>;
  /** The port went away. `healthy` = the host had reported ready (or acked). */
  disconnected(healthy: boolean): void;
  /** A tab or focus event. Starts a series only when idle and the 60 s limit allows. */
  trigger(): boolean;
  /** The popup's Reconnect: starts a series at once. */
  manual(): void;
  /** A retry is scheduled. */
  readonly pending: boolean;
  /** The schedule is spent (or nothing is in flight after a restart) and nothing is scheduled. */
  readonly exhausted: boolean;
  readonly seriesStarted: number;
  readonly attempts: number;
  readonly step: number;
}

export function createReconnectPolicy(opts: {
  clock: Clock;
  attempt: () => void;
  store?: SeriesStore;
  delays?: readonly number[];
  seriesMinIntervalMs?: number;
}): ReconnectPolicy {
  const { clock, attempt } = opts;
  const delays = opts.delays ?? RECONNECT_DELAYS_MS;
  const minInterval = opts.seriesMinIntervalMs ?? SERIES_MIN_INTERVAL_MS;
  let step = 0;
  let timer: unknown = null;
  let retryAt: number | null = null;
  /** False until start() has read the store: events before that start nothing. */
  let loaded = false;
  let exhausted = false;
  let seriesStartedAt = Number.NEGATIVE_INFINITY;
  let seriesStarted = 0;
  let attempts = 0;

  const save = () => {
    if (!Number.isFinite(seriesStartedAt)) return;
    try {
      opts.store?.save({ seriesStartedAt, step, exhausted, retryAt });
    } catch {
      // storage unavailable: the in-memory bound still holds for this worker
    }
  };
  const clear = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    retryAt = null;
  };
  const fire = () => {
    attempts++;
    save();
    attempt();
  };
  const schedule = (ms: number) => {
    retryAt = clock.now() + ms;
    timer = clock.setTimeout(() => {
      timer = null;
      retryAt = null;
      fire();
    }, ms);
    save();
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
    async start() {
      let s: SeriesState | undefined;
      try {
        s = await opts.store?.load();
      } catch {
        s = undefined;
      }
      loaded = true;
      if (timer !== null || seriesStarted > 0) return; // a manual Reconnect beat us to it
      if (s && Number.isFinite(s.seriesStartedAt)) {
        seriesStartedAt = s.seriesStartedAt;
        step = Math.max(0, Math.min(delays.length, Math.floor(s.step)));
        if (s.retryAt !== null && !s.exhausted) {
          // The worker died with a retry pending: resume the same step.
          exhausted = false;
          schedule(Math.max(0, s.retryAt - clock.now()));
          return;
        }
        if (!seriesAllowed()) {
          // Idle until an event or Reconnect that the 60 s rule allows.
          exhausted = true;
          save();
          return;
        }
      }
      newSeries();
      fire();
    },
    disconnected(healthy) {
      clear();
      if (healthy && seriesAllowed()) newSeries();
      const d = delays[step];
      if (d === undefined) {
        exhausted = true;
        save();
        return;
      }
      step++;
      schedule(d);
    },
    trigger() {
      if (!loaded || !exhausted || timer !== null || !seriesAllowed()) return false;
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
    get step() {
      return step;
    },
  };
}
