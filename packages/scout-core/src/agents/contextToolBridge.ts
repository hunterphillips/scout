// The per-job forwarding bridge: a stdio MCP server (`scout_bridge`) the job's CLI starts,
// which forwards calls for the user's explicitly selected tools to the existing local stdio
// servers that provide them. Entrypoint: bridgeMain.ts (`dist/agents/bridgeMain.js`).
//
// Input: one private job file (0600, owned, regular, ≤ 1 MiB) the core writes into the job
// dir just before launch. It lists the selected connections (absolute command, argv, and
// the environment values the core resolved in memory from the user's bindings) and the
// selected tools with their frozen descriptions, input schemas and schema hashes.
//
// Behaviour:
//   - Each connection used by a selected tool is started once, as a child of the bridge
//     (same process group, so the job's process-tree kill covers it), argv-only, cwd `/`,
//     with exactly its bound environment: nothing from the bridge's, the core's or the
//     CLI's environment. Its stderr is discarded.
//   - Startup is bounded (`limits.startupMs` per connection). The bridge lists the tools
//     once and keeps a selected tool only if it exists with an input schema whose hash
//     equals the frozen one. A changed or missing tool, or a connection that never starts,
//     is simply not advertised; the job's init check then decides (required → blocked,
//     optional → reported unavailable).
//   - It advertises only the kept tools, each under its own name with the frozen
//     description and input schema, and no `listChanged` capability. Every other tool name
//     is refused before anything reaches a backend.
//   - A backend's `notifications/tools/list_changed` (and every other notification) is
//     ignored for the job: tools are never re-listed or added. Requests a backend makes
//     of the bridge (sampling, elicitation, roots, ...) are refused with MethodNotFound.
//   - Permitted calls are forwarded with their arguments unchanged. A reply is bounded
//     (`limits.maxReplyBytes` of serialized content, else an error result instead of the
//     content), each call has a deadline (`limits.callMs`), and the job has a call budget
//     (`limits.maxCalls`).
//   - Annotations such as readOnlyHint are not trusted and not enforced: whether a tool is
//     suitable for unattended use is the user's declaration. The bridge does not sandbox a
//     server's internals.
//
// stdout carries MCP protocol only (bridgeMain.ts); diagnostics are fixed codes on stderr.

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants as fsc, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, CallToolResultSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult, type JSONRPCMessage, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CONNECTION_ID_RE, isAllowedEnvName, MAX_ARGS, MAX_CONNECTIONS, MAX_SELECTIONS, schemaHash, SELECTED_TOOL_RE } from "./toolProfile.js";

export const BRIDGE_JOB_MAX_BYTES = 1024 * 1024;
/** A backend line longer than this closes that backend. */
export const BACKEND_MAX_LINE_BYTES = 1024 * 1024;
const MAX_LISTED_PAGES = 8;

export const BRIDGE_DEFAULT_LIMITS = Object.freeze({ startupMs: 5000, callMs: 15_000, maxReplyBytes: 32 * 1024, maxCalls: 20 });

const abs = z
  .string()
  .max(1024)
  .refine((p) => isAbsolute(p) && !p.includes("\0"));

export const BridgeJobSchema = z
  .strictObject({
    version: z.literal(1),
    limits: z.strictObject({
      startupMs: z.int().min(50).max(60_000),
      callMs: z.int().min(50).max(120_000),
      maxReplyBytes: z.int().min(256).max(1024 * 1024),
      maxCalls: z.int().min(0).max(1000),
    }),
    connections: z
      .array(
        z.strictObject({
          id: z.string().regex(CONNECTION_ID_RE),
          command: abs,
          args: z.array(z.string().refine((a) => !a.includes("\0"))).max(MAX_ARGS),
          env: z.record(z.string(), z.string()).refine((e) => Object.keys(e).every(isAllowedEnvName)),
        }),
      )
      .min(1)
      .max(MAX_CONNECTIONS),
    tools: z
      .array(
        z.strictObject({
          name: z.string().regex(SELECTED_TOOL_RE),
          connectionId: z.string().regex(CONNECTION_ID_RE),
          description: z.string(),
          inputSchema: z.looseObject({ type: z.literal("object") }),
          schemaHash: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      )
      .min(1)
      .max(MAX_SELECTIONS),
  })
  .refine((j) => new Set(j.tools.map((t) => t.name)).size === j.tools.length && j.tools.every((t) => j.connections.some((c) => c.id === t.connectionId)));
export type BridgeJob = z.infer<typeof BridgeJobSchema>;

export class BridgeJobError extends Error {
  constructor(readonly code: "bridge: job file unreadable" | "bridge: job file not private" | "bridge: job file invalid") {
    super(code);
    this.name = "BridgeJobError";
  }
}

/** Read and validate the job file: a regular file owned by this user, no group/other bits. */
export function readBridgeJob(path: string): BridgeJob {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  } catch {
    throw new BridgeJobError("bridge: job file unreadable");
  }
  let text: string;
  try {
    const st = fstatSync(fd);
    const owned = typeof process.getuid !== "function" || st.uid === process.getuid();
    if (!st.isFile() || !owned || (st.mode & 0o077) !== 0) throw new BridgeJobError("bridge: job file not private");
    if (st.size > BRIDGE_JOB_MAX_BYTES) throw new BridgeJobError("bridge: job file invalid");
    text = readFileSync(fd, "utf8");
  } catch (e) {
    throw e instanceof BridgeJobError ? e : new BridgeJobError("bridge: job file unreadable");
  } finally {
    closeSync(fd);
  }
  try {
    return BridgeJobSchema.parse(JSON.parse(text));
  } catch {
    throw new BridgeJobError("bridge: job file invalid");
  }
}

// ---------- a stdio client transport with an exact environment ----------

/**
 * Like the SDK's StdioClientTransport, except the child gets exactly `env` (the SDK's merges
 * in HOME, PATH, USER, ... from this process), its stderr is discarded, its cwd is `/`, and
 * one oversized line closes it.
 */
export class ExactEnvStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private proc: ChildProcess | undefined;
  private readonly buffer = new ReadBuffer({ maxBufferSize: BACKEND_MAX_LINE_BYTES });

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly env: Readonly<Record<string, string>>,
  ) {}

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.command, [...this.args], { env: { ...this.env }, cwd: "/", stdio: ["pipe", "pipe", "ignore"], shell: false });
      this.proc = proc;
      proc.once("error", (e) => {
        reject(e);
        this.onerror?.(e);
      });
      proc.once("spawn", () => resolve());
      proc.once("close", () => {
        this.proc = undefined;
        this.onclose?.();
      });
      proc.stdin?.on("error", () => {});
      proc.stdout?.on("data", (chunk: Buffer) => {
        try {
          this.buffer.append(chunk);
          for (let m = this.buffer.readMessage(); m !== null; m = this.buffer.readMessage()) this.onmessage?.(m);
        } catch (e) {
          this.onerror?.(e as Error);
          void this.close();
        }
      });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    const proc = this.proc;
    if (!proc?.stdin || proc.stdin.destroyed) return Promise.reject(new Error("not connected"));
    return new Promise((resolve) => (proc.stdin!.write(serializeMessage(message)) ? resolve() : proc.stdin!.once("drain", () => resolve())));
  }

  /** SIGTERM, then SIGKILL after 1 s if it is still there. */
  async close(): Promise<void> {
    const proc = this.proc;
    this.buffer.clear();
    if (!proc) return;
    proc.stdin?.end();
    try {
      proc.kill("SIGTERM");
    } catch {
      // gone
    }
    setTimeout(() => this.killNow(proc), 1000).unref();
  }

  /** Synchronous SIGKILL, for process exit. */
  killNow(proc: ChildProcess | undefined = this.proc): void {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      // gone
    }
  }
}

// ---------- the bridge ----------

export interface BridgeStats {
  /** Selected tools the bridge advertises. */
  advertised: string[];
  /** Selected tools dropped at startup, with a fixed code. */
  dropped: { tool: string; code: "connection_unavailable" | "tool_missing" | "schema_changed" }[];
  forwardedCalls: number;
  refusedCalls: number;
  /** Requests a backend made of the bridge (sampling, elicitation, ...), all refused. */
  refusedBackendRequests: number;
}

export interface ContextToolBridge {
  server: Server;
  /** Settles once every backend started (or failed to) and the tool list is fixed. */
  ready: Promise<void>;
  stats: BridgeStats;
  /** Close every backend. */
  close(): Promise<void>;
  /** SIGKILL every backend now (synchronous, for process exit). */
  killBackends(): void;
}

const errorResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), ms)))]).finally(() => clearTimeout(timer));
}

interface Backend {
  transport: ExactEnvStdioTransport;
  client: Client;
}

export function createContextToolBridge(job: BridgeJob, onCode: (code: string) => void = () => {}): ContextToolBridge {
  const stats: BridgeStats = { advertised: [], dropped: [], forwardedCalls: 0, refusedCalls: 0, refusedBackendRequests: 0 };
  const backends = new Map<string, Backend>();
  /** Every transport started, including those that failed to start. */
  const transports: ExactEnvStdioTransport[] = [];
  const available = new Map<string, BridgeJob["tools"][number]>();

  async function listAll(client: Client): Promise<Tool[]> {
    const out: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LISTED_PAGES; page++) {
      const r = await client.listTools(cursor === undefined ? {} : { cursor });
      out.push(...r.tools);
      cursor = r.nextCursor;
      if (cursor === undefined) break;
    }
    return out;
  }

  async function startConnection(conn: BridgeJob["connections"][number]): Promise<void> {
    const selected = job.tools.filter((t) => t.connectionId === conn.id);
    const transport = new ExactEnvStdioTransport(conn.command, conn.args, conn.env);
    transports.push(transport);
    const client = new Client({ name: "scout-bridge", version: "0" }, { capabilities: {} });
    // Every request a backend makes of us is refused; every notification (list_changed included) is ignored.
    client.fallbackRequestHandler = async () => {
      stats.refusedBackendRequests++;
      throw new McpError(ErrorCode.MethodNotFound, "refused by the Scout bridge");
    };
    client.fallbackNotificationHandler = async () => {};
    client.onerror = () => {};
    let tools: Tool[];
    try {
      tools = await withTimeout(
        (async () => {
          await client.connect(transport);
          return listAll(client);
        })(),
        job.limits.startupMs,
      );
    } catch {
      onCode("backend-unavailable");
      void transport.close();
      for (const t of selected) stats.dropped.push({ tool: t.name, code: "connection_unavailable" });
      return;
    }
    backends.set(conn.id, { transport, client });
    for (const t of selected) {
      const live = tools.find((x) => x.name === t.name);
      if (!live) stats.dropped.push({ tool: t.name, code: "tool_missing" });
      else if (schemaHash(live.inputSchema) !== t.schemaHash) stats.dropped.push({ tool: t.name, code: "schema_changed" });
      else available.set(t.name, t);
    }
  }

  const ready = Promise.all(job.connections.map(startConnection)).then(() => {
    // Advertise in the job file's order.
    stats.advertised = job.tools.filter((t) => available.has(t.name)).map((t) => t.name);
  });

  const server = new Server({ name: "scout-bridge", version: "0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await ready;
    return {
      tools: stats.advertised.map((name) => {
        const t = available.get(name)!;
        const tool: Tool = { name, inputSchema: t.inputSchema as Tool["inputSchema"] };
        if (t.description !== "") tool.description = t.description;
        return tool;
      }),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    await ready;
    const t = available.get(req.params.name);
    const backend = t ? backends.get(t.connectionId) : undefined;
    if (!t || !backend) {
      stats.refusedCalls++;
      throw new McpError(ErrorCode.InvalidParams, "tool not available");
    }
    if (stats.forwardedCalls >= job.limits.maxCalls) return errorResult("call budget exhausted");
    stats.forwardedCalls++;
    let r: CallToolResult;
    try {
      r = (await backend.client.request(
        { method: "tools/call", params: { name: t.name, arguments: req.params.arguments ?? {} } },
        CallToolResultSchema,
        { timeout: job.limits.callMs, maxTotalTimeout: job.limits.callMs },
      )) as CallToolResult;
    } catch {
      return errorResult("tool call failed");
    }
    const out: CallToolResult = { content: r.content };
    if (r.isError === true) out.isError = true;
    if (Buffer.byteLength(JSON.stringify(out), "utf8") > job.limits.maxReplyBytes) return errorResult("reply too large");
    return out;
  });

  return {
    server,
    ready,
    stats,
    async close() {
      await Promise.all(transports.map((t) => t.close()));
    },
    killBackends() {
      for (const t of transports) t.killNow();
    },
  };
}
