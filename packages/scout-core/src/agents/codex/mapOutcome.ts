// A finished Codex run as a job outcome. Order: a spawn failure; then any stop decision
// (cancel, timeout, a failed check: a stop always wins over output); then a required user tool
// every call of which errored (tool_unavailable, `required_tool_failed`); then no
// `turn.completed` (auth_or_quota when an error read as one, else agent_failed `no_result`);
// then a non-zero exit after a completed turn (agent_failed `process_error`); then no final
// agent message, or one that is not JSON (invalid_output `no_structured_output`); then the
// answer through normalizeCodexOutput and outcomeFromOutput, as every adapter's is.
// Usage counts are copied from `turn.completed` whatever the outcome.

import type { JobRequest } from "@scout/contracts";
import type { JobDetails } from "../adapter.js";
import type { Out } from "../jobStop.js";
import { isRecord, type StreamRecord } from "../jsonLineStream.js";
import { outcomeFromOutput } from "../outputValidation.js";
import { normalizeCodexOutput } from "./outputSchema.js";

export interface CodexRun {
  spawnError: boolean;
  /** The CLI's exit code; null when it was signalled or never reported one. */
  exitCode: number | null;
  stop: Out | undefined;
  completed: StreamRecord | undefined;
  lastMessage: string | undefined;
  authOrQuota: boolean;
  requiredToolFailed: boolean;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Usage from `turn.completed`, and the turn count the monitor saw. */
export function recordCodexUsage(completed: StreamRecord | undefined, turns: number, details: JobDetails): void {
  const usage = isRecord(completed?.usage) ? completed.usage : {};
  const set = (k: keyof JobDetails["usage"], v: unknown): void => {
    const n = num(v);
    if (n !== undefined) details.usage[k] = n;
  };
  if (turns > 0) details.usage.turns = turns;
  set("inputTokens", usage.input_tokens);
  set("cacheReadTokens", usage.cached_input_tokens);
  set("cacheWriteTokens", usage.cache_write_input_tokens);
  set("outputTokens", usage.output_tokens);
}

export function mapCodexOutcome(run: CodexRun, req: Pick<JobRequest, "candidates" | "maxPicks">, details: JobDetails): Out {
  const noAnswer: Out = { result: { status: "error", reason: "invalid_output" }, termination: "invalid_output", detail: "no_structured_output" };
  if (run.spawnError) return { result: { status: "unavailable", reason: "agent_unavailable" }, termination: "agent_unavailable", detail: "spawn_failed" };
  if (run.stop !== undefined) return run.stop;
  if (run.requiredToolFailed) return { result: { status: "error", reason: "tool_unavailable" }, termination: "tool_unavailable", detail: "required_tool_failed" };
  if (run.completed === undefined) {
    if (run.authOrQuota) return { result: { status: "unavailable", reason: "agent_unavailable" }, termination: "auth_or_quota", detail: "auth_or_quota" };
    return { result: { status: "error", reason: "agent_failed" }, termination: "no_result" };
  }
  if (run.exitCode !== 0) return { result: { status: "error", reason: "agent_failed" }, termination: "process_error" };
  if (run.lastMessage === undefined) return noAnswer;
  let output: unknown;
  try {
    output = JSON.parse(run.lastMessage);
  } catch {
    return noAnswer;
  }
  return outcomeFromOutput(normalizeCodexOutput(output), req, details);
}
