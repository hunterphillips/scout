/** Injected time source so tests run on fake time. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Injected one-shot timers so tests can run scheduled work on a fake clock. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The global timers, unref'd so a pending one never keeps the process alive. */
export const systemTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
