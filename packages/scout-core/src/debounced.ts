// Coalesce bursts of change notifications into one run: the first `schedule()` arms a timer,
// later ones before it fires are absorbed, so a run happens at most `delayMs` after the first
// change. Used for the frames the core re-sends whole to the native app on every change.

import { systemTimers, type Timers } from "./clock.js";

export interface Debounced {
  /** Run `fn` once, `delayMs` after the first call since the last run. */
  schedule(): void;
  /** Run `fn` now, dropping any pending run. */
  flush(): void;
  /** Drop any pending run; `schedule` keeps working afterwards. */
  cancel(): void;
}

export function createDebounced(fn: () => void, delayMs: number, timers: Timers = systemTimers): Debounced {
  let handle: unknown = null;
  const cancel = (): void => {
    if (handle === null) return;
    timers.clearTimeout(handle);
    handle = null;
  };
  return {
    schedule() {
      if (handle !== null) return;
      handle = timers.setTimeout(() => {
        handle = null;
        fn();
      }, delayMs);
    },
    flush() {
      cancel();
      fn();
    },
    cancel,
  };
}
