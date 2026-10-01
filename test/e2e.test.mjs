// End-to-end: the built native host and the built core, talking over a real Unix
// socket in a temp SCOUT_HOME. Builds nothing; run `npm run build` first (or
// `npm run test:all`). Never touches the real ~/.scout.

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { endianness, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = join(ROOT, "packages/scout-core/dist/main.js");
const HOST = join(ROOT, "packages/native-host/dist/host.js");
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
    expect(frames).toEqual([{ type: "upgrade_required", protocol: 2 }]);

    core.stdin.end();
    expect(await exitOf(core)).toBe(0);
  }, 30_000);
});
