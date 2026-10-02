// Phase 3 automated verification, end to end: the built native host and core, the real
// scout-mcp adapter and agent.sock, the scripted fake `claude` (never a model) and its fake
// retrieval backend, in a temp SCOUT_HOME. DNS is stubbed in the core (`--import`): every
// lookup is recorded and either never answers or answers loopback (which the fetch policy
// refuses), per a mode file, so nothing leaves the machine. Builds nothing; run
// `npm run build` first.
//
//   B10: success, intentional empty, malformed output, unknown and duplicate IDs, failed
//        targets, quota and auth denial (at run time and at the billing preflight), required-tool
//        failure and timeout, each with the exact `results` frame the window gets.
//   B11: click authorization (`open_link`) after a tab, document and app switch, and a tab
//        switch during model execution, through the real processes.
//   B7/B12/B13: permission loss, pause, resource revoke, deadline and shutdown each end the
//        running job (its token refused on agent.sock, its process gone, the window out of
//        `working`), GitHub grant loss clears captured activity, and no fixture text reaches
//        the diagnostics file or the core's stderr.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { endianness, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = join(ROOT, "packages/scout-core/dist/main.js");
const HOST = join(ROOT, "packages/native-host/dist/host.js");
const MCP_CLIENT = join(ROOT, "packages/scout-mcp/dist/client.js");
const FAKE_CLAUDE = join(ROOT, "packages/scout-core/src/agents/testing/fake-claude.mjs");
const FAKE_BACKEND = join(ROOT, "packages/scout-core/src/agents/testing/fake-backend.mjs");
const BUILT = existsSync(CORE) && existsSync(HOST) && existsSync(MCP_CLIENT);
if (!BUILT) console.warn("phase3: skipped: run `npm run build` first");

const EXT_ID = "a".repeat(32);
const HOSTNAME = "docs.scout-p3.invalid";
const SITE = `https://${HOSTNAME}`;
const ISSUE = "https://github.com/o/r/issues/7";
// Fixture text that must never reach a log.
const TITLE = "P3V-SECRET-ISSUE-TITLE";
const BODY = "P3V-SECRET-ISSUE-BODY";
const RESOURCE_TEXT = "P3V-SECRET-RESOURCE-TEXT: how to bill by usage\n".repeat(900);
const CANDIDATES = ["alpha", "bravo", "charlie", "delta"].map((p, i) => ({
  id: `c${i}`,
  sourceUrl: `${SITE}/docs/${p}`,
  title: `P3V-SECRET-CANDIDATE-${p}`,
  labelQuality: "published",
  provenance: "llms.txt",
}));
const REASON = "Fits the open billing work";
const LE = endianness() === "LE";
const LOOKUP_SCHEMA = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  if (LE) head.writeUInt32LE(body.length);
  else head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

async function until(cond, what, ms = 20_000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

const readLines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** DNS that records every lookup and, per `dns-mode`, never answers (`hang`) or answers loopback (`loopback`, refused by the fetch policy). */
function dnsStub(dir) {
  const log = join(dir, "dns.log");
  const mode = join(dir, "dns-mode");
  writeFileSync(mode, "hang");
  const path = join(dir, "dns-stub.mjs");
  writeFileSync(
    path,
    [
      'import dns from "node:dns";',
      'import { appendFileSync, readFileSync } from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      `const record = (host) => appendFileSync(${JSON.stringify(log)}, String(host) + "\\n");`,
      `const mode = () => readFileSync(${JSON.stringify(mode)}, "utf8").trim();`,
      "const loop = { address: '127.0.0.1', family: 4 };",
      "dns.promises.lookup = (host, opts) => { record(host); return mode() === 'loopback' ? Promise.resolve(opts && opts.all ? [loop] : loop) : new Promise(() => {}); };",
      "dns.lookup = (host, ...rest) => { record(host); const cb = rest.at(-1); if (typeof cb === 'function') process.nextTick(cb, Object.assign(new Error('stubbed'), { code: 'ENOTFOUND' })); };",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
  );
  return { importArg: pathToFileURL(path).href, hosts: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []), set: (m) => writeFileSync(mode, m) };
}

/** The agent profile: the fake CLI, and optionally the fake backend's `lookup` as a selected tool. */
function profileJson(home, { revision = 0, tool, claude = "claude" } = {}) {
  const profile = { schemaVersion: 1, adapter: "claude-code", claudePath: join(home, "bin", claude), model: "claude-sonnet-5-5" };
  if (tool) {
    profile.tools = {
      revision,
      connections: [{ id: "notes", transport: "stdio", command: join(home, "bin", "notes"), args: [], env: {} }],
      selections: [
        {
          connectionId: "notes",
          toolName: "lookup",
          description: "Reviewed lookup",
          inputSchema: LOOKUP_SCHEMA,
          schemaHash: tool.schemaHash,
          required: tool.required,
          unattendedReadDeclared: true,
          selectedAt: "2026-10-01T12:00:00.000Z",
        },
      ],
    };
  }
  return JSON.stringify(profile);
}

/** Replace the profile the way an editor's rename-save does. */
function saveProfile(home, json) {
  const tmp = join(home, ".agent-profile.tmp");
  writeFileSync(tmp, json, { mode: 0o600 });
  renameSync(tmp, join(home, "agent-profile.json"));
}

/** A temp home: the fake agent (mode per launch from `fake-mode`), its backend, a fresh cached catalog, the site enabled. */
async function makeHome(prefix, { browserContext = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const userHome = join(home, "u");
  mkdirSync(join(userHome, ".claude"), { recursive: true });
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ extensionId: EXT_ID, destinations: [HOSTNAME], agentBrowserContext: browserContext }));
  writeFileSync(join(home, "fake-mode"), "ok");
  writeFileSync(join(home, "backend-mode"), "honest");
  const claudePath = join(home, "bin", "claude");
  writeFileSync(claudePath, `#!/bin/sh\nFAKE_MODE="$(cat '${home}/fake-mode')" FAKE_VERSION=2.1.286 FAKE_LOG='${home}/fake.log' exec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`);
  const notesPath = join(home, "bin", "notes");
  writeFileSync(notesPath, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_BACKEND}' --mode "$(cat '${home}/backend-mode')" --log '${home}/notes.log'\n`);
  // The same fake CLI whose `auth status` reports an API-key login (the billing preflight's refusal).
  const apiKeyPath = join(home, "bin", "claude-apikey");
  writeFileSync(apiKeyPath, `#!/bin/sh\nFAKE_MODE=auth-api-key FAKE_VERSION=2.1.286 FAKE_LOG='${home}/fake.log' exec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`);
  chmodSync(claudePath, 0o755);
  chmodSync(notesPath, 0o755);
  chmodSync(apiKeyPath, 0o755);
  writeFileSync(join(home, "agent-profile.json"), profileJson(home), { mode: 0o600 });
  const { cacheFileName } = await import(join(ROOT, "packages/scout-core/dist/privateCacheFile.js"));
  const now = Date.now();
  mkdirSync(join(home, "cache", "catalog"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, "cache", "catalog", cacheFileName(SITE)),
    JSON.stringify({ schemaVersion: 3, origin: SITE, fetchedAt: now, resources: [], catalog: { origin: SITE, version: "p3v-v1", fetchedAt: now, candidates: CANDIDATES, truncated: false, errors: [] } }),
    { mode: 0o600 },
  );
  // Only what the launch profile and the preflight need: no gateway, no API key, a throwaway HOME.
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: userHome, USER: "p3v", LOGNAME: "p3v", LANG: "en_US.UTF-8", TMPDIR: tmpdir(), SCOUT_HOME: home };
  return { home, env };
}

/** Host and core started, Chrome frontmost, the sensor ready. */
async function boot(home, env, children) {
  const dns = dnsStub(home);
  const host = spawn(process.execPath, [HOST, `chrome-extension://${EXT_ID}/`], { env, stdio: ["pipe", "pipe", "pipe"] });
  children.push(host);
  const toChrome = [];
  let buf = Buffer.alloc(0);
  host.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const n = LE ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
      if (buf.length < 4 + n) break;
      toChrome.push(JSON.parse(buf.subarray(4, 4 + n).toString("utf8")));
      buf = buf.subarray(4 + n);
    }
  });
  host.stderr.resume();
  const core = spawn(process.execPath, ["--import", dns.importArg, CORE, "--stdio"], { env: { ...env, SCOUT_DWELL_MS: "300" }, cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  children.push(core);
  let out = "";
  let err = "";
  core.stdout.on("data", (c) => (out += c));
  core.stderr.on("data", (c) => (err += c));
  core.stdin.on("error", () => {});
  const exited = new Promise((resolve) => core.once("exit", (code, signal) => resolve({ code, signal })));
  const panel = () => out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const command = (obj) => core.stdin.write(`${JSON.stringify(obj)}\n`);
  command({ type: "frontmost", bundleId: "com.google.Chrome", at: Date.now() });
  await until(() => toChrome.some((f) => f.type === "ready"), "ready from the host");
  let seq = 0;
  let permRev = 0;
  const sense = (obj) => host.stdin.write(frame({ seq: ++seq, at: Date.now(), ...obj }));
  const grant = (granted, githubCapture) => {
    permRev += 1;
    host.stdin.write(frame({ kind: "permissions", revision: permRev, at: Date.now(), granted, githubCapture }));
  };
  const focus = (tabId, path, documentId) =>
    sense({ kind: "focus", browserFocused: true, windowId: 1, tabId, url: path.startsWith("https://") ? path : `${SITE}${path}`, title: "Docs", incognito: false, permissionsRevision: permRev, ...(documentId ? { documentId } : {}) });
  const diagEvents = () => readLines(join(home, "logs", "diagnostics.jsonl"));
  return { host, core, toChrome, panel, command, sense, grant, focus, dns, exited, diagEvents, stderr: () => err, fake: () => readLines(join(home, "fake.log")) };
}

/** Capture one GitHub issue (title and body are fixture secrets) through the real gate. */
async function captureIssue(b) {
  b.grant([`${SITE}/*`, "https://github.com/*"], true);
  b.focus(7, ISSUE, "D-issue");
  await until(() => b.toChrome.filter((f) => f.type === "capture_policy").at(-1)?.captureEnabled === true, "the enabling capture_policy");
  const policy = b.toChrome.filter((f) => f.type === "capture_policy").at(-1).revision;
  const acks = b.toChrome.filter((f) => f.type === "ack").length;
  b.sense({ kind: "page_text", tabId: 7, documentId: "D-issue", url: ISSUE, source: "github_issue", title: TITLE, text: BODY, truncated: false, policyRevision: policy });
  await until(() => b.toChrome.filter((f) => f.type === "ack").length > acks, "ack for the page_text");
}

/** Focus a page and wait for its job's `working` frame; returns the job id and the visit epoch. */
async function startJob(b, tabId, path, documentId) {
  const before = b.panel().length;
  b.focus(tabId, path, documentId);
  await until(() => b.panel().slice(before).some((f) => f.type === "state" && f.status === "working"), `a job for ${path}`);
  const working = b.panel().slice(before).find((f) => f.type === "state" && f.status === "working");
  return { jobId: working.jobId, epoch: working.visitEpoch, before };
}

/** Wait for the `results` frame of `jobId`. */
async function resultsOf(b, jobId, ms = 40_000) {
  await until(() => b.panel().some((f) => f.type === "results" && f.jobId === jobId), `results for ${jobId}`, ms);
  return b.panel().find((f) => f.type === "results" && f.jobId === jobId);
}

/** Send open_link and wait for its ack. */
async function openLink(b, identity) {
  const commandId = `open-${Math.random().toString(36).slice(2, 10)}`;
  const caps = b.panel().find((f) => f.type === "capabilities");
  b.command({ type: "open_link", commandId, coreInstanceId: caps.coreInstanceId, ...identity });
  await until(() => b.panel().some((f) => f.type === "ack" && f.commandId === commandId), "the open_link ack");
  return b.panel().find((f) => f.type === "ack" && f.commandId === commandId);
}

/** A fixture string found in any log, or undefined. */
function leaked(b, home, secrets) {
  const diag = existsSync(join(home, "logs", "diagnostics.jsonl")) ? readFileSync(join(home, "logs", "diagnostics.jsonl"), "utf8") : "";
  for (const [name, text] of [
    ["core stderr", b.stderr()],
    ["diagnostics", diag],
  ]) {
    for (const s of secrets) if (text.includes(s)) return `${name} contains ${s}`;
  }
  return undefined;
}

const SECRETS = [TITLE, BODY, REASON, "P3V-SECRET", ...CANDIDATES.map((c) => c.sourceUrl), "/docs/", "/issues/", "github.com/o/r"];

describe.skipIf(!BUILT)("Phase 3 verification e2e: B10 outcomes and B11 click authorization (one core, a page per case)", () => {
  const children = [];
  let home;
  let b;
  /** The window's answer per B10 case, for the distinctness check. */
  const shown = new Map();
  let page = 0;
  const nextPage = () => `/docs/page-${++page}`;
  const setMode = (m) => writeFileSync(join(home, "fake-mode"), m);

  beforeAll(async () => {
    ({ home } = await makeHome("scout-p3v-"));
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(home, "u"), USER: "p3v", LOGNAME: "p3v", LANG: "en_US.UTF-8", TMPDIR: tmpdir(), SCOUT_HOME: home };
    b = await boot(home, env, children);
    await captureIssue(b);
    // From here every lookup is answered loopback (refused): discovery and verification fail fast, unless a case sets `hang`.
    b.dns.set("loopback");
  }, 60_000);

  afterAll(async () => {
    if (b && b.core.exitCode === null) {
      b.core.stdin.end();
      await Promise.race([b.exited, new Promise((r) => setTimeout(r, 8_000))]);
    }
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    if (home) rmSync(home, { recursive: true, force: true });
  });

  /** One B10 case: a fresh page, the mode, the job's answer as the window gets it, and its job_finished. */
  async function runCase(mode, { dns = "loopback" } = {}) {
    b.dns.set(dns);
    setMode(mode);
    const { jobId, epoch } = await startJob(b, 8, nextPage());
    const result = await resultsOf(b, jobId);
    expect(result).toMatchObject({ jobId, visitEpoch: epoch, origin: SITE });
    expect(JSON.stringify(result)).not.toContain(`${SITE}/`);
    await until(() => b.diagEvents().some((e) => e.event === "job_finished" && e.epoch === epoch), "job_finished");
    const fin = b.diagEvents().find((e) => e.event === "job_finished" && e.epoch === epoch);
    return { result, fin, jobId, epoch };
  }

  it("B10 success: ok with the model's picks, verified (no optional tool configured: the tool-absent case)", async () => {
    // Verification fetches never get an answer: each pick is kept on the source URL after the 4 s budget.
    const { result, fin, jobId, epoch } = await runCase("ok", { dns: "hang" });
    expect(result.status).toBe("ok");
    expect(result.items.map((i) => i.candidateId)).toEqual(["c0", "c1"]);
    expect(result.items.map((i) => i.reason)).toEqual([REASON, REASON]);
    expect(fin).toMatchObject({ status: "ok", termination: "completed" });
    shown.set("success", "ok");

    // B11 click authorization, through the real processes: the link resolves while the visit is current...
    expect(await openLink(b, { visitEpoch: epoch, jobId, candidateId: "c0" })).toMatchObject({ ok: true, target: { href: `${SITE}/docs/alpha` } });
    // ...and is refused after a tab switch (same URL, so the new visit gets the cached answer under a new job).
    const pageNow = `/docs/page-${page}`;
    const t = await startJob(b, 9, pageNow);
    expect((await resultsOf(b, t.jobId)).status).toBe("ok");
    expect(await openLink(b, { visitEpoch: epoch, jobId, candidateId: "c0" })).toMatchObject({ ok: false, code: "stale_revision" });
    // A document switch in that tab: the tab's link is refused.
    const d = await startJob(b, 9, pageNow, "D-other");
    expect((await resultsOf(b, d.jobId)).status).toBe("ok");
    expect(await openLink(b, { visitEpoch: t.epoch, jobId: t.jobId, candidateId: "c0" })).toMatchObject({ ok: false, code: "stale_revision" });
    expect(await openLink(b, { visitEpoch: d.epoch, jobId: d.jobId, candidateId: "c1" })).toMatchObject({ ok: true, target: { href: `${SITE}/docs/bravo` } });
    // An app switch: refused while away, and still refused back in Chrome (a new visit).
    b.command({ type: "frontmost", bundleId: "com.apple.Terminal", at: Date.now() });
    await until(() => b.panel().at(-1)?.type === "state" && b.panel().at(-1).visitEpoch !== d.epoch, "the state after leaving Chrome");
    expect(await openLink(b, { visitEpoch: d.epoch, jobId: d.jobId, candidateId: "c1" })).toMatchObject({ ok: false, code: "stale_revision" });
    const before = b.panel().length;
    b.command({ type: "frontmost", bundleId: "com.google.Chrome", at: Date.now() });
    await until(() => b.panel().slice(before).some((f) => f.type === "results"), "the cached answer back in Chrome");
    expect(await openLink(b, { visitEpoch: d.epoch, jobId: d.jobId, candidateId: "c1" })).toMatchObject({ ok: false, code: "stale_revision" });
    // Only the two ok acks ever carried an href; no results or state frame did.
    expect(b.panel().filter((f) => JSON.stringify(f).includes(`${SITE}/`)).every((f) => f.type === "ack" && f.ok)).toBe(true);
  }, 90_000);

  it("B10 intentional empty: empty, never an error", async () => {
    const { result, fin } = await runCase("empty");
    expect(result).toMatchObject({ status: "empty" });
    expect(result.reason).toBeUndefined();
    expect(fin).toMatchObject({ status: "empty", termination: "completed" });
    shown.set("empty", "empty");
  }, 60_000);

  it("B10 malformed output: error invalid_output", async () => {
    const { result, fin } = await runCase("invalid-shape");
    expect(result).toMatchObject({ status: "error", reason: "invalid_output" });
    expect(fin).toMatchObject({ status: "error", reason: "invalid_output", termination: "invalid_output" });
    expect(fin.droppedPicks).toBeUndefined();
    shown.set("malformed", "error/invalid_output");
  }, 60_000);

  it("B10 unknown IDs: every pick unknown is error invalid_output, never empty", async () => {
    const { result, fin } = await runCase("all-invalid");
    expect(result).toMatchObject({ status: "error", reason: "invalid_output" });
    // The window shows the same error; the diagnostics' dropped-pick count tells the two apart.
    expect(fin).toMatchObject({ status: "error", reason: "invalid_output", termination: "invalid_output" });
    expect(fin.droppedPicks).toBeGreaterThan(0);
    shown.set("unknown_ids", "error/invalid_output");
  }, 60_000);

  it("B10 duplicate IDs: the repeat is dropped and the first pick verified alone; one unknown among valid picks is dropped the same way", async () => {
    const dup = await runCase("duplicate", { dns: "hang" });
    expect(dup.result.status).toBe("ok");
    expect(dup.result.items.map((i) => i.candidateId)).toEqual(["c0"]);
    expect(dup.fin).toMatchObject({ status: "ok", termination: "completed" });
    const some = await runCase("some-invalid", { dns: "hang" });
    expect(some.result.status).toBe("ok");
    expect(some.result.items.map((i) => i.candidateId)).toEqual(["c0"]);
    shown.set("duplicate_ids", "ok(1 of 2)");
  }, 60_000);

  it("B10 failed targets: every pick fails verification → error agent_failed with verifyAllFailed, never empty", async () => {
    // Loopback answers: every target is refused by the fetch policy (off host) and dropped.
    const { result, fin, epoch } = await runCase("ok");
    expect(result).toMatchObject({ status: "error", reason: "agent_failed" });
    expect(fin).toMatchObject({ status: "error", reason: "agent_failed", termination: "completed", verifyAllFailed: true });
    expect(b.diagEvents().find((e) => e.event === "verify" && e.epoch === epoch)).toMatchObject({ picked: 2, verified: 0 });
    shown.set("failed_targets", "error/agent_failed");
  }, 60_000);

  it("B10 quota denial (429 while retrying): unavailable agent_unavailable at once, not a timeout", async () => {
    const t0 = Date.now();
    const { result, fin } = await runCase("quota");
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(result).toMatchObject({ status: "unavailable", reason: "agent_unavailable" });
    expect(fin).toMatchObject({ termination: "auth_or_quota" });
    shown.set("quota", "unavailable/agent_unavailable");
  }, 60_000);

  it("B10 auth denial (401 result): unavailable agent_unavailable", async () => {
    const { result, fin } = await runCase("auth");
    expect(result).toMatchObject({ status: "unavailable", reason: "agent_unavailable" });
    expect(fin).toMatchObject({ termination: "auth_or_quota" });
    shown.set("auth", "unavailable/agent_unavailable");
  }, 60_000);

  it("B10 auth denial at the billing preflight (an API-key login): error preflight_failed, the CLI never launched for the job", async () => {
    // A profile naming a CLI whose `auth status` reports an API-key login: a new environment, a new preflight.
    const preflights = () => b.diagEvents().filter((e) => e.event === "agent_preflight");
    const n = preflights().length;
    saveProfile(home, profileJson(home, { claude: "claude-apikey" }));
    await until(() => preflights().slice(n).some((e) => e.verdict !== "subscription"), "the API-key preflight verdict", 20_000);
    const launches = b.fake().filter((l) => Array.isArray(l.argv)).length;
    const { result, fin } = await runCase("ok");
    expect(result).toMatchObject({ status: "error", reason: "preflight_failed" });
    expect(fin).toMatchObject({ status: "error", reason: "preflight_failed" });
    expect(b.fake().filter((l) => Array.isArray(l.argv)).length).toBe(launches);
    shown.set("preflight_denied", "error/preflight_failed");
  }, 60_000);

  it("B10 required-tool failure: every call to a required tool errored → error tool_unavailable", async () => {
    const { schemaHash } = await import(join(ROOT, "packages/scout-core/dist/agents/toolProfile.js"));
    const changes = () => b.diagEvents().filter((e) => e.event === "agent_profile_changed");
    const n = changes().length;
    saveProfile(home, profileJson(home, { revision: 2, tool: { schemaHash: schemaHash(LOOKUP_SCHEMA), required: true } }));
    await until(() => changes().length > n, "the profile change", 20_000);
    expect(changes().at(-1)).toMatchObject({ usable: true, toolsRevision: 2 });
    const { result, fin } = await runCase("tool-errors");
    expect(result).toMatchObject({ status: "error", reason: "tool_unavailable" });
    expect(fin).toMatchObject({ status: "error", reason: "tool_unavailable", termination: "tool_unavailable" });
    shown.set("required_tool", "error/tool_unavailable");
    // The same tool, optional and working: the success path with the tool present and called.
    const m = changes().length;
    saveProfile(home, profileJson(home, { revision: 3, tool: { schemaHash: schemaHash(LOOKUP_SCHEMA), required: false } }));
    await until(() => changes().length > m, "the optional-tool profile", 20_000);
    const ok = await runCase("bridge-call", { dns: "hang" });
    expect(ok.result.status).toBe("ok");
    expect(ok.result.items[0].reason).toContain("lookup:metered");
    expect(ok.fin.optionalToolFailed).toBeUndefined();
  }, 90_000);

  it("B11 during model execution: a tab switch cancels the job visit_changed; nothing is shown for it and its process ends", async () => {
    setMode("hang");
    const launches = () => b.fake().filter((l) => typeof l.pid === "number" && Array.isArray(l.argv));
    const n = launches().length;
    const { jobId } = await startJob(b, 8, nextPage());
    await until(() => launches().length > n, "the job's CLI");
    const pid = launches().at(-1).pid;
    // It is in model execution: started, connected to Scout's tools, never answering.
    await until(() => b.fake().slice(b.fake().findIndex((l) => l.pid === pid)).some((l) => typeof l.scoutPid === "number"), "scout-mcp connected");
    expect(alive(pid)).toBe(true);
    const before = b.panel().length;
    b.focus(12, `/docs/page-${page}`);
    await until(() => b.diagEvents().some((e) => e.event === "job_cancelled" && e.reason === "visit_changed"), "job_cancelled visit_changed");
    await until(() => !alive(pid), "the cancelled CLI to end", 5_000);
    // The new tab's own job starts (the same mode, hanging): leave it before it can matter.
    b.command({ type: "frontmost", bundleId: "com.apple.Terminal", at: Date.now() });
    await until(() => b.diagEvents().filter((e) => e.event === "job_finished" && e.status === "cancelled").length >= 1, "the cancellations to finish");
    expect(b.panel().slice(before).some((f) => f.type === "results" && f.jobId === jobId)).toBe(false);
    b.command({ type: "frontmost", bundleId: "com.google.Chrome", at: Date.now() });
  }, 60_000);

  it("B10 timeout: an agent that never answers ends at the deadline with error timeout", async () => {
    const t0 = Date.now();
    const { result, fin } = await runCase("hang");
    expect(result).toMatchObject({ status: "error", reason: "timeout" });
    expect(fin).toMatchObject({ status: "error", reason: "timeout", termination: "timeout" });
    expect(Date.now() - t0).toBeLessThan(35_000);
    shown.set("timeout", "error/timeout");
  }, 60_000);

  it("B10: every outcome reaches the window as its own answer; malformed output and all-unknown IDs share error/invalid_output", () => {
    expect(Object.fromEntries(shown)).toEqual({
      success: "ok",
      empty: "empty",
      malformed: "error/invalid_output",
      unknown_ids: "error/invalid_output",
      duplicate_ids: "ok(1 of 2)",
      failed_targets: "error/agent_failed",
      quota: "unavailable/agent_unavailable",
      auth: "unavailable/agent_unavailable",
      preflight_denied: "error/preflight_failed",
      required_tool: "error/tool_unavailable",
      timeout: "error/timeout",
    });
    // The B10 classes (quota and auth are one class, "quota/auth denial"; malformed and unknown IDs both "invalid output").
    const byClass = new Map([
      ["success", shown.get("success")],
      ["empty", shown.get("empty")],
      ["invalid output", shown.get("malformed")],
      ["failed targets", shown.get("failed_targets")],
      ["quota/auth denial", shown.get("quota")],
      ["timeout", shown.get("timeout")],
      ["required-tool failure", shown.get("required_tool")],
    ]);
    expect(new Set(byClass.values()).size).toBe(byClass.size);
    expect(shown.get("quota")).toBe(shown.get("auth"));
  });

  it("B8/B9 no prescribed personal paths: every job ran in its own dir under run/jobs, its argv names only that dir, and its prompt names no path or personal source", () => {
    const jobsRoot = join(realpathSync(home), "run", "jobs");
    const launches = b.fake().filter((l) => Array.isArray(l.argv));
    expect(launches.length).toBeGreaterThan(5);
    for (const l of launches) {
      expect(l.cwd.startsWith(`${jobsRoot}/`), l.cwd).toBe(true);
      for (const a of l.argv.filter((x) => typeof x === "string" && x.startsWith("/"))) expect(a.startsWith(`${l.cwd}/`), a).toBe(true);
      expect(l.envKeys.some((k) => /PERSONAL_CONTEXT|SCOUT_HOME/.test(k)), l.envKeys.join(",")).toBe(false);
      expect(l.violations).toEqual([]);
    }
    const prompts = b.fake().filter((l) => typeof l.prompt === "string").map((l) => l.prompt);
    expect(prompts.length).toBeGreaterThan(5);
    for (const p of prompts) {
      expect(/(^|[\s"'(=])\/(Users|home|private|var|tmp|etc)\//.test(p), p.slice(0, 200)).toBe(false);
      expect(/personal-context|second-brain|PERSONAL_CONTEXT|~\//i.test(p)).toBe(false);
    }
  });

  it("no fixture text (issue, candidates, reasons, links) in the diagnostics file or the core's stderr; DNS only for the test site", () => {
    // The check reads real content: the origin (allowed in diagnostics) is found.
    expect(leaked(b, home, [HOSTNAME])).toBeDefined();
    expect(leaked(b, home, SECRETS)).toBeUndefined();
    expect(new Set(b.dns.hosts())).toEqual(new Set([HOSTNAME]));
  });
});

describe.skipIf(!BUILT)("Phase 3 verification e2e: B7/B12/B13 closing paths end the job, refuse its token, and leak nothing", () => {
  const children = [];
  let home;
  let b;
  let resourceId;
  let page = 0;
  const nextPage = () => `/docs/close-${++page}`;

  /** agent.sock calls with a given token file, through the production scout-mcp socket client. */
  async function agentCall(tokenFile, method, params = {}) {
    const { createSocketBackend } = await import(MCP_CLIENT);
    const backend = createSocketBackend({ socketPath: join(home, "run", "agent.sock"), tokenFile, timeoutMs: 3_000 });
    try {
      return await backend.call({ protocol: 1, requestId: `p3v${Math.random().toString(36).slice(2, 10)}`, method, params });
    } catch (e) {
      return { status: "error", error: { code: e?.code ?? "unavailable" } };
    } finally {
      backend.close();
    }
  }

  /** Start a hanging job, keep a copy of its token (0600, ours), and return what the closing checks need. */
  async function runningJob() {
    writeFileSync(join(home, "fake-mode"), "hang");
    const launches = () => b.fake().filter((l) => typeof l.pid === "number" && Array.isArray(l.argv));
    const n = launches().length;
    const jobsRoot = join(home, "run", "jobs");
    const seen = new Set(existsSync(jobsRoot) ? readdirSync(jobsRoot) : []);
    const { jobId, epoch } = await startJob(b, 8, nextPage());
    await until(() => launches().length > n, "the job's CLI");
    const pid = launches().at(-1).pid;
    const tokenOf = () => (existsSync(jobsRoot) ? readdirSync(jobsRoot) : []).filter((d) => !seen.has(d)).map((d) => join(jobsRoot, d, "agent-token")).find((f) => existsSync(f));
    await until(() => tokenOf() !== undefined, "the job token");
    const tokenCopy = join(home, `token-${jobId}`);
    writeFileSync(tokenCopy, readFileSync(tokenOf()), { mode: 0o600 });
    // While it runs, its token reads its snapshot: the issue it was given.
    const read = await agentCall(tokenCopy, "recent_activity");
    expect(read).toMatchObject({ status: "ok" });
    expect(JSON.stringify(read)).toContain(TITLE);
    return { jobId, epoch, tokenCopy, pid };
  }

  /** After a closing path: the job ended with `status/reason`, its process is gone, its token refused, the window out of working. */
  async function closed(job, expected) {
    await until(() => b.diagEvents().some((e) => e.event === "job_finished" && e.epoch === job.epoch), `job_finished for ${expected.reason}`, 40_000);
    expect(b.diagEvents().find((e) => e.event === "job_finished" && e.epoch === job.epoch)).toMatchObject(expected);
    await until(() => !alive(job.pid), "the job's CLI to end", 5_000);
    const after = await agentCall(job.tokenCopy, "recent_activity");
    expect(after.status).toBe("error");
    expect(["not_granted", "unavailable"]).toContain(after.error.code);
    const last = b.panel().filter((f) => f.type === "state").at(-1);
    expect(last.status === "working" && last.jobId === job.jobId).toBe(false);
    rmSync(job.tokenCopy, { force: true });
    expect(leaked(b, home, [...SECRETS, "P3V-SECRET-RESOURCE"])).toBeUndefined();
  }

  beforeAll(async () => {
    ({ home } = await makeHome("scout-p3c-"));
    // An approved resource every job's snapshot pins (the revoke path).
    const { createCapabilityStore } = await import(join(ROOT, "packages/scout-core/dist/capabilities/store.js"));
    const store = await createCapabilityStore({ scoutHome: home, clock: { now: () => Date.now() } });
    const sourceUrl = `${SITE}/llms.txt`;
    const sha256 = createHash("sha256").update(RESOURCE_TEXT, "utf8").digest("hex");
    const now = Date.now();
    const report = await store.ingest(
      {
        origin: SITE, checkedAt: now, robots: "not_fetched",
        items: [{ kind: "llms_txt", sourceUrl, status: "found", source: "network", resource: { kind: "llms_txt", siteOrigin: SITE, publisherOrigin: SITE, sourceUrl, finalUrl: sourceUrl, text: RESOURCE_TEXT, sha256, byteLength: Buffer.byteLength(RESOURCE_TEXT), fetchedAt: now } }],
        externalReferences: [], skillsOverCap: 0, acceptedBytes: 0, stats: { requests: 0, refused: 0, ms: 0 },
      },
      { chromePermitted: false },
    );
    resourceId = report.results[0].resourceId;
    await store.approve({ resourceId, version: report.results[0].version, expectedRevision: store.getResource(resourceId).revision });
    await store.close();
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(home, "u"), USER: "p3v", LOGNAME: "p3v", LANG: "en_US.UTF-8", TMPDIR: tmpdir(), SCOUT_HOME: home };
    b = await boot(home, env, children);
    b.dns.set("loopback");
    await captureIssue(b);
  }, 60_000);

  afterAll(() => {
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("permission loss (the site's grant and GitHub's removed): cancelled revoked; captured activity cleared", async () => {
    const interactive = join(home, "run", "agent-token");
    expect(JSON.stringify(await agentCall(interactive, "recent_activity"))).toContain(TITLE);
    const job = await runningJob();
    b.grant([], false);
    await closed(job, { status: "cancelled", reason: "revoked" });
    // The live store is empty now: GitHub capture lost its grant.
    b.grant([`${SITE}/*`, "https://github.com/*"], true);
    const after = await agentCall(interactive, "recent_activity");
    expect(after).toMatchObject({ status: "ok" });
    expect(after.result.entries).toEqual([]);
    // Capture the issue again for the next paths (the same fixture text).
    await captureIssue(b);
  }, 60_000);

  it("pause: cancelled paused; resume starts nothing on its own for the old job", async () => {
    const job = await runningJob();
    b.command({ type: "pause" });
    await closed(job, { status: "cancelled", reason: "paused" });
    expect(b.panel().filter((f) => f.type === "state").at(-1)).toMatchObject({ status: "paused" });
    b.command({ type: "resume" });
  }, 60_000);

  it("revoking a resource the snapshot pinned: cancelled revoked, then one replacement, which the deadline ends with error timeout", async () => {
    const job = await runningJob();
    const caps = b.panel().filter((f) => f.type === "capabilities").at(-1);
    const entry = caps.library.find((l) => l.resourceId === resourceId);
    expect(entry).toBeDefined();
    const started = () => b.diagEvents().filter((e) => e.event === "job_started").length;
    const n = started();
    b.command({ type: "revoke", commandId: "rv1", resourceId, expectedRevision: entry.resourceRevision });
    await until(() => b.panel().some((f) => f.type === "ack" && f.commandId === "rv1"), "the revoke ack");
    expect(b.panel().find((f) => f.type === "ack" && f.commandId === "rv1")).toMatchObject({ ok: true });
    await until(() => b.diagEvents().some((e) => e.event === "job_cancelled" && e.reason === "revoked"), "job_cancelled revoked");
    await until(() => !alive(job.pid), "the revoked job's CLI to end", 5_000);
    const refused = await agentCall(job.tokenCopy, "recent_activity");
    expect(refused.status).toBe("error");
    // The replacement (same visit, a fresh snapshot without the revoked resource) runs to the visit's deadline.
    await until(() => started() > n, "the replacement job");
    const launches = () => b.fake().filter((l) => typeof l.pid === "number" && Array.isArray(l.argv));
    await until(() => launches().at(-1).pid !== job.pid, "the replacement's CLI");
    const replacement = { pid: launches().at(-1).pid, jobId: b.panel().filter((f) => f.type === "state" && f.status === "working").at(-1).jobId };
    const jobsRoot = join(home, "run", "jobs");
    const token = () => readdirSync(jobsRoot).map((d) => join(jobsRoot, d, "agent-token")).find((f) => existsSync(f));
    await until(() => token() !== undefined, "the replacement's token");
    replacement.tokenCopy = join(home, "token-replacement");
    writeFileSync(replacement.tokenCopy, readFileSync(token()), { mode: 0o600 });
    expect(JSON.stringify(await agentCall(replacement.tokenCopy, "list_resources"))).not.toContain(resourceId);
    // Deadline: the visit's 30 s budget less the 4 s verification reserve.
    await until(() => b.diagEvents().filter((e) => e.event === "job_finished" && e.epoch === job.epoch).length >= 2, "the replacement to end", 40_000);
    const fins = b.diagEvents().filter((e) => e.event === "job_finished" && e.epoch === job.epoch);
    expect(fins.map((f) => [f.status, f.reason])).toEqual([
      ["cancelled", "revoked"],
      ["error", "timeout"],
    ]);
    expect(b.panel().filter((f) => f.type === "results" && f.jobId === replacement.jobId)).toMatchObject([{ status: "error", reason: "timeout" }]);
    await until(() => !alive(replacement.pid), "the timed-out CLI to end", 5_000);
    expect((await agentCall(replacement.tokenCopy, "recent_activity")).status).toBe("error");
    rmSync(replacement.tokenCopy, { force: true });
    expect(leaked(b, home, [...SECRETS, "P3V-SECRET-RESOURCE"])).toBeUndefined();
  }, 90_000);

  it("shutdown with a job running: exit 0, the job's process and dir gone, nothing leaked", async () => {
    const job = await runningJob();
    b.core.stdin.end();
    const { code, signal } = await b.exited;
    expect(signal).toBeNull();
    expect(code).toBe(0);
    await until(() => !alive(job.pid), "the job's CLI to end", 2_000);
    expect(readdirSync(join(home, "run", "jobs"))).toEqual([]);
    const fin = b.diagEvents().filter((e) => e.event === "job_finished").at(-1);
    expect(fin).toMatchObject({ status: "cancelled", reason: "shutdown" });
    expect(leaked(b, home, [HOSTNAME])).toBeDefined();
    expect(leaked(b, home, [...SECRETS, "P3V-SECRET-RESOURCE"])).toBeUndefined();
    expect(new Set(b.dns.hosts())).toEqual(new Set([HOSTNAME]));
  }, 60_000);
});
