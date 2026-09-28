// Unix socket the native host connects to: <runDir>/core.sock.
//
// The run dir must be a real directory (not a symlink) owned by us with mode 0700. It is
// created 0700 when missing and refused, never chmod-ed, when it exists with other
// permissions. An existing socket file is removed only after a connect probe is refused
// (a stale socket); a live one means another core is running, and start() refuses.
// Frames are length-prefixed JSON (see @scout/contracts/frame). Each connection must
// open with a valid hello; anything else before it closes the connection. After hello,
// bad frames are dropped and counted, and valid observation frames reach the caller.

import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, BridgeFrameSchema, type ObservationFrame, type ToChromeFrame } from "@scout/contracts";
import { encodeFrame, FrameDecoder, MAX_FRAME_FROM_CHROME, MAX_FRAME_TO_CHROME } from "@scout/contracts/frame";
import type { Diagnostics } from "./diagnostics.js";

export const SOCKET_NAME = "core.sock";
/** A connection that has not sent hello by then is closed. */
export const HELLO_TIMEOUT_MS = 5_000;
/** A live-socket probe that neither connects nor fails by then counts as live. */
export const PROBE_TIMEOUT_MS = 1_000;

export type SocketServerErrorCode =
  | "runtime-dir-create-failed"
  | "runtime-dir-not-directory"
  | "runtime-dir-wrong-owner"
  | "runtime-dir-not-private"
  | "socket-not-socket"
  | "socket-wrong-owner"
  | "socket-probe-failed"
  | "already-running"
  | "listen-failed";

export class SocketServerError extends Error {
  constructor(readonly code: SocketServerErrorCode) {
    super(code);
    this.name = "SocketServerError";
  }
}

/** One native-host connection that has completed hello. */
export interface SocketClient {
  readonly id: number;
  /** Write one frame; dropped silently once the connection is closed. */
  send(frame: ToChromeFrame): void;
  onFrame(handler: (frame: ObservationFrame) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface SocketServerOptions {
  runDir: string;
  socketName?: string;
  /** Called synchronously when a connection completes hello. */
  onClient: (client: SocketClient) => void;
  diagnostics: Diagnostics;
  helloTimeoutMs?: number;
}

export interface SocketServer {
  start(): Promise<void>;
  /** Closes every connection and the listener, and removes the socket file we created. */
  close(): Promise<void>;
  readonly socketPath: string;
}

export function createSocketServer(options: SocketServerOptions): SocketServer {
  const { diagnostics } = options;
  const socketPath = join(options.runDir, options.socketName ?? SOCKET_NAME);
  const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const sockets = new Set<Socket>();
  let server: Server | null = null;
  let socketIno: number | null = null;
  let nextId = 0;

  const handleConnection = (sock: Socket): void => {
    sockets.add(sock);
    const id = ++nextId;
    const decoder = new FrameDecoder({ maxBytes: MAX_FRAME_FROM_CHROME });
    const frameHandlers: Array<(f: ObservationFrame) => void> = [];
    const closeHandlers: Array<() => void> = [];
    let helloDone = false;
    const helloTimer = setTimeout(() => {
      diagnostics.event("bridge_rejected", { conn: id, code: "hello-timeout" });
      sock.destroy();
    }, helloTimeoutMs);
    helloTimer.unref();

    const client: SocketClient = {
      id,
      send(frame) {
        if (sock.destroyed || !sock.writable) return;
        try {
          sock.write(encodeFrame(frame, MAX_FRAME_TO_CHROME));
        } catch {
          diagnostics.event("bridge_send_failed", { conn: id });
        }
      },
      onFrame: (h) => void frameHandlers.push(h),
      onClose: (h) => void closeHandlers.push(h),
      close: () => void sock.destroy(),
    };

    const drop = (code: string): void => diagnostics.event("bridge_frame_dropped", { conn: id, code });

    sock.on("data", (chunk: Buffer) => {
      for (const r of decoder.push(chunk)) {
        if (sock.destroyed) return;
        if (!helloDone) {
          const hello = r.ok ? BridgeFrameSchema.safeParse(r.value) : null;
          if (hello?.success && hello.data.type === "hello" && hello.data.protocol === BRIDGE_PROTOCOL) {
            helloDone = true;
            clearTimeout(helloTimer);
            diagnostics.event("bridge_hello", { conn: id });
            options.onClient(client);
            continue;
          }
          diagnostics.event("bridge_rejected", { conn: id, code: r.ok ? "handshake" : r.code });
          sock.destroy();
          return;
        }
        if (!r.ok) {
          drop(r.code);
          continue;
        }
        const parsed = BridgeFrameSchema.safeParse(r.value);
        if (!parsed.success) {
          drop("schema");
          continue;
        }
        if (parsed.data.type !== "observation") {
          drop("repeat-hello");
          continue;
        }
        for (const h of frameHandlers) h(parsed.data);
      }
    });
    sock.on("end", () => {
      for (const r of decoder.end()) if (!r.ok) drop(r.code);
      sock.end();
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      clearTimeout(helloTimer);
      sockets.delete(sock);
      if (!helloDone) return;
      diagnostics.event("bridge_close", { conn: id });
      for (const h of closeHandlers) h();
    });
  };

  return {
    socketPath,
    async start() {
      if (server !== null) throw new Error("scout: socket server already started");
      ensurePrivateRunDir(options.runDir);
      await clearStaleSocket(socketPath);

      const srv = createServer(handleConnection);
      // Bind with a 0177 umask so the socket is never briefly wider than 0600, then chmod
      // anyway: umask cannot be set from a worker thread.
      const prevUmask = trySetUmask(0o177);
      try {
        await new Promise<void>((resolve, reject) => {
          srv.once("error", reject);
          srv.listen({ path: socketPath }, () => {
            srv.off("error", reject);
            resolve();
          });
        });
      } catch {
        throw new SocketServerError("listen-failed");
      } finally {
        if (prevUmask !== null) trySetUmask(prevUmask);
      }
      chmodSync(socketPath, 0o600);
      socketIno = lstatSync(socketPath).ino;
      server = srv;
      srv.on("error", () => diagnostics.event("socket_server_error", {}));
      diagnostics.event("socket_listening", {});
    },
    async close() {
      const srv = server;
      server = null;
      for (const s of sockets) s.destroy();
      if (srv !== null) await new Promise<void>((resolve) => srv.close(() => resolve()));
      // Remove only the inode we bound; a newer core may own the path by now.
      if (socketIno !== null) {
        try {
          if (lstatSync(socketPath).ino === socketIno) unlinkSync(socketPath);
        } catch {
          // Already gone.
        }
        socketIno = null;
      }
    },
  };
}

/** Create (0700) or verify the run dir. Never loosens or tightens an existing one. */
export function ensurePrivateRunDir(dir: string, uid: number = process.getuid?.() ?? -1): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    throw new SocketServerError("runtime-dir-create-failed");
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new SocketServerError("runtime-dir-not-directory");
  if (st.uid !== uid) throw new SocketServerError("runtime-dir-wrong-owner");
  if ((st.mode & 0o777) !== 0o700) throw new SocketServerError("runtime-dir-not-private");
}

/** Remove an existing socket only when a connect probe is refused. */
async function clearStaleSocket(path: string, uid: number = process.getuid?.() ?? -1): Promise<void> {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (!st.isSocket()) throw new SocketServerError("socket-not-socket");
  if (st.uid !== uid) throw new SocketServerError("socket-wrong-owner");
  const probe = await probeSocket(path);
  if (probe === "live") throw new SocketServerError("already-running");
  if (probe === "gone") return;
  if (probe === "refused") {
    try {
      unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new SocketServerError("socket-probe-failed");
    }
    return;
  }
  throw new SocketServerError("socket-probe-failed");
}

function probeSocket(path: string): Promise<"live" | "refused" | "gone" | "error"> {
  return new Promise((resolve) => {
    const s = createConnection({ path });
    const done = (result: "live" | "refused" | "gone" | "error"): void => {
      clearTimeout(timer);
      s.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done("live"), PROBE_TIMEOUT_MS);
    s.once("connect", () => done("live"));
    s.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ECONNREFUSED") done("refused");
      else if (e.code === "ENOENT") done("gone");
      else done("error");
    });
  });
}

function trySetUmask(mask: number): number | null {
  try {
    return process.umask(mask);
  } catch {
    return null;
  }
}
