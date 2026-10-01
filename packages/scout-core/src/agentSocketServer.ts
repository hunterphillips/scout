// Unix socket Scout's MCP adapter connects to: <runDir>/agent.sock. Its files are handled
// like core.sock's (localSocketFiles.ts); its protocol is the separate, read-only agent
// protocol (@scout/contracts agent.ts) with its own frame caps (16 KiB in, 64 KiB out).
// Neither socket accepts the other's frames: a browser frame is not an agent request and
// closes this connection before authentication, as an agent frame does on core.sock.
//
// Each connection must open with `hello` within the timeout. A first frame that is not a
// `hello` request closes the connection; a refused `hello` (bad token, other protocol) is
// answered and then the connection is closed. After it, every frame is answered by the
// handlers, in order; an undecodable one gets `limit_exceeded` or `protocol_mismatch`, and a
// second `hello` closes the connection. Closing a connection drops its cursors and pins.

import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { AGENT_REQUEST_MAX_BYTES, AGENT_RESPONSE_MAX_BYTES, type AgentResponse } from "@scout/contracts";
import { encodeFrame, FrameDecoder } from "@scout/contracts/frame";
import type { AgentAuth, JobTokenGrant } from "./agentApi/auth.js";
import type { AgentConnection, AgentHandlers } from "./agentApi/handlers.js";
import type { ReadAudit, ReadAuditEntry } from "./agentApi/readAudit.js";
import type { Diagnostics } from "./diagnostics.js";
import { type PublishedSocket, publishPrivateSocket } from "./localSocketFiles.js";

export const AGENT_SOCKET_NAME = "agent.sock";
/** A connection that has not completed hello by then is closed. */
export const AGENT_HELLO_TIMEOUT_MS = 5_000;

export interface AgentSocketServerOptions {
  runDir: string;
  handlers: AgentHandlers;
  auth: AgentAuth;
  audit: ReadAudit;
  diagnostics: Diagnostics;
  helloTimeoutMs?: number;
  /** Test seam for the post-listen chmod of the temp socket; defaults to fs.chmodSync. */
  chmod?: (path: string, mode: number) => void;
}

export interface AgentSocketServer {
  readonly socketPath: string;
  readonly coreInstanceId: string;
  start(): Promise<void>;
  /** Closes every connection (dropping cursors and releasing pins) and the listener, and removes the socket. */
  close(): Promise<void>;
  /** A token for one background job; it authenticates as role `job` until revoked. */
  issueJobToken(grant: JobTokenGrant): string;
  revokeJobToken(jobId: string): void;
  /** For the store's `onRevoked`: drop the resource's cursors and the job tokens that pinned it. Synchronous. */
  resourceRevoked(resourceId: string): void;
  /** Drop expired cursors and release their read pins; main runs it before each capability GC. */
  sweepExpired(): void;
  /** The recent browser-context reads, oldest first. */
  readAudit(): ReadAuditEntry[];
  readonly openConnections: number;
}

export function createAgentSocketServer(options: AgentSocketServerOptions): AgentSocketServer {
  const { diagnostics, handlers, auth } = options;
  const helloTimeoutMs = options.helloTimeoutMs ?? AGENT_HELLO_TIMEOUT_MS;
  const sockets = new Set<Socket>();
  let server: Server | null = null;
  let published: PublishedSocket | null = null;
  let nextId = 0;
  /** Set by `close()`: a connection accepted from then on is destroyed before it can authenticate. */
  let closing = false;

  const handleConnection = (sock: Socket): void => {
    if (closing) {
      sock.destroy();
      return;
    }
    sockets.add(sock);
    const n = ++nextId;
    const conn: AgentConnection = { id: `agent-conn-${n}`, principal: null };
    const decoder = new FrameDecoder({ maxBytes: AGENT_REQUEST_MAX_BYTES });
    const reject = (code: string): void => {
      diagnostics.event("agent_rejected", { conn: n, code });
      sock.destroy();
    };
    const helloTimer = setTimeout(() => reject("hello-timeout"), helloTimeoutMs);
    helloTimer.unref();

    const send = (res: AgentResponse): boolean => {
      if (sock.destroyed || !sock.writable) return false;
      try {
        sock.write(encodeFrame(res, AGENT_RESPONSE_MAX_BYTES));
        return true;
      } catch {
        // The handlers keep responses under the cap; one that is not cannot be attributed.
        reject("response-oversized");
        return false;
      }
    };

    sock.on("data", (chunk: Buffer) => {
      for (const r of decoder.push(chunk)) {
        if (sock.destroyed) return;
        const isHello = r.ok && r.value.method === "hello";
        if (conn.principal === null) {
          if (!isHello) return reject(r.ok ? "handshake" : r.code);
          const res = handlers.call(r.value, conn);
          // `call` sets the principal on an accepted hello.
          const principal = conn.principal as AgentConnection["principal"];
          if (principal === null) {
            diagnostics.event("agent_rejected", { conn: n, code: res.status === "error" ? res.error.code : "handshake" });
            clearTimeout(helloTimer);
            if (send(res)) sock.end();
            return;
          }
          clearTimeout(helloTimer);
          diagnostics.event("agent_hello", { conn: n, role: principal.role });
          send(res);
          continue;
        }
        if (isHello) return reject("repeat-hello");
        send(r.ok ? handlers.call(r.value, conn) : handlers.refuse(r.code === "oversized" ? "limit_exceeded" : "protocol_mismatch"));
      }
    });
    sock.on("end", () => void sock.end());
    sock.on("error", (e: NodeJS.ErrnoException) => diagnostics.event("agent_conn_error", { conn: n, code: e.code ?? "unknown" }));
    sock.on("close", () => {
      clearTimeout(helloTimer);
      sockets.delete(sock);
      handlers.endConnection(conn);
      if (conn.principal !== null) diagnostics.event("agent_close", { conn: n });
    });
  };

  return {
    socketPath: join(options.runDir, AGENT_SOCKET_NAME),
    coreInstanceId: handlers.coreInstanceId,
    async start() {
      if (server !== null) throw new Error("scout: agent socket server already started");
      closing = false;
      const srv = createServer(handleConnection);
      published = await publishPrivateSocket({
        runDir: options.runDir,
        socketName: AGENT_SOCKET_NAME,
        server: srv,
        dropConnections: () => {
          for (const sock of sockets) sock.destroy();
        },
        ...(options.chmod ? { chmod: options.chmod } : {}),
      });
      server = srv;
      srv.on("error", () => diagnostics.event("agent_socket_error", {}));
      diagnostics.event("agent_socket_listening", {});
    },
    async close() {
      const pub = published;
      server = null;
      published = null;
      closing = true;
      // Stop accepting first, so a client reconnecting now cannot authenticate and hold the
      // listener open; then wait for each close event, so every connection's cursors and pins
      // are gone on return.
      const listenerClosed = pub?.close();
      await Promise.all(
        [...sockets].map(
          (s) =>
            new Promise<void>((resolve) => {
              s.once("close", () => resolve());
              s.destroy();
            }),
        ),
      );
      await listenerClosed;
    },
    issueJobToken: (grant) => auth.issueJobToken(grant),
    revokeJobToken: (jobId) => auth.revokeJobToken(jobId),
    resourceRevoked(resourceId) {
      handlers.dropResource(resourceId);
      auth.revokeJobTokensPinning(resourceId);
    },
    sweepExpired: () => handlers.sweepExpired(),
    readAudit: () => options.audit.entries(),
    get openConnections() {
      return sockets.size;
    },
  };
}
