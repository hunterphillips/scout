// Command IDs for the side panel's window commands, and each command's way to its ack.
// A port of ScoutKit's CommandTracker; the rules are the same, with two browser differences:
// - IDs are `sp-` plus 128 random bits (never a counter), so they can never collide with the
//   Mac app's IDs or with another panel's, and a reopened panel never reuses one.
// - An `open_link` the worker could not hand to a ready port fails at once as `unavailable`
//   (Dismiss only): a click is never re-sent later, when the user may no longer want it.
//
// A command is `pending` from the moment it is issued until an ack (or, for `preview`, its
// chunk) arrives. A write the worker refused for now leaves it pending and unsent; it is sent
// again under the same ID. A line too long for one atomic write fails at once as `invalid`.
// When the core restarts (or the link to it is re-established), only pending decisions
// (approve, decline, revoke) are re-sent with the same ID; pending toggles, refreshes and clicks
// become `unknown`; pending previews fail as `unavailable`. A retry never draws a new ID.
//
// A written command the core never answers (it was sent on a connection the core has since
// replaced, or the core is wedged) expires after PENDING_TIMEOUT_MS: decisions and refreshes
// fail as `unavailable` (Retry re-sends the same ID), a click fails the same way (Dismiss
// only), toggles settle `unknown` (the next frame shows what took effect), previews fail.
// Pure: no `chrome.*`.

import type { AckFailureCode, PanelAck, RelayCommand } from "@scout/contracts";

/** A window command that carries a `commandId`, as sent. */
export type PanelCommand = Extract<RelayCommand, { commandId: string }>;
type Omit2<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A window command before it has an ID. */
export type PanelRequest = Omit2<PanelCommand, "commandId">;

export type CommandState = "pending" | "ok" | "failed" | "unknown" | "superseded";
/** `oversize`: the line is too long; `invalid`: not a relay command. Both fail as `invalid`, for good. */
export type SendOutcome = "written" | "retryLater" | "oversize" | "invalid";

export interface CommandRecord {
  readonly id: string;
  readonly request: PanelRequest;
  state: CommandState;
  /** Set while `state` is `failed`. */
  code?: AckFailureCode;
  /** False until a write of this command went through. */
  sent: boolean;
  /** When the last write went through (ms), for the pending timeout. */
  sentAt?: number;
}

/** How long a written command may wait for its ack (or chunk). */
export const PENDING_TIMEOUT_MS = 10_000;

/** `NATIVE_COMMAND_MAX_BYTES` in @scout/contracts panel.ts (a test pins it; no zod in this bundle). */
export const COMMAND_MAX_BYTES = 512;

export const isMutation = (r: PanelRequest): boolean => r.type !== "preview";
export const isDecision = (r: PanelRequest): boolean => r.type === "approve" || r.type === "decline" || r.type === "revoke";
/** Settings: a pending one settles `unknown` rather than being re-sent or retried (the next frame shows what took effect). `set_agent` is a set, handled the same way. */
export const isToggle = (r: PanelRequest): boolean => r.type === "set_auto_acquire" || r.type === "set_agent_browser_context" || r.type === "set_destination" || r.type === "set_agent";
/** Decisions and refreshes may be retried under their ID; previews, toggles and clicks never. */
export const isRetryableRequest = (r: PanelRequest): boolean => isDecision(r) || r.type === "refresh_capabilities";
export const isRetryableCode = (c: AckFailureCode): boolean => c === "unavailable" || c === "store_error";

export const commandOf = (r: CommandRecord): PanelCommand => ({ ...r.request, commandId: r.id }) as PanelCommand;

/** The JSONL line the native app would get, newline included: under COMMAND_MAX_BYTES or never sent. */
export function commandLineBytes(c: PanelCommand): number {
  return new TextEncoder().encode(`${JSON.stringify(c)}\n`).length;
}

/** `sp-` + 128 bits from crypto.getRandomValues, base64url (22 characters). */
export function randomCommandId(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return `sp-${btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** The same request, field for field (key order ignored). */
export function sameRequest(a: PanelRequest, b: PanelRequest): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join() !== kb.join()) return false;
  return ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

export class CommandTracker {
  static readonly capacity = 64;
  /** Oldest first. */
  readonly records: CommandRecord[] = [];

  constructor(private readonly newId: () => string = randomCommandId) {}

  /** Records a new pending command and returns it to send. */
  issue(request: PanelRequest): PanelCommand {
    const record: CommandRecord = { id: this.newId(), request, state: "pending", sent: false };
    this.records.push(record);
    this.trim();
    return commandOf(record);
  }

  record(id: string): CommandRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  /** The newest command matching `predicate`. */
  latest(predicate: (r: PanelRequest) => boolean): CommandRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) if (predicate(this.records[i]!.request)) return this.records[i];
    return undefined;
  }

  /** What became of a write of `id` (`now` in ms, for the pending timeout). */
  markSent(id: string, outcome: SendOutcome, now = 0): void {
    const r = this.record(id);
    if (!r || r.state !== "pending") return;
    if (outcome === "written") {
      r.sent = true;
      r.sentAt = now;
    }
    else if (outcome === "oversize" || outcome === "invalid") this.fail(r, "invalid");
    else if (r.request.type === "open_link") this.fail(r, "unavailable"); // never re-sent later
  }

  /** Applies an ack. Repeated identical acks change nothing; an unknown ID is ignored. */
  apply(ack: PanelAck): CommandRecord | undefined {
    const r = this.record(ack.commandId);
    if (!r) return undefined;
    r.sent = true;
    if (ack.ok) {
      r.state = "ok";
      delete r.code;
    } else this.fail(r, ack.code);
    return r;
  }

  /** A preview chunk answered `id`: settles only a pending `preview`. */
  chunkArrived(id: string): void {
    const r = this.record(id);
    if (!r || r.request.type !== "preview" || r.state !== "pending") return;
    r.sent = true;
    r.state = "ok";
  }

  /** The window no longer waits for preview `id`. */
  supersede(id: string): void {
    const r = this.record(id);
    if (!r || r.request.type !== "preview" || r.state !== "pending") return;
    r.state = "superseded";
  }

  /** Pending commands whose write was refused, to send again with the same ID. */
  get unsent(): PanelCommand[] {
    return this.records.filter((r) => r.state === "pending" && !r.sent).map(commandOf);
  }

  /** A fresh core: re-send pending decisions; settle toggles, refreshes and clicks `unknown`; fail previews. */
  coreRestarted(): PanelCommand[] {
    const resend: PanelCommand[] = [];
    for (const r of this.records) {
      if (r.state !== "pending") continue;
      if (isDecision(r.request)) {
        r.sent = false;
        resend.push(commandOf(r));
      } else if (isMutation(r.request)) r.state = "unknown";
      else this.fail(r, "unavailable");
    }
    return resend;
  }

  /** Written commands with no answer after PENDING_TIMEOUT_MS: settles them and returns them. */
  expire(now: number): CommandRecord[] {
    const out: CommandRecord[] = [];
    for (const r of this.records) {
      if (r.state !== "pending" || !r.sent || r.sentAt === undefined || now - r.sentAt < PENDING_TIMEOUT_MS) continue;
      if (isToggle(r.request)) r.state = "unknown";
      else this.fail(r, "unavailable");
      out.push(r);
    }
    return out;
  }

  /** Settles `id` as ok: a refusal the latest frame shows was moot. */
  settle(id: string): void {
    const r = this.record(id);
    if (!r) return;
    r.state = "ok";
    delete r.code;
  }

  canRetry(id: string): boolean {
    const r = this.record(id);
    if (!r || !isRetryableRequest(r.request)) return false;
    if (r.state === "failed") return r.code !== undefined && isRetryableCode(r.code);
    if (r.state === "pending") return !r.sent;
    return false;
  }

  /** Re-sends a decision or refresh that failed for a passing reason, or whose write was refused, with its own ID. */
  retry(id: string): PanelCommand | undefined {
    if (!this.canRetry(id)) return undefined;
    const r = this.record(id)!;
    if (r.state === "failed") {
      r.state = "pending";
      delete r.code;
      r.sent = false;
    }
    return commandOf(r);
  }

  private fail(r: CommandRecord, code: AckFailureCode): void {
    r.state = "failed";
    r.code = code;
  }

  /** Drops the oldest settled commands first, then the oldest of any kind. */
  private trim(): void {
    while (this.records.length > CommandTracker.capacity) {
      const i = this.records.findIndex((r) => r.state !== "pending");
      this.records.splice(i >= 0 ? i : 0, 1);
    }
  }
}
