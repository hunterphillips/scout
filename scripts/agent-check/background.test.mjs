// verify:agent --case baseline|selected-tool|cancel against the scripted fake CLI, which
// starts the real scout-mcp server (and, with a selected tool, the real per-job bridge and
// fake-backend.mjs) from the job's mcp.json. No model, no real config.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWorlds, makeWorld, SENTINELS, snapshotTree } from "./test-support.mjs";

afterEach(cleanupWorlds);

function expectClean(w, r, token) {
  expect(r.reportText).toBeDefined();
  for (const s of [token, w.home, homedir(), ...SENTINELS]) expect(r.reportText).not.toContain(s);
}

const jobLaunches = (w) => w.lines().filter((l) => Array.isArray(l.argv) && l.argv.includes("-p"));

describe("background: dry run and refusals", () => {
  it.each(["baseline", "selected-tool", "cancel"])("%s --dry-run prints the plan and writes and launches nothing", async (c) => {
    const w = makeWorld("ok");
    const before = snapshotTree(w.root);
    const r = await w.run(["--case", c, "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.text).toContain("--strict-mcp-config");
    expect(r.text).toContain("inference requests: 1");
    if (c === "selected-tool") expect(r.text).toContain("mcp__scout_bridge__lookup");
    expect(snapshotTree(w.root)).toEqual(before);
    expect(w.lines()).toEqual([]);
  });

  it("refuses hotload-only options", async () => {
    const w = makeWorld("ok");
    const r = await w.run(["--case", "baseline", "--authorize-real-root"]);
    expect(r.code).toBe(2);
    expect(w.lines()).toEqual([]);
  });

  it("launches no job when the preflight is not subscription", async () => {
    const w = makeWorld("auth-api-key");
    const r = await w.run(["--case", "baseline"]);
    expect(r.code).toBe(1);
    expect(r.report).toMatchObject({ outcome: "preflight_failed", inferenceRequests: [] });
    expect(jobLaunches(w)).toEqual([]);
  });
});

describe("background: cases", () => {
  it("baseline: ok with picks through Scout's tools, one request, clean up", async () => {
    const w = makeWorld("ok");
    let token;
    const r = await w.run(["--case", "baseline"], { hooks: { onStart: (c) => void (token = c.token) } });
    expect(r.code, r.text).toBe(0);
    const rep = r.report;
    expect(rep).toMatchObject({ case: "baseline", pass: true, outcome: "ok", failures: [] });
    expect(rep.preflight).toMatchObject({ verdict: "subscription", cliVersion: "2.1.286" });
    expect(rep.result.items.map((i) => i.id)).toEqual(["c1", "c2"]);
    expect(rep.details.toolUses).toEqual(["mcp__scout__current_site", "mcp__scout__recent_activity"]);
    expect(rep.details).toMatchObject({ termination: "completed", model: "claude-sonnet-5-5", cliVersion: "2.1.286" });
    expect(rep.details.usage.outputTokens).toBe(20);
    expect(rep.init.mcpServers).toEqual([{ name: "scout", status: "connected" }]);
    expect(rep.argv).toEqual(expect.arrayContaining(["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]));
    expect(rep.inferenceRequests).toHaveLength(1);
    expect(rep.cleanup).toMatchObject({ ok: true, jobDirRemoved: true, processesRemaining: 0, fixtureConnectionsAtEnd: 0 });
    expect(jobLaunches(w)).toHaveLength(1);
    expect(existsSync(join(w.scoutHome, "agent-profile.json"))).toBe(true);
    expectClean(w, r, token);
  });

  it("selected-tool: the bridged tool is called and its reply reaches the answer", async () => {
    const w = makeWorld("bridge-call");
    let token;
    const r = await w.run(["--case", "selected-tool"], { hooks: { onStart: (c) => void (token = c.token) } });
    expect(r.code, r.text).toBe(0);
    expect(r.report.selectedTool).toMatchObject({ bridgedToolUsed: true, backendCalls: 1, proofPhraseInReasons: true });
    expect(r.report.details.toolUses).toContain("mcp__scout_bridge__lookup");
    expect(r.report.init.mcpServers).toEqual([
      { name: "scout", status: "connected" },
      { name: "scout_bridge", status: "connected" },
    ]);
    const profile = JSON.parse(readFileSync(join(w.scoutHome, "agent-profile.json"), "utf8"));
    expect(profile.tools.selections.map((s) => s.toolName)).toEqual(["lookup"]);
    expect(profile.tools.connections[0].literalEnv).toEqual({ SCOUT_CHECK: "synthetic" });
    expect(profile.tools.connections[0].env).toEqual({});
    expectClean(w, r, token);
  });

  it("selected-tool fails when the tool is only listed, never called", async () => {
    const w = makeWorld("ok");
    const r = await w.run(["--case", "selected-tool"]);
    expect(r.code).toBe(1);
    expect(r.report.failures).toContain("selected_tool_not_called");
  });

  it("cancel: cancelled after init, no process left, no connection open, job dir gone", async () => {
    const w = makeWorld("hang");
    let token;
    const r = await w.run(["--case", "cancel"], { hooks: { onStart: (c) => void (token = c.token) } });
    expect(r.code, r.text).toBe(0);
    expect(r.report).toMatchObject({ outcome: "cancelled", pass: true });
    expect(r.report.result).toMatchObject({ status: "cancelled", reason: "superseded" });
    expect(r.report.cancel.cancelAfterInitMs).toBe(300);
    expect(r.report.cleanup).toMatchObject({ ok: true, jobDirRemoved: true, processesRemaining: 0, fixtureConnectionsAtEnd: 0 });
    expect(r.report.cleanup.processesSeen).toBeGreaterThanOrEqual(2);
    expect(r.report.inferenceRequests).toHaveLength(1);
    expectClean(w, r, token);
  });

  it("cancel fails when the job finishes before the cancel", async () => {
    const w = makeWorld("ok");
    const r = await w.run(["--case", "cancel"], { cancelAfterInitMs: 5000 });
    expect(r.code).toBe(1);
    expect(r.report.failures).toContain("not_cancelled");
  });
});
