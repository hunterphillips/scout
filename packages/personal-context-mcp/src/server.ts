// The personal-context MCP service: Streamable HTTP on 127.0.0.1, three tools.
//
// `node dist/server.js` runs it standalone. `runServer(deps)` is the testable core; its
// only deps are the environment and a log sink. Tests reach a fake CLI through config
// `claudePath` (a wrapper script that answers the preflight's four allowlisted `auth`
// invocations itself and execs test/fake-claude.mjs for runs), so the real billing
// preflight runs against it and no preflight or spawn seam exists here.
//
// Request gate, before the MCP transport sees anything: `Host` must be exactly
// `127.0.0.1:<port>` or `localhost:<port>` and any `Origin` header is refused (403); the
// bearer token from <home>/token is compared in constant time (401); only `/mcp` exists
// (404). One MCP session = one SDK transport + one McpServer.
//
// Abort triggers for a running `rank_site_links`, each ending in the RunContext signal
// with the runner's AbortReason as the abort reason:
//   - `notifications/cancelled` for that request: the SDK aborts the handler's
//     `extra.signal`; while the session is still open that maps to `notifications_cancelled`.
//   - `supersedes`: a later rank in the same session naming a running requestId (a
//     per-session requestId -> AbortController map; other sessions never see it).
//   - `session_closed`: the session's transport closing (DELETE, idle expiry, shutdown).
//     Our transport.onclose runs before the SDK's own, which also aborts `extra.signal`.
//   - `response_closed`: the POST that carried the rank closing before its response was
//     written (Node `res` 'close' with `writableFinished` false). The server parses POST
//     bodies itself so it knows which JSON-RPC ids each response stream carries.
//   - `grant_changed`: reload (SIGHUP) via runner.abortAll.
//   - `sigterm` / `sigint`: shutdown via runner.abortAll.
//   - `deadline`: the runner's own timer.
// Every rank outcome, including unavailable/error/cancelled, is a normal tool result.
//
// Sessions: at most MAX_SESSIONS. Scout opens a new session on every reconnect and may
// never DELETE the old one, so at the cap the least recently seen session with no running
// rank is closed to make room; only when every session has a running rank is a new one
// refused (503). A session with no running rank and no HTTP traffic for SESSION_IDLE_MS is
// closed by a sweep every SESSION_SWEEP_MS; a session with a running rank is kept.
//
// run/server.json ownership: a live pid is not enough (a SIGKILL leaves the file, and the
// pid can be reused). Start refuses only when the file's service answers on its port with
// its own serviceInstanceId (serviceProbe.ts); otherwise the file is stale and overwritten.
//
// Reload (SIGHUP) accepted limits, fine for the PoC: refreshPreflight runs the preflight's
// `claude` invocations synchronously, so the event loop is blocked for that time even while
// connections are live. Between setConfig and refreshPreflight a new rank sees no current
// preflight verdict and returns `unavailable`, which fails safe. A reload during shutdown
// is ignored. Shutdown waits at most SHUTDOWN_GRACE_MS (or until a second signal) after
// aborting every run, then exits anyway.
//
// Logging: JSONL on stderr, fixed codes and scalars only. Never a token, prompt, page
// text, title, URL, candidate or path.

import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createAgentRunner, type AbortReason, type AgentRunner } from "./agentRunner.js";
import {
  ActivityObservationSchema,
  ContextStatusSchema,
  ObserveActivityResultSchema,
  RankRequestSchema,
  RankResponseSchema,
  type ContextStatus,
  type RankRequest,
  type RankResponse,
} from "./api.js";
import { systemClock } from "./clock.js";
import { ConfigError, loadConfig, resolveHome, sourceGrantRevision, type EnvLike, type PcmConfig } from "./config.js";
import { createObservationStore } from "./observationStore.js";
import {
  ensurePrivateDir,
  ensureToken,
  MESSAGES,
  pidAlive,
  readServerInfo,
  removeServerInfo,
  RUN_DIR,
  ServiceFileError,
  writeServerInfo,
} from "./serviceFiles.js";
import { probeService } from "./serviceProbe.js";

export const SERVER_NAME = "personal-context-mcp";
export const SERVER_VERSION = "0.0.0";
export const MCP_PATH = "/mcp";
/** Largest POST body read. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_SESSIONS = 64;
/** A session with no HTTP traffic and no running rank for this long is closed. */
export const SESSION_IDLE_MS = 5 * 60_000;
export const SESSION_SWEEP_MS = 30_000;
/** How long a response watch no handler claimed outlives its closed response. */
export const WATCH_GRACE_MS = 2_000;
/** Longest the process waits for a clean shutdown after a signal. */
export const SHUTDOWN_GRACE_MS = 10_000;

export type LogFields = Record<string, string | number | boolean>;

export interface ServerDeps {
  /** Defaults to process.env. Reads PERSONAL_CONTEXT_HOME, HOME, PCM_PORT, PCM_SCRATCH_ROOT, PCM_WORKSPACE_ROOTS. */
  env?: EnvLike;
  /** One JSONL line per call. Defaults to stderr. */
  log?: (line: string) => void;
}

export interface ReloadResult {
  ok: boolean;
  sourceGrantRevision: string;
}

export interface RunningServer {
  readonly port: number;
  readonly serviceInstanceId: string;
  readonly home: string;
  readonly sourceGrantRevision: string;
  /** Re-read the config (SIGHUP). A malformed file keeps the old config. */
  reload(): Promise<ReloadResult>;
  /** Abort every run, close the HTTP server, remove server.json. Idempotent. */
  shutdown(reason: "sigterm" | "sigint"): Promise<void>;
  readonly runner: AgentRunner;
  /** Live bookkeeping sizes, for tests: open sessions, response watches, running ranks. */
  counts(): { sessions: number; watches: number; runs: number };
}

/** Start failures; `message` is fixed text and safe to print. */
export class ServerStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerStartError";
  }
}

export function portInUseMessage(port: number): string {
  return `port ${port} in use; set PCM_PORT`;
}

/** The scout repo root, from this module's location (dist/ or src/ under packages/personal-context-mcp). */
function scoutRoot(): string {
  const here = fileURLToPath(new URL("../../..", import.meta.url));
  try {
    return realpathSync(here);
  } catch {
    return here;
  }
}

/**
 * The built source-tools entry next to this module. Loaded from src/ (the tests run the
 * TypeScript directly), it is the built copy in dist/, which the test global setup builds.
 */
function sourceToolsPath(): string {
  const here = fileURLToPath(import.meta.url);
  return here.endsWith(".ts") ? join(dirname(here), "..", "dist", "sourceTools.js") : join(dirname(here), "sourceTools.js");
}

function parsePort(v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  if (!/^\d{1,5}$/.test(v) || Number(v) > 65_535) throw new ServerStartError("PCM_PORT is not a port number");
  return Number(v);
}

interface Session {
  id: string | undefined;
  transport: StreamableHTTPServerTransport;
  closed: boolean;
  lastSeen: number;
  /** Running ranks by the caller's requestId, for supersedes. */
  runs: Map<string, AbortController>;
  /** JSON-RPC request id -> response watch, for response_closed. */
  watches: Map<string | number, ResponseWatch>;
}

interface ResponseWatch {
  closed: boolean;
  controller?: AbortController;
}

function textResult(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function jsonRpcIds(body: unknown): Array<string | number> {
  const msgs = Array.isArray(body) ? body : [body];
  const ids: Array<string | number> = [];
  for (const m of msgs) {
    if (m !== null && typeof m === "object" && "method" in m && "id" in m) {
      const id = (m as { id: unknown }).id;
      if (typeof id === "string" || typeof id === "number") ids.push(id);
    }
  }
  return ids;
}

function isInitialize(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => m !== null && typeof m === "object" && (m as { method?: unknown }).method === "initialize");
}

/** The body, or "too-large" as soon as it passes `max` (the rest is never read). */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let len = 0;
    const onData = (c: Buffer): void => {
      len += c.length;
      if (len > max) {
        req.off("data", onData);
        req.pause();
        resolve("too-large");
        return;
      }
      chunks.push(c);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 413, then drop the connection instead of draining the rest of the body. */
function refuseTooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.once("finish", () => req.destroy());
  sendJson(res, 413, rpcError(-32600, "request too large"), { connection: "close" });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(body));
}

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

export async function runServer(deps: ServerDeps = {}): Promise<RunningServer> {
  const env = deps.env ?? process.env;
  const sink = deps.log ?? ((line: string) => void process.stderr.write(line + "\n"));
  const log = (code: string, fields: LogFields = {}): void => {
    try {
      sink(JSON.stringify({ t: new Date().toISOString(), code, ...fields }));
    } catch {
      // a broken sink never breaks the service
    }
  };

  let home: string;
  let config: PcmConfig;
  try {
    home = resolveHome(env);
    ensurePrivateDir(home);
    config = loadConfig(home, env);
  } catch (e) {
    if (e instanceof ConfigError) throw new ServerStartError(`config: ${e.code}`);
    if (e instanceof ServiceFileError) throw new ServerStartError(e.message);
    throw new ServerStartError("config: unusable");
  }
  const requestedPort = parsePort(env.PCM_PORT, config.port);

  let token: string;
  try {
    token = ensureToken(home);
  } catch (e) {
    throw new ServerStartError(e instanceof ServiceFileError ? e.message : MESSAGES.tokenUnreadable);
  }
  const tokenDigest = createHash("sha256").update(token).digest();

  // Refuse only when the file names a live service that answers as itself; anything else
  // (dead pid, reused pid, no answer, another instance id) is a stale file, overwritten below.
  const prior = readServerInfo(home);
  if (prior !== undefined && prior.pid !== process.pid && pidAlive(prior.pid)) {
    if ((await probeService(prior, token)) !== undefined) throw new ServerStartError(MESSAGES.alreadyRunning);
    log("stale_server_json");
  }

  let scratchRoot: string;
  try {
    ensurePrivateDir(join(home, RUN_DIR));
    scratchRoot = env.PCM_SCRATCH_ROOT || join(home, RUN_DIR, "scratch");
    if (!isAbsolute(scratchRoot)) throw new ServerStartError("PCM_SCRATCH_ROOT is not absolute");
    ensurePrivateDir(scratchRoot);
  } catch (e) {
    if (e instanceof ServerStartError) throw e;
    throw new ServerStartError(MESSAGES.privateDir);
  }
  const userHome = env.HOME;
  const workspaceRoots = env.PCM_WORKSPACE_ROOTS
    ? env.PCM_WORKSPACE_ROOTS.split(delimiter).filter((p) => p !== "")
    : [scoutRoot(), ...(userHome ? [join(userHome, "workspace")] : [])];
  if (workspaceRoots.some((r) => !isAbsolute(r))) throw new ServerStartError("PCM_WORKSPACE_ROOTS entries must be absolute");

  const serviceInstanceId = randomUUID();
  const store = createObservationStore({ clock: systemClock });
  let grantRevision = sourceGrantRevision(config);
  const runner = createAgentRunner({
    config,
    home,
    parentEnv: env,
    scratchRoot,
    workspaceRoots,
    sourceToolsPath: sourceToolsPath(),
    log: (line) => log("runner", { detail: line }),
  });

  // Once, before listening; never on the request path.
  const pre = runner.refreshPreflight();
  log("preflight", { verdict: pre.verdict, reasons: pre.reasons.length });

  const sessions = new Map<string, Session>();
  let shuttingDown = false;
  let port = requestedPort;

  // ---------- tools ----------

  const contextStatus = (): ContextStatus => ({ serviceInstanceId, activityRevision: store.activityRevision, sourceGrantRevision: grantRevision });

  async function rank(session: Session, req: RankRequest, extra: { signal: AbortSignal; requestId: string | number }): Promise<CallToolResult> {
    const controller = new AbortController();
    const abort = (reason: AbortReason): void => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    if (req.supersedes !== undefined) session.runs.get(req.supersedes)?.abort("supersedes");
    session.runs.set(req.requestId, controller);
    const onCancel = (): void => abort(session.closed ? "session_closed" : "notifications_cancelled");
    if (extra.signal.aborted) onCancel();
    else extra.signal.addEventListener("abort", onCancel, { once: true });
    let watch = session.watches.get(extra.requestId);
    if (watch === undefined) {
      watch = { closed: false };
      session.watches.set(extra.requestId, watch);
    }
    watch.controller = controller;
    if (watch.closed) abort("response_closed");
    if (session.closed) abort("session_closed");
    if (shuttingDown) abort("sigterm");

    // Everything the run sees is fixed here, at request time.
    const snapshot = store.snapshot();
    const grant = grantRevision;
    const sources = config.sources;
    try {
      const outcome = await runner.run(req, { snapshot, sources, sourceGrantRevision: grant, signal: controller.signal });
      const status = { serviceInstanceId, activityRevision: snapshot.activityRevision, sourceGrantRevision: grant };
      const parsed = RankResponseSchema.safeParse({ ...outcome.result, ...status });
      const response: RankResponse = parsed.success ? parsed.data : { status: "error", reason: "invalid response", ...status };
      log("rank", { status: response.status, ...(response.status === "cancelled" || response.status === "unavailable" || response.status === "error" ? { reason: response.reason } : {}) });
      return textResult(response as Record<string, unknown>);
    } finally {
      session.lastSeen = Date.now();
      extra.signal.removeEventListener("abort", onCancel);
      if (session.runs.get(req.requestId) === controller) session.runs.delete(req.requestId);
      if (session.watches.get(extra.requestId) === watch) session.watches.delete(extra.requestId);
    }
  }

  function buildMcp(session: Session): McpServer {
    const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    mcp.registerTool(
      "rank_site_links",
      {
        description:
          "Rank a site's candidate links against Hunter's recent activity and granted sources. Returns at most maxResults picks " +
          "with evidence, or empty/unavailable/cancelled/error, always with the ContextStatus fields.",
        inputSchema: RankRequestSchema,
      },
      // No outputSchema: the response is a union, which the SDK cannot use as one. It is
      // validated against RankResponseSchema above instead.
      (args, extra) => rank(session, args, extra),
    );
    mcp.registerTool(
      "observe_activity",
      {
        description: "Record one page Hunter viewed. Kept in memory for 15 minutes; never written to disk.",
        inputSchema: ActivityObservationSchema,
        outputSchema: ObserveActivityResultSchema,
      },
      (args) => {
        const r = store.add(args);
        return textResult({ accepted: r.accepted, observationId: r.observationId });
      },
    );
    mcp.registerTool(
      "context_status",
      {
        description: "The service instance, activity revision and source grant revision. No model call, no context content.",
        outputSchema: ContextStatusSchema,
      },
      () => textResult(contextStatus()),
    );
    return mcp;
  }

  function closeSession(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    for (const c of session.runs.values()) if (!c.signal.aborted) c.abort("session_closed" satisfies AbortReason);
    session.watches.clear();
    if (session.id !== undefined && sessions.get(session.id) === session) sessions.delete(session.id);
    log("session_closed", { sessions: sessions.size });
  }

  async function newSession(): Promise<Session> {
    const session: Session = {
      id: undefined,
      transport: undefined as unknown as StreamableHTTPServerTransport,
      closed: false,
      lastSeen: Date.now(),
      runs: new Map(),
      watches: new Map(),
    };
    session.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.id = id;
        sessions.set(id, session);
        log("session_opened", { sessions: sessions.size });
      },
    });
    // Set before connect: the SDK chains its own onclose after this one, so our reason
    // (session_closed) is recorded before it aborts the handlers' extra.signal.
    session.transport.onclose = () => closeSession(session);
    session.transport.onerror = () => {};
    // The SDK class trips exactOptionalPropertyTypes on `onclose`; it is the documented pairing.
    await buildMcp(session).connect(session.transport as Transport);
    return session;
  }

  /** Close the least recently seen session with no running rank. False when every session has one. */
  function evictIdleSession(): boolean {
    let oldest: Session | undefined;
    for (const s of sessions.values()) {
      if (s.runs.size === 0 && (oldest === undefined || s.lastSeen < oldest.lastSeen)) oldest = s;
    }
    if (oldest === undefined) return false;
    closeSession(oldest);
    log("session_evicted", { sessions: sessions.size });
    void oldest.transport.close().catch(() => {});
    return true;
  }

  /** Watch a POST's response stream for the JSON-RPC requests it carries. */
  function watchResponse(session: Session, res: ServerResponse, ids: Array<string | number>): void {
    if (ids.length === 0) return;
    const mine = new Map<string | number, ResponseWatch>();
    for (const id of ids) {
      const w: ResponseWatch = { closed: false };
      session.watches.set(id, w);
      mine.set(id, w);
    }
    res.once("close", () => {
      const early = !res.writableFinished;
      const drop = (id: string | number, w: ResponseWatch): void => {
        if (w.controller === undefined && session.watches.get(id) === w) session.watches.delete(id);
      };
      for (const [id, w] of mine) {
        if (early) {
          w.closed = true;
          if (w.controller && !w.controller.signal.aborted) w.controller.abort("response_closed" satisfies AbortReason);
        }
        // A claimed watch is removed by its rank. An unclaimed one is dropped once its
        // response is gone; after an early close it is kept briefly, in case a rank handler
        // has yet to claim it and must see the close.
        if (!early) drop(id, w);
        else if (w.controller === undefined) setTimeout(() => drop(id, w), WATCH_GRACE_MS).unref();
      }
    });
  }

  // ---------- HTTP ----------

  function tokenOk(header: string | undefined): boolean {
    if (typeof header !== "string") return false;
    const m = /^Bearer ([^\s]+)$/.exec(header);
    if (!m) return false;
    const given = createHash("sha256").update(m[1] ?? "").digest();
    return timingSafeEqual(given, tokenDigest);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return sendJson(res, 403, { error: "forbidden" });
    if (req.headers.origin !== undefined) return sendJson(res, 403, { error: "forbidden" });
    if (!tokenOk(req.headers.authorization)) return sendJson(res, 401, { error: "unauthorized" });
    const path = (req.url ?? "").split("?")[0];
    if (path !== MCP_PATH) return sendJson(res, 404, { error: "not found" });
    if (shuttingDown) return sendJson(res, 503, rpcError(-32000, "shutting down"));

    const sidHeader = req.headers["mcp-session-id"];
    const sid = typeof sidHeader === "string" ? sidHeader : undefined;

    if (req.method === "POST") {
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return refuseTooLarge(req, res);
      const raw = await readBody(req, MAX_BODY_BYTES);
      if (raw === "too-large") return refuseTooLarge(req, res);
      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return sendJson(res, 400, rpcError(-32700, "parse error"));
      }
      let session: Session | undefined;
      if (sid === undefined) {
        if (!isInitialize(body)) return sendJson(res, 400, rpcError(-32000, "session required"));
        if (sessions.size >= MAX_SESSIONS && !evictIdleSession()) return sendJson(res, 503, rpcError(-32000, "too many sessions"));
        session = await newSession();
      } else {
        session = sessions.get(sid);
        if (session === undefined) return sendJson(res, 404, rpcError(-32001, "session not found"));
      }
      session.lastSeen = Date.now();
      watchResponse(session, res, jsonRpcIds(body));
      await session.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method === "GET" || req.method === "DELETE") {
      const session = sid === undefined ? undefined : sessions.get(sid);
      if (session === undefined) return sendJson(res, sid === undefined ? 400 : 404, rpcError(-32001, "session not found"));
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res);
      return;
    }
    sendJson(res, 405, rpcError(-32000, "method not allowed"), { allow: "GET, POST, DELETE" });
  }

  const http: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      log("request_failed");
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, "internal error"));
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException): void => {
      http.off("listening", onListening);
      reject(e.code === "EADDRINUSE" ? new ServerStartError(portInUseMessage(requestedPort)) : new ServerStartError("listen failed"));
    };
    const onListening = (): void => {
      http.off("error", onError);
      resolve();
    };
    http.once("error", onError);
    http.once("listening", onListening);
    http.listen(requestedPort, "127.0.0.1");
  });
  port = (http.address() as AddressInfo).port;
  http.on("error", () => log("http_error"));

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const s of [...sessions.values()]) {
      if (s.runs.size === 0 && now - s.lastSeen > SESSION_IDLE_MS) {
        closeSession(s);
        void s.transport.close().catch(() => {});
      }
    }
  }, SESSION_SWEEP_MS);
  sweeper.unref();

  try {
    writeServerInfo(home, { pid: process.pid, port, serviceInstanceId, startedAt: new Date().toISOString() });
  } catch {
    http.close();
    clearInterval(sweeper);
    throw new ServerStartError("could not write run/server.json");
  }
  log("listening", { port, sources: config.sources.filter((s) => s.enabled).length });

  // ---------- reload / shutdown ----------

  let reloadChain: Promise<unknown> = Promise.resolve();
  async function doReload(): Promise<ReloadResult> {
    if (shuttingDown) {
      log("reload_rejected", { reason: "shutting-down" });
      return { ok: false, sourceGrantRevision: grantRevision };
    }
    let next: PcmConfig;
    try {
      next = loadConfig(home, env);
    } catch (e) {
      log("reload_rejected", { reason: e instanceof ConfigError ? e.code : "config-unreadable" });
      return { ok: false, sourceGrantRevision: grantRevision };
    }
    // Abort synchronously, then swap the config before anything can start under the old grant.
    const aborted = runner.abortAll("grant_changed");
    runner.setConfig(next);
    config = next;
    grantRevision = sourceGrantRevision(next);
    await aborted;
    const state = runner.refreshPreflight();
    log("reload", { verdict: state.verdict, reasons: state.reasons.length, sources: next.sources.filter((s) => s.enabled).length });
    return { ok: true, sourceGrantRevision: grantRevision };
  }

  let shutdownPromise: Promise<void> | undefined;
  async function doShutdown(reason: "sigterm" | "sigint"): Promise<void> {
    shuttingDown = true;
    clearInterval(sweeper);
    const closed = new Promise<void>((r) => http.close(() => r()));
    await runner.abortAll(reason);
    for (const s of [...sessions.values()]) await s.transport.close().catch(() => {});
    http.closeAllConnections();
    await closed;
    try {
      removeServerInfo(home, process.pid);
    } catch {
      log("server_json_remove_failed");
    }
    log("stopped", { reason });
  }

  return {
    get port() {
      return port;
    },
    serviceInstanceId,
    home,
    get sourceGrantRevision() {
      return grantRevision;
    },
    runner,
    counts() {
      let watches = 0;
      let runs = 0;
      for (const s of sessions.values()) {
        watches += s.watches.size;
        runs += s.runs.size;
      }
      return { sessions: sessions.size, watches, runs };
    },
    reload() {
      const p = reloadChain.then(doReload, doReload);
      reloadChain = p;
      return p;
    },
    shutdown(reason) {
      shutdownPromise ??= doShutdown(reason);
      return shutdownPromise;
    },
  };
}

// ---------- process entry ----------

async function main(): Promise<void> {
  let server: RunningServer;
  try {
    server = await runServer();
  } catch (e) {
    process.stderr.write(`${e instanceof ServerStartError ? e.message : "failed to start"}\n`);
    process.exit(1);
  }
  let stopping = false;
  const stop = (reason: "sigterm" | "sigint") => () => {
    // A second signal, or a shutdown still running after the grace period, exits at once.
    if (stopping) process.exit(0);
    stopping = true;
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
    void server.shutdown(reason).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", stop("sigterm"));
  process.on("SIGINT", stop("sigint"));
  process.on("SIGHUP", () => void server.reload());
}

function isEntrypoint(): boolean {
  try {
    const argv1 = process.argv[1];
    return !!argv1 && realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) void main();
