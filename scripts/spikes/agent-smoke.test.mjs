import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_OUTPUT_SCHEMA, buildArgv, buildPrompt, checkInit, readAuditFile, runAgent, runSmoke, SERVER_PATH, SOURCE_TOOLS, validateOutput, writeRunInputs } from "./agent-smoke.mjs";
import { buildFixture, CANDIDATES } from "./smoke-fixture.mjs";
import { expectNoSentinels } from "./test-helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const dirs = [];
function tmp(prefix = "scout-smoke-test-") {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("agent smoke: invocation", () => {
  it("builds the exact strict argv for a streamed run", () => {
    const runDir = "/r";
    const argv = buildArgv({ modelArgs: ["--model", "opus"], runDir, format: "stream-json" });
    expect(argv).toEqual([
      "--model", "opus",
      "-p", "--output-format", "stream-json", "--verbose",
      "--json-schema", JSON.stringify(AGENT_OUTPUT_SCHEMA),
      "--strict-mcp-config", "--mcp-config", "/r/mcp.json",
      "--tools", "", "--allowedTools", "mcp__sources__*",
      "--permission-mode", "dontAsk", "--disable-slash-commands", "--no-session-persistence",
      "--system-prompt-file", "/r/system.md", "--max-turns", "8",
    ]);
  });

  it("builds the production json form and the inline system-prompt fallback", () => {
    const json = buildArgv({ modelArgs: [], runDir: "/r", format: "json" });
    expect(json.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(json).not.toContain("--verbose");
    const inline = buildArgv({ modelArgs: [], runDir: "/r", format: "stream-json", systemPromptText: "SYS TEXT" });
    expect(inline).not.toContain("--system-prompt-file");
    expect(inline).not.toContain("--max-turns");
    expect(inline.slice(-2)).toEqual(["--system-prompt", "SYS TEXT"]);
  });

  it("writes an mcp.json with only the sources server and a data-only system prompt", () => {
    const runDir = tmp();
    writeRunInputs(runDir, {});
    const mcp = JSON.parse(readFileSync(join(runDir, "mcp.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["sources"]);
    const s = mcp.mcpServers.sources;
    expect(s.command).toBe(process.execPath);
    expect(isAbsolute(s.command)).toBe(true);
    expect(s.args).toEqual([SERVER_PATH, runDir]);
    expect(SERVER_PATH).toBe(join(HERE, "fixture-source-server.mjs"));
    expect(s.env).toBeUndefined();
    const sys = readFileSync(join(runDir, "system.md"), "utf8");
    expect(sys).toMatch(/evidence/i);
    expect(sys).not.toMatch(/billing|metered|invoice/i);
    expect(statSync(join(runDir, "mcp.json")).mode & 0o777).toBe(0o600);
    writeRunInputs(tmp(), { delayMs: 2000 });
  });

  it("adds the delay flag only in cancel mode", () => {
    const runDir = tmp();
    writeRunInputs(runDir, { delayMs: 2000 });
    const mcp = JSON.parse(readFileSync(join(runDir, "mcp.json"), "utf8"));
    expect(mcp.mcpServers.sources.args).toEqual([SERVER_PATH, runDir, "--delay-ms", "2000"]);
  });

  it("puts candidates in the prompt as data without preloading the answer or note content", () => {
    const p = buildPrompt(CANDIDATES, {});
    for (const c of CANDIDATES) expect(p).toContain(c.id);
    expect(p).not.toMatch(/Lumen|usage-based billing for|c02 is|relevant: /i);
    expect(buildPrompt(CANDIDATES, { cancel: true })).toMatch(/read_source/);
  });
});

const IDS = CANDIDATES.map((c) => c.id);
const AUDIT = [
  { type: "lifecycle", event: "start", pid: 1 },
  { type: "tool_call", tool: "list_sources", outcome: "ok", evidenceIds: [], docs: [] },
  { type: "tool_call", tool: "search_source", outcome: "ok", evidenceIds: ["e1", "e2"], docs: ["notes/usage-billing-project.md"] },
  { type: "tool_call", tool: "read_source", outcome: "ok", evidenceIds: ["e3"], docs: ["notes/usage-billing-project.md"] },
];
const okResult = (so) => ({ type: "result", subtype: "success", is_error: false, structured_output: so });

describe("agent smoke: output validation", () => {
  it("accepts a schema-valid ranking citing audited retrieval evidence", () => {
    const v = validateOutput(okResult({ status: "ok", items: [{ id: "c02", reason: "Metering is open work", evidenceIds: ["e1", "e3"] }] }), { candidateIds: IDS, audit: AUDIT });
    expect(v).toEqual({ ok: true, failures: [], output: { status: "ok", items: [{ id: "c02", reason: "Metering is open work", evidenceIds: ["e1", "e3"] }] } });
  });

  it("accepts {status:'empty'} exactly", () => {
    expect(validateOutput(okResult({ status: "empty" }), { candidateIds: IDS, audit: AUDIT }).ok).toBe(true);
    expect(validateOutput(okResult({ status: "empty", items: [] }), { candidateIds: IDS, audit: AUDIT }).ok).toBe(false);
  });

  it("rejects JSON that only appears in the result text (no brace-slicing)", () => {
    const ev = { type: "result", subtype: "success", is_error: false, result: '{"status":"empty"}' };
    expect(validateOutput(ev, { candidateIds: IDS, audit: AUDIT }).failures).toContain("output: no structured_output");
  });

  it.each([
    ["unknown candidate", { status: "ok", items: [{ id: "c99", reason: "x", evidenceIds: ["e1"] }] }, "output: unknown candidate id"],
    ["unaudited evidence", { status: "ok", items: [{ id: "c02", reason: "x", evidenceIds: ["e999"] }] }, "output: evidence id not returned by a retrieval tool"],
    ["long reason", { status: "ok", items: [{ id: "c02", reason: "x".repeat(141), evidenceIds: ["e1"] }] }, "output: schema violation"],
    ["extra key", { status: "ok", items: [{ id: "c02", reason: "x", evidenceIds: ["e1"], url: "u" }] }, "output: schema violation"],
    ["too many", { status: "ok", items: ["c02", "c05", "c07", "c10"].map((id) => ({ id, reason: "x", evidenceIds: ["e1"] })) }, "output: schema violation"],
    ["duplicate", { status: "ok", items: [{ id: "c02", reason: "x", evidenceIds: ["e1"] }, { id: "c02", reason: "y", evidenceIds: ["e1"] }] }, "output: duplicate candidate id"],
    ["no evidence", { status: "ok", items: [{ id: "c02", reason: "x", evidenceIds: [] }] }, "output: schema violation"],
    ["ok but empty", { status: "ok", items: [] }, "output: schema violation"],
  ])("rejects %s", (_n, so, failure) => {
    expect(validateOutput(okResult(so), { candidateIds: IDS, audit: AUDIT }).failures).toContain(failure);
  });

  it("does not count list_sources as evidence", () => {
    const audit = [{ type: "tool_call", tool: "list_sources", outcome: "ok", evidenceIds: ["e1"], docs: [] }];
    const v = validateOutput(okResult({ status: "ok", items: [{ id: "c02", reason: "x", evidenceIds: ["e1"] }] }), { candidateIds: IDS, audit });
    expect(v.failures).toContain("output: evidence id not returned by a retrieval tool");
  });

  it("rejects an error or non-success result envelope", () => {
    expect(validateOutput({ type: "result", subtype: "error_max_turns", is_error: true }, { candidateIds: IDS, audit: AUDIT }).failures).toContain("envelope: result is not a success");
    expect(validateOutput(undefined, { candidateIds: IDS, audit: AUDIT }).failures).toContain("envelope: no result event");
  });
});

const INIT = {
  type: "system",
  subtype: "init",
  tools: [...SOURCE_TOOLS],
  mcp_servers: [{ name: "sources", status: "connected" }],
  model: "claude-test",
  permissionMode: "dontAsk",
  apiKeySource: "none",
};

describe("agent smoke: init capability check", () => {
  it("accepts only the sources tools and server", () => {
    expect(checkInit(INIT)).toEqual({ ok: true, reasons: [], structuredOutputTool: false });
  });

  it("allows the internal structured-output tool by exact name and reports it", () => {
    expect(checkInit({ ...INIT, tools: [...SOURCE_TOOLS, "StructuredOutput"] })).toEqual({ ok: true, reasons: [], structuredOutputTool: true });
  });

  it.each([
    ["a builtin tool", { tools: [...SOURCE_TOOLS, "Bash"] }, "init: unexpected tools: Bash"],
    ["another MCP tool", { tools: [...SOURCE_TOOLS, "mcp__other__x"] }, "init: unexpected tools: mcp__other__x"],
    ["an unknown sources tool", { tools: [...SOURCE_TOOLS, "mcp__sources__write"] }, "init: unexpected tools: mcp__sources__write"],
    ["a missing retrieval tool", { tools: ["mcp__sources__list_sources"] }, "init: sources retrieval tools missing"],
    ["another MCP server", { mcp_servers: [{ name: "sources", status: "connected" }, { name: "x", status: "connected" }] }, "init: unexpected MCP servers"],
    ["a failed sources server", { mcp_servers: [{ name: "sources", status: "failed" }] }, "init: sources server not connected"],
    ["another permission mode", { permissionMode: "default" }, "init: permission mode is not dontAsk"],
    ["an API key route", { apiKeySource: "ANTHROPIC_API_KEY" }, "init: unexpected auth route"],
    ["a non-first-party provider", { apiProvider: "gateway" }, "init: unexpected auth route"],
  ])("aborts on %s", (_n, patch, reason) => {
    const r = checkInit({ ...INIT, ...patch });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain(reason);
  });
});

const FAKE = join(HERE, "fake-claude.mjs");
function makeFake(mode) {
  const dir = tmp("scout-fake-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "argv.log");
  const claude = join(bin, "claude");
  writeFileSync(claude, `#!/bin/sh\nFAKE_MODE='${mode}' FAKE_ARGV_LOG='${log}' exec '${process.execPath}' '${FAKE}' "$@"\n`);
  chmodSync(claude, 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { dir, bin, claude, log, calls };
}

function prepareRun({ delayMs = 0 } = {}) {
  const runDir = tmp("scout-run-");
  const fx = buildFixture(runDir);
  writeRunInputs(runDir, { delayMs });
  const cwd = tmp("scout-cwd-");
  return { runDir, cwd, ...fx };
}

async function runFake(mode, opts = {}) {
  const fake = makeFake(mode);
  const run = prepareRun(opts);
  const res = await runAgent({
    claudePath: fake.claude,
    env: { PATH: "/usr/bin:/bin", HOME: fake.dir },
    cwd: run.cwd,
    args: buildArgv({ modelArgs: ["--model", "opus"], runDir: run.runDir, format: opts.format ?? "stream-json" }),
    prompt: buildPrompt(CANDIDATES, {}),
    timeoutMs: opts.timeoutMs ?? 15_000,
    maxStdoutBytes: opts.maxStdoutBytes ?? 1024 * 1024,
    cancelAfterMs: opts.cancelAfterMs,
    killGraceMs: opts.killGraceMs ?? 2000,
    settleMs: 3000,
  });
  return { res, fake, run, audit: readAuditFile(join(run.runDir, "audit.jsonl")) };
}

describe("agent smoke: process control against a fake CLI", () => {
  it("runs a full retrieval over the real MCP server and cleans up the whole tree", async () => {
    const { res, fake, run, audit } = await runFake("ok");
    expect(res.abortReason).toBeUndefined();
    expect(res.initCheck.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    const v = validateOutput(res.result, { candidateIds: CANDIDATES.map((c) => c.id), audit });
    expect(v.ok).toBe(true);
    expect(res.toolUses).toEqual(["mcp__sources__list_sources", "mcp__sources__search_source", "mcp__sources__read_source", "mcp__sources__read_source"]);
    expect(res.tree.survivorsAfterSettle).toBe(0);
    expect(res.tree.owned).toBeGreaterThanOrEqual(1); // short-lived children may finish between polls
    expect(audit.at(-1)).toMatchObject({ type: "lifecycle", event: "exit" });
    expect(res.rawText).not.toContain(run.sentinel);
    const [call] = fake.calls();
    expect(call.cwd).toBe(run.cwd);
    expect(call.envKeys.filter((k) => !["PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING", "FAKE_MODE", "FAKE_ARGV_LOG", "OLDPWD"].includes(k))).toEqual(["HOME", "PATH"]);
  }, 20_000);

  it("aborts on unexpected capabilities before any tool use", async () => {
    const { res, audit } = await runFake("extra-tool");
    expect(res.abortReason).toBe("unexpected-capability");
    expect(res.initCheck.reasons).toContain("init: unexpected tools: Bash");
    expect(audit.filter((r) => r.type === "tool_call")).toEqual([]);
    expect(res.tree.survivorsAfterSettle).toBe(0);
  }, 20_000);

  it("aborts a streamed run that produces model output without an init event", async () => {
    // (The fake drives the server itself, so it can't show "no tool ran"; the
    // abort-before-tool-use path is covered by the extra-tool case.)
    const { res } = await runFake("no-init");
    expect(res.abortReason).toBe("unexpected-capability");
    expect(res.initCheck.reasons).toEqual(["init: no init event before model output"]);
    expect(res.tree.survivorsAfterSettle).toBe(0);
  }, 20_000);

  it("kills the whole owned group on timeout", async () => {
    const { res } = await runFake("hang", { timeoutMs: 1500 });
    expect(res.abortReason).toBe("timeout");
    expect(res.tree.beforeSignal).toBeGreaterThanOrEqual(2); // CLI + sleep
    expect(res.tree.survivorsAfterSettle).toBe(0);
  }, 20_000);

  it("also kills an owned descendant that left the process group", async () => {
    const { res } = await runFake("escape-group", { timeoutMs: 1500 });
    expect(res.tree.escaped).toBeGreaterThanOrEqual(1);
    expect(res.tree.survivorsAfterSettle).toBe(0);
  }, 20_000);

  it("escalates to SIGKILL after the grace period", async () => {
    const { res } = await runFake("ignore-term", { timeoutMs: 1000, killGraceMs: 500 });
    expect(res.tree.forcedKill).toBe(true);
    expect(res.tree.survivorsAfterSettle).toBe(0);
  }, 20_000);

  it("stops reading past the stdout byte limit", async () => {
    const { res } = await runFake("flood", { maxStdoutBytes: 256 * 1024 });
    expect(res.abortReason).toBe("stdout-limit");
    expect(res.tree.survivorsAfterSettle).toBe(0);
  }, 20_000);

  it("classifies an auth error result as a stop, and a 429 retry as an abort", async () => {
    expect((await runFake("auth-error")).res.stopReason).toBe("auth-or-quota");
    const rl = await runFake("rate-limit");
    expect(rl.res.abortReason).toBe("auth-or-quota");
    expect(rl.res.stopReason).toBe("auth-or-quota");
  }, 30_000);

  it("reports a pre-init unknown-option rejection as a compatibility error", async () => {
    const { res } = await runFake("unknown-option");
    expect(res.compatError).toBe(true);
    expect(res.init).toBeUndefined();
  }, 20_000);

  it("parses the production json envelope as one document", async () => {
    const { res, audit } = await runFake("ok", { format: "json" });
    expect(res.init).toBeUndefined();
    expect(validateOutput(res.result, { candidateIds: CANDIDATES.map((c) => c.id), audit }).ok).toBe(true);
  }, 20_000);

  it("cancels mid-run: SIGTERM to the group, source server exits, nothing survives 3s", async () => {
    const { res, audit } = await runFake("cancel", { delayMs: 2000, cancelAfterMs: 1500 });
    expect(res.abortReason).toBe("cancelled");
    expect(res.tree.beforeSignal).toBeGreaterThanOrEqual(2);
    expect(res.tree.survivorsAfterSettle).toBe(0);
    expect(res.tree.settleMs).toBeLessThanOrEqual(3000);
    expect(res.tree.sigtermToAllGoneMs).toBeLessThanOrEqual(3000);
    const start = audit.find((r) => r.event === "start");
    const exit = audit.find((r) => r.event === "exit");
    expect(exit).toBeDefined();
    expect(exit.pid).toBe(start.pid);
  }, 20_000);
});

const SUBSCRIPTION = () => ({ verdict: "subscription", reasons: [] });

async function smokeWithFake(mode, opts = {}) {
  const fake = makeFake(mode);
  const scratch = tmp("scout-smoke-scratch-");
  const ws = tmp("scout-smoke-ws-");
  const lines = [];
  const out = await runSmoke({
    parentEnv: { HOME: fake.dir, PATH: `${fake.bin}:/usr/bin:/bin`, ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" },
    scratchRoot: scratch,
    workspaceRoots: [ws],
    runs: opts.runs ?? 2,
    mode: opts.mode ?? "measure",
    timeoutMs: 15_000,
    cancelAfterMs: opts.cancelAfterMs,
    preflight: opts.preflight ?? SUBSCRIPTION,
    log: (l) => lines.push(l),
  });
  return { out, fake, scratch, lines };
}

function leftovers(scratch) {
  const all = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      all.push(relative(scratch, join(d, e.name)));
      if (e.isDirectory()) walk(join(d, e.name));
    }
  };
  walk(scratch);
  return all;
}

describe("agent smoke: orchestration against a fake CLI", () => {
  it("never spawns the CLI when the profile preflight is ambiguous", async () => {
    const { out, fake, scratch } = await smokeWithFake("ok", { preflight: () => ({ verdict: "ambiguous", reasons: ["env: gateway route"] }) });
    expect(out.code).not.toBe(0);
    expect(out.report.blocker).toBe("preflight");
    expect(out.report.preflightReasons).toEqual(["env: gateway route"]);
    expect(fake.calls()).toEqual([]);
    expect(leftovers(scratch).filter((p) => !p.endsWith("report.json") && p.includes("/"))).toEqual([]);
  }, 20_000);

  it("runs N streamed measurements plus one json envelope, validates them, and leaves only the report", async () => {
    const { out, fake, scratch, lines } = await smokeWithFake("ok", { runs: 2 });
    expect(out.code).toBe(0);
    expect(out.report.attempts.map((a) => [a.format, a.passed])).toEqual([["stream-json", true], ["stream-json", true], ["json", true]]);
    const a = out.report.attempts[0];
    expect(a).toMatchObject({ model: "fake-model-1", numTurns: 3, usage: { input_tokens: 100, output_tokens: 20 }, notionalCostUsd: 0.0123 });
    expect(a.retrievalCalls).toBeGreaterThanOrEqual(1);
    expect(a.items.map((i) => i.id)).toEqual(["c02", "c07"]);
    expect(a.unexpectedFiles).toEqual([]);
    expect(out.report.summary.streamed.p50WallMs).toBeGreaterThan(0);
    expect(out.report.flags.systemPrompt).toBe("--system-prompt-file");
    const calls = fake.calls();
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.envKeys).not.toContain("ANTHROPIC_API_KEY");
      expect(c.argv).toContain("--strict-mcp-config");
    }
    const left = leftovers(scratch);
    expect(left.filter((p) => p.includes("/"))).toEqual([expect.stringMatching(/report\.json$/)]);
    const text = readFileSync(join(scratch, left.find((p) => p.endsWith("report.json"))), "utf8") + lines.join("\n");
    expectNoSentinels(expect, text);
    expect(text).not.toContain("fake-session-id");
    expect(text).not.toContain(fake.dir);
    expect(text).not.toMatch(/SCOUT-SENTINEL-DENIED-[0-9a-f]/);
    expect(text).not.toContain("Candidate links from the current page");
  }, 60_000);

  it("falls back to an inline system prompt once when the CLI rejects the file flags before running", async () => {
    const { out, fake } = await smokeWithFake("unknown-option", { runs: 1 });
    expect(out.code).toBe(0);
    expect(out.report.flags).toEqual({ systemPrompt: "--system-prompt", maxTurns: "not passed (rejected by CLI)" });
    expect(fake.calls()).toHaveLength(3); // rejected attempt + streamed + json
    expect(out.report.attempts[0]).toMatchObject({ passed: false, failures: ["cli: rejected --max-turns/--system-prompt-file before running"] });
  }, 60_000);

  it("stops at the first auth or quota error instead of retrying", async () => {
    const { out, fake } = await smokeWithFake("auth-error", { runs: 5 });
    expect(out.code).not.toBe(0);
    expect(out.report.blocker).toBe("auth-or-quota");
    expect(fake.calls()).toHaveLength(1);
  }, 20_000);

  it("reports files the CLI created in its directories instead of ignoring them", async () => {
    const { out, fake } = await smokeWithFake("stray-file", { runs: 3 });
    expect(out.report.attempts[0].unexpectedFiles).toEqual(["cwd:stray.txt"]);
    expect(out.report.attempts[0].passed).toBe(false);
    expect(out.report.blocker).toBe("unexpected-files");
    expect(out.report.attempts).toHaveLength(1);
    expect(fake.calls()).toHaveLength(1);
  }, 60_000);

  it("stops once, without retrying, when a streamed run never reports init", async () => {
    const { out, fake } = await smokeWithFake("no-init", { runs: 3 });
    expect(out.code).not.toBe(0);
    expect(out.report.blocker).toBe("unexpected-capability");
    expect(out.report.attempts).toHaveLength(1);
    expect(out.report.attempts[0].init).toBeUndefined();
    expect(fake.calls()).toHaveLength(1);
  }, 20_000);

  it("fails a completed streamed run whose source tool calls are not all audited", async () => {
    const { out } = await smokeWithFake("malformed-arg", { runs: 1 });
    const a = out.report.attempts[0];
    expect(a.passed).toBe(false);
    expect(a.checks.streamToolUsesMatchAudit).toBe(false);
    expect(a.failures).toContain("audit: streamed source tool calls do not match audit records");
    expect(out.code).not.toBe(0);
  }, 60_000);

  it("rejects a scratch root inside a workspace (including a case alias) before creating anything or calling the CLI", async () => {
    const fake = makeFake("ok");
    const ws = join(tmp("scout-smoke-wsparent-"), "CaseWs");
    mkdirSync(join(ws, "Scratch"), { recursive: true });
    const scratchAliases = [join(ws, "Scratch")];
    const alias = join(dirname(ws), "casews", "scratch");
    if (existsSync(alias)) scratchAliases.push(alias);
    for (const scratchRoot of [...scratchAliases, join(ws, "missing"), "relative/dir"]) {
      const out = await runSmoke({ parentEnv: { HOME: fake.dir, PATH: `${fake.bin}:/usr/bin:/bin` }, scratchRoot, workspaceRoots: [ws], runs: 1, preflight: SUBSCRIPTION });
      expect(out.code).toBe(2);
      expect(out.report.blocker).toBe("scratch-root");
      expect(out.report.reportPath).toBeUndefined();
    }
    expect(readdirSync(join(ws, "Scratch"))).toEqual([]);
    expect(fake.calls()).toEqual([]);
  }, 20_000);

  it("cancel mode: one delayed run, SIGTERM at the cancel point, verified cleanup", async () => {
    const { out } = await smokeWithFake("cancel", { mode: "cancel", cancelAfterMs: 1500 });
    expect(out.report.attempts).toHaveLength(1);
    const a = out.report.attempts[0];
    expect(a.abortReason).toBe("cancelled");
    expect(a.tree.survivorsAfterSettle).toBe(0);
    expect(a.sourceServer).toMatchObject({ exited: true, leftCliProcessGroup: false });
    expect(out.code).toBe(0);
  }, 30_000);
});

describe("agent smoke: entrypoint", () => {
  it("refuses to run without SCOUT_LIVE=1", () => {
    const fake = makeFake("ok");
    const r = spawnSync(process.execPath, [join(HERE, "agent-smoke.mjs"), "--scratch-root", tmp()], {
      env: { HOME: fake.dir, PATH: `${fake.bin}:/usr/bin:/bin` },
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/SCOUT_LIVE=1/);
    expect(fake.calls()).toEqual([]);
  });
});
