// A finished CLI run as a job outcome. Order: a spawn failure; then any stop decision
// (cancel, timeout, a failed check: a stop always wins over output); then a required user tool
// every call of which errored (streamMonitor.ts: tool_unavailable, `required_tool_failed`, since
// the answer would rest on a retrieval that failed); then no init; then the
// result event (none, max turns, error, non-success, no structured output); then the
// structured output through outcomeFromOutput (outputValidation.ts). Only `completed` can be `ok` or `empty`.
// With an instruction marker, the first pick's reason loses the marker; a pick whose reason
// was only the marker is dropped like any other pick without a reason.
// Usage counts, API time and permission denials are copied from the result event whatever the
// outcome.

import type { JobRequest } from "@scout/contracts";
import type { JobDetails, JobTermination } from "../adapter.js";
import type { Out } from "../jobStop.js";
import { isRecord, type StreamRecord } from "../jsonLineStream.js";
import { outcomeFromOutput } from "../outputValidation.js";
import { isAuthOrQuota } from "./streamMonitor.js";

export interface CliRun {
  spawnError: boolean;
  stop: Out | undefined;
  init: StreamRecord | undefined;
  result: StreamRecord | undefined;
  /** A required user tool was called and every call to it errored (streamMonitor.ts). */
  requiredToolFailed?: boolean;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function recordUsage(resultEv: StreamRecord | undefined, details: JobDetails): void {
  const usage = isRecord(resultEv?.usage) ? resultEv.usage : {};
  const set = (k: keyof JobDetails["usage"], v: unknown): void => {
    const n = num(v);
    if (n !== undefined) details.usage[k] = n;
  };
  set("turns", resultEv?.num_turns);
  set("inputTokens", usage.input_tokens);
  set("outputTokens", usage.output_tokens);
  set("cacheReadTokens", usage.cache_read_input_tokens);
  set("cacheWriteTokens", usage.cache_creation_input_tokens);
  const apiMs = num(resultEv?.duration_api_ms);
  if (apiMs !== undefined) details.timings.apiMs = apiMs;
  if (Array.isArray(resultEv?.permission_denials)) details.permissionDenials = resultEv.permission_denials.length;
}

export function mapOutcome(run: CliRun, req: Pick<JobRequest, "candidates" | "maxPicks">, details: JobDetails, instructionMarker?: string): Out {
  const agentFailed = (termination: JobTermination): Out => ({ result: { status: "error", reason: "agent_failed" }, termination });
  const authOrQuota: Out = { result: { status: "unavailable", reason: "agent_unavailable" }, termination: "auth_or_quota" };
  const resultEv = run.result;

  if (run.spawnError) return { result: { status: "unavailable", reason: "agent_unavailable" }, termination: "agent_unavailable", detail: "spawn_failed" };
  if (run.stop !== undefined) return run.stop;
  if (run.requiredToolFailed) return { result: { status: "error", reason: "tool_unavailable" }, termination: "tool_unavailable", detail: "required_tool_failed" };
  if (run.init === undefined) {
    if (resultEv && isAuthOrQuota(resultEv)) return authOrQuota;
    return { result: { status: "error", reason: "unsupported_configuration" }, termination: "malformed_startup", detail: "no_init" };
  }
  if (resultEv === undefined) return agentFailed("no_result");
  if (resultEv.subtype === "error_max_turns") return agentFailed("max_turns");
  if (resultEv.is_error !== false) return isAuthOrQuota(resultEv) ? authOrQuota : agentFailed("process_error");
  if (resultEv.subtype !== "success") return agentFailed("process_error");
  if (resultEv.structured_output === undefined) return { result: { status: "error", reason: "invalid_output" }, termination: "invalid_output", detail: "no_structured_output" };

  return outcomeFromOutput(resultEv.structured_output, req, details, instructionMarker);
}
