#!/usr/bin/env node
// Scout Phase 0 bridge spike: hermetic end-to-end echo test (no browser).
//
//   node echo-test.mjs [--scratch-root <absolute dir>]
//
// Plays Chrome's role: spawns the GENERATED wrapper (path contains spaces)
// with the caller origin as argv, exactly as Chrome would, and talks framed
// JSON over its stdio. The wrapper's host talks to a real stub server over a
// real Unix socket in a private runtime dir whose absolute socket path is
// longer than macOS's 104-byte sun_path limit.
//
// Checks: 100 framed messages/acks (random partial chunks, one body of exactly
// 64 KiB), >64 KiB rejection without forwarding, invalid UTF-8 / non-object /
// unknown type rejection, wrong origin rejection, server kill -> disconnected
// + drop, bounded reconnect, schedule exhaustion + manual reconnect, truncated
// frame at EOF, and cleanup (no owned process or socket left).
// Output: one JSON summary, metadata only. Exit 0 only if every check passed.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FrameDecoder, frameHeader, INCOMING_MAX_BYTES } from "./framing.mjs";
import { isMain } from "./is-main.mjs";
import { prepareNativeHost } from "./prepare-host.mjs";
import { SOCKET_NAME } from "./runtime-dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "echo-server.mjs");
export const TEST_EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const WRONG_ORIGIN = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a queued item matching `pred`. */
function makeQueue() {
  const items = [];
  const waiters = [];
  return {
    items,
    push(v) {
      items.push(v);
      for (const w of [...waiters]) {
        const i = items.findIndex(w.pred);
        if (i >= 0) {
          waiters.splice(waiters.indexOf(w), 1);
          clearTimeout(w.t);
          w.resolve(items.splice(i, 1)[0]);
        }
      }
    },
    next(pred = () => true, timeoutMs = 5000, label = "item") {
      const i = items.findIndex(pred);
      if (i >= 0) return Promise.resolve(items.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        w.t = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`timeout waiting for ${label}`));
        }, timeoutMs);
        waiters.push(w);
      });
    },
  };
}

export function startServer(runtimeDir) {
  const child = spawn(process.execPath, [SERVER, "--runtime-dir", runtimeDir, "--exit-on-stdin-end"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const events = makeQueue();
  const all = [];
  let buf = "";
  child.stdin.on("error", () => {});
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const ev = JSON.parse(line);
        all.push(ev);
        events.push(ev);
      } catch {
        // ignore
      }
    }
  });
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  return {
    child,
    events,
    all,
    exited,
    ready: events.next((e) => e.event === "ready" || e.event === "error", 5000, "server ready"),
    count: (name) => all.filter((e) => e.event === name).length,
    /**
     * Bounded shutdown of THIS child only: close its stdin (it exits on EOF),
     * then SIGTERM, then SIGKILL after `graceMs`. Never touches any other
     * process. A child that failed at startup (e.g. already-running) exits on
     * its own and never removes a socket it did not create.
     */
    async stop(graceMs = 2000) {
      const running = () => child.exitCode === null && child.signalCode === null;
      if (running()) child.stdin.end();
      const t1 = setTimeout(() => running() && child.kill("SIGTERM"), 200);
      const t2 = setTimeout(() => running() && child.kill("SIGKILL"), graceMs);
      const r = await exited;
      clearTimeout(t1);
      clearTimeout(t2);
      return r;
    },
  };
}

export function startHost(wrapperPath, origin, env = {}) {
  const child = spawn(wrapperPath, [origin], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", ...env },
  });
  const frames = makeQueue();
  let stderrBytes = 0;
  child.stderr.on("data", (d) => (stderrBytes += d.length));
  const dec = new FrameDecoder({ maxBytes: 16 * 1024 });
  child.stdout.on("data", (chunk) => {
    for (const r of dec.push(chunk)) frames.push(r.ok ? r.value : { type: "__bad-frame__", code: r.code });
  });
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  child.stdin.on("error", () => {});
  return {
    child,
    frames,
    exited,
    get stderrBytes() {
      return stderrBytes;
    },
    writeRaw(buf) {
      child.stdin.write(buf);
    },
    send(obj) {
      const body = Buffer.from(JSON.stringify(obj), "utf8");
      child.stdin.write(Buffer.concat([frameHeader(body.length), body]));
      return body;
    },
    async sendChunked(body, rng) {
      const all = Buffer.concat([frameHeader(body.length), body]);
      let i = 0;
      while (i < all.length) {
        const n = Math.max(1, Math.floor(rng() * Math.min(all.length - i, 7000)));
        child.stdin.write(all.subarray(i, i + n));
        i += n;
        if (rng() < 0.3) await sleep(1);
      }
    },
    next: (pred, ms, label) => frames.next(pred, ms, label),
    close() {
      child.stdin.end();
      return exited;
    },
  };
}

/** A body whose serialized JSON is exactly `bytes` long. */
export function bodyOfSize(id, bytes) {
  const base = { type: "probe", id, data: "" };
  const overhead = Buffer.byteLength(JSON.stringify(base));
  const body = Buffer.from(JSON.stringify({ ...base, data: "x".repeat(bytes - overhead) }), "utf8");
  if (body.length !== bytes) throw new Error("size mismatch");
  return body;
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function runEchoTest({ scratchRoot = tmpdir(), backoffScale = 0.01 } = {}) {
  const checks = [];
  const check = (name, ok, meta = {}) => {
    checks.push({ name, ok: !!ok, ...meta });
    if (!ok) throw new Error(`check failed: ${name}`);
  };
  if (!isAbsolute(scratchRoot)) throw new Error("scratch-root must be absolute");
  const root = mkdtempSync(join(scratchRoot, "scout echo "));
  const deep = join(root, "a deliberately long directory name so the socket path exceeds sun_path");
  mkdirSync(deep);
  const runtimeDir = join(deep, "run time");
  const outDir = join(root, "prepared out");
  const owned = [];
  let server;
  const hosts = [];
  const hostEnv = { SCOUT_BRIDGE_BACKOFF_SCALE: String(backoffScale) };
  try {
    const prep = prepareNativeHost({ outDir, runtimeDir, extensionId: TEST_EXTENSION_ID });
    const sockAbs = join(runtimeDir, SOCKET_NAME);
    check("socket-path-exceeds-sun_path", Buffer.byteLength(sockAbs) > 104, { absSocketPathBytes: Buffer.byteLength(sockAbs) });
    check("wrapper-path-has-spaces", prep.wrapperPath.includes(" "));

    server = startServer(runtimeDir);
    owned.push(server.child.pid);
    const ready = await server.ready;
    check("server-ready", ready.event === "ready", { mode: ready.mode });
    check("runtime-dir-0700", (statSync(runtimeDir).mode & 0o777) === 0o700);
    check("socket-0600", (statSync(sockAbs).mode & 0o777) === 0o600);

    // --- wrong origin: rejected before any socket connection ---
    const connsBefore = server.count("connection");
    const bad = startHost(prep.wrapperPath, WRONG_ORIGIN, hostEnv);
    owned.push(bad.child.pid);
    const badFrame = await bad.next(() => true, 5000, "origin error");
    const badExit = await bad.exited;
    await sleep(50);
    check("wrong-origin-rejected", badFrame.type === "error" && badFrame.code === "origin-rejected" && badExit.code === 1 && server.count("connection") === connsBefore);

    // --- handshake ---
    const host = startHost(prep.wrapperPath, prep.origin, hostEnv);
    hosts.push(host);
    owned.push(host.child.pid);
    const early = host.send({ type: "probe", id: -1 });
    void early;
    const hs = await host.next(() => true, 5000, "handshake reply");
    check("hello-required-first", hs.type === "error" && hs.code === "handshake");
    await host.exited;

    const h = startHost(prep.wrapperPath, prep.origin, hostEnv);
    hosts.push(h);
    owned.push(h.child.pid);
    h.send({ type: "hello", protocol: 1 });
    const ack = await h.next((f) => f.type === "hello-ack", 5000, "hello-ack");
    check("hello-ack-protocol-1", ack.protocol === 1);
    await h.next((f) => f.type === "status" && f.server === "connected", 5000, "server connected");

    // --- 100 framed messages with partial chunks, incl. exactly 64 KiB ---
    const rng = mulberry32(42);
    const t0 = Date.now();
    const expected = new Map();
    for (let i = 0; i < 100; i++) {
      const size = i === 50 ? INCOMING_MAX_BYTES : 40 + Math.floor(rng() * 3000);
      const body = bodyOfSize(i, size);
      expected.set(i, { bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
      await h.sendChunked(body, rng);
    }
    let matched = 0;
    for (let i = 0; i < 100; i++) {
      const a = await h.next((f) => f.type === "ack" && f.id === i, 10000, `ack ${i}`);
      const e = expected.get(i);
      if (a.bytes === e.bytes && a.sha256 === e.sha256 && a.msgType === "probe") matched++;
    }
    check("100-acks-match", matched === 100, { ms: Date.now() - t0, maxBodyBytes: INCOMING_MAX_BYTES });

    // --- rejections: never forwarded ---
    const framesBefore = server.count("frame");
    h.writeRaw(Buffer.concat([frameHeader(INCOMING_MAX_BYTES + 1), bodyOfSize(900, INCOMING_MAX_BYTES + 1)]));
    const over = await h.next((f) => f.type === "error", 5000, "oversized error");
    check("over-cap-rejected", over.code === "oversized");
    h.writeRaw(Buffer.concat([frameHeader(3), Buffer.from([0x7b, 0xff, 0x7d])]));
    check("invalid-utf8-rejected", (await h.next((f) => f.type === "error", 5000)).code === "invalid-utf8");
    h.send([1, 2, 3]);
    check("non-object-rejected", (await h.next((f) => f.type === "error", 5000)).code === "not-object");
    h.send({ type: "exec", id: 7, cmd: "not a command; never run" });
    const unk = await h.next((f) => f.type === "error", 5000);
    check("unknown-type-rejected", unk.code === "unknown-type" && unk.id === 7);
    // A valid frame after the rejects proves the stream stayed in sync.
    h.send({ type: "ping", id: 901 });
    await h.next((f) => f.type === "ack" && f.id === 901, 5000, "post-reject ack");
    check("rejects-not-forwarded", server.count("frame") === framesBefore + 1);

    // --- server killed: disconnected, drop without queueing ---
    await server.stop();
    check("server-socket-removed", !existsSync(sockAbs));
    await h.next((f) => f.type === "status" && f.server === "disconnected", 5000, "disconnected");
    h.send({ type: "capture", id: 902 });
    const dropped = await h.next((f) => f.type === "dropped", 5000, "dropped");
    check("drop-while-disconnected", dropped.id === 902 && dropped.reason === "server-disconnected");

    // --- bounded reconnect: server returns inside the schedule ---
    server = startServer(runtimeDir);
    owned.push(server.child.pid);
    await server.ready;
    await h.next((f) => f.type === "status" && f.server === "connected", 5000, "reconnected");
    h.send({ type: "ping", id: 903 });
    await h.next((f) => f.type === "ack" && f.id === 903, 5000);
    check("reconnect-within-schedule", true);

    // --- schedule exhaustion, then manual reconnect ---
    await server.stop();
    const idle = await h.next((f) => f.type === "status" && f.server === "idle", 10000, "idle");
    check("schedule-exhausts-to-idle", idle.attempts === 6, { attempts: idle.attempts });
    server = startServer(runtimeDir);
    owned.push(server.child.pid);
    await server.ready;
    await sleep(300);
    check("no-retry-after-exhaustion", server.count("connection") === 0);
    h.send({ type: "reconnect" });
    await h.next((f) => f.type === "status" && f.server === "connected", 5000, "manual reconnect");
    check("manual-reconnect", server.count("connection") === 1);

    // --- truncated frame at EOF, then clean exit ---
    h.writeRaw(frameHeader(10));
    h.writeRaw(Buffer.from("{\"a\""));
    const exit = await h.close();
    const trunc = h.frames.items.find((f) => f.type === "error" && f.code === "truncated");
    check("truncated-at-eof", !!trunc);
    check("host-exits-0-on-eof", exit.code === 0);
    check("host-stderr-silent", hosts.every((x) => x.stderrBytes === 0));
    await sleep(100);
    check("server-saw-host-close", server.count("close") >= 1);
  } catch (e) {
    if (!checks.some((c) => !c.ok)) checks.push({ name: "error", ok: false, error: e.message });
  } finally {
    for (const x of hosts) if (x.child.exitCode === null) x.child.stdin.end();
    if (server) await server.stop();
    await sleep(100);
    for (const pid of owned) if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  await sleep(50);
  const leftovers = owned.filter(alive);
  const socketLeft = existsSync(join(runtimeDir, SOCKET_NAME));
  const runtimeEntries = readdirSync(runtimeDir);
  rmSync(root, { recursive: true, force: true });
  checks.push({ name: "cleanup-no-owned-process", ok: leftovers.length === 0, leftovers: leftovers.length });
  checks.push({ name: "cleanup-no-socket", ok: !socketLeft && runtimeEntries.length === 0 });
  checks.push({ name: "cleanup-root-removed", ok: !existsSync(root) });
  return { ok: checks.every((c) => c.ok), checks };
}

if (isMain(import.meta.url)) {
  const i = process.argv.indexOf("--scratch-root");
  const scratchRoot = i >= 0 ? process.argv[i + 1] : tmpdir();
  if (!isAbsolute(scratchRoot)) {
    process.stdout.write(JSON.stringify({ ok: false, error: "scratch-root must be absolute" }) + "\n");
    process.exit(2);
  }
  runEchoTest({ scratchRoot }).then(
    (r) => {
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      process.exit(r.ok ? 0 : 1);
    },
    (e) => {
      process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + "\n");
      process.exit(1);
    },
  );
}
