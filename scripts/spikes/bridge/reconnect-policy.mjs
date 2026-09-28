// Scout Phase 0 bridge spike: bounded reconnect schedule.
//
// Shared by the native host (socket reconnects) and the extension (native
// port reconnects). Delays 1, 2, 4, 8, 16, 30 s, then nothing: the caller
// waits for an explicit trigger (tab/focus event or manual Reconnect) and
// calls reset(). No infinite retry loop. No imports, so the extension can load
// this file unchanged.

export const RECONNECT_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000, 16000, 30000]);

export function createBackoff({ delays = RECONNECT_DELAYS_MS, scale = 1 } = {}) {
  let attempt = 0;
  return {
    /** Delay before the next attempt, or null once the schedule is spent. */
    next() {
      if (attempt >= delays.length) return null;
      return Math.round(delays[attempt++] * scale);
    },
    get attempts() {
      return attempt;
    },
    get exhausted() {
      return attempt >= delays.length;
    },
    reset() {
      attempt = 0;
    },
  };
}
