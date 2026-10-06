// End-to-end, bridge protocol 3: Scout's window over the relay. The built native host and
// the built core in a temp SCOUT_HOME; a scripted stand-in for the extension speaks Chrome's
// native-messaging framing on the host's stdio, and the core's stdout stands in for the
// native app, which gets `state` frames only. The user's agent is the scripted fake CLI (never a model); DNS is stubbed.
// Builds nothing; run `npm run build` first. Never touches the real ~/.scout.

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { endianness, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = join(ROOT, "packages/scout-core/dist/main.js");
const HOST = join(ROOT, "packages/native-host/dist/host.js");
const FAKE_CLAUDE = join(ROOT, "packages/scout-core/src/agents/claudeCode/testing/fake-claude.mjs");
const BUILT = existsSync(CORE) && existsSync(HOST);
if (!BUILT) console.warn("e2e: skipped: packages/scout-core/dist/main.js or packages/native-host/dist/host.js is missing; run `npm run build`");

const EXT_ID = "a".repeat(32);
const HOSTNAME = "docs.scout-relay.invalid";
const SITE = `https://${HOSTNAME}`;
const LE = endianness() === "LE";

/** Chrome native messaging: a 32-bit length in native byte order, then UTF-8 JSON. */
function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  if (LE) head.writeUInt32LE(body.length);
  else head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

/** Collects length-prefixed JSON frames from a stream. */
function collectFrames(stream) {
  const frames = [];
  let buf = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const n = LE ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
      if (buf.length < 4 + n) break;
      frames.push(JSON.parse(buf.subarray(4, 4 + n).toString("utf8")));
      buf = buf.subarray(4 + n);
    }
  });
  return frames;
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

/** A DNS stub the core preloads: every lookup fails, nothing leaves the machine. */
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

describe.skipIf(!BUILT)("bridge protocol 3: Scout's window over the relay", () => {
  let home;
  const children = [];
  const sockets = [];

  afterEach(() => {
    for (const s of sockets.splice(0)) s.destroy();
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("panel frames reach the side panel and state frames the app; commands from the side panel act, and their acks come back only to it", async () => {
    home = mkdtempSync(join(tmpdir(), "scout-relay-"));
    const userHome = join(home, "u");
    mkdirSync(join(userHome, ".claude"), { recursive: true });
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ extensionId: EXT_ID, destinations: [HOSTNAME] }));
    const claudePath = join(home, "bin", "claude");
    writeFileSync(claudePath, `#!/bin/sh\nFAKE_MODE=ok FAKE_VERSION=2.1.286 FAKE_LOG='${home}/fake.log' exec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`);
    chmodSync(claudePath, 0o755);
    writeFileSync(join(home, "agent-profile.json"), JSON.stringify({ schemaVersion: 1, adapter: "claude-code", claudePath, model: "claude-sonnet-5-5" }), { mode: 0o600 });
    // A fresh cached catalog: the job never waits on the network.
    const { cacheFileName } = await import(join(ROOT, "packages/scout-core/dist/privateCacheFile.js"));
    const now = Date.now();
    const candidates = ["billing", "pricing", "webhooks"].map((p, i) => ({ id: `c${i}`, sourceUrl: `${SITE}/docs/${p}`, title: `Docs ${p}`, labelQuality: "published", provenance: "llms.txt" }));
    mkdirSync(join(home, "cache", "catalog"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, "cache", "catalog", cacheFileName(SITE)),
      JSON.stringify({ schemaVersion: 3, origin: SITE, fetchedAt: now, resources: [], catalog: { origin: SITE, version: "relay-v1", fetchedAt: now, candidates, truncated: false, errors: [] } }),
      { mode: 0o600 },
    );
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: userHome, USER: "e2e", LOGNAME: "e2e", LANG: "en_US.UTF-8", TMPDIR: tmpdir(), SCOUT_HOME: home };

    // The core (the app's side: JSONL on stdio) and the host with its extension stand-in.
    const core = spawn(process.execPath, ["--import", dnsStub(home), CORE, "--stdio"], { env: { ...env, SCOUT_DWELL_MS: "1500" }, cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    children.push(core);
    let coreOut = "";
    let coreErr = "";
    core.stdout.on("data", (c) => (coreOut += c));
    core.stderr.on("data", (c) => (coreErr += c));
    const coreExit = exitOf(core);
    const app = () => coreOut.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    await until(() => coreErr.includes("listening on"), "the core to listen");
    core.stdin.write(`${JSON.stringify({ type: "frontmost", bundleId: "com.google.Chrome", at: Date.now() })}\n`);

    const host = spawn(process.execPath, [HOST, `chrome-extension://${EXT_ID}/`], { env, stdio: ["pipe", "pipe", "pipe"] });
    children.push(host);
    const toChrome = collectFrames(host.stdout);
    let hostErr = "";
    host.stderr.on("data", (c) => (hostErr += c));
    const hostExit = exitOf(host);
    const panel = () => toChrome.filter((f) => f.type === "panel").map((f) => f.state);
    const command = (c) => host.stdin.write(frame({ type: "command", command: c }));

    // 1. ready after the capture-disabled policy, then the repaint: grant, capabilities, audit, state.
    await until(() => panel().length >= 4, "the side panel's first frames");
    const types = toChrome.map((f) => f.type);
    expect(types.indexOf("capture_policy")).toBeLessThan(types.indexOf("ready"));
    expect(types.indexOf("ready")).toBeLessThan(types.indexOf("panel"));
    expect(panel().slice(0, 4).map((f) => f.type)).toEqual(["grant", "capabilities", "audit", "state"]);
    expect(panel()[3]).toMatchObject({ type: "state", status: "idle" });

    // 2. pause and resume from the side panel act on the core: both surfaces see them.
    command({ type: "pause" });
    await until(() => panel().some((f) => f.type === "state" && f.status === "paused"), "paused on the side panel");
    await until(() => app().some((f) => f.type === "state" && f.status === "paused"), "paused on the app");
    expect(toChrome.filter((f) => f.type === "capture_policy").at(-1)).toMatchObject({ paused: true });
    command({ type: "resume" });
    await until(() => panel().at(-1)?.status === "idle", "idle again on the side panel");

    // 3. frontmost from the extension never leaves the host (counted at exit, below).
    command({ type: "frontmost", bundleId: "com.google.Chrome", at: Date.now() });

    // 4. A settled visit to a recommendation host: the fake agent's results reach the side panel;
    // the app's stdout carries state frames only.
    const at = Date.now();
    host.stdin.write(frame({ kind: "permissions", revision: 1, at, granted: [`${SITE}/*`], githubCapture: false }));
    host.stdin.write(frame({ kind: "focus", seq: 1, at, browserFocused: true, windowId: 1, tabId: 8, url: `${SITE}/docs/billing`, title: "Billing", incognito: false, permissionsRevision: 1 }));
    await until(() => panel().some((f) => f.type === "results"), "results on the side panel", 40_000);
    const results = panel().find((f) => f.type === "results");
    expect(results).toMatchObject({ status: "ok", origin: SITE });
    expect(app().some((f) => f.status === "working") && app().every((f) => f.type === "state")).toBe(true);
    expect(JSON.stringify(results)).not.toContain(`${SITE}/`);

    // 5. open_link from the side panel: the ack with the target goes to the side panel only.
    const commandId = "side-open-1";
    command({ type: "open_link", commandId, coreInstanceId: results.coreInstanceId, visitEpoch: results.visitEpoch, jobId: results.jobId, candidateId: results.items[0].candidateId });
    await until(() => panel().some((f) => f.type === "ack" && f.commandId === commandId), "the open_link ack");
    const ack = panel().find((f) => f.type === "ack" && f.commandId === commandId);
    expect(ack).toMatchObject({ ok: true, target: { href: candidates.find((c) => c.id === results.items[0].candidateId).sourceUrl } });
    await new Promise((r) => setTimeout(r, 200));
    expect(coreOut).not.toContain(commandId);

    // 6. A direct core-socket client: it replaces the host's connection and is repainted; a
    // frontmost it sends is answered not_permitted, to it alone.
    const direct = connect({ path: join(home, "run", "core.sock") });
    sockets.push(direct);
    direct.on("error", () => {});
    await new Promise((r) => direct.once("connect", r));
    const fromCore = collectFrames(direct);
    const panelBefore = panel().length;
    direct.write(frame({ type: "hello", protocol: 3 }));
    await until(() => fromCore.filter((f) => f.type === "panel").length >= 4, "the replacing connection's repaint");
    expect(fromCore[0]).toEqual({ type: "capture_policy", revision: 0, paused: false, captureEnabled: false });
    expect(fromCore.filter((f) => f.type === "panel").slice(0, 4).map((f) => f.state.type)).toEqual(["grant", "capabilities", "audit", "state"]);
    direct.write(frame({ type: "command", command: { type: "frontmost", bundleId: "com.google.Chrome", at: Date.now(), commandId: "direct-1" } }));
    await until(() => fromCore.some((f) => f.type === "panel" && f.state.type === "ack"), "the not_permitted ack");
    expect(fromCore.find((f) => f.type === "panel" && f.state.type === "ack").state).toEqual({ type: "ack", commandId: "direct-1", ok: false, code: "not_permitted" });
    expect(coreOut).not.toContain("direct-1");
    // The replaced host connection gets no window frames; a command it sends with a commandId is
    // answered `unavailable` on it alone (the core no longer takes its commands).
    expect(panel().length).toBe(panelBefore);
    command({ type: "refresh_capabilities", commandId: "side-stale-1" });
    await until(() => panel().some((f) => f.type === "ack" && f.commandId === "side-stale-1"), "the unavailable ack on the replaced connection");
    expect(panel().slice(panelBefore)).toEqual([{ type: "ack", commandId: "side-stale-1", ok: false, code: "unavailable" }]);
    expect(fromCore.some((f) => f.type === "panel" && f.state.commandId === "side-stale-1")).toBe(false);
    expect(coreOut).not.toContain("side-stale-1");

    // 7. The app quits: both exit 0; the host counted the frontmost it refused.
    direct.destroy();
    core.stdin.end();
    expect(await coreExit).toBe(0);
    host.stdin.end();
    expect(await hostExit).toBe(0);
    const exitLine = hostErr.split("\n").find((l) => l.includes("scout-native-host: exit"));
    const drops = JSON.parse(exitLine.slice(exitLine.indexOf("{")));
    expect(drops.fromChrome).toMatchObject({ refusedCommand: 1, commandsHandedOff: 4, commandBeforeReady: 0 });
    // No href, page title or candidate title in any log.
    for (const secret of ["Billing", "Docs billing", `${SITE}/docs`]) {
      expect(coreErr.includes(secret), `core stderr contains ${secret}`).toBe(false);
      expect(hostErr.includes(secret), `host stderr contains ${secret}`).toBe(false);
    }
  }, 90_000);
});
