// How an agent job ends, and the one place a job's stop decision is kept.
//
// A stop comes from outside the CLI (cancel signal, deadline, adapter shutdown) or from the
// job's own checks (a failed init check, an unexpected tool, too much output). The first
// decision wins. A result event that arrived before any stop stands: later decisions still
// terminate the CLI but no longer change the outcome. Once the CLI has exited and its
// output is being mapped, outside stops change nothing; the job's own checks still apply to
// the last buffered line.

import type { AgentPick, JOB_ERROR_REASONS } from "@scout/contracts";
import type { JobCancelReason, JobTermination } from "./adapter.js";

export type Ending =
  | { status: "ok"; items: AgentPick[] }
  | { status: "empty" }
  | { status: "cancelled"; reason: JobCancelReason }
  | { status: "unavailable"; reason: "agent_unavailable" | "busy" | "no_time_left" }
  | { status: "error"; reason: (typeof JOB_ERROR_REASONS)[number] };

/** How a job ends, with its local termination code. */
export interface Out {
  result: Ending;
  termination: JobTermination;
  detail?: string;
}

export class JobStop {
  private decided: Out | undefined;
  private resultSeen = false;
  private sealed = false;
  private onStop: (() => void) | undefined;

  /** The stop that decides the outcome, if any. */
  get decision(): Out | undefined {
    return this.decided;
  }

  /** Cancel, timeout or shutdown. Ignored once sealed. */
  external(s: Out): void {
    if (!this.sealed) this.halt(s);
  }

  /** A stop from the job's own checks. */
  halt(s: Out): void {
    if (this.decided === undefined && !this.resultSeen) this.decided = s;
    this.onStop?.();
  }

  /** A result event arrived; a later stop no longer replaces it. */
  resultArrived(): void {
    this.resultSeen = true;
  }

  /** Called on every stop once the CLI is running (to terminate it). */
  onHalt(fn: () => void): void {
    this.onStop = fn;
  }

  /** The CLI exited: outside stops no longer count. */
  seal(): void {
    this.sealed = true;
  }
}
