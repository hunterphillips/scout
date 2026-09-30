import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  type ActivityObservation,
  type ContextStatus,
  ContextStatusSchema,
  type ObserveActivityResult,
  ObserveActivityResultSchema,
  type RankRequest,
  type RankResponse,
  RankResponseSchema,
} from "personal-context-mcp/api";
import type { z } from "zod";
import { SCOUT_VERSION } from "../version.js";

export const DEFAULT_SERVICE_URL = "http://127.0.0.1:47821/mcp";

/** Fixed reasons a call can fail on Scout's side of the wire. */
export type TransportFailureReason =
  | "no token"
  | "bad token"
  | "service unreachable"
  | "timed out"
  | "bad response"
  | "service error"
  | "aborted";

export type TransportFailure = {
  ok: false;
  /** `cancelled` only when the caller's own signal aborted the call. */
  status: "unavailable" | "error" | "cancelled";
  reason: TransportFailureReason;
};

export type TransportResult<T> = { ok: true; value: T } | TransportFailure;

export interface CallOptions {
  signal?: AbortSignal;
  /** The SDK's per-request timeout; on expiry it sends `notifications/cancelled` and the call fails `timed out`. */
  timeoutMs?: number;
}

export interface ServiceTransport {
  rankSiteLinks(req: RankRequest, options?: CallOptions): Promise<TransportResult<RankResponse>>;
  observeActivity(obs: ActivityObservation, options?: CallOptions): Promise<TransportResult<ObserveActivityResult>>;
  contextStatus(options?: CallOptions): Promise<TransportResult<ContextStatus>>;
  /** The ContextStatus from the most recent well-formed rank or status answer, or null before the first. */
  lastContextStatus(): ContextStatus | null;
  close(): Promise<void>;
}

export interface ServiceTransportOptions {
  /** Defaults to the service's fixed loopback endpoint. */
  baseUrl?: string;
  /** Defaults to `<personal-context home>/token`. */
  tokenPath?: string;
  /** Injected for tests; passed to the SDK transport. */
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** ~/.personal-context-mcp, or PERSONAL_CONTEXT_HOME when set (the service's own convention). */
export function personalContextHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PERSONAL_CONTEXT_HOME || join(env.HOME || homedir(), ".personal-context-mcp");
}

class NoTokenError extends Error {}

/** SDK default is 60 s; nothing Scout sends should wait that long. */
const DEFAULT_CALL_TIMEOUT_MS = 10_000;

/**
 * The one MCP client session Scout holds with the personal-context service.
 *
 * Policy: the bearer token is read lazily at connect, from a regular file only, and is
 * re-read on every reconnect. After a connection failure, a 401, or a lost session, the
 * session is dropped and the next call reconnects; a malformed answer, a JSON-RPC error,
 * a timeout, or the caller's own abort keeps it. Aborting a
 * call's signal makes the SDK send `notifications/cancelled` for that request (the
 * service treats it as an abort) and fail the call at once. `supersedes` only works
 * within one session, which is why the session is kept rather than opened per call.
 * Nothing here logs; the token and full URL never leave this module.
 */
export function createServiceTransport(options: ServiceTransportOptions = {}): ServiceTransport {
  const baseUrl = new URL(options.baseUrl ?? DEFAULT_SERVICE_URL);
  const tokenPath = options.tokenPath ?? join(personalContextHome(options.env), "token");
  let connecting: Promise<Client> | null = null;
  let lastStatus: ContextStatus | null = null;

  const readToken = async (): Promise<string> => {
    try {
      const info = await lstat(tokenPath);
      if (!info.isFile()) throw new NoTokenError();
      const token = (await readFile(tokenPath, "utf8")).trim();
      if (token === "") throw new NoTokenError();
      return token;
    } catch {
      throw new NoTokenError();
    }
  };

  const connect = async (): Promise<Client> => {
    const token = await readToken();
    const transport = new StreamableHTTPClientTransport(baseUrl, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const client = new Client({ name: "scout-core", version: SCOUT_VERSION });
    try {
      // The SDK's own class trips exactOptionalPropertyTypes on `sessionId`; it is the documented pairing.
      await client.connect(transport as Transport);
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    return client;
  };

  const getClient = (): Promise<Client> => {
    connecting ??= connect();
    return connecting;
  };

  const reset = (failed: Promise<Client>): void => {
    // Only drop the session that failed; a newer one may already be connecting.
    if (connecting !== failed) return;
    connecting = null;
    void failed.then((c) => c.close()).catch(() => {});
  };

  async function call<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>, opts: CallOptions): Promise<TransportResult<T>> {
    const pending = getClient();
    let structured: unknown;
    try {
      const client = await pending;
      opts.signal?.throwIfAborted();
      const result = await client.callTool({ name, arguments: args }, undefined, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        timeout: opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      });
      if (result.isError === true) return { ok: false, status: "error", reason: "service error" };
      structured = result.structuredContent;
    } catch (err) {
      if (opts.signal?.aborted) return { ok: false, status: "cancelled", reason: "aborted" };
      const failure = classify(err);
      // A JSON-RPC error answer or a timeout leaves the session usable; closing it on a
      // timeout would also cut off the SDK's `notifications/cancelled` for that request.
      if (failure.reason !== "service error" && failure.reason !== "timed out") reset(pending);
      return failure;
    }
    const parsed = schema.safeParse(structured);
    if (!parsed.success) return { ok: false, status: "error", reason: "bad response" };
    return { ok: true, value: parsed.data };
  }

  const remember = <T extends ContextStatus>(r: TransportResult<T>): TransportResult<T> => {
    if (r.ok) {
      const { serviceInstanceId, activityRevision, sourceGrantRevision } = r.value;
      lastStatus = { serviceInstanceId, activityRevision, sourceGrantRevision };
    }
    return r;
  };

  return {
    async rankSiteLinks(req, opts = {}) {
      return remember(await call("rank_site_links", req, RankResponseSchema, opts));
    },
    observeActivity(obs, opts = {}) {
      return call("observe_activity", obs, ObserveActivityResultSchema, opts);
    },
    async contextStatus(opts = {}) {
      return remember(await call("context_status", {}, ContextStatusSchema, opts));
    },
    lastContextStatus: () => (lastStatus === null ? null : { ...lastStatus }),
    async close() {
      const current = connecting;
      connecting = null;
      if (current) await current.then((c) => c.close()).catch(() => {});
    },
  };
}

function classify(err: unknown): TransportFailure {
  if (err instanceof NoTokenError) return { ok: false, status: "unavailable", reason: "no token" };
  if (err instanceof StreamableHTTPError && err.code === 401) return { ok: false, status: "unavailable", reason: "bad token" };
  if (err instanceof McpError) {
    if (err.code === ErrorCode.RequestTimeout) return { ok: false, status: "unavailable", reason: "timed out" };
    if (err.code === ErrorCode.ConnectionClosed) return { ok: false, status: "unavailable", reason: "service unreachable" };
    return { ok: false, status: "error", reason: "service error" };
  }
  // Refused connections, resets, HTTP errors other than 401, and session loss.
  return { ok: false, status: "unavailable", reason: "service unreachable" };
}
