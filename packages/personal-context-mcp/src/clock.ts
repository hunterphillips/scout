/** Injected time source so tests run on fake time. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
