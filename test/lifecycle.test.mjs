// Runtime ownership and shutdown (P3.4), end to end: the built host and core in a temp
// SCOUT_HOME, a recommendation job running the scripted fake CLI (never a model) in its
// `sleep-ignore-term` mode (no final response, SIGTERM ignored, one in-group and one escaped
// `sleep` descendant that also ignore SIGTERM) with an optional retrieval tool whose backend
// ignores SIGTERM and stdin EOF. Each shutdown trigger is tested on its own: the core exits 0
// within SHUTDOWN_DEADLINE_MS, and no `claude`, Scout MCP server, bridge, backend or descendant
// is left, nor the job dir, the sockets or the token. A hard-killed core leaves the job running; the
// next start kills it from the job dir's tree.json and sweeps the dir. A profile edit mid-job
// cancels the job `superseded` and reaps its tree. Builds nothing; run `npm run build` first.

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { endianness, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = join(ROOT, "packages/scout-core/dist/main.js");
const HOST = join(ROOT, "packages/native-host/dist/host.js");
const FAKE_CLAUDE = join(ROOT, "packages/scout-core/src/agents/testing/fake-claude.mjs");
const FAKE_BACKEND = join(ROOT, "packages/scout-core/src/agents/testing/fake-backend.mjs");
const BUILT = existsSync(CORE) && existsSync(HOST);
if (!BUILT) console.warn("lifecycle: skipped: run `npm run build` first");

const EXT_ID = "a".repeat(32);
const SITE = "https://docs.scout-life.invalid";
const LE = endianness() === "LE";
/** The core's shutdown deadline (main.ts SHUTDOWN_DEADLINE_MS). */
const DEADLINE_MS = 5000;

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  if (LE) head.writeUInt32LE(body.length);
  else head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

async function until(cond, what, ms = 20_000) {
  const start = Date.now();
  while (!cond()) {
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

/** DNS that records and never answers: discovery never leaves the machine. */
function dnsStub(dir) {
  const path = join(dir, "dns-stub.mjs");
  writeFileSync(
    path,
    [
      'import dns from "node:dns";',
      'import { syncBuiltinESMExports } from "node:module";',
      "dns.promises.lookup = () => new Promise(() => {});",
      "dns.lookup = (host, ...rest) => { const cb = rest.at(-1); if (typeof cb === 'function') process.nextTick(cb, Object.assign(new Error('stubbed'), { code: 'ENOTFOUND' })); };",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
  );
  return pathToFileURL(path).href;
}

/** A temp home with the fake agent, its ignoring backend, a fresh cached catalog, and the recommendation host enabled. */
async function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "scout-life-"));
  const userHome = join(home, "u");
  mkdirSync(join(userHome, ".claude"), { recursive: true });
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ extensionId: EXT_ID, destinations: ["docs.scout-life.invalid"] }));
  const claudePath = join(home, "bin", "claude");
  writeFileSync(claudePath, `#!/bin/sh\nFAKE_MODE=sleep-ignore-term FAKE_VERSION=2.1.286 FAKE_LOG='${home}/fake.log' exec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`);
  const notesPath = join(home, "bin", "notes");
  writeFileSync(notesPath, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_BACKEND}' --mode honest --ignore-term --log '${home}/notes.log'\n`);
  chmodSync(claudePath, 0o755);
  chmodSync(notesPath, 0o755);
  const { schemaHash } = await import(join(ROOT, "packages/scout-core/dist/agents/toolProfile.js"));
  const lookupSchema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
  writeFileSync(
    join(home, "agent-profile.json"),
    JSON.stringify({
      schemaVersion: 1,
      adapter: "claude-code",
      claudePath,
      model: "claude-sonnet-5-5",
      tools: {
        revision: 1,
        connections: [{ id: "notes", transport: "stdio", command: notesPath, args: [], env: {} }],
        selections: [
          { connectionId: "notes", toolName: "lookup", description: "Reviewed lookup", inputSchema: lookupSchema, schemaHash: schemaHash(lookupSchema), required: false, unattendedReadDeclared: true, selectedAt: "2026-10-01T12:00:00.000Z" },
        ],
      },
    }),
    { mode: 0o600 },
  );
  const { cacheFileName } = await import(join(ROOT, "packages/scout-core/dist/privateCacheFile.js"));
  const now = Date.now();
  const candidates = ["billing", "pricing"].map((p, i) => ({ id: `c${i}`, sourceUrl: `${SITE}/docs/${p}`, title: `Docs ${p}`, labelQuality: "published", provenance: "llms.txt" }));
  mkdirSync(join(home, "cache", "catalog"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, "cache", "catalog", cacheFileName(SITE)),
    JSON.stringify({ schemaVersion: 3, origin: SITE, fetchedAt: now, resources: [], catalog: { origin: SITE, version: "life-v1", fetchedAt: now, candidates, truncated: false, errors: [] } }),
    { mode: 0o600 },
  );
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: userHome, USER: "life", LOGNAME: "life", LANG: "en_US.UTF-8", TMPDIR: tmpdir(), SCOUT_HOME: home };
  return { home, env };
}

/** Start host and core, settle a visit to the enabled site, and wait until the job's whole tree is up. */
async function startWithRunningJob(children) {
  const { home, env } = await makeHome();
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
  const core = spawn(process.execPath, ["--import", dnsStub(home), CORE, "--stdio"], { env: { ...env, SCOUT_DWELL_MS: "300" }, cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  children.push(core);
  let coreOut = "";
  let coreErr = "";
  core.stdout.on("data", (c) => (coreOut += c));
  core.stderr.on("data", (c) => (coreErr += c));
  core.stdin.on("error", () => {});
  const exited = new Promise((resolve) => core.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
  core.stdin.write(`${JSON.stringify({ type: "frontmost", bundleId: "com.google.Chrome", at: Date.now() })}\n`);
  await until(() => toChrome.some((f) => f.type === "ready"), "ready from the host");
  const at = Date.now();
  host.stdin.write(frame({ kind: "permissions", revision: 1, at, granted: [`${SITE}/*`], githubCapture: false }));
  host.stdin.write(frame({ kind: "focus", seq: 1, at, browserFocused: true, windowId: 1, tabId: 8, url: `${SITE}/docs/billing`, title: "Billing", incognito: false, permissionsRevision: 1 }));

  const fake = () => readLines(join(home, "fake.log"));
  const descendants = () => fake().flatMap((l) => l.descendantPids ?? []);
  const backend = () => readLines(join(home, "notes.log")).flatMap((l) => (typeof l.pid === "number" ? [l.pid] : []));
  await until(() => descendants().length === 2 && backend().length === 1, "the job's whole tree (CLI, servers, bridge, backend, sleeps)");
  const jobsRoot = join(home, "run", "jobs");
  expect(readdirSync(jobsRoot)).toHaveLength(1);
  expect(coreOut).toContain('"status":"working"');
  // The CLI, scout-mcp, the bridge (scoutPid lines), both sleeps, the backend.
  const pids = [...fake().flatMap((l) => [l.pid, l.scoutPid].filter((p) => typeof p === "number")), ...descendants(), ...backend()];
  expect(pids).toHaveLength(6);
  expect(pids.every(alive)).toBe(true);
  return { home, core, exited, pids, jobsRoot, stdout: () => coreOut, stderr: () => coreErr };
}

const timings = [];

describe.skipIf(!BUILT)("core shutdown with a job running (each trigger on its own)", () => {
  let home;
  const children = [];

  afterEach(() => {
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });
  afterAll(() => {
    if (timings.length && process.env.SCOUT_LIFECYCLE_TIMINGS) writeFileSync(process.env.SCOUT_LIFECYCLE_TIMINGS, `shutdown took ${timings.map(([t, ms]) => `${t} ${ms} ms`).join(", ")}`);
  });

  const triggers = [
    ["stdin EOF (the app quit)", (core) => core.stdin.end()],
    ["stdin destroyed (the app crashed)", (core) => core.stdin.destroy()],
    ["the shutdown command", (core) => core.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`)],
    ["SIGTERM", (core) => core.kill("SIGTERM")],
    ["SIGINT", (core) => core.kill("SIGINT")],
    ["SIGHUP", (core) => core.kill("SIGHUP")],
  ];

  for (const [name, trigger] of triggers) {
    it(`${name}: exit 0 within the deadline, no descendant left, job dir, sockets and token removed`, async () => {
      const run = await startWithRunningJob(children);
      home = run.home;
      const t0 = Date.now();
      trigger(run.core);
      const { code, signal, at } = await run.exited;
      const took = at - t0;
      timings.push([name, took]);
      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(took, `exit took ${took} ms`).toBeLessThan(DEADLINE_MS);
      // Never before the job's tree is gone: every pid is dead at the moment the core exits (allow the kernel a beat to reap).
      await until(() => !run.pids.some(alive), "no job descendant alive", 500);
      expect(readdirSync(run.jobsRoot)).toEqual([]);
      for (const f of ["core.sock", "agent.sock", "agent-token"]) expect(existsSync(join(run.home, "run", f)), f).toBe(false);
      expect(existsSync(join(run.home, "agent-profile.lock"))).toBe(false);
      const events = readLines(join(run.home, "logs", "diagnostics.jsonl"));
      const done = events.find((e) => e.event === "shutdown");
      expect(done).toMatchObject({ jobsMs: expect.any(Number), descendantsMs: expect.any(Number) });
      // The CLI ignored SIGTERM: the job ended at the 2 s kill grace, not by its own exit.
      expect(done.jobsMs).toBeGreaterThanOrEqual(1900);
      expect(events.some((e) => e.event === "shutdown_deadline" || e.event === "shutdown_orphan")).toBe(false);
      expect(events.filter((e) => e.event === "job_finished").map((e) => e.status)).toEqual(["cancelled"]);
      expect(events.some((e) => e.event === "job_finished" && e.status === "ok")).toBe(false);
    }, 60_000);
  }

  it("a hard-killed core leaves its job running; the next start kills that tree from tree.json and sweeps the dir", async () => {
    const run = await startWithRunningJob(children);
    home = run.home;
    const [jobDir] = readdirSync(run.jobsRoot);
    const treeFile = join(run.jobsRoot, jobDir, "tree.json");
    const recorded = () => (existsSync(treeFile) ? JSON.parse(readFileSync(treeFile, "utf8")).members.map((m) => m.pid) : []);
    // The poll (1 s) has recorded the whole tree, the escaped sleep included.
    await until(() => run.pids.every((p) => recorded().includes(p)), "tree.json to name every process of the job");
    expect((statSync(treeFile).mode & 0o777).toString(8)).toBe("600");
    const record = JSON.parse(readFileSync(treeFile, "utf8"));
    expect(Object.keys(record).sort()).toEqual(["members", "pgid", "pid", "schemaVersion", "startedAt"]);
    expect(record.pid).toBe(run.pids[0]); // the CLI
    run.core.kill("SIGKILL");
    await run.exited;
    // Nobody told the job: the CLI and its tree keep running (and would keep spending quota).
    await new Promise((r) => setTimeout(r, 300));
    expect(run.pids.every(alive)).toBe(true);
    expect(readdirSync(run.jobsRoot)).toHaveLength(1);

    const env = { PATH: "/usr/bin:/bin", HOME: join(run.home, "u"), SCOUT_HOME: run.home, SCOUT_DWELL_MS: "600000" };
    const core = spawn(process.execPath, [CORE, "--stdio"], { env, cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    children.push(core);
    let err = "";
    core.stderr.on("data", (c) => (err += c));
    core.stdout.resume();
    await until(() => err.includes("listening on"), "the second core to listen");
    expect(readdirSync(run.jobsRoot)).toEqual([]);
    await until(() => !run.pids.some(alive), "the old job's tree to be gone", 2_000);
    const events = readLines(join(run.home, "logs", "diagnostics.jsonl"));
    const swept = events.find((e) => e.event === "jobs_swept");
    expect(swept).toMatchObject({ count: 1 });
    expect(swept.killed).toBeGreaterThanOrEqual(run.pids.length);
    core.stdin.end();
    expect(await new Promise((r) => core.once("exit", r))).toBe(0);
  }, 60_000);

  it("a profile edit while a job runs: the job is cancelled `superseded`, its whole tree reaped, and the visit's one replacement runs on the new profile", async () => {
    const run = await startWithRunningJob(children);
    home = run.home;
    const profilePath = join(run.home, "agent-profile.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.tools.revision = 2;
    const tmp = join(run.home, ".agent-profile.tmp");
    writeFileSync(tmp, JSON.stringify(profile), { mode: 0o600 });
    renameSync(tmp, profilePath);
    const diag = () => readLines(join(run.home, "logs", "diagnostics.jsonl"));
    await until(() => diag().filter((e) => e.event === "job_started").length === 2, "the replacement to start", 10_000);
    const events = diag();
    expect(events.find((e) => e.event === "agent_profile_changed")).toMatchObject({ usable: true, toolsRevision: 2 });
    expect(events.find((e) => e.event === "job_cancelled")).toMatchObject({ reason: "superseded" });
    expect(events.find((e) => e.event === "job_replaced")).toMatchObject({ reason: "superseded" });
    expect(events.filter((e) => e.event === "job_started").map((e) => e.replacement)).toEqual([false, true]);
    // The cancelled run published nothing: the replacement's answer is what the window waits for.
    expect(run.stdout()).not.toContain('"superseded"');
    await until(() => !run.pids.some(alive), "the old job's tree to be reaped", 5_000);
    // The replacement launches a second CLI once the new adapter's preflight passed; only its dir is left.
    await until(() => readLines(join(run.home, "fake.log")).filter((l) => Array.isArray(l.argv)).length === 2, "the replacement's CLI", 10_000);
    expect(readdirSync(run.jobsRoot).filter((n) => !n.startsWith("preflight-"))).toHaveLength(1);
    run.core.stdin.end();
    const { code } = await run.exited;
    expect(code).toBe(0);
    expect(diag().filter((e) => e.event === "job_finished").map((e) => [e.status, e.reason])).toEqual([
      ["cancelled", "superseded"],
      ["cancelled", "shutdown"],
    ]);
  }, 60_000);
});

