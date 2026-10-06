// Watches a running Codex job's `--json` events and stops the job the moment one shows a
// misconfiguration. Events (Codex CLI 0.155.1): `thread.started`, `turn.started`,
// `item.started|item.updated|item.completed {item}`, `error {message}`, `turn.completed {usage}`,
// `turn.failed {error}`. Rules, in order, for each event (nothing counts after a stop):
//   - `error` / `turn.failed` whose message reads as auth or quota (401, 403, 429, unauthorized,
//     usage limit, rate limit, not logged in): unavailable, auth_or_quota;
//   - the first event must be `thread.started` (malformed_startup); a second one is
//     malformed_startup `second_thread`;
//   - `turn.started` counts a turn;
//   - an item of type `command_execution`, `web_search` or `file_change` (started, updated or
//     completed): unsupported_configuration `unexpected_tool_use`. The launch turns the shell
//     tool and web search off and runs read-only; any of these means it did not hold;
//   - an `mcp_tool_call` item whose server is not in the job's surface, or whose tool is not
//     in that server's expected list: the same halt. A completed call is recorded
//     (`mcp__<server>__<tool>`, bounded); one with an `error` or a status other than
//     `completed` counts against that tool (`toolErrors`), and flags `optionalToolFailed` when
//     the tool is optional. Errors from Scout's own tools are only counted;
//   - required-tool rule, decided at job end (`requiredToolFailed()`), the same as Claude's: a
//     required tool of a non-Scout server fails the job only when it was called and every
//     call to it errored;
//   - the last completed `agent_message` item's text is kept (the final answer);
//   - `turn.completed`: usage is kept and the result counts (a later stop no longer replaces it).

import type { JobDetails } from "../adapter.js";
import type { JobStop } from "../jobStop.js";
import { isRecord, type StreamRecord } from "../jsonLineStream.js";
import { mcpToolName, SCOUT_SERVER_NAME, type ExpectedServer } from "../claudeCode/jobSurface.js";

const MAX_TOOL_USES_RECORDED = 64;
const FORBIDDEN_ITEMS = new Set(["command_execution", "web_search", "file_change"]);
export const AUTH_OR_QUOTA_RE = /\b(401|403|429)\b|unauthori[sz]ed|usage limit|not logged in|rate limit/i;

export interface CodexEventMonitorOptions {
  /** The job's servers with their full tool names (jobSurface.ts). */
  expected: readonly ExpectedServer[];
  details: JobDetails;
  stop: JobStop;
}

export interface CodexEventMonitor {
  onEvent(ev: StreamRecord): void;
  readonly threadStarted: boolean;
  /** The `turn.completed` event, when one arrived. */
  readonly completed: StreamRecord | undefined;
  /** The last completed agent message's text. */
  readonly lastMessage: string | undefined;
  /** An `error` or `turn.failed` event read as auth or quota (whether or not it stopped the job). */
  readonly authOrQuota: boolean;
  readonly turns: number;
  requiredToolFailed(): boolean;
}

const messageOf = (ev: StreamRecord): string => {
  if (ev.type === "error") return typeof ev.message === "string" ? ev.message : "";
  if (ev.type === "turn.failed" && isRecord(ev.error)) return typeof ev.error.message === "string" ? ev.error.message : "";
  return "";
};

export function createCodexEventMonitor(o: CodexEventMonitorOptions): CodexEventMonitor {
  const { details, stop } = o;
  const servers = new Map(o.expected.map((s) => [s.name, new Set(s.tools)]));
  const optional = new Set(o.expected.flatMap((s) => s.optionalTools));
  const requiredExternal = new Set(o.expected.filter((s) => s.name !== SCOUT_SERVER_NAME).flatMap((s) => s.tools.filter((t) => !s.optionalTools.includes(t))));
  const calls = new Map<string, number>();
  let seen = 0;
  let threadStarted = false;
  let completed: StreamRecord | undefined;
  let lastMessage: string | undefined;
  let authOrQuota = false;
  let turns = 0;
  const unsupported = (detail: string): void => stop.halt({ result: { status: "error", reason: "unsupported_configuration" }, termination: "unsupported_configuration", detail });

  /** The tool's full name when the surface allows it, else undefined. */
  const allowed = (item: StreamRecord): string | undefined => {
    const server = typeof item.server === "string" ? item.server : "";
    const tool = typeof item.tool === "string" ? item.tool : "";
    const name = mcpToolName(server, tool);
    return servers.get(server)?.has(name) ? name : undefined;
  };

  const onItem = (phase: string, item: StreamRecord): void => {
    const type = item.type;
    if (typeof type === "string" && FORBIDDEN_ITEMS.has(type)) return unsupported("unexpected_tool_use");
    if (type === "mcp_tool_call") {
      const name = allowed(item);
      if (name === undefined) return unsupported("unexpected_tool_use");
      if (phase !== "item.completed") return;
      if (details.toolUses.length < MAX_TOOL_USES_RECORDED) details.toolUses.push(name);
      calls.set(name, (calls.get(name) ?? 0) + 1);
      if ((item.error !== undefined && item.error !== null) || item.status !== "completed") {
        details.toolErrors[name] = (details.toolErrors[name] ?? 0) + 1;
        if (optional.has(name)) details.optionalToolFailed = true;
      }
      return;
    }
    if (type === "agent_message" && phase === "item.completed" && typeof item.text === "string") lastMessage = item.text;
  };

  const onEvent = (ev: StreamRecord): void => {
    if (stop.decision !== undefined) return; // nothing after a stop counts, a late answer least of all
    seen++;
    if ((ev.type === "error" || ev.type === "turn.failed") && AUTH_OR_QUOTA_RE.test(messageOf(ev))) {
      authOrQuota = true;
      return stop.halt({ result: { status: "unavailable", reason: "agent_unavailable" }, termination: "auth_or_quota", detail: "auth_or_quota" });
    }
    if (ev.type === "thread.started") {
      if (threadStarted) return stop.halt({ result: { status: "error", reason: "unsupported_configuration" }, termination: "malformed_startup", detail: "second_thread" });
      if (seen !== 1) return stop.halt({ result: { status: "error", reason: "unsupported_configuration" }, termination: "malformed_startup" });
      threadStarted = true;
      return;
    }
    if (!threadStarted) return stop.halt({ result: { status: "error", reason: "unsupported_configuration" }, termination: "malformed_startup" });
    if (ev.type === "turn.started") turns++;
    else if ((ev.type === "item.started" || ev.type === "item.updated" || ev.type === "item.completed") && isRecord(ev.item)) onItem(ev.type, ev.item);
    else if (ev.type === "turn.completed" && completed === undefined) {
      completed = ev;
      stop.resultArrived();
    }
  };

  return {
    onEvent,
    get threadStarted() {
      return threadStarted;
    },
    get completed() {
      return completed;
    },
    get lastMessage() {
      return lastMessage;
    },
    get authOrQuota() {
      return authOrQuota;
    },
    get turns() {
      return turns;
    },
    requiredToolFailed() {
      for (const tool of requiredExternal) {
        const n = calls.get(tool) ?? 0;
        if (n > 0 && (details.toolErrors[tool] ?? 0) >= n) return true;
      }
      return false;
    },
  };
}
