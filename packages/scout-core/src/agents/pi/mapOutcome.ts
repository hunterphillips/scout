// A finished Pi stream as a Scout job outcome. Order: spawn error; an earlier stop
// (cancel, timeout or monitor halt); a required external tool every call of which failed;
// a structured answer with zero Scout tools (silent MCP startup failure); a nonzero exit;
// the first valid answer through shared output validation; auth/quota or other model error;
// no settled event or result; finally a settled run with no answer (invalid_output).
// Pi JSON mode can exit zero after a model error, so exit status alone is never success.

import type { JobRequest } from "@scout/contracts";
import type { JobDetails } from "../adapter.js";
import type { Out } from "../jobStop.js";
import { outcomeFromOutput } from "../outputValidation.js";

export interface PiRun {
  spawnError: boolean;
  exitCode: number | null;
  stop: Out | undefined;
  requiredToolFailed: boolean;
  answer: unknown;
  scoutTools: number | undefined;
  settled: boolean;
  error: boolean;
  authOrQuota: boolean;
}

/** Map Pi's authoritative answer tool and stream state to the fixed Scout contract. */
export function mapPiOutcome(
  run: PiRun,
  req: Pick<JobRequest, "candidates" | "maxPicks">,
  details: JobDetails,
): Out {
  if (run.spawnError) {
    return {
      result: { status: "unavailable", reason: "agent_unavailable" },
      termination: "agent_unavailable",
      detail: "spawn_failed",
    };
  }
  if (run.stop) return run.stop;
  if (run.requiredToolFailed) {
    return {
      result: { status: "error", reason: "tool_unavailable" },
      termination: "tool_unavailable",
      detail: "required_tool_failed",
    };
  }
  if (run.answer !== undefined && run.scoutTools === 0) {
    return {
      result: { status: "error", reason: "agent_failed" },
      termination: "process_error",
      detail: "tool_surface",
    };
  }
  if (run.exitCode !== 0) {
    return { result: { status: "error", reason: "agent_failed" }, termination: "process_error" };
  }
  if (run.answer !== undefined) return outcomeFromOutput(run.answer, req, details);
  if (run.authOrQuota) {
    return {
      result: { status: "unavailable", reason: "agent_unavailable" },
      termination: "auth_or_quota",
      detail: "auth_or_quota",
    };
  }
  if (run.error) {
    return { result: { status: "error", reason: "agent_failed" }, termination: "process_error" };
  }
  if (!run.settled) {
    return { result: { status: "error", reason: "agent_failed" }, termination: "no_result" };
  }
  return {
    result: { status: "error", reason: "invalid_output" },
    termination: "invalid_output",
    detail: "no_structured_output",
  };
}
