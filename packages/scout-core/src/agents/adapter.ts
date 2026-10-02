// The generic agent-job adapter the core calls (from Phase 3) to get recommendations from
// the user's own agent. One implementation per agent CLI; Claude Code is claudeJob.ts.
//
// An adapter owns launch settings, billing checks, the deadline, cancellation and response
// decoding. It returns a HostJobResult (the fixed contract the rest of Scout sees) plus job
// details for local diagnostics. Nothing an adapter returns is ever `empty` unless the model
// itself answered `empty` and that answer validated.

import { createHash } from "node:crypto";
import { JOB_CANCELLED_REASONS, type HostJobResult, type JobRequest } from "@scout/contracts";
import type { Clock } from "../clock.js";

/**
 * What the job gets from Scout: the core's agent socket and this job's token. The user's
 * selected tools come from the adapter's agent profile (toolPolicy.ts), not from here.
 */
export interface JobToolSurface {
  scout: { socketPath: string; token: string };
}

export interface JobRunOptions {
  toolSurface: JobToolSurface;
  /** Aborting cancels the job; `signal.reason` may be one of JOB_CANCELLED_REASONS. */
  signal?: AbortSignal;
  /** Absolute deadline on `clock`. The job also never runs past `request.deadlineMs`. */
  deadline?: number;
  clock?: Clock;
}

/**
 * How a job ended, finer than HostJobResult's reason codes, for local job details only.
 * None of these except `completed` can produce `ok` or `empty`.
 */
export type JobTermination =
  | "completed"
  | "cancelled"
  | "timeout"
  | "max_turns"
  | "auth_or_quota"
  | "invalid_output"
  | "tool_unavailable"
  | "unsupported_configuration"
  | "preflight_failed"
  | "malformed_startup"
  | "output_too_large"
  | "no_result"
  | "process_error"
  | "no_time_left"
  | "busy"
  | "agent_unavailable";

/** Do not launch inference with less than this left (plan: common limits). */
export const MIN_LAUNCH_MS = 5000;

export interface JobUsage {
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface JobDetails {
  adapter: string;
  termination: JobTermination;
  /** Fixed code naming what failed, e.g. `extra_server` or `hook_ran`. */
  detail?: string;
  /** The CLI version the job's init event reported. */
  cliVersion?: string;
  /** The model the job's init event reported. */
  model?: string;
  /** Tool names the agent called, in order (bounded). Names only, never arguments. */
  toolUses: string[];
  /**
   * Each optional selected tool (full `mcp__<server>__<tool>` name) and whether the job had
   * it: unavailable before launch (its connection could not be prepared) or at startup (it
   * did not load). Missing optional tools are never hidden.
   */
  optionalTools: { server: string; tool: string; status: "available" | "unavailable" }[];
  /** Picks the model returned that failed validation. */
  droppedPicks: number;
  /** Valid picks past the request's maxPicks. */
  cutPicks: number;
  /** Whether a synthetic instruction marker reached the model (compatibility checks only). */
  instructionMarker?: "reached" | "missing";
  /**
   * The init reported another CLI version than the preflight saw. Advisory: the adapter re-ran
   * the billing preflight, and the answer counted only if that verdict was `subscription`.
   */
  cliVersionChanged?: true;
  /** How many tool calls the CLI's permission mode denied (the result event's `permission_denials`). */
  permissionDenials?: number;
  /** Tool calls whose result was an error, by full tool name (names only, bounded). */
  toolErrors: Record<string, number>;
  /** Errored tool results whose call was past the recorded bound (or never seen): counted, not named. */
  unattributedToolErrors?: number;
  /**
   * An optional selected tool was unavailable or returned an error: the answer, if any, rests on
   * Scout's browser context alone. A required tool every call of which failed never yields an
   * answer (streamMonitor.ts).
   */
  optionalToolFailed: boolean;
  timings: { totalMs: number; cliMs?: number; initMs?: number; /** The result event's `duration_api_ms`. */ apiMs?: number };
  usage: JobUsage;
}

export interface JobOutcome {
  result: HostJobResult;
  details: JobDetails;
}

export interface AgentJobAdapter {
  readonly id: string;
  run(request: JobRequest, options: JobRunOptions): Promise<JobOutcome>;
  /** Close the adapter: cancel every running job (reason `shutdown`) and wait for cleanup. A later `run` is `unavailable`. */
  abortAll(): Promise<void>;
}

export type JobCancelReason = (typeof JOB_CANCELLED_REASONS)[number];

/** A signal's reason as a cancel code; anything unrecognized is `shutdown`. */
export function toCancelReason(reason: unknown): JobCancelReason {
  return typeof reason === "string" && (JOB_CANCELLED_REASONS as readonly string[]).includes(reason) ? (reason as JobCancelReason) : "shutdown";
}

/** A request ID as it may appear in logs. */
export function hashRequestId(requestId: string): string {
  return createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 16);
}
