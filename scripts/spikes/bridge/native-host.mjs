#!/usr/bin/env node
// Scout Phase 0 bridge spike: Chrome native-messaging host shim.
//
// Launched by Chrome (through the generated wrapper) as
//   native-host.mjs chrome-extension://<id>/
// with cwd = the private runtime dir and SCOUT_BRIDGE_ALLOWED_ORIGIN set by the
// wrapper. It:
//   - rejects any caller origin that is not exactly the configured one;
//   - requires {type:"hello", protocol:1} as the first message;
//   - forwards only allowlisted message types (capture, probe, ping) to the
//     stub server over the private Unix socket, as the exact validated bytes;
//   - relays small, re-built acknowledgements (never content) back to Chrome;
//   - drops messages while the server is absent (no queue) and reports status;
//   - reconnects on a bounded 1, 2, 4, 8, 16, 30 s schedule, then waits for an
//     explicit {type:"reconnect"} from the extension;
//   - never executes anything, never logs or persists message content;
//   - exits on stdin EOF (Chrome closed the port), cleaning only its own socket
//     connection and timers.
// stderr is silent.

import { createConnection } from "node:net";
import { encodeFrame, FrameDecoder, frameBytes, INCOMING_MAX_BYTES, OUTGOING_MAX_BYTES } from "./framing.mjs";
import { isMain } from "./is-main.mjs";
import { createBackoff } from "./reconnect-policy.mjs";
import { checkOwnSocket, checkPrivateRuntimeDir, SOCKET_NAME } from "./runtime-dir.mjs";

export const PROTOCOL = 1;
export const HOST_NAME = "dev.scout.spike_bridge";
export const ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}\/$/;
export const FORWARD_TYPES = new Set(["capture", "probe", "ping"]);

function backoffScale(env) {
  const v = Number(env.SCOUT_BRIDGE_BACKOFF_SCALE);
  return Number.isFinite(v) && v >= 0.001 && v <= 1 ? v : 1;
}

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
const int = (v) => (Number.isSafeInteger(v) ? v : null);

export function runHost({ argv = process.argv.slice(2), env = process.env, stdin = process.stdin, stdout = process.stdout, exit = (c) => process.exit(c) } = {}) {
  let exiting = false;
  const send = (obj) => {
    if (exiting && obj.type !== "error") return;
    try {
      stdout.write(encodeFrame(obj, OUTGOING_MAX_BYTES));
    } catch {
      // oversized outgoing is a programming error; never send it
    }
  };
  const finish = (code) => {
    if (exiting) return;
    exiting = true;
    clearTimeout(retryTimer);
    if (sock) sock.destroy();
    sock = null;
    // Let queued stdout frames flush before exiting.
    if (stdout.writableLength) stdout.once("drain", () => exit(code));
    else setImmediate(() => exit(code));
    setTimeout(() => exit(code), 500).unref();
  };

  const allowed = env.SCOUT_BRIDGE_ALLOWED_ORIGIN;
  const caller = argv[0];
  let sock = null;
  let retryTimer = null;
  if (typeof allowed !== "string" || !ORIGIN_RE.test(allowed)) {
    send({ type: "error", code: "config" });
    finish(1);
    return;
  }
  if (caller !== allowed) {
    send({ type: "error", code: "origin-rejected" });
    finish(1);
    return;
  }
  try {
    checkPrivateRuntimeDir(".");
  } catch (e) {
    send({ type: "error", code: e.code ?? "runtime-dir" });
    finish(1);
    return;
  }

  const backoff = createBackoff({ scale: backoffScale(env) });
  let server = "disconnected"; // connecting | connected | disconnected | idle
  let helloDone = false;

  const status = (extra = {}) => send({ type: "status", server, ...extra });
  const setServer = (s, extra) => {
    server = s;
    if (helloDone) status(extra);
  };

  const scheduleRetry = () => {
    const delay = backoff.next();
    if (delay === null) {
      setServer("idle", { attempts: backoff.attempts });
      return;
    }
    setServer("disconnected", { retryInMs: delay, attempt: backoff.attempts });
    retryTimer = setTimeout(connectNow, delay);
  };

  function connectNow() {
    retryTimer = null;
    if (exiting || sock) return;
    try {
      if (!checkOwnSocket(SOCKET_NAME)) return scheduleRetry();
    } catch {
      return scheduleRetry();
    }
    setServer("connecting");
    const s = createConnection({ path: SOCKET_NAME });
    sock = s;
    const dec = new FrameDecoder({ maxBytes: OUTGOING_MAX_BYTES });
    let serverHello = false;
    s.once("connect", () => s.write(encodeFrame({ type: "hello", protocol: PROTOCOL, role: "native-host" })));
    s.on("data", (chunk) => {
      for (const r of dec.push(chunk)) {
        if (!r.ok) continue;
        const m = r.value;
        if (!serverHello) {
          if (m.type === "hello-ack" && m.protocol === PROTOCOL) {
            serverHello = true;
            backoff.reset();
            setServer("connected");
          } else s.destroy();
          continue;
        }
        if (m.type === "ack") {
          send({ type: "ack", id: int(m.id), msgType: str(m.msgType, 32), bytes: int(m.bytes), sha256: str(m.sha256, 64) });
        } else if (m.type === "error") {
          send({ type: "error", code: str(m.code, 32), from: "server" });
        }
      }
    });
    s.on("error", () => {});
    s.on("close", () => {
      if (sock !== s) return;
      sock = null;
      if (exiting) return;
      scheduleRetry();
    });
    s.connected = () => serverHello;
  }

  const dec = new FrameDecoder({ maxBytes: INCOMING_MAX_BYTES });
  const onMessage = (r) => {
    if (exiting) return; // later frames in the same chunk after a fatal one
    if (!r.ok) {
      send({ type: "error", code: r.code });
      if (!helloDone) finish(1); // the first frame must be a valid hello
      return;
    }
    const m = r.value;
    if (!helloDone) {
      if (m.type === "hello" && m.protocol === PROTOCOL) {
        helloDone = true;
        send({ type: "hello-ack", protocol: PROTOCOL, server });
        connectNow();
      } else {
        send({ type: "error", code: "handshake" });
        finish(1);
      }
      return;
    }
    if (m.type === "reconnect") {
      if (!sock && (server === "idle" || server === "disconnected")) {
        clearTimeout(retryTimer);
        backoff.reset();
        connectNow();
      } else status();
      return;
    }
    if (m.type === "hello") {
      send({ type: "hello-ack", protocol: PROTOCOL, server });
      return;
    }
    const id = int(m.id);
    if (!FORWARD_TYPES.has(m.type) || id === null) {
      send({ type: "error", code: "unknown-type", id });
      return;
    }
    if (!sock || !sock.connected?.()) {
      send({ type: "dropped", id, reason: "server-disconnected" });
      return;
    }
    sock.write(frameBytes(r.raw, INCOMING_MAX_BYTES));
  };

  stdin.on("data", (chunk) => {
    if (exiting) return;
    for (const r of dec.push(chunk)) onMessage(r);
  });
  stdin.on("end", () => {
    for (const r of dec.end()) send({ type: "error", code: r.code });
    finish(0);
  });
  stdin.on("error", () => finish(0));
  stdout.on("error", () => finish(0));
}

if (isMain(import.meta.url)) {
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => process.exit(0));
  runHost();
}
