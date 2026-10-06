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

// ---------- --adapter codex: the same cases through the Codex adapter and the fake codex ----------

const codexLaunches = (w) => w.lines().filter((l) => Array.isArray(l.argv) && l.argv[0] === "exec");

describe("background --adapter codex", () => {
  it.each(["baseline", "selected-tool", "cancel"])("%s --dry-run prints the Codex plan and writes and launches nothing", async (c) => {
    const w = makeWorld("ok", { adapter: "codex" });
    const before = snapshotTree(w.root);
    const r = await w.run(["--case", c, "--dry-run"]);
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain("adapter: codex");
    expect(r.text).toContain("exec --json --ephemeral");
    expect(r.text).toContain("codex login status");
    expect(r.text).toContain("inference requests: 1");
    expect(snapshotTree(w.root)).toEqual(before);
    expect(w.lines()).toEqual([]);
  });

  it("refuses hotload, --claude with codex, and --codex without it", async () => {
    const w = makeWorld("ok", { adapter: "codex" });
    expect((await w.run(["--case", "hotload", "--preliminary"])).code).toBe(2);
    expect((await w.run(["--case", "baseline", "--claude", w.claude])).code).toBe(2);
    const c = makeWorld("ok");
    expect((await c.run(["--case", "baseline", "--codex", c.codex])).code).toBe(2);
    expect([...w.lines(), ...c.lines()]).toEqual([]);
  });

  it("launches no job when the login is not ChatGPT", async () => {
    const w = makeWorld("ok", { adapter: "codex" });
    w.setLogin("api-key");
    const r = await w.run(["--case", "baseline"]);
    expect(r.code).toBe(1);
    expect(r.report).toMatchObject({ adapter: "codex", outcome: "preflight_failed", inferenceRequests: [], preflight: { verdict: "ambiguous", reasons: ["not_chatgpt"] } });
    expect(codexLaunches(w)).toEqual([]);
  });

  it("baseline: ok with picks through Scout's tools, one request, clean up", async () => {
    const w = makeWorld("ok", { adapter: "codex" });
    let token;
    const r = await w.run(["--case", "baseline"], { hooks: { onStart: (c) => void (token = c.token) } });
    expect(r.code, r.text).toBe(0);
    const rep = r.report;
    expect(rep).toMatchObject({ case: "baseline", adapter: "codex", pass: true, outcome: "ok", failures: [] });
    expect(rep.preflight).toMatchObject({ verdict: "subscription", cliVersion: "0.155.1" });
    expect(rep.result.items.map((i) => i.id)).toEqual(["c1", "c2"]);
    expect(rep.details).toMatchObject({ termination: "completed", model: "gpt-6-sol", cliVersion: "0.155.1", toolUses: ["mcp__scout__current_site"] });
    expect(rep.init).toEqual({ seen: true, event: "thread.started" });
    expect(rep.argv).toEqual(expect.arrayContaining(["exec", "--ephemeral", "--ignore-user-config", "read-only"]));
    expect(rep.cleanup).toMatchObject({ ok: true, jobDirRemoved: true, processesRemaining: 0, fixtureConnectionsAtEnd: 0 });
    const [launch] = codexLaunches(w);
    expect(launch.violations).toEqual([]);
    expect(JSON.parse(readFileSync(join(w.scoutHome, "agent-profile.json"), "utf8"))).toMatchObject({ adapter: "codex", codexPath: w.codex, model: "gpt-6-sol" });
    expectClean(w, r, token);
  });

  it("selected-tool: the bridged tool is called and its reply reaches the answer", async () => {
    const w = makeWorld("bridge-call", { adapter: "codex" });
    let token;
    const r = await w.run(["--case", "selected-tool"], { hooks: { onStart: (c) => void (token = c.token) } });
    expect(r.code, r.text).toBe(0);
    expect(r.report.selectedTool).toMatchObject({ bridgedToolUsed: true, backendCalls: 1, proofPhraseInReasons: true });
    expect(codexLaunches(w)[0].argv).toContain("mcp_servers.scout_bridge.required=true");
    expectClean(w, r, token);
  });

  it("cancel: cancelled after thread.started, no process left, no connection open, job dir gone", async () => {
    const w = makeWorld("hang", { adapter: "codex" });
    let token;
    const r = await w.run(["--case", "cancel"], { hooks: { onStart: (c) => void (token = c.token) } });
    expect(r.code, r.text).toBe(0);
    expect(r.report).toMatchObject({ outcome: "cancelled", pass: true });
    expect(r.report.result).toMatchObject({ status: "cancelled", reason: "superseded" });
    expect(r.report.cleanup).toMatchObject({ ok: true, jobDirRemoved: true, processesRemaining: 0, fixtureConnectionsAtEnd: 0 });
    expect(r.report.cleanup.processesSeen).toBeGreaterThanOrEqual(2);
    expectClean(w, r, token);
  });
});
