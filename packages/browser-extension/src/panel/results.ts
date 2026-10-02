// The current visit's recommendation results and the links clicked on them. A port of
// ScoutKit's ResultsModel (native/Scout/Sources/ScoutKit/ResultsModel.swift).
//
// One results state per visit. A `state` frame for a new visit, or one that is not `working`
// (an `idle` for the same visit is how the core says it cleared them), resets it; `working`
// for the current visit starts a job's spinner, and the job it replaces can no longer publish.
// A `results` frame counts only for the running core instance and the visit the latest `state`
// named, and never for a replaced job. Nothing here opens a link on its own: a click sends
// `open_link`, and only that command's ok ack yields a target, checked by links.ts. No href is
// ever in a results frame; the only one the panel sees is in that ack. Pure: no `chrome.*`.

import type { PanelResultItem, PanelResults, PanelStatusState } from "@scout/contracts";
import { type CommandTracker, type PanelCommand, sameRequest } from "./commands.js";
import { checkLink, type LinkRefusal } from "./links.js";

export type CoreStatus = PanelStatusState["status"];
type Reason<S extends PanelResults["status"]> = Extract<PanelResults, { status: S }> extends { reason: infer R } ? R : never;
export type UnavailableReason = Reason<"unavailable">;
export type ErrorReason = Reason<"error">;
export type CancelledReason = Reason<"cancelled">;

export interface ResultsIdentity {
  readonly coreInstanceId: string;
  readonly visitEpoch: number;
  readonly origin: string;
  readonly jobId: string;
}

export type ResultsPhase =
  | { kind: "working"; jobId: string | null }
  | { kind: "ready"; identity: ResultsIdentity; items: PanelResultItem[] }
  | { kind: "empty" }
  | { kind: "unavailable"; reason: UnavailableReason }
  | { kind: "timeout" }
  | { kind: "error"; reason: ErrorReason }
  | { kind: "cancelled"; reason: CancelledReason };

/** What the Results section shows. Each state is distinct; "nothing relevant" is never a failure. */
export type ResultsDisplay =
  | { kind: "none" }
  | { kind: "paused" }
  | { kind: "disconnected" }
  | { kind: "working" }
  | { kind: "ready"; items: PanelResultItem[] }
  | { kind: "empty" }
  | { kind: "unavailable"; reason: UnavailableReason }
  | { kind: "timeout" }
  | { kind: "error"; reason: ErrorReason }
  | { kind: "cancelled"; reason: CancelledReason };

const UNAVAILABLE_TEXT: Record<UnavailableReason, string> = {
  no_time_left: "not enough time was left on this visit",
  agent_unavailable: "Claude is not available",
  busy: "Scout is busy with another request",
};
const ERROR_TEXT: Record<ErrorReason, string> = {
  timeout: "it took too long",
  invalid_output: "the answer was not usable",
  tool_unavailable: "a required tool was unavailable",
  preflight_failed: "the subscription check failed",
  unsupported_configuration: "this setup is not supported",
  agent_failed: "the agent failed",
};
const CANCELLED_TEXT: Record<CancelledReason, string> = {
  superseded: "a newer request replaced this one",
  visit_changed: "you moved on",
  revoked: "access was revoked",
  paused: "Scout was paused",
  shutdown: "Scout is shutting down",
};

/** A few words for the header; null when there is nothing to say. */
export function displaySummary(d: ResultsDisplay): string | null {
  switch (d.kind) {
    case "none":
      return null;
    case "paused":
      return "Paused";
    case "disconnected":
      return "Chrome not connected";
    case "working":
      return "Looking for links…";
    case "ready":
      return d.items.length === 1 ? "1 link" : `${d.items.length} links`;
    case "empty":
      return "Nothing relevant";
    case "unavailable":
      return "Links unavailable";
    case "timeout":
      return "Timed out";
    case "error":
      return "Links failed";
    case "cancelled":
      return "Stopped";
  }
}

/** One sentence for the Results section, also its accessible description. */
export function displayExplanation(d: ResultsDisplay): string {
  switch (d.kind) {
    case "none":
      return "No links for this page yet. Scout looks once you stay on a site Chrome lets it read.";
    case "paused":
      return "Scout is paused. Resume it to get links.";
    case "disconnected":
      return "Scout can't see Chrome right now, so it has no links to show.";
    case "working":
      return "Looking for links on this site…";
    case "ready":
      return d.items.length === 1 ? "1 link for this page." : `${d.items.length} links for this page.`;
    case "empty":
      return "Nothing on this site looks relevant to what you are doing.";
    case "unavailable":
      return `Links are unavailable: ${UNAVAILABLE_TEXT[d.reason]}.`;
    case "timeout":
      return "Scout ran out of time looking for links on this visit.";
    case "error":
      return `Scout couldn't get links: ${ERROR_TEXT[d.reason]}.`;
    case "cancelled":
      return `Scout stopped looking: ${CANCELLED_TEXT[d.reason]}.`;
  }
}

/** A link the core authorized for the user's click and links.ts passed: the panel opens it once. */
export interface LinkOpenRequest {
  readonly commandId: string;
  readonly href: string;
  /** The origin of the result the user clicked. */
  readonly origin: string;
}

export interface LinkRefusalRecord {
  readonly commandId: string;
  readonly refusal: LinkRefusal;
}

export class ResultsModel {
  static readonly linkRefusalsMax = 8;

  phase: ResultsPhase | null = null;
  /** The visit the latest `state` frame named. */
  visitEpoch: number | null = null;
  private superseded = new Set<string>();
  private resultJob: string | null = null;
  /** The origin of the result each pending `open_link` was clicked on. */
  private linkOrigins = new Map<string, string>();
  private linksToOpen: LinkOpenRequest[] = [];
  /** Newest last. */
  linkRefusals: LinkRefusalRecord[] = [];

  applyState(status: CoreStatus, epoch: number | null, jobId: string | null): void {
    if (epoch !== this.visitEpoch) this.superseded = new Set();
    this.visitEpoch = epoch;
    if (status !== "working" || epoch === null) {
      this.phase = null;
      return;
    }
    const running = this.currentJobId;
    if (running !== null && running !== jobId) this.superseded.add(running);
    this.phase = { kind: "working", jobId };
  }

  applyResults(frame: PanelResults, coreInstanceId: string | null, core: CoreStatus | null): void {
    if (coreInstanceId === null || frame.coreInstanceId !== coreInstanceId) return;
    if (core !== "idle" && core !== "working") return;
    if (this.visitEpoch === null || frame.visitEpoch !== this.visitEpoch || this.superseded.has(frame.jobId)) return;
    if (this.phase?.kind === "working" && this.phase.jobId !== null && this.phase.jobId !== frame.jobId) return;
    const shown = this.currentJobId;
    if (shown !== null && shown !== frame.jobId) this.superseded.add(shown);
    const identity: ResultsIdentity = { coreInstanceId: frame.coreInstanceId, visitEpoch: frame.visitEpoch, origin: frame.origin, jobId: frame.jobId };
    switch (frame.status) {
      case "ok":
        this.phase = { kind: "ready", identity, items: frame.items };
        break;
      case "empty":
        this.phase = { kind: "empty" };
        break;
      case "unavailable":
        this.phase = { kind: "unavailable", reason: frame.reason };
        break;
      case "error":
        this.phase = frame.reason === "timeout" ? { kind: "timeout" } : { kind: "error", reason: frame.reason };
        break;
      case "cancelled":
        this.phase = { kind: "cancelled", reason: frame.reason };
        break;
    }
    this.resultJob = frame.jobId;
  }

  private get currentJobId(): string | null {
    if (this.phase === null) return null;
    if (this.phase.kind === "working") return this.phase.jobId;
    return this.resultJob;
  }

  /** Drops the results (a core restart). Pending clicks and refusals stay. */
  reset(): void {
    this.phase = null;
    this.resultJob = null;
    this.superseded = new Set();
  }

  /** The core is not reachable: drops the results and the visit. */
  coreStopped(): void {
    this.reset();
    this.visitEpoch = null;
  }

  display(core: CoreStatus | null): ResultsDisplay {
    if (core === "paused") return { kind: "paused" };
    if (core === "disconnected") return { kind: "disconnected" };
    const p = this.phase;
    if (p === null) return { kind: "none" };
    switch (p.kind) {
      case "working":
        return { kind: "working" };
      case "ready":
        return { kind: "ready", items: p.items };
      default:
        return p;
    }
  }

  /**
   * The user clicked a shown result: ask the core for its target with the identity shown. The
   * click is remembered by command, so a late ok ack after the user navigated still opens it.
   */
  openResult(candidateId: string, commands: CommandTracker): PanelCommand | null {
    const p = this.phase;
    if (p?.kind !== "ready" || !p.items.some((i) => i.candidateId === candidateId)) return null;
    if (this.linkRecord(candidateId, commands)?.state === "pending") return null;
    const id = p.identity;
    const command = commands.issue({ type: "open_link", coreInstanceId: id.coreInstanceId, visitEpoch: id.visitEpoch, jobId: id.jobId, candidateId });
    this.linkOrigins.set(command.commandId, id.origin);
    for (const k of [...this.linkOrigins.keys()]) if (!commands.record(k)) this.linkOrigins.delete(k);
    return command;
  }

  /** The newest click on `candidateId` of the results shown. */
  linkRecord(candidateId: string, commands: CommandTracker) {
    const p = this.phase;
    if (p?.kind !== "ready") return undefined;
    const want = { type: "open_link" as const, coreInstanceId: p.identity.coreInstanceId, visitEpoch: p.identity.visitEpoch, jobId: p.identity.jobId, candidateId };
    return commands.latest((r) => sameRequest(r, want));
  }

  /** An ok ack for `open_link` `commandId`: only the one that settled a pending click counts, once. */
  linkAcked(commandId: string, target: string | undefined, wasPending: boolean): void {
    if (!wasPending) return;
    const origin = this.linkOrigins.get(commandId);
    if (origin === undefined) return;
    this.linkOrigins.delete(commandId);
    if (target === undefined) {
      this.linkRefused(commandId, "malformed");
      return;
    }
    const check = checkLink(target, origin);
    if (check.ok) this.linksToOpen.push({ commandId, href: check.url, origin });
    else this.linkRefused(commandId, check.refusal);
  }

  /** Links to open now, each once. */
  takeLinksToOpen(): LinkOpenRequest[] {
    const out = this.linksToOpen;
    this.linksToOpen = [];
    return out;
  }

  linkRefused(commandId: string, refusal: LinkRefusal): void {
    this.linkRefusals.push({ commandId, refusal });
    if (this.linkRefusals.length > ResultsModel.linkRefusalsMax) this.linkRefusals.splice(0, this.linkRefusals.length - ResultsModel.linkRefusalsMax);
  }

  dismissLink(commandId: string): void {
    this.linkRefusals = this.linkRefusals.filter((r) => r.commandId !== commandId);
  }
}
