// Unix socket the native host connects to: <runDir>/core.sock.
//
// The socket's files (private run dir, stale probe, publish after chmod 0600, inode-checked
// removal) are handled by localSocketFiles.ts, shared with the agent socket.
// Frames are length-prefixed JSON (see @scout/contracts/frame). Each connection must
// open with a hello; anything else before it closes the connection. A hello for another
// protocol is answered with upgrade_required and closed, so mixed versions fail closed
// instead of continuing with ambiguous permissions. After a protocol-3 hello, bad frames
// are dropped and counted, and valid observation and window-command frames reach the caller.
//
// Window commands (protocol 3) are what the native app may send, except STDIO_ONLY_COMMANDS
// (frontmost, shutdown): one of those reaches the caller as a `refused_command` frame (with
// the `commandId` it carried, if a valid one) so the coordinator can answer `not_permitted`;
// it is never parsed as a command. A command whose JSONL line would not fit
// NATIVE_COMMAND_MAX_BYTES is dropped, as the app's own stdin would refuse it. Frames to the
// host go out under their per-type cap (a `panel` frame up to MAX_PANEL_FRAME_BYTES).

import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  AnyHelloSchema,
  BRIDGE_PROTOCOL,
  BridgeFrameSchema,
  type CommandFrame,
  CommandIdSchema,
  NATIVE_COMMAND_MAX_BYTES,
  type ObservationFrame,
  STDIO_ONLY_COMMANDS,
  type StdioOnlyCommandType,
  type ToChromeFrame,
} from "@scout/contracts";
import { encodeToChromeFrame, FrameDecoder, MAX_FRAME_FROM_CHROME } from "@scout/contracts/frame";
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
/** After upgrade_required, how long the peer gets to read it and close before we destroy the socket. */
export const UPGRADE_CLOSE_MS = 1_000;

/** A native-app-only command sent over the bridge: never applied, answered `not_permitted`. */
export interface RefusedCommandFrame {
  type: "refused_command";
  command: StdioOnlyCommandType;
  /** The commandId the frame carried, when it was a valid one: the refusal's ack names it. */
  commandId?: string;
}

/** What a connection hands the coordinator after hello. */
export type SocketClientFrame = ObservationFrame | CommandFrame | RefusedCommandFrame;

/** One native-host connection that has completed hello. */
export interface SocketClient {
  readonly id: number;
  /** Write one frame; dropped silently once the connection is closed. */
  send(frame: ToChromeFrame): void;
  onFrame(handler: (frame: SocketClientFrame) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface SocketServerOptions {
  runDir: string;
  socketName?: string;
  /** Called synchronously when a connection completes a protocol-3 hello. */
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
    const frameHandlers: Array<(f: SocketClientFrame) => void> = [];
    const closeHandlers: Array<() => void> = [];
    let helloDone = false;
    let rejected = false;
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
          sock.write(encodeToChromeFrame(frame));
        } catch {
          diagnostics.event("bridge_send_failed", { conn: id, type: frame.type });
        }
      },
      onFrame: (h) => void frameHandlers.push(h),
      onClose: (h) => void closeHandlers.push(h),
      close: () => void sock.destroy(),
    };

    const drop = (code: string): void => diagnostics.event("bridge_frame_dropped", { conn: id, code });

    sock.on("data", (chunk: Buffer) => {
      for (const r of decoder.push(chunk)) {
        if (sock.destroyed || rejected) return;
        if (!helloDone) {
          const hello = r.ok ? AnyHelloSchema.safeParse(r.value) : null;
          if (hello?.success && hello.data.protocol === BRIDGE_PROTOCOL) {
            helloDone = true;
            clearTimeout(helloTimer);
            diagnostics.event("bridge_hello", { conn: id });
            options.onClient(client);
            continue;
          }
          clearTimeout(helloTimer);
          rejected = true;
          if (hello?.success) {
            // Tell the host which protocol we speak, then close: it reports upgrade_required.
            diagnostics.event("bridge_rejected", { conn: id, code: "upgrade_required", protocol: hello.data.protocol });
            const upgrade: ToChromeFrame = { type: "upgrade_required", protocol: BRIDGE_PROTOCOL };
            sock.end(encodeToChromeFrame(upgrade));
            setTimeout(() => sock.destroy(), UPGRADE_CLOSE_MS).unref();
            return;
          }
          diagnostics.event("bridge_rejected", { conn: id, code: r.ok ? "handshake" : r.code });
          sock.destroy();
          return;
        }
        if (!r.ok) {
          drop(r.code);
          continue;
        }
        const refused = refusedCommand(r.value);
        if (refused !== null) {
          diagnostics.event("bridge_command_refused", { conn: id, type: refused.command });
          for (const h of frameHandlers) h(refused);
          continue;
        }
        const parsed = BridgeFrameSchema.safeParse(r.value);
        if (!parsed.success) {
          drop("schema");
          continue;
        }
        if (parsed.data.type === "hello") {
          drop("repeat-hello");
          continue;
        }
        if (parsed.data.type === "command" && Buffer.byteLength(`${JSON.stringify(parsed.data.command)}\n`, "utf8") >= NATIVE_COMMAND_MAX_BYTES) {
          drop("command-oversized");
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

/** A `command` frame naming a native-app-only command, as the refusal the coordinator answers; else null. */
function refusedCommand(value: Record<string, unknown>): RefusedCommandFrame | null {
  if (value["type"] !== "command") return null;
  const command = value["command"];
  if (typeof command !== "object" || command === null) return null;
  const { type, commandId } = command as Record<string, unknown>;
  const stdioOnly = STDIO_ONLY_COMMANDS.find((t) => t === type);
  if (stdioOnly === undefined) return null;
  const id = CommandIdSchema.safeParse(commandId);
  return id.success ? { type: "refused_command", command: stdioOnly, commandId: id.data } : { type: "refused_command", command: stdioOnly };
}
