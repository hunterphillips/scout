#!/usr/bin/env node
// Scout Phase 0 bridge spike: stub Unix-socket server.
//
//   node echo-server.mjs --runtime-dir <absolute private dir>
//
// Listens on <runtime-dir>/bridge.sock (0600, dir 0700), bound by relative
// basename after chdir into the runtime dir. Speaks the same length-prefixed
// JSON framing as Chrome native messaging. After a fixed hello/protocol-1
// handshake it acknowledges every frame by type, id, byte length and SHA-256.
// It never echoes content, never logs content, never interprets messages as
// commands, and never persists anything.
//
// stdout: one JSON line per event, metadata only ({event, ...}).
// Exits on SIGTERM/SIGINT/SIGHUP or stdin EOF (when stdin is a pipe), removing
// only the socket inode it created.

import { createHash } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { isAbsolute } from "node:path";
import { encodeFrame, FrameDecoder, INCOMING_MAX_BYTES } from "./framing.mjs";
import { isMain } from "./is-main.mjs";
import { checkOwnSocket, ensurePrivateRuntimeDir, RuntimeDirError, SOCKET_NAME } from "./runtime-dir.mjs";

export const PROTOCOL = 1;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function parseArgs(argv) {
  const i = argv.indexOf("--runtime-dir");
  const dir = i >= 0 ? argv[i + 1] : undefined;
  if (!dir || !isAbsolute(dir)) return null;
  return { runtimeDir: dir, exitOnStdinEnd: argv.includes("--exit-on-stdin-end") };
}

function probeLive(name) {
  return new Promise((resolve) => {
    const s = createConnection({ path: name });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

function handleConnection(sock, counters) {
  const conn = ++counters.connections;
  emit({ event: "connection", conn });
  const dec = new FrameDecoder({ maxBytes: INCOMING_MAX_BYTES });
  let helloDone = false;
  const send = (obj) => {
    if (!sock.destroyed) sock.write(encodeFrame(obj));
  };
  sock.on("data", (chunk) => {
    for (const r of dec.push(chunk)) {
      if (!r.ok) {
        emit({ event: "reject", conn, code: r.code });
        send({ type: "error", code: r.code });
        continue;
      }
      const msg = r.value;
      if (!helloDone) {
        if (msg.type === "hello" && msg.protocol === PROTOCOL) {
          helloDone = true;
          emit({ event: "hello", conn });
          send({ type: "hello-ack", protocol: PROTOCOL });
        } else {
          emit({ event: "reject", conn, code: "handshake" });
          send({ type: "error", code: "handshake" });
          sock.destroy();
          return;
        }
        continue;
      }
      counters.frames++;
      const sha256 = createHash("sha256").update(r.raw).digest("hex");
      const id = Number.isSafeInteger(msg.id) ? msg.id : null;
      const msgType = typeof msg.type === "string" ? msg.type.slice(0, 32) : null;
      emit({ event: "frame", conn, n: counters.frames, bytes: r.bytes, msgType });
      send({ type: "ack", id, msgType, bytes: r.bytes, sha256 });
    }
  });
  sock.on("end", () => {
    for (const r of dec.end()) emit({ event: "reject", conn, code: r.code });
  });
  sock.on("error", () => {});
  sock.on("close", () => emit({ event: "close", conn }));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args) {
    emit({ event: "error", code: "usage" });
    return 2;
  }
  try {
    ensurePrivateRuntimeDir(args.runtimeDir);
    process.chdir(args.runtimeDir);
    const existing = checkOwnSocket(SOCKET_NAME);
    if (existing) {
      if (await probeLive(SOCKET_NAME)) {
        emit({ event: "error", code: "already-running" });
        return 1;
      }
      unlinkSync(SOCKET_NAME); // stale socket we own
    }
  } catch (e) {
    emit({ event: "error", code: e instanceof RuntimeDirError ? e.code : "runtime-dir" });
    return 1;
  }

  process.umask(0o177); // socket is created 0600 (no later files are created)
  const counters = { connections: 0, frames: 0 };
  const sockets = new Set();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    handleConnection(sock, counters);
  });
  let ino = null;
  let closing = false;
  const shutdown = (reason) => {
    if (closing) return;
    closing = true;
    for (const s of sockets) s.destroy();
    server.close();
    try {
      const st = lstatSync(SOCKET_NAME);
      if (ino !== null && st.ino === ino) unlinkSync(SOCKET_NAME);
    } catch {
      // already gone
    }
    emit({ event: "shutdown", reason, frames: counters.frames, connections: counters.connections });
    process.exitCode = 0;
    setImmediate(() => process.exit(0));
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => shutdown(sig));
  if (args.exitOnStdinEnd) {
    process.stdin.on("end", () => shutdown("stdin-end"));
    process.stdin.resume();
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: SOCKET_NAME }, resolve);
  }).catch(() => {
    emit({ event: "error", code: "listen-failed" });
    process.exit(1);
  });
  const st = checkOwnSocket(SOCKET_NAME);
  ino = st.ino;
  emit({ event: "ready", pid: process.pid, socket: SOCKET_NAME, mode: (st.mode & 0o777).toString(8) });
  return undefined;
}

if (isMain(import.meta.url)) {
  main().then((code) => {
    if (code !== undefined) process.exit(code);
  });
}
