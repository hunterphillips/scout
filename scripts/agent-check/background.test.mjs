// verify:agent --case baseline|selected-tool|cancel against the scripted fake CLI, which
// starts the real scout-mcp server (and, with a selected tool, the real per-job bridge and
// fake-backend.mjs) from the job's mcp.json. No model, no real config.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

  it("runs a job with an API-key login", async () => {
    const w = makeWorld("auth-api-key");
    const r = await w.run(["--case", "baseline"]);
    expect(r.code, r.text).toBe(0);
    expect(r.report).toMatchObject({ outcome: "ok", preflight: { verdict: "ready" } });
    expect(jobLaunches(w)).toHaveLength(1);
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
    expect(rep.preflight).toMatchObject({ verdict: "ready", cliVersion: "2.1.286" });
    expect(rep.result.items.map((i) => [i.id, i.title])).toEqual([
      ["c1", "Usage-based billing guide"],
      ["c2", "Careers"],
    ]);
    expect(rep.inputs).toBeUndefined();
    expect(rep.details.toolUses).toEqual(["mcp__scout__current_site", "mcp__scout__recent_activity"]);
    expect(rep.details).toMatchObject({ termination: "completed", model: "claude-haiku-5-5", cliVersion: "2.1.286" });
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

  it("runs a Codex job with an API-key login", async () => {
    const w = makeWorld("ok", { adapter: "codex" });
    w.setLogin("api-key");
    const r = await w.run(["--case", "baseline"]);
    expect(r.code, r.text).toBe(0);
    expect(r.report).toMatchObject({ adapter: "codex", outcome: "ok", preflight: { verdict: "ready" } });
    expect(codexLaunches(w)).toHaveLength(1);
  });

  it("baseline: ok with picks through Scout's tools, one request, clean up", async () => {
    const w = makeWorld("ok", { adapter: "codex" });
    let token;
    const r = await w.run(["--case", "baseline"], { hooks: { onStart: (c) => void (token = c.token) } });
    expect(r.code, r.text).toBe(0);
    const rep = r.report;
    expect(rep).toMatchObject({ case: "baseline", adapter: "codex", pass: true, outcome: "ok", failures: [] });
    expect(rep.preflight).toMatchObject({ verdict: "ready", cliVersion: "0.155.1" });
    expect(rep.result.items.map((i) => i.id)).toEqual(["c1", "c2"]);
    expect(rep.details).toMatchObject({ termination: "completed", model: "gpt-6-luna", cliVersion: "0.155.1", toolUses: ["mcp__scout__current_site"] });
    expect(rep.init).toEqual({ seen: true, event: "thread.started" });
    expect(rep.argv).toEqual(expect.arrayContaining(["exec", "--ephemeral", "--ignore-user-config", "read-only"]));
    expect(rep.cleanup).toMatchObject({ ok: true, jobDirRemoved: true, processesRemaining: 0, fixtureConnectionsAtEnd: 0 });
    const [launch] = codexLaunches(w);
    expect(launch.violations).toEqual([]);
    expect(JSON.parse(readFileSync(join(w.scoutHome, "agent-profile.json"), "utf8"))).toMatchObject({ adapter: "codex", codexPath: w.codex, model: "gpt-6-luna" });
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

// ---------- baseline on a real case: --candidates and --activity ----------

const CASE_ORIGIN = "https://shop.example.net";
const caseCandidate = (n, title, extra = {}) => ({ id: `c${n.toString(36)}`, sourceUrl: `${CASE_ORIGIN}/p/${n}`, title, labelQuality: "published", provenance: "sitemap", ...extra });

/** A file shaped like Scout's catalog cache (`~/.scout/cache/catalog/<host>-<hash>.json`). */
function writeCatalog(w, candidates, name = "catalog.json") {
  const file = join(w.root, name);
  writeFileSync(file, JSON.stringify({ schema: 3, origin: CASE_ORIGIN, catalog: { origin: CASE_ORIGIN, version: "v-real", fetchedAt: 1, candidates, truncated: false, errors: [] } }));
  return file;
}

function writeJson(w, name, value) {
  const file = join(w.root, name);
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

const ACTIVITY = [
  { url: "https://news.example.org/a/espresso-grinders", title: "Burr grinders compared", text: "Flat and conical burrs, tested over a month." },
  { url: "https://forum.example.org/t/42", title: "Descaling a home espresso machine" },
];

describe("background: baseline with --candidates and --activity", () => {
  it("the job request carries the file's candidates, and the report names the picks and counts the inputs", async () => {
    const w = makeWorld("ok");
    const candidates = [caseCandidate(10, "Flat burr grinder", { description: "64 mm burrs" }), caseCandidate(11, "Descaling kit"), caseCandidate(12, "Gift cards")];
    const r = await w.run(["--case", "baseline", "--candidates", writeCatalog(w, candidates), "--activity", writeJson(w, "activity.json", ACTIVITY)]);
    expect(r.code, r.text).toBe(0);
    const prompt = w.lines().find((l) => typeof l.prompt === "string").prompt;
    for (const c of candidates) expect(prompt).toContain(`${c.id} | ${c.title}`);
    expect(prompt).not.toContain("Usage-based billing guide");
    expect(r.report.result.items).toEqual([
      { id: "ca", title: "Flat burr grinder", url: `${CASE_ORIGIN}/p/10`, reason: expect.any(String) },
      { id: "cb", title: "Descaling kit", url: `${CASE_ORIGIN}/p/11`, reason: expect.any(String) },
    ]);
    expect(r.report.inputs).toEqual({ candidates: 3, origin: CASE_ORIGIN, activity: 2 });
    expect(r.text).toContain(`pick ca: Flat burr grinder <${CASE_ORIGIN}/p/10>`);
  });

  it("takes a plain array of candidates, the site being the first one's origin", async () => {
    const w = makeWorld("ok");
    const r = await w.run(["--case", "baseline", "--candidates", writeJson(w, "list.json", [caseCandidate(1, "One"), caseCandidate(2, "Two")])]);
    expect(r.code, r.text).toBe(0);
    expect(r.report.inputs).toEqual({ candidates: 2, origin: CASE_ORIGIN });
    expect(r.report.result.items.map((i) => i.title)).toEqual(["One", "Two"]);
  });

  it("--dry-run prints the files and their counts and launches nothing", async () => {
    const w = makeWorld("ok", { adapter: "codex" });
    const cat = writeCatalog(w, [caseCandidate(1, "One"), caseCandidate(2, "Two")]);
    const act = writeJson(w, "activity.json", ACTIVITY);
    const before = snapshotTree(w.root);
    const r = await w.run(["--case", "baseline", "--candidates", cat, "--activity", act, "--dry-run"]);
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain(`candidates: ${cat} (2 on ${CASE_ORIGIN})`);
    expect(r.text).toContain(`activity: ${act} (2 pages)`);
    expect(snapshotTree(w.root)).toEqual(before);
    expect(w.lines()).toEqual([]);
  });

  it("refuses the options outside baseline", async () => {
    const w = makeWorld("ok");
    const file = writeJson(w, "activity.json", ACTIVITY);
    for (const c of ["selected-tool", "cancel", "hotload"]) {
      const r = await w.run(["--case", c, "--activity", file]);
      expect(r.code).toBe(2);
      expect(r.text).toContain("--case baseline only");
    }
    expect(w.lines()).toEqual([]);
  });

  it.each([
    ["--candidates", "not json", "--candidates must name a readable JSON file"],
    ["--candidates", [caseCandidate(1, "x".repeat(161))], "--candidates: [0].title: "],
    ["--candidates", [caseCandidate(1, "A"), caseCandidate(1, "B")], "--candidates: duplicate candidate id"],
    ["--candidates", { catalog: { origin: CASE_ORIGIN, candidates: [] } }, "--candidates: "],
    ["--candidates", Array.from({ length: 501 }, (_, i) => caseCandidate(i, `T${i}`)), "--candidates: "],
    ["--activity", [{ url: "http://plain.example.org/", title: "Plain http" }], "--activity: [0].url: not an https URL"],
    ["--activity", [{ url: "https://a.example.org/", title: "Long", text: "x".repeat(8 * 1024 + 1) }], "--activity: [0].text: "],
    ["--activity", Array.from({ length: 11 }, (_, i) => ({ url: `https://a.example.org/${i}`, title: `P${i}` })), "--activity: "],
    ["--activity", { url: "https://a.example.org/", title: "Not a list" }, "--activity: must be a JSON array"],
  ])("refuses an invalid %s file with a clear message", async (flag, value, message) => {
    const w = makeWorld("ok");
    const r = await w.run(["--case", "baseline", flag, writeJson(w, "bad.json", value)]);
    expect(r.code).toBe(2);
    expect(r.text).toContain(message);
    expect(w.lines()).toEqual([]);
    expect(w.reports()).toEqual([]);
  });
});
