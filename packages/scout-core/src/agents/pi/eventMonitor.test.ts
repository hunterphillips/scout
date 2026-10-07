import { describe, expect, it } from "vitest";
import { JobStop } from "../jobStop.js";
import { createPiEventMonitor } from "./eventMonitor.js";
import { mapPiOutcome } from "./mapOutcome.js";
import { jobDetails } from "./testing/testWorld.js";

const expected = [{
  name: "scout",
  tools: ["mcp__scout__recent_activity"],
  required: true,
  optionalTools: [],
}];

describe("Pi event monitor", () => {
  it("requires one first session and halts on turn 17", () => {
    const second = new JobStop();
    const first = createPiEventMonitor({ expected, details: jobDetails(), stop: second });
    first.onEvent({ type: "session" });
    first.onEvent({ type: "session" });
    expect(second.decision?.termination).toBe("malformed_startup");

    const max = new JobStop();
    const turns = createPiEventMonitor({ expected, details: jobDetails(), stop: max });
    turns.onEvent({ type: "session" });
    for (let index = 0; index < 17; index++) {
      turns.onEvent({ type: "turn_start" });
    }
    expect(max.decision?.termination).toBe("max_turns");
  });

  it("rejects built-ins and an MCP result outside the exact surface", () => {
    const builtin = new JobStop();
    const first = createPiEventMonitor({ expected, details: jobDetails(), stop: builtin });
    first.onEvent({ type: "session" });
    first.onEvent({ type: "tool_execution_start", toolName: "bash" });
    expect(builtin.decision?.detail).toBe("unexpected_tool_use");

    const foreign = new JobStop();
    const second = createPiEventMonitor({ expected, details: jobDetails(), stop: foreign });
    second.onEvent({ type: "session" });
    second.onEvent({ type: "tool_execution_start", toolCallId: "x", toolName: "mcp__scout__recent_activity" });
    second.onEvent({
      type: "tool_execution_end",
      toolCallId: "x",
      toolName: "mcp__scout__recent_activity",
      result: { details: { server: "scout", tool: "other" } },
    });
    expect(foreign.decision?.detail).toBe("unexpected_tool_use");
  });

  it("accepts an answer after a rejected one and ignores late events", () => {
    const stop = new JobStop();
    const monitor = createPiEventMonitor({ expected, details: jobDetails(), stop });
    monitor.onEvent({ type: "session" });
    monitor.onEvent({ type: "tool_execution_end", toolName: "scout_answer", isError: true });
    monitor.onEvent({
      type: "tool_execution_end",
      toolName: "scout_answer",
      result: { details: { answer: { status: "ok", items: [{ id: "c1", reason: "First" }] }, scoutTools: 5 } },
      isError: false,
    });
    monitor.onEvent({ type: "agent_settled" });
    monitor.onEvent({ type: "tool_execution_start", toolName: "bash" });
    monitor.onEvent({
      type: "tool_execution_end",
      toolName: "scout_answer",
      result: { details: { answer: { status: "empty" }, scoutTools: 5 } },
      isError: false,
    });
    expect(monitor.answer).toEqual({ status: "ok", items: [{ id: "c1", reason: "First" }] });
    expect(stop.decision).toBeUndefined();
  });

  it("sums assistant usage and remembers auth errors through retries", () => {
    const details = jobDetails();
    const monitor = createPiEventMonitor({ expected, details, stop: new JobStop() });
    monitor.onEvent({ type: "session" });
    monitor.onEvent({ type: "agent_end", willRetry: true });
    monitor.onEvent({ type: "auto_retry_start" });
    monitor.onEvent({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "429 usage limit", usage: { input: 10, output: 2, cacheRead: 3 } },
    });
    monitor.onEvent({
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", usage: { input: 5, output: 4 } },
    });
    monitor.onEvent({ type: "agent_settled" });
    expect(monitor.settled).toBe(true);
    expect(monitor.authOrQuota).toBe(true);
    expect(details.usage).toMatchObject({ inputTokens: 15, outputTokens: 6, cacheReadTokens: 3 });
  });
  it("reads Anthropic's out-of-extra-usage 400 as a quota error", () => {
    const monitor = createPiEventMonitor({ expected, details: jobDetails(), stop: new JobStop() });
    monitor.onEvent({ type: "session" });
    const errorMessage = '400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."}}';
    monitor.onEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage, usage: { input: 0, output: 0 } } });
    expect(monitor.error).toBe(true);
    expect(monitor.authOrQuota).toBe(true);
  });
});

describe("Pi outcome", () => {
  it("separates a missing Scout server from a settled run without an answer", () => {
    const base = {
      spawnError: false,
      exitCode: 0,
      stop: undefined,
      requiredToolFailed: false,
      answer: { status: "empty" },
      scoutTools: 0,
      settled: true,
      error: false,
      authOrQuota: false,
    };
    expect(mapPiOutcome(base, { candidates: [], maxPicks: 3 }, jobDetails()).detail).toBe("tool_surface");
    expect(mapPiOutcome(
      { ...base, answer: undefined, scoutTools: undefined },
      { candidates: [], maxPicks: 3 },
      jobDetails(),
    ).detail).toBe("no_structured_output");
  });
});
