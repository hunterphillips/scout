// The side panel's one Pause/Resume control. A port of ScoutKit's PauseState (P4.2): the core is
// the one source of truth for pause. A click sends the core's `pause` or `resume`; what shows
// follows the core's `state` frame, so a pause or resume from the Mac menu or window shows here
// too, and the extension's posting follows the core's capture_policy in the worker.
//
// `pause` and `resume` carry no command ID and get no ack, so this holds the one pending
// request: set only when the worker wrote it to a ready port, settled by the first `state`
// frame showing its target (whoever caused it), dropped when the link goes down or another core
// instance answers (never re-sent: it was picked from a possibly stale frame), and dropped after
// PAUSE_PENDING_MS with no frame showing it (the control then shows the core's state again).
// With no core to reach there is nothing to pause: the control is off. Pure: no `chrome.*`.

import type { CoreStatus } from "./results.js";

export const PAUSE_PENDING_MS = 10_000;

export interface PauseControl {
  readonly title: string;
  readonly enabled: boolean;
  readonly label: string;
  /** What a click asks for: true to pause, false to resume. */
  readonly pause: boolean;
}

export class PauseState {
  /** The latest `state` frame's status; null while the core is not reachable or has not reported. */
  core: CoreStatus | null = null;
  pending: "pausing" | "resuming" | null = null;
  private pendingSince = 0;

  apply(status: CoreStatus): void {
    this.core = status;
    if (this.pending === "pausing" && status === "paused") this.pending = null;
    if (this.pending === "resuming" && status !== "paused") this.pending = null;
  }

  coreStopped(): void {
    this.core = null;
    this.pending = null;
  }

  coreRestarted(): void {
    this.pending = null;
  }

  get paused(): boolean {
    return this.core === "paused";
  }

  /** What a click sends given the latest frame: true (pause), false (resume), or null (nothing). */
  get command(): boolean | null {
    switch (this.core) {
      case "paused":
        return false;
      case "idle":
      case "working":
        return true;
      default:
        return null;
    }
  }

  /** The user clicked: the command to send, or null while one is pending or there is no core. */
  request(): boolean | null {
    if (this.pending !== null) return null;
    return this.command;
  }

  /** The worker reports whether it wrote the core command to a ready port. */
  sent(pause: boolean, written: boolean, now = 0): void {
    if (!written) return;
    this.pending = pause ? "pausing" : "resuming";
    this.pendingSince = now;
  }

  /** No frame showed the request's target in PAUSE_PENDING_MS: show the core's state again. */
  expire(now: number): void {
    if (this.pending !== null && now - this.pendingSince >= PAUSE_PENDING_MS) this.pending = null;
  }

  get control(): PauseControl {
    if (this.pending === "pausing") return { title: "Pausing…", enabled: false, label: "Pausing Scout", pause: true };
    if (this.pending === "resuming") return { title: "Resuming…", enabled: false, label: "Resuming Scout", pause: false };
    if (this.core === "paused") return { title: "Resume", enabled: true, label: "Resume Scout", pause: false };
    return { title: "Pause", enabled: this.command !== null, label: "Pause Scout", pause: true };
  }
}
