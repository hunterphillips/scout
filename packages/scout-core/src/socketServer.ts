// Unix socket the native host connects to: <runDir>/core.sock.
//
// The run dir must be a real directory (not a symlink) owned by us with mode 0700. It is
// created 0700 when missing and refused, never chmod-ed, when it exists with other
// permissions. An existing socket file is removed only after a connect probe is refused
// (a stale socket); a live one means another core is running, and start() refuses.
// The listener binds a temp name (core.sock.<pid>.tmp), is chmod-ed 0600, and only then
// is hard-linked to core.sock, so the final name never shows the umask mode. link (not
// rename) fails if another core claimed core.sock in the meantime, instead of replacing it.
// Frames are length-prefixed JSON (see @scout/contracts/frame). Each connection must
// open with a valid hello; anything else before it closes the connection. After hello,
// bad frames are dropped and counted, and valid observation frames reach the caller.

import { chmodSync, linkSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
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
  /** Test seam for the post-listen chmod of the temp socket; defaults to fs.chmodSync. */
  chmod?: (path: string, mode: number) => void;
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
  const tempPath = `${socketPath}.${process.pid}.tmp`;
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
    sock.on("error", (e: NodeJS.ErrnoException) =>
      diagnostics.event("bridge_conn_error", { conn: id, code: e.code ?? "unknown" }),
    );
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

      // A leftover temp name from an earlier core with our pid would fail the bind.
      unlinkQuietly(tempPath);

      const srv = createServer(handleConnection);
      // No umask here: it is process-wide and would also apply to anything else created
      // while listen is pending (e.g. the diagnostics log dir). The run dir is 0700 and
      // owner-checked, and the socket is only published under its final name after the
      // chmod below.
      try {
        await new Promise<void>((resolve, reject) => {
          srv.once("error", reject);
          srv.listen({ path: tempPath }, () => {
            srv.off("error", reject);
            resolve();
          });
        });
      } catch {
        unlinkQuietly(tempPath);
        throw new SocketServerError("listen-failed");
      }
      let published = false;
      try {
        (options.chmod ?? chmodSync)(tempPath, 0o600);
        const ino = lstatSync(tempPath).ino;
        try {
          linkSync(tempPath, socketPath);
        } catch (e) {
          throw new SocketServerError(
            (e as NodeJS.ErrnoException).code === "EEXIST" ? "already-running" : "listen-failed",
          );
        }
        published = true;
        unlinkSync(tempPath);
        socketIno = ino;
      } catch (e) {
        // Don't leak a listener nobody will close, or its socket files.
        for (const sock of sockets) sock.destroy();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        unlinkQuietly(tempPath);
        if (published) unlinkQuietly(socketPath);
        throw e instanceof SocketServerError ? e : new SocketServerError("listen-failed");
      }
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

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
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
