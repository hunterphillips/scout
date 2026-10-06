// The dwell scheduler: automatic discovery starts only after a permitted foreground
// visit has stayed the same for DWELL_MS. One timer at a time. The coordinator arms it
// on every visit change that has a visit and cancels it (with a reason) on pause,
// navigation, the visit ending, another app coming to the front (`visit_suspended`; armed
// again in full on the return), permission loss, sensor disconnect, and shutdown. Timers are injected so tests run it on a fake clock.

import type { ActiveVisit } from "@scout/contracts";
import { systemTimers, type Timers } from "./clock.js";
import type { Diagnostics } from "./diagnostics.js";

/** How long a visit must stay unchanged before it counts as settled. */
export const DWELL_MS = 3000;

export type DwellCancelReason =
  | "visit_changed"
  | "visit_ended"
  | "visit_suspended"
  | "paused"
  | "permission_lost"
  | "disconnected"
  | "stopped";

export interface DwellSchedulerOptions {
  /** Called once per armed visit, when its dwell completes. A throw is caught and logged. */
  onSettled: (visit: ActiveVisit) => void;
  timers?: Timers;
  diagnostics?: Diagnostics;
  dwellMs?: number;
}

export interface DwellScheduler {
  /**
   * Start the dwell for `visit`. Re-arming the visit already armed does nothing; arming a
   * different visit cancels the current one as `visit_changed`. Ignored after `stop()`.
   */
  arm(visit: ActiveVisit): void;
  /** Cancel the armed dwell, if any. */
  cancel(reason: DwellCancelReason): void;
  /** Cancel and refuse further arms. Idempotent. */
  stop(): void;
  /** The epoch of the armed visit, or null. */
  readonly armedEpoch: number | null;
}

export function createDwellScheduler(options: DwellSchedulerOptions): DwellScheduler {
  const timers = options.timers ?? systemTimers;
  const dwellMs = options.dwellMs ?? DWELL_MS;
  const { diagnostics } = options;
  let armed: { visit: ActiveVisit; handle: unknown } | null = null;
  let stopped = false;

  const cancel = (reason: DwellCancelReason): void => {
    if (armed === null) return;
    timers.clearTimeout(armed.handle);
    diagnostics?.event("dwell_cancelled", { epoch: armed.visit.epoch, reason });
    armed = null;
  };

  return {
    get armedEpoch() {
      return armed?.visit.epoch ?? null;
    },
    arm(visit) {
      if (stopped) return;
      if (armed !== null && armed.visit.epoch === visit.epoch) return;
      cancel("visit_changed");
      const entry: { visit: ActiveVisit; handle: unknown } = { visit, handle: null };
      entry.handle = timers.setTimeout(() => {
        if (armed !== entry) return;
        armed = null;
        diagnostics?.event("dwell_settled", { epoch: visit.epoch });
        try {
          options.onSettled(visit);
        } catch {
          diagnostics?.event("dwell_settled_handler_error", { epoch: visit.epoch });
        }
      }, dwellMs);
      armed = entry;
    },
    cancel,
    stop() {
      if (stopped) return;
      cancel("stopped");
      stopped = true;
    },
  };
}
