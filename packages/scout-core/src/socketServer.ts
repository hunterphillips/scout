// Unix socket the native host connects to: <runDir>/core.sock.
//
// The socket's files (private run dir, stale probe, publish after chmod 0600, inode-checked
// removal) are handled by localSocketFiles.ts, shared with the agent socket.
// Frames are length-prefixed JSON (see @scout/contracts/frame). Each connection must
// open with a valid hello; anything else before it closes the connection. After hello,
// bad frames are dropped and counted, and valid observation frames reach the caller.

import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, BridgeFrameSchema, type ObservationFrame, type ToChromeFrame } from "@scout/contracts";
import { encodeFrame, FrameDecoder, MAX_FRAME_FROM_CHROME, MAX_FRAME_TO_CHROME } from "@scout/contracts/frame";
import type { Diagnostics } from "./diagnostics.js";
import { type PublishedSocket, publishPrivateSocket } from "./localSocketFiles.js";

export {
  ensurePrivateRunDir,
  PROBE_TIMEOUT_MS,
  SocketServerError,
  type SocketServerErrorCode,
} from "./localSocketFiles.js";

export const SOCKET_NAME = "core.sock";
/** A connection that has not sent hello by then is closed. */
export const HELLO_TIMEOUT_MS = 5_000;

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
  const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const sockets = new Set<Socket>();
  let server: Server | null = null;
  let published: PublishedSocket | null = null;
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
      const srv = createServer(handleConnection);
      published = await publishPrivateSocket({
        runDir: options.runDir,
        socketName: options.socketName ?? SOCKET_NAME,
        server: srv,
        dropConnections: () => {
          for (const sock of sockets) sock.destroy();
        },
        ...(options.chmod ? { chmod: options.chmod } : {}),
      });
      server = srv;
      srv.on("error", () => diagnostics.event("socket_server_error", {}));
      diagnostics.event("socket_listening", {});
    },
    async close() {
      const pub = published;
      server = null;
      published = null;
      for (const s of sockets) s.destroy();
      await pub?.close();
    },
  };
}
