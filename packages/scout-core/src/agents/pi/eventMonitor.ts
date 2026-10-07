// Watches Pi 1.0.4 `--mode json` events and stops at the first decisive result. Rules, in
// order, for each event (nothing after a stop or accepted answer counts):
//   1. The first record must be `session`; a second session is malformed_startup.
//   2. `turn_start` counts turns; turn 17 halts because Pi has no max-turns flag.
//   3. `tool_execution_start` may name scout_answer or a Scout/selected-bridge MCP tool;
//      built-ins and codemode halt as unexpected_tool_use.
//   4. An MCP `tool_execution_end` must report details.server/tool in the exact surface.
//      Calls are recorded up to 64, errors counted, and optional-tool failures flagged.
//   5. The first successful scout_answer end supplies details.answer and scoutTools.
//      Rejected arguments (`isError`) let Pi retry; a good answer protects the result.
//   6. Assistant `message_end` contributes usage, provider and model. Error/aborted stop
//      reasons are remembered, including auth/quota text, for outcome mapping.
//   7. `agent_end {willRetry:true}` and `auto_retry_*` are nonterminal. Only
//      `agent_settled` or process exit ends a run without an answer.
// A required external tool fails the job only if it was called and every call errored.

import type { JobDetails } from "../adapter.js";
import type { JobStop } from "../jobStop.js";
import { isRecord, type StreamRecord } from "../jsonLineStream.js";
import { mcpToolName, SCOUT_SERVER_NAME, type ExpectedServer } from "../claudeCode/jobSurface.js";
import { JOB_MAX_TURNS } from "./launch.js";

const MAX_TOOL_USES_RECORDED = 64;
// Provider wording seen through Pi: "You're out of extra usage" (Anthropic, HTTP 400).
const AUTH_OR_QUOTA_RE = /\b(401|403|429)\b|unauthori[sz]ed|credentials|usage limit|out of (extra )?usage|extra usage|quota|not logged in|rate limit/i;

export interface PiEventMonitorOptions {
  expected: readonly ExpectedServer[];
  details: JobDetails;
  stop: JobStop;
}

export interface PiEventMonitor {
  onEvent(ev: StreamRecord): void;
  readonly answer: unknown;
  readonly scoutTools: number | undefined;
  readonly settled: boolean;
  readonly error: boolean;
  readonly authOrQuota: boolean;
  readonly turns: number;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  requiredToolFailed(): boolean;
}

/** Consume Pi events against the exact job surface without reading tool arguments. */
export function createPiEventMonitor(o: PiEventMonitorOptions): PiEventMonitor {
  const { details, stop } = o;
  const servers = new Map(o.expected.map((server) => [server.name, new Set(server.tools)]));
  const optional = new Set(o.expected.flatMap((server) => server.optionalTools));
  const requiredExternal = new Set(
    o.expected
      .filter((server) => server.name !== SCOUT_SERVER_NAME)
      .flatMap((server) => server.tools.filter((tool) => !server.optionalTools.includes(tool))),
  );
  const calls = new Map<string, number>();
  const starts = new Map<string, string>();
  let seen = 0;
  let turns = 0;
  let settled = false;
  let error = false;
  let authOrQuota = false;
  let answer: unknown;
  let scoutTools: number | undefined;
  let provider: string | undefined;
  let model: string | undefined;

  const unsupported = (detail: string): void => {
    stop.halt({
      result: { status: "error", reason: "unsupported_configuration" },
      termination: "unsupported_configuration",
      detail,
    });
  };
  const malformed = (): void => {
    stop.halt({
      result: { status: "error", reason: "unsupported_configuration" },
      termination: "malformed_startup",
    });
  };

  const onEvent = (ev: StreamRecord): void => {
    if (stop.decision !== undefined || answer !== undefined) return;
    seen++;
    if (ev.type === "session") {
      if (seen !== 1) malformed();
      return;
    }
    if (seen === 1) {
      malformed();
      return;
    }
    if (ev.type === "turn_start") {
      turns++;
      if (turns > JOB_MAX_TURNS) {
        stop.halt({ result: { status: "error", reason: "agent_failed" }, termination: "max_turns" });
      }
      return;
    }
    if (ev.type === "tool_execution_start") {
      const name = ev.toolName;
      const permitted = typeof name === "string" && (
        name === "scout_answer" ||
        name.startsWith("mcp__scout__") ||
        (servers.has("scout_bridge") && name.startsWith("mcp__scout_bridge__"))
      );
      if (!permitted) {
        unsupported("unexpected_tool_use");
        return;
      }
      if (typeof ev.toolCallId === "string") starts.set(ev.toolCallId, name);
      return;
    }
    if (ev.type === "tool_execution_end") {
      const name = typeof ev.toolName === "string"
        ? ev.toolName
        : typeof ev.toolCallId === "string"
          ? starts.get(ev.toolCallId)
          : undefined;
      const result = isRecord(ev.result) ? ev.result : {};
      const data = isRecord(result.details) ? result.details : {};
      if (name === "scout_answer") {
        if (ev.isError === true) return;
        if (data.answer !== undefined) {
          answer = data.answer;
          scoutTools = typeof data.scoutTools === "number" ? data.scoutTools : undefined;
          stop.resultArrived();
        }
        return;
      }
      const server = typeof data.server === "string" ? data.server : "";
      const tool = typeof data.tool === "string" ? data.tool : "";
      const full = mcpToolName(server, tool);
      if (!servers.get(server)?.has(full) || name !== full) {
        unsupported("unexpected_tool_use");
        return;
      }
      if (details.toolUses.length < MAX_TOOL_USES_RECORDED) details.toolUses.push(full);
      calls.set(full, (calls.get(full) ?? 0) + 1);
      if (ev.isError === true || result.isError === true) {
        details.toolErrors[full] = (details.toolErrors[full] ?? 0) + 1;
        if (optional.has(full)) details.optionalToolFailed = true;
      }
      return;
    }
    if (ev.type === "message_end" && isRecord(ev.message) && ev.message.role === "assistant") {
      const message = ev.message;
      if (typeof message.provider === "string") provider = message.provider;
      if (typeof message.model === "string") model = message.model;
      const usage = isRecord(message.usage) ? message.usage : {};
      for (const [to, from] of [
        ["inputTokens", "input"],
        ["outputTokens", "output"],
        ["cacheReadTokens", "cacheRead"],
        ["cacheWriteTokens", "cacheWrite"],
      ] as const) {
        const count = usage[from];
        if (typeof count === "number" && Number.isFinite(count)) {
          details.usage[to] = (details.usage[to] ?? 0) + count;
        }
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        error = true;
        const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : "";
        if (AUTH_OR_QUOTA_RE.test(errorMessage)) authOrQuota = true;
      }
      return;
    }
    if (ev.type === "agent_settled") settled = true;
  };

  return {
    onEvent,
    get answer() {
      return answer;
    },
    get scoutTools() {
      return scoutTools;
    },
    get settled() {
      return settled;
    },
    get error() {
      return error;
    },
    get authOrQuota() {
      return authOrQuota;
    },
    get turns() {
      return turns;
    },
    get provider() {
      return provider;
    },
    get model() {
      return model;
    },
    requiredToolFailed() {
      for (const tool of requiredExternal) {
        const count = calls.get(tool) ?? 0;
        if (count > 0 && (details.toolErrors[tool] ?? 0) >= count) return true;
      }
      return false;
    },
  };
}
