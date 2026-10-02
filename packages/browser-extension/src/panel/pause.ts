// The side panel's one Pause/Resume control. A port of ScoutKit's PauseState (P4.2) plus the
// extension's own pause, which Scout's popup used to hold: one click pauses both the core
// (`pause`/`resume` through the relay) and the extension's posting (the worker's persisted
// `paused` flag), so a paused Scout neither looks for links nor hears about tabs.
//
// What shows follows the core's `state` frame and the extension's flag: paused when either is
// paused. `pause` and `resume` carry no command ID and get no ack, so this holds the one pending
// core request: set only when the worker wrote it to a ready port, settled by the first `state`
// frame showing its target (whoever caused it), dropped when the link goes down or another core
// instance answers (never re-sent: it was picked from a possibly stale frame). With no core to
// reach, a click still pauses or resumes the extension. Pure: no `chrome.*`.

import type { CoreStatus } from "./results.js";

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
  /** The extension's own paused flag, as the worker last reported it. */
  extPaused = false;

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
    return this.core === "paused" || this.extPaused;
  }

  /** The user clicked: true to pause, false to resume, or null while a request is pending. */
  request(): boolean | null {
    if (this.pending !== null) return null;
    return !this.paused;
  }

  /** The worker reports whether it wrote the core command (`pause` true/false) to a ready port. */
  sent(pause: boolean, written: boolean): void {
    if (!written) return;
    const target = pause ? "paused" : "running";
    if ((target === "paused") === (this.core === "paused")) return; // already there
    this.pending = pause ? "pausing" : "resuming";
  }

  get control(): PauseControl {
    if (this.pending === "pausing") return { title: "Pausing…", enabled: false, label: "Pausing Scout", pause: true };
    if (this.pending === "resuming") return { title: "Resuming…", enabled: false, label: "Resuming Scout", pause: false };
    if (this.paused) return { title: "Resume", enabled: true, label: "Resume Scout", pause: false };
    return { title: "Pause", enabled: true, label: "Pause Scout", pause: true };
  }
}
