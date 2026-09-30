/** Waits `ms` milliseconds; injected so tests can drive time. */
export type Sleep = (ms: number) => Promise<void>;

export interface AckTracker {
  /** Track one in-flight `observe_activity` send until it settles either way. */
  track(send: Promise<unknown>): void;
  /** Resolves when every send tracked so far has settled, or after `maxMs`, whichever is first. */
  waitForAcks(maxMs: number): Promise<void>;
  readonly pendingCount: number;
}

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The observations a rank must wait for. Policy: a rank waits only for sends that were
 * already in flight when it started; sends tracked during the wait do not extend it, and
 * the wait never exceeds its cap.
 */
export function createAckTracker(options: { sleep?: Sleep } = {}): AckTracker {
  const sleep = options.sleep ?? realSleep;
  const pending = new Set<Promise<unknown>>();

  return {
    get pendingCount() {
      return pending.size;
    },
    track(send) {
      const settled = send.then(
        () => undefined,
        () => undefined,
      );
      pending.add(settled);
      void settled.then(() => pending.delete(settled));
    },
    async waitForAcks(maxMs) {
      if (pending.size === 0) return;
      await Promise.race([Promise.all([...pending]), sleep(maxMs)]);
    },
  };
}
