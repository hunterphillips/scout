import { describe, expect, it } from "vitest";
import type { JobDetails } from "../adapter.js";
import { JobStop } from "./jobStop.js";
import { createStreamMonitor } from "./streamMonitor.js";

const scoutTools = ["current_site", "recent_activity"].map((t) => `mcp__scout__${t}`);
const expected = {
  servers: [
    { name: "scout", tools: scoutTools, required: true, optionalTools: [] },
    { name: "scout_bridge", tools: ["mcp__scout_bridge__lookup"], required: false, optionalTools: ["mcp__scout_bridge__lookup"] },
  ],
  model: "claude-sonnet-5-5",
  cliVersion: "2.1.286",
};

const details = (): JobDetails => ({
  adapter: "claude-code",
  termination: "completed",
  toolUses: [],
  optionalTools: [],
  droppedPicks: 0,
  cutPicks: 0,
  toolErrors: {},
  optionalToolFailed: false,
  timings: { totalMs: 0 },
  usage: {},
});

const init = (extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "init",
  tools: [...scoutTools, "mcp__scout_bridge__lookup", "StructuredOutput"],
  mcp_servers: [
    { name: "scout", status: "connected" },
    { name: "scout_bridge", status: "connected" },
  ],
  model: "claude-sonnet-5-5",
  permissionMode: "dontAsk",
  apiKeySource: "none",
  claude_code_version: "2.1.286",
  ...extra,
});

const use = (id: string, name: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: {} }] } });
const answer = (id: string, isError: boolean) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "x" }] } });

function monitor(onCliVersionChanged?: (v: string | undefined) => void) {
  const d = details();
  const stop = new JobStop();
  const allowedTools = new Set([...scoutTools, "mcp__scout_bridge__lookup"]);
  const m = createStreamMonitor({ expected, allowedTools, details: d, stop, clock: { now: () => 0 }, startedAt: 0, ...(onCliVersionChanged ? { onCliVersionChanged } : {}) });
  return { m, d, stop };
}

describe("stream monitor: job details", () => {
  it("counts errored tool results by tool name; an optional tool's error flags optionalToolFailed", () => {
    const { m, d, stop } = monitor();
    m.onEvent(init());
    m.onEvent(use("t1", "mcp__scout__current_site"));
    m.onEvent(answer("t1", true));
    m.onEvent(use("t2", "mcp__scout__current_site"));
    m.onEvent(answer("t2", false));
    expect(d.toolErrors).toEqual({ mcp__scout__current_site: 1 });
    expect(d.optionalToolFailed).toBe(false);
    m.onEvent(use("t3", "mcp__scout_bridge__lookup"));
    m.onEvent(answer("t3", true));
    m.onEvent(answer("unknown-id", true));
    expect(d.toolErrors).toEqual({ mcp__scout__current_site: 1, mcp__scout_bridge__lookup: 1 });
    expect(d.unattributedToolErrors).toBe(1);
    expect(d.optionalToolFailed).toBe(true);
    expect(stop.decision).toBeUndefined();
  });

  function requiredMonitor() {
    const d = details();
    const stop = new JobStop();
    const req = { ...expected, servers: [expected.servers[0]!, { name: "scout_bridge", tools: ["mcp__scout_bridge__lookup"], required: true, optionalTools: [] }] };
    const m = createStreamMonitor({ expected: req, allowedTools: new Set([...scoutTools, "mcp__scout_bridge__lookup"]), details: d, stop, clock: { now: () => 0 }, startedAt: 0 });
    m.onEvent(init());
    return { m, d, stop };
  }

  it("a required user tool every call of which errored fails the job at its end, never mid-stream", () => {
    const { m, d, stop } = requiredMonitor();
    m.onEvent(use("t1", "mcp__scout_bridge__lookup"));
    m.onEvent(answer("t1", true));
    m.onEvent(use("t2", "mcp__scout_bridge__lookup"));
    m.onEvent(answer("t2", true));
    expect(stop.decision).toBeUndefined();
    expect(m.requiredToolFailed()).toBe(true);
    expect(d.toolErrors).toEqual({ mcp__scout_bridge__lookup: 2 });
    expect(d.optionalToolFailed).toBe(false);
  });

  it("a required user tool with one success among its errors is only counted; an uncalled one never fails the job", () => {
    const { m, d, stop } = requiredMonitor();
    expect(m.requiredToolFailed()).toBe(false);
    m.onEvent(use("t1", "mcp__scout_bridge__lookup"));
    m.onEvent(answer("t1", true));
    m.onEvent(use("t2", "mcp__scout_bridge__lookup"));
    m.onEvent(answer("t2", false));
    m.onEvent(use("t3", "mcp__scout_bridge__lookup"));
    m.onEvent(answer("t3", true));
    expect(stop.decision).toBeUndefined();
    expect(m.requiredToolFailed()).toBe(false);
    expect(d.toolErrors).toEqual({ mcp__scout_bridge__lookup: 2 });
  });

  it("Scout's own tools never fail the job, even when every call errored", () => {
    const { m, d, stop } = requiredMonitor();
    m.onEvent(use("t1", "mcp__scout__current_site"));
    m.onEvent(answer("t1", true));
    m.onEvent(use("t2", "mcp__scout__recent_activity"));
    m.onEvent(answer("t2", true));
    expect(stop.decision).toBeUndefined();
    expect(m.requiredToolFailed()).toBe(false);
    expect(d.toolErrors).toEqual({ mcp__scout__current_site: 1, mcp__scout__recent_activity: 1 });
  });

  it("errors past the recorded tool-use bound are still counted, without names; such calls never prove a required tool failed", () => {
    const { m, d } = requiredMonitor();
    for (let i = 0; i < 70; i++) {
      m.onEvent(use(`t${i}`, "mcp__scout_bridge__lookup"));
      m.onEvent(answer(`t${i}`, true));
    }
    expect(d.toolErrors).toEqual({ mcp__scout_bridge__lookup: 64 });
    expect(d.unattributedToolErrors).toBe(6);
    expect(m.requiredToolFailed()).toBe(false);
  });

  it("an optional tool that did not load flags optionalToolFailed; the job goes on", () => {
    const { m, d, stop } = monitor();
    m.onEvent(init({ mcp_servers: [{ name: "scout", status: "connected" }, { name: "scout_bridge", status: "failed" }], tools: [...scoutTools, "StructuredOutput"] }));
    expect(d.optionalTools).toEqual([{ server: "scout_bridge", tool: "mcp__scout_bridge__lookup", status: "unavailable" }]);
    expect(d.optionalToolFailed).toBe(true);
    expect(stop.decision).toBeUndefined();
  });

  it("another CLI version is recorded and reported, never a stop", () => {
    const seen: (string | undefined)[] = [];
    const { m, d, stop } = monitor((v) => seen.push(v));
    m.onEvent(init({ claude_code_version: "2.1.300" }));
    expect(stop.decision).toBeUndefined();
    expect(d.cliVersionChanged).toBe(true);
    expect(d.cliVersion).toBe("2.1.300");
    expect(seen).toEqual(["2.1.300"]);
  });
});
