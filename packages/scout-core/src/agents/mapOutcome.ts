// A finished CLI run as a job outcome. Order: a spawn failure; then any stop decision
// (cancel, timeout, a failed check: a stop always wins over output); then no init; then the
// result event (none, max turns, error, non-success, no structured output); then the
// structured output through validateJobOutput. Only `completed` can be `ok` or `empty`.
// With an instruction marker, the first pick's reason loses the marker; a pick whose reason
// was only the marker is dropped like any other pick without a reason.
// Usage counts, API time and permission denials are copied from the result event whatever the
// outcome.

import type { JobRequest } from "@scout/contracts";
import type { JobDetails, JobTermination } from "./adapter.js";
import type { Out } from "./jobStop.js";
import { isRecord, type StreamRecord } from "./jsonLineStream.js";
import { validateJobOutput } from "./outputValidation.js";
import { takeInstructionMarker } from "./prompt.js";
import { isAuthOrQuota } from "./streamMonitor.js";

export interface CliRun {
  spawnError: boolean;
  stop: Out | undefined;
  init: StreamRecord | undefined;
  result: StreamRecord | undefined;
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
  if (run.init === undefined) {
    if (resultEv && isAuthOrQuota(resultEv)) return authOrQuota;
    return { result: { status: "error", reason: "unsupported_configuration" }, termination: "malformed_startup", detail: "no_init" };
  }
  if (resultEv === undefined) return agentFailed("no_result");
  if (resultEv.subtype === "error_max_turns") return agentFailed("max_turns");
  if (resultEv.is_error !== false) return isAuthOrQuota(resultEv) ? authOrQuota : agentFailed("process_error");
  if (resultEv.subtype !== "success") return agentFailed("process_error");
  if (resultEv.structured_output === undefined) return { result: { status: "error", reason: "invalid_output" }, termination: "invalid_output", detail: "no_structured_output" };

  const v = validateJobOutput(resultEv.structured_output, req);
  if (v.status === "invalid") {
    details.droppedPicks = v.droppedPicks;
    return { result: { status: "error", reason: "invalid_output" }, termination: "invalid_output" };
  }
  if (v.status === "empty") {
    if (instructionMarker !== undefined) details.instructionMarker = "missing";
    return { result: { status: "empty" }, termination: "completed" };
  }
  details.droppedPicks = v.droppedPicks;
  details.cutPicks = v.cutPicks;
  const items = v.items.map((i) => ({ ...i }));
  if (instructionMarker !== undefined) {
    const first = items[0]!;
    const taken = takeInstructionMarker(first.reason, instructionMarker);
    details.instructionMarker = taken.reached ? "reached" : "missing";
    first.reason = taken.reason;
    if (first.reason === "") {
      // The marker was the whole reason: a pick with no reason is dropped, never shown with the marker.
      items.shift();
      details.droppedPicks++;
      if (items.length === 0) return { result: { status: "error", reason: "invalid_output" }, termination: "invalid_output" };
    }
  }
  return { result: { status: "ok", items }, termination: "completed" };
}
