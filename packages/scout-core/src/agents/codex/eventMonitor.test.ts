import { describe, expect, it } from "vitest";
import type { JobDetails } from "../adapter.js";
import { JobStop } from "../jobStop.js";
import { buildJobSurface, scoutServerSpec } from "../claudeCode/jobSurface.js";
import { createCodexEventMonitor } from "./eventMonitor.js";
import { mapCodexOutcome, recordCodexUsage, type CodexRun } from "./mapOutcome.js";

const details = (): JobDetails => ({ adapter: "codex", termination: "completed", toolUses: [], optionalTools: [], droppedPicks: 0, cutPicks: 0, toolErrors: {}, optionalToolFailed: false, timings: { totalMs: 0 }, usage: {} });

function surface(bridge?: { required: boolean; optional?: string[] }) {
  const scout = scoutServerSpec({ nodePath: "/n", entrypoint: "/e", socketPath: "/s", tokenFile: "/t" });
  const servers = [scout];
  const allowed = scout.tools.map((t) => `mcp__scout__${t}`);
  if (bridge) {
    servers.push({ name: "scout_bridge", command: "/n", args: ["/b"], tools: ["lookup", "search"], required: bridge.required, optionalTools: bridge.optional ?? [] });
    allowed.push("mcp__scout_bridge__lookup", "mcp__scout_bridge__search");
  }
  return buildJobSurface({ servers, allowedTools: allowed });
}

function monitor(bridge?: { required: boolean; optional?: string[] }) {
  const d = details();
  const stop = new JobStop();
  const m = createCodexEventMonitor({ expected: surface(bridge).expected, details: d, stop });
  return { m, d, stop };
}

const call = (server: string, tool: string, extra: Record<string, unknown> = {}) => ({ type: "item.completed", item: { id: "i", type: "mcp_tool_call", server, tool, arguments: {}, result: null, error: null, status: "completed", ...extra } });
const started = { type: "thread.started", thread_id: "t" };

describe("codex event monitor", () => {
  it("records tool calls, the last agent message, turns and the completed turn", () => {
    const { m, d, stop } = monitor();
    for (const ev of [
      started,
      { type: "turn.started" },
      { type: "item.started", item: { id: "i", type: "mcp_tool_call", server: "scout", tool: "current_site", status: "in_progress" } },
      call("scout", "current_site"),
      { type: "item.completed", item: { id: "r", type: "reasoning", text: "thinking" } },
      { type: "item.completed", item: { id: "a", type: "agent_message", text: "draft" } },
      { type: "item.completed", item: { id: "b", type: "agent_message", text: '{"status":"empty","items":[]}' } },
      { type: "turn.completed", usage: { input_tokens: 35000, cached_input_tokens: 22000, cache_write_input_tokens: 0, output_tokens: 170, reasoning_output_tokens: 40 } },
    ])
      m.onEvent(ev);
    expect(stop.decision).toBeUndefined();
    expect(d.toolUses).toEqual(["mcp__scout__current_site"]);
    expect(m.lastMessage).toBe('{"status":"empty","items":[]}');
    expect(m.turns).toBe(1);
    recordCodexUsage(m.completed, m.turns, d);
    expect(d.usage).toEqual({ turns: 1, inputTokens: 35000, cacheReadTokens: 22000, cacheWriteTokens: 0, outputTokens: 170 });
  });

  it.each([
    ["command_execution", { type: "item.started", item: { id: "c", type: "command_execution", command: "ls", status: "in_progress" } }],
    ["web_search", { type: "item.completed", item: { id: "w", type: "web_search", query: "x" } }],
    ["file_change", { type: "item.updated", item: { id: "f", type: "file_change", changes: [] } }],
    ["a foreign server", call("other", "current_site")],
    ["an unknown Scout tool", call("scout", "write_file")],
    ["a bridge tool without a bridge", call("scout_bridge", "lookup")],
  ])("%s halts with unexpected_tool_use", (_l, ev) => {
    const { m, stop } = monitor();
    m.onEvent(started);
    m.onEvent(ev);
    expect(stop.decision).toEqual({ result: { status: "error", reason: "unsupported_configuration" }, termination: "unsupported_configuration", detail: "unexpected_tool_use" });
  });

  it("the first event must be thread.started; a second one is malformed", () => {
    const a = monitor();
    a.m.onEvent({ type: "turn.started" });
    expect(a.stop.decision).toMatchObject({ termination: "malformed_startup" });
    const b = monitor();
    b.m.onEvent(started);
    b.m.onEvent(started);
    expect(b.stop.decision).toMatchObject({ termination: "malformed_startup", detail: "second_thread" });
  });

  it.each([
    [{ type: "error", message: "unexpected status 401 Unauthorized" }],
    [{ type: "error", message: "You've hit your usage limit. Try again later." }],
    [{ type: "turn.failed", error: { message: "exceeded retry limit, last status: 429 Too Many Requests" } }],
    [{ type: "turn.failed", error: { message: "Not logged in" } }],
  ])("auth or quota (%o): unavailable auth_or_quota", (ev) => {
    const { m, stop } = monitor();
    m.onEvent(started);
    m.onEvent(ev);
    expect(stop.decision).toEqual({ result: { status: "unavailable", reason: "agent_unavailable" }, termination: "auth_or_quota", detail: "auth_or_quota" });
    expect(m.authOrQuota).toBe(true);
  });

  it("another error is not a stop; a failed turn leaves no completed turn", () => {
    const { m, stop } = monitor();
    m.onEvent(started);
    m.onEvent({ type: "error", message: "Reconnecting... 1/5" });
    m.onEvent({ type: "turn.failed", error: { message: "stream disconnected" } });
    expect(stop.decision).toBeUndefined();
    expect(m.completed).toBeUndefined();
  });

  it("tool errors: counted per tool; a required bridge tool every call of which failed fails the job; Scout's own only counted", () => {
    const { m, d } = monitor({ required: true, optional: ["search"] });
    m.onEvent(started);
    m.onEvent(call("scout", "current_site", { error: { message: "MCP tool call requires approval, but approval policy is never" }, status: "failed" }));
    m.onEvent(call("scout_bridge", "lookup", { error: { message: "boom" }, status: "failed" }));
    expect(d.toolErrors).toEqual({ mcp__scout__current_site: 1, mcp__scout_bridge__lookup: 1 });
    expect(d.optionalToolFailed).toBe(false);
    expect(m.requiredToolFailed()).toBe(true);
    m.onEvent(call("scout_bridge", "lookup"));
    expect(m.requiredToolFailed()).toBe(false);
    m.onEvent(call("scout_bridge", "search", { status: "failed" }));
    expect(d.optionalToolFailed).toBe(true);
  });

  it("nothing counts after a stop, and a completed turn stands against a later stop", () => {
    const a = monitor();
    a.m.onEvent(started);
    a.stop.external({ result: { status: "cancelled", reason: "visit_changed" }, termination: "cancelled" });
    a.m.onEvent({ type: "item.completed", item: { id: "x", type: "agent_message", text: "late" } });
    expect(a.m.lastMessage).toBeUndefined();
    const b = monitor();
    b.m.onEvent(started);
    b.m.onEvent({ type: "turn.completed", usage: {} });
    b.stop.external({ result: { status: "error", reason: "timeout" }, termination: "timeout" });
    expect(b.stop.decision).toBeUndefined();
  });
});

describe("codex outcome", () => {
  const req = { candidates: [{ id: "c1", title: "A", labelQuality: "published" as const }, { id: "c2", title: "B", labelQuality: "published" as const }], maxPicks: 3 };
  const run = (extra: Partial<CodexRun>): CodexRun => ({ spawnError: false, exitCode: 0, stop: undefined, completed: { type: "turn.completed" }, lastMessage: '{"status":"ok","items":[{"id":"c1","reason":"fits"}]}', authOrQuota: false, requiredToolFailed: false, ...extra });

  it.each<[string, Partial<CodexRun>, Record<string, unknown>]>([
    ["ok", {}, { result: { status: "ok", items: [{ id: "c1", reason: "fits" }] }, termination: "completed" }],
    ["strict empty", { lastMessage: '{"status":"empty","items":[]}' }, { result: { status: "empty" }, termination: "completed" }],
    ["spawn error", { spawnError: true }, { termination: "agent_unavailable", detail: "spawn_failed" }],
    ["stop", { stop: { result: { status: "error", reason: "timeout" }, termination: "timeout" } }, { termination: "timeout" }],
    ["required tool failed", { requiredToolFailed: true }, { result: { status: "error", reason: "tool_unavailable" }, detail: "required_tool_failed" }],
    ["no completed turn", { completed: undefined }, { result: { status: "error", reason: "agent_failed" }, termination: "no_result" }],
    ["no completed turn after an auth error", { completed: undefined, authOrQuota: true }, { result: { status: "unavailable", reason: "agent_unavailable" }, termination: "auth_or_quota" }],
    ["non-zero exit after a completed turn", { exitCode: 1 }, { result: { status: "error", reason: "agent_failed" }, termination: "process_error" }],
    ["no agent message", { lastMessage: undefined }, { result: { status: "error", reason: "invalid_output" }, detail: "no_structured_output" }],
    ["text that is not JSON", { lastMessage: "here are some links" }, { result: { status: "error", reason: "invalid_output" }, detail: "no_structured_output" }],
    ["an invalid shape", { lastMessage: '{"status":"maybe","items":[]}' }, { result: { status: "error", reason: "invalid_output" }, termination: "invalid_output" }],
    ["ok with no items", { lastMessage: '{"status":"ok","items":[]}' }, { result: { status: "error", reason: "invalid_output" } }],
  ])("%s", (_l, r, expected) => {
    expect(mapCodexOutcome(run(r), req, details())).toMatchObject(expected);
  });
});
