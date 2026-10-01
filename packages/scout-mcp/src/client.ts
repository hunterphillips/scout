// The adapter's backend: anything that answers agent-protocol requests.
//
// createSocketBackend is the production client. It talks to the core's `run/agent.sock`
// with the length-prefixed frame codec, authenticates each new connection with `hello`,
// and never starts a core. Before sending the token it checks that the socket and its
// directory belong to this user and are private. A missing core, a dropped connection or a
// timeout rejects with `unavailable`; the next call reconnects and re-authenticates.
// The in-memory fixture backend is in fixture.ts.

import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  AGENT_PROTOCOL_VERSION,
  AGENT_REQUEST_MAX_BYTES,
  AGENT_RESPONSE_MAX_BYTES,
  AgentResponseEnvelopeSchema,
  AgentTokenSchema,
  type AgentMethod,
  type AgentRequest,
  type AgentRequestOf,
  type AgentResponse,
  type AgentStatusCode,
} from "@scout/contracts";
import { encodeFrame, FrameDecoder, FrameError } from "@scout/contracts/frame";

/** A request that got no response. `code` is from the closed status set. */
export class BackendError extends Error {
  constructor(readonly code: AgentStatusCode) {
    super(code);
    this.name = "BackendError";
  }
}

export interface ScoutAgentBackend {
  /**
   * Send one request. Resolves with the backend's response (`ok` or an error status);
   * rejects with BackendError when there is no response to give. The caller validates the
   * response against its method's schema.
   */
  call<M extends AgentMethod>(request: AgentRequestOf<M>): Promise<AgentResponse<M>>;
  close(): void;
}

// ---------------------------------------------------------------------------
// Production client over the agent socket
// ---------------------------------------------------------------------------

export const DEFAULT_CALL_TIMEOUT_MS = 10_000;
const TOKEN_FILE_MAX_BYTES = 1024;

export interface SocketBackendOptions {
  socketPath: string;
  /** A 0600 regular file owned by this user, holding the connection token. Read on every connect. */
  tokenFile: string;
  timeoutMs?: number;
}

/** Read the token; any problem is `unavailable` with no detail (the token is never echoed). */
export function readTokenFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new BackendError("unavailable");
  }
  try {
    const st = fstatSync(fd);
    const ownedByMe = process.getuid === undefined || st.uid === process.getuid();
    if (!st.isFile() || !ownedByMe || (st.mode & 0o077) !== 0 || st.size > TOKEN_FILE_MAX_BYTES) throw new BackendError("unavailable");
    const token = readFileSync(fd, "utf8").trim();
    if (!AgentTokenSchema.safeParse(token).success) throw new BackendError("unavailable");
    return token;
  } catch {
    throw new BackendError("unavailable");
  } finally {
    closeSync(fd);
  }
}

/**
 * True when the socket's parent is a real directory owned by `uid` with mode 0700, and the
 * socket is a Unix socket owned by `uid` with no group or other permission bits. Mirrors
 * native-host's checkRuntimeDir (not imported: scout-mcp must not depend on that package).
 */
export function isPrivateSocket(socketPath: string, uid: number = process.getuid?.() ?? -1): boolean {
  try {
    const dir = lstatSync(dirname(socketPath));
    if (dir.isSymbolicLink() || !dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o777) !== 0o700) return false;
    const sock = lstatSync(socketPath);
    return sock.isSocket() && sock.uid === uid && (sock.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

export const newRequestId = (): string => randomBytes(12).toString("base64url");

interface Pending {
  resolve(r: AgentResponse): void;
  reject(e: BackendError): void;
  timer: NodeJS.Timeout;
}

interface Connection {
  socket: Socket;
  pending: Map<string, Pending>;
}

export function createSocketBackend(opts: SocketBackendOptions): ScoutAgentBackend {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  let current: Promise<Connection> | undefined;
  let closed = false;

  const send = (c: Connection, request: AgentRequest): Promise<AgentResponse> =>
    new Promise((resolve, reject) => {
      let frame: Buffer;
      try {
        frame = encodeFrame(request, AGENT_REQUEST_MAX_BYTES);
      } catch (e) {
        reject(new BackendError(e instanceof FrameError ? "limit_exceeded" : "unavailable"));
        return;
      }
      const timer = setTimeout(() => {
        c.pending.delete(request.requestId);
        reject(new BackendError("unavailable"));
      }, timeoutMs);
      c.pending.set(request.requestId, { resolve, reject, timer });
      c.socket.write(frame, (err) => {
        if (!err || !c.pending.has(request.requestId)) return;
        c.pending.delete(request.requestId);
        clearTimeout(timer);
        reject(new BackendError("unavailable"));
      });
    });

  const connect = (): Promise<Connection> =>
    new Promise((resolve, reject) => {
      let token: string;
      try {
        token = readTokenFile(opts.tokenFile);
      } catch (e) {
        reject(e);
        return;
      }
      // The token goes only to a socket this user owns in a private directory.
      if (!isPrivateSocket(opts.socketPath)) {
        reject(new BackendError("unavailable"));
        return;
      }
      const socket = createConnection(opts.socketPath);
      const c: Connection = { socket, pending: new Map() };
      const decoder = new FrameDecoder({ maxBytes: AGENT_RESPONSE_MAX_BYTES });
      let ready = false;
      const drop = (code: AgentStatusCode): void => {
        for (const p of c.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new BackendError(code));
        }
        c.pending.clear();
        socket.destroy();
        if (!ready) reject(new BackendError(code));
      };
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          // A frame we can't attribute (oversized, malformed) poisons the stream: drop it.
          if (!frame.ok) return drop(frame.code === "oversized" ? "limit_exceeded" : "protocol_mismatch");
          const env = AgentResponseEnvelopeSchema.safeParse(frame.value);
          if (!env.success) return drop("protocol_mismatch");
          const p = c.pending.get(env.data.requestId);
          if (!p) continue;
          c.pending.delete(env.data.requestId);
          clearTimeout(p.timer);
          if (env.data.protocol !== AGENT_PROTOCOL_VERSION) p.reject(new BackendError("protocol_mismatch"));
          else p.resolve(frame.value as AgentResponse);
        }
      });
      socket.on("error", () => drop("unavailable"));
      socket.on("close", () => drop("unavailable"));
      socket.once("connect", () => {
        const hello: AgentRequestOf<"hello"> = {
          protocol: AGENT_PROTOCOL_VERSION,
          requestId: newRequestId(),
          method: "hello",
          params: { token },
        };
        send(c, hello).then(
          (res) => {
            if (res.status === "ok") {
              ready = true;
              resolve(c);
            } else drop(res.error.code);
          },
          (e: BackendError) => drop(e.code),
        );
      });
    });

  return {
    async call<M extends AgentMethod>(request: AgentRequestOf<M>): Promise<AgentResponse<M>> {
      if (closed) throw new BackendError("unavailable");
      // A connection that dropped since the last call (core restart) is replaced once: the new
      // one re-reads the token and re-authenticates before this request is sent.
      for (let tries = 0; ; tries++) {
        const attempt = (current ??= connect());
        let c: Connection;
        try {
          c = await attempt;
        } catch (e) {
          if (current === attempt) current = undefined;
          throw e instanceof BackendError ? e : new BackendError("unavailable");
        }
        if (!c.socket.destroyed) return (await send(c, request)) as AgentResponse<M>;
        if (current === attempt) current = undefined;
        if (tries > 0) throw new BackendError("unavailable");
      }
    },
    close() {
      closed = true;
      void current?.then((c) => c.socket.destroy(), () => {});
      current = undefined;
    },
  };
}
