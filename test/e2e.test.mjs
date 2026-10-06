// End-to-end: the built native host and the built core, talking over a real Unix
// socket in a temp SCOUT_HOME. Builds nothing; run `npm run build` first (or
// `npm run test:all`). Never touches the real ~/.scout.

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { endianness, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = join(ROOT, "packages/scout-core/dist/main.js");
const HOST = join(ROOT, "packages/native-host/dist/host.js");
const FAKE_CLAUDE = join(ROOT, "packages/scout-core/src/agents/claudeCode/testing/fake-claude.mjs");
const FAKE_BACKEND = join(ROOT, "packages/scout-core/src/agents/testing/fake-backend.mjs");
const BUILT = existsSync(CORE) && existsSync(HOST);
if (!BUILT) console.warn("e2e: skipped: packages/scout-core/dist/main.js or packages/native-host/dist/host.js is missing; run `npm run build`");

const EXT_ID = "a".repeat(32);
const ISSUE = "https://github.com/o/r/issues/1";
const TITLE = "E2E-SECRET-TITLE";
const BODY = "E2E-SECRET-BODY";
const LE = endianness() === "LE";

/** Chrome native messaging: a 32-bit length in native byte order, then UTF-8 JSON. */
function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  if (LE) head.writeUInt32LE(body.length);
  else head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

async function until(cond, what, ms = 8_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * A DNS stub the core preloads (`--import`), so the job case never sends a real DNS query: every
 * lookup is recorded and never answers (each fetch then ends on its own timeout, as an
 * unreachable site's would). Returns the preload path and a reader for the hostnames asked.
 */
function dnsStub(dir) {
  const log = join(dir, "dns.log");
  const path = join(dir, "dns-stub.mjs");
  writeFileSync(
    path,
    [
      'import dns from "node:dns";',
      'import { appendFileSync } from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      `const record = (host) => appendFileSync(${JSON.stringify(log)}, String(host) + "\\n");`,
      "dns.promises.lookup = (host) => { record(host); return new Promise(() => {}); };",
      "dns.lookup = (host, ...rest) => { record(host); const cb = rest.at(-1); if (typeof cb === 'function') process.nextTick(cb, Object.assign(new Error('stubbed'), { code: 'ENOTFOUND' })); };",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
  );
  return { importArg: pathToFileURL(path).href, hosts: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

function exitOf(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
}

describe.skipIf(!BUILT)("host <-> core end to end", () => {
  let home;
  const children = [];

  afterEach(() => {
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("host waits for the core, relays through it, and both shut down cleanly without leaking page content", async () => {
    home = mkdtempSync(join(tmpdir(), "scout-e2e-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ extensionId: EXT_ID, destinations: ["docs.stripe.com"] }));
    const env = { ...process.env, SCOUT_HOME: home };
    const runDir = join(home, "run");
    const sockPath = join(runDir, "core.sock");

    // 1. The host starts first; the core is not running yet.
    const host = spawn(process.execPath, [HOST, `chrome-extension://${EXT_ID}/`], { env, stdio: ["pipe", "pipe", "pipe"] });
    children.push(host);
    const toChrome = [];
    let hostBuf = Buffer.alloc(0);
    host.stdout.on("data", (chunk) => {
      hostBuf = Buffer.concat([hostBuf, chunk]);
      while (hostBuf.length >= 4) {
        const n = LE ? hostBuf.readUInt32LE(0) : hostBuf.readUInt32BE(0);
        if (hostBuf.length < 4 + n) break;
        toChrome.push(JSON.parse(hostBuf.subarray(4, 4 + n).toString("utf8")));
        hostBuf = hostBuf.subarray(4 + n);
      }
    });
    let hostErr = "";
    host.stderr.on("data", (c) => (hostErr += c));
    const hostExit = exitOf(host);

    const at = Date.now();
    // page_text before the handshake is dropped by the relay (approved under no policy);
    // the focus waits in its buffer.
    host.stdin.write(
      frame({
        kind: "page_text",
        seq: 1,
        at,
        tabId: 7,
        documentId: "D1",
        url: ISSUE,
        source: "github_issue",
        title: TITLE,
        text: BODY,
        truncated: false,
      }),
    );
    host.stdin.write(frame({ kind: "focus", seq: 2, at, browserFocused: true, windowId: 1, tabId: 7, url: ISSUE, title: TITLE, incognito: false }));
    await until(() => toChrome.some((f) => f.type === "core_unavailable"), "core_unavailable before the core starts");
    expect(toChrome.some((f) => f.type === "ready")).toBe(false);

    // 2. The core starts; the app tells it Chrome is frontmost.
    // A 10-minute dwell: no visit here settles into real fetches.
    const core = spawn(process.execPath, [CORE, "--stdio"], { env: { ...env, SCOUT_DWELL_MS: "600000" }, cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    children.push(core);
    let coreOut = "";
    let coreErr = "";
    core.stdout.on("data", (c) => (coreOut += c));
    core.stderr.on("data", (c) => (coreErr += c));
    const coreExit = exitOf(core);
    core.stdin.write(`${JSON.stringify({ type: "frontmost", bundleId: "com.google.Chrome", at: Date.now() })}\n`);

    // The core's capture-disabled policy reaches Chrome before ready.
    await until(() => toChrome.some((f) => f.type === "ready"), "ready from the host");
    const firstPolicy = toChrome.findIndex((f) => f.type === "capture_policy");
    expect(firstPolicy).toBeGreaterThanOrEqual(0);
    expect(firstPolicy).toBeLessThan(toChrome.findIndex((f) => f.type === "ready"));
    expect(toChrome[firstPolicy]).toEqual({ type: "capture_policy", revision: 0, paused: false, captureEnabled: false });

    // 3. The extension answers with a snapshot (GitHub granted, capture on), then focus; only then does capture turn on.
    expect(toChrome.filter((f) => f.type === "capture_policy")).toHaveLength(1);
    host.stdin.write(frame({ kind: "permissions", revision: 1, at, granted: ["https://github.com/*"], githubCapture: true }));
    host.stdin.write(
      frame({ kind: "focus", seq: 3, at, browserFocused: true, windowId: 1, tabId: 7, url: ISSUE, title: TITLE, incognito: false, permissionsRevision: 1 }),
    );
    await until(() => toChrome.some((f) => f.type === "capture_policy" && f.captureEnabled), "the enabling capture_policy");
    expect(toChrome.filter((f) => f.type === "capture_policy").at(-1)).toEqual({ type: "capture_policy", revision: 1, paused: false, captureEnabled: true });

    const pageTextSeq = 4;
    host.stdin.write(
      frame({
        kind: "page_text",
        seq: pageTextSeq,
        at,
        tabId: 7,
        documentId: "D1",
        url: ISSUE,
        source: "github_issue",
        title: TITLE,
        text: BODY,
        truncated: false,
        // The enabling policy's revision, as the extension stamps it.
        policyRevision: 1,
      }),
    );
    await until(() => toChrome.some((f) => f.type === "ack"), "ack for the page_text");
    expect(toChrome.filter((f) => f.type === "ack")).toEqual([{ type: "ack", seq: pageTextSeq }]);
    // Leave the GitHub visit at once, so its dwell never settles into a real discovery pass.
    core.stdin.write(`${JSON.stringify({ type: "frontmost", bundleId: "com.apple.Terminal", at: Date.now() })}\n`);

    expect(lstatSync(runDir).mode & 0o777).toBe(0o700);
    const sock = lstatSync(sockPath);
    expect(sock.isSocket()).toBe(true);
    expect(sock.mode & 0o777).toBe(0o600);

    // 3. The app quits: the core's stdin closes.
    const before = toChrome.length;
    const t0 = Date.now();
    core.stdin.end();
    const code = await Promise.race([coreExit, new Promise((r) => setTimeout(() => r("timeout"), 1_000))]);
    expect(code, `core exit within 1 s (took ${Date.now() - t0} ms)`).toBe(0);
    expect(existsSync(sockPath)).toBe(false);

    await until(() => toChrome.slice(before).some((f) => f.type === "core_unavailable"), "core_unavailable after the core quits");
    expect(await hostExit).toBe(0);

    // 4. No page text, title, or URL in any log.
    const diag = readFileSync(join(home, "logs", "diagnostics.jsonl"), "utf8");
    for (const [name, text] of [
      ["core stderr", coreErr],
      ["host stderr", hostErr],
      ["diagnostics", diag],
    ]) {
      for (const secret of [TITLE, BODY, "github.com", "/issues/"]) {
        expect(text.includes(secret), `${name} contains ${secret}`).toBe(false);
      }
    }
    expect(coreOut).not.toContain(BODY);
    expect(diag).not.toContain('"event":"dwell_settled"');
  }, 30_000);

  it("the core answers a protocol-1 hello with upgrade_required and closes", async () => {
    home = mkdtempSync(join(tmpdir(), "scout-e2e-"));
    const env = { ...process.env, SCOUT_HOME: home };
    // A 10-minute dwell: no visit here settles into real fetches.
    const core = spawn(process.execPath, [CORE, "--stdio"], { env: { ...env, SCOUT_DWELL_MS: "600000" }, cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    children.push(core);
    let coreErr = "";
    core.stderr.on("data", (c) => (coreErr += c));
    await until(() => coreErr.includes("listening on"), "the core to listen");

    const sock = connect({ path: join(home, "run", "core.sock") });
    sock.on("error", () => {});
    const frames = [];
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const n = LE ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
        if (buf.length < 4 + n) break;
        frames.push(JSON.parse(buf.subarray(4, 4 + n).toString("utf8")));
        buf = buf.subarray(4 + n);
      }
    });
    const closed = new Promise((r) => sock.once("close", r));
    await new Promise((r) => sock.once("connect", r));
    sock.write(frame({ type: "hello", protocol: 1 }));
    await closed;
    expect(frames).toEqual([{ type: "upgrade_required", protocol: 3 }]);

    core.stdin.end();
    expect(await exitOf(core)).toBe(0);
  }, 30_000);

  it("a settled visit to a recommendation host runs the user's agent (fake CLI) through scout-mcp and agent.sock: ok with the optional tool, then empty without it", async () => {
    home = mkdtempSync(join(tmpdir(), "scout-e2e-"));
    const SITE = "https://docs.scout-e2e.invalid";
    const userHome = join(home, "u");
    mkdirSync(join(userHome, ".claude"), { recursive: true });
    mkdirSync(join(home, "bin"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ extensionId: EXT_ID, destinations: ["docs.scout-e2e.invalid"], agentBrowserContext: true }),
    );
    // The user's agent: the scripted fake CLI (never a model), and one optional retrieval tool
    // (the fake backend), each behind a wrapper that reads its mode from a file per launch.
    writeFileSync(join(home, "fake-mode"), "bridge-call");
    writeFileSync(join(home, "backend-mode"), "honest");
    const claudePath = join(home, "bin", "claude");
    writeFileSync(
      claudePath,
      `#!/bin/sh\nFAKE_MODE="$(cat '${home}/fake-mode')" FAKE_VERSION=2.1.286 FAKE_LOG='${home}/fake.log' exec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`,
    );
    const notesPath = join(home, "bin", "notes");
    writeFileSync(notesPath, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_BACKEND}' --mode "$(cat '${home}/backend-mode')" --log '${home}/notes.log'\n`);
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
            {
              connectionId: "notes",
              toolName: "lookup",
              description: "Reviewed lookup",
              inputSchema: lookupSchema,
              schemaHash: schemaHash(lookupSchema),
              required: false,
              unattendedReadDeclared: true,
              selectedAt: "2026-10-01T12:00:00.000Z",
            },
          ],
        },
      }),
      { mode: 0o600 },
    );
    // A fresh cached catalog: the job never waits on the network (the site does not resolve).
    const { cacheFileName } = await import(join(ROOT, "packages/scout-core/dist/privateCacheFile.js"));
    const now = Date.now();
    const candidates = ["billing", "pricing", "webhooks"].map((p, i) => ({
      id: `c${i}`,
      sourceUrl: `${SITE}/docs/${p}`,
      title: `Docs ${p}`,
      labelQuality: "published",
      provenance: "llms.txt",
    }));
    mkdirSync(join(home, "cache", "catalog"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, "cache", "catalog", cacheFileName(SITE)),
      JSON.stringify({ schemaVersion: 3, origin: SITE, fetchedAt: now, resources: [], catalog: { origin: SITE, version: "e2e-v1", fetchedAt: now, candidates, truncated: false, errors: [] } }),
      { mode: 0o600 },
    );

    // Only what the launch profile and the preflight need: no gateway, no API key, a throwaway HOME.
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: userHome, USER: "e2e", LOGNAME: "e2e", LANG: "en_US.UTF-8", TMPDIR: tmpdir(), SCOUT_HOME: home };
    const host = spawn(process.execPath, [HOST, `chrome-extension://${EXT_ID}/`], { env, stdio: ["pipe", "pipe", "pipe"] });
    children.push(host);
    const toChrome = [];
    let hostBuf = Buffer.alloc(0);
    host.stdout.on("data", (chunk) => {
      hostBuf = Buffer.concat([hostBuf, chunk]);
      while (hostBuf.length >= 4) {
        const n = LE ? hostBuf.readUInt32LE(0) : hostBuf.readUInt32BE(0);
        if (hostBuf.length < 4 + n) break;
        toChrome.push(JSON.parse(hostBuf.subarray(4, 4 + n).toString("utf8")));
        hostBuf = hostBuf.subarray(4 + n);
      }
    });
    host.stderr.resume();
    // A 1.5 s dwell: the GitHub visit below is left well before it settles. Hermetic: DNS is stubbed.
    const dns = dnsStub(home);
    const core = spawn(process.execPath, ["--import", dns.importArg, CORE, "--stdio"], { env: { ...env, SCOUT_DWELL_MS: "1500" }, cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    children.push(core);
    let coreErr = "";
    core.stdout.resume();
    core.stderr.on("data", (c) => (coreErr += c));
    const coreExit = exitOf(core);
    const panel = () => toChrome.filter((f) => f.type === "panel").map((f) => f.state);
    core.stdin.write(`${JSON.stringify({ type: "frontmost", bundleId: "com.google.Chrome", at: Date.now() })}\n`);
    await until(() => toChrome.some((f) => f.type === "ready"), "ready from the host");

    const at = Date.now();
    host.stdin.write(frame({ kind: "permissions", revision: 1, at, granted: ["https://github.com/*", `${SITE}/*`], githubCapture: true }));
    host.stdin.write(frame({ kind: "focus", seq: 1, at, browserFocused: true, windowId: 1, tabId: 7, url: ISSUE, title: TITLE, incognito: false, permissionsRevision: 1 }));
    await until(() => toChrome.some((f) => f.type === "capture_policy" && f.captureEnabled), "the enabling capture_policy");
    host.stdin.write(
      frame({ kind: "page_text", seq: 2, at, tabId: 7, documentId: "D1", url: ISSUE, source: "github_issue", title: TITLE, text: BODY, truncated: false, policyRevision: 1 }),
    );
    await until(() => toChrome.some((f) => f.type === "ack"), "ack for the page_text");

    // 1. The docs page settles: one job, the optional tool present and called.
    host.stdin.write(frame({ kind: "focus", seq: 3, at, browserFocused: true, windowId: 1, tabId: 8, url: `${SITE}/docs/billing`, title: "Billing", incognito: false, permissionsRevision: 1 }));
    await until(() => panel().some((f) => f.type === "results"), "the first job's results", 40_000);
    const first = panel();
    const working = first.findIndex((f) => f.type === "state" && f.status === "working");
    const results = first.findIndex((f) => f.type === "results");
    expect(working).toBeGreaterThanOrEqual(0);
    const jobId = first[working].jobId;
    expect(first[results]).toMatchObject({ status: "ok", jobId, origin: SITE });
    expect(first[results].items.map((i) => i.candidateId)).toEqual(["c0", "c1"]);
    expect(first[results].items[0].reason).toContain("lookup:metered");
    expect(first[results].items[0].hostname).toBe("docs.scout-e2e.invalid");
    expect(JSON.stringify(first[results])).not.toContain(`${SITE}/`);
    // working{jobId} → the visit's idle → results, and nothing for the visit after them.
    const between = first.slice(working + 1, results);
    expect(between.filter((f) => f.type === "state").map((f) => f.status)).toEqual(["idle"]);
    expect(first.slice(results + 1).some((f) => f.type === "state" && f.visitEpoch === first[results].visitEpoch)).toBe(false);
    // The fake CLI read the issue through the prompt and Scout's tools through agent.sock with its job token.
    const fakeLines = readFileSync(join(home, "fake.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(fakeLines.filter((l) => l.violations !== undefined).every((l) => l.violations.length === 0)).toBe(true);
    expect(fakeLines.find((l) => l.prompt !== undefined).prompt).toContain(`issue: ${TITLE}`);
    expect(readFileSync(join(home, "notes.log"), "utf8")).toContain('"tool":"lookup"');

    // 2. Another page, the agent answers empty, the optional tool's schema changed (unavailable): empty, the limitation in diagnostics.
    // The first visit's resource probes are still waiting on DNS that never answers (each up to its
    // 8 s timeout, one after another): the visit change cancels that pass, and the second job runs
    // at once instead of queueing behind it.
    writeFileSync(join(home, "fake-mode"), "empty");
    writeFileSync(join(home, "backend-mode"), "schema-change");
    const before = panel().length;
    const focusedAt = Date.now();
    host.stdin.write(frame({ kind: "focus", seq: 4, at, browserFocused: true, windowId: 1, tabId: 8, url: `${SITE}/docs/pricing`, title: "Pricing", incognito: false, permissionsRevision: 1 }));
    await until(() => panel().slice(before).some((f) => f.type === "results"), "the second job's results", 40_000);
    expect(panel().slice(before).find((f) => f.type === "results")).toMatchObject({ status: "empty", origin: SITE });
    // Dwell, then the agent: far less than the probes still queued in the first pass.
    expect(Date.now() - focusedAt).toBeLessThan(12_000);

    core.stdin.end();
    expect(await coreExit).toBe(0);
    const diag = readFileSync(join(home, "logs", "diagnostics.jsonl"), "utf8");
    const events = diag.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const finished = events.filter((e) => e.event === "job_finished");
    expect(finished.map((e) => e.status)).toEqual(["ok", "empty"]);
    expect(finished[0].optionalToolFailed).toBeUndefined();
    expect(finished[1].optionalToolFailed).toBe(true);
    expect(events.filter((e) => e.event === "agent_preflight").map((e) => e.verdict)).toEqual(["subscription"]);
    // The GitHub visit was left before its dwell: no discovery pass ever went to github.com.
    expect(events.some((e) => e.event === "discovery_start" && e.origin === "https://github.com")).toBe(false);
    // The second job started while the first visit's pass was still unwinding its probe; that pass never ingested.
    const secondStart = events.findIndex((e) => e.event === "job_started" && e.epoch === finished[1].epoch);
    const firstDiscarded = events.findIndex((e) => e.event === "discovery_discarded" && e.origin === SITE && e.reason === "visit_changed");
    expect(secondStart).toBeGreaterThanOrEqual(0);
    expect(firstDiscarded === -1 || firstDiscarded > secondStart).toBe(true);
    expect(events.some((e) => e.event === "discovery_ingested")).toBe(false);
    // Hermetic: every lookup went to the stub, and only for the test site.
    expect(dns.hosts().length).toBeGreaterThan(0);
    expect(new Set(dns.hosts())).toEqual(new Set(["docs.scout-e2e.invalid"]));
    // Nothing a page, the issue or the model wrote, and no URL beyond the origin, in any log:
    // run metadata is redacted status, timing and counts only (P3.4). The fixture's candidate
    // titles, the issue's title and body, both picks' reasons, and every candidate href.
    expect(first[results].items[1].reason).toBe("Fits the open billing work");
    const fixtureText = [TITLE, BODY, ...candidates.map((c) => c.title), "Fits the open billing work", "lookup:metered", "Matches", ...candidates.map((c) => c.sourceUrl), "/docs/", "/issues/"];
    for (const [name, text] of [
      ["core stderr", coreErr],
      ["diagnostics", diag],
    ]) {
      for (const secret of fixtureText) {
        expect(text.includes(secret), `${name} contains ${secret}`).toBe(false);
      }
    }
    expect(existsSync(join(home, "run", "jobs")) ? readdirSync(join(home, "run", "jobs")) : []).toEqual([]);
  }, 90_000);
});
