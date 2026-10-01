// The per-job forwarding bridge: a stdio MCP server (`scout_bridge`) the job's CLI starts,
// which forwards calls for the user's explicitly selected tools to the existing local stdio
// servers that provide them. Entrypoint: bridgeMain.ts (`dist/agents/bridgeMain.js`).
//
// Input: one private job file (0600, owned, regular, ≤ 1 MiB) the core writes into the job
// dir just before launch. It lists the selected connections (absolute command, argv, the
// user's environment bindings as `{file, pointer}`, never their values, and the
// definition's non-secret `literalEnv` verbatim) and the selected tools with their frozen
// descriptions, input schemas and schema hashes. The core refuses a job whose file would
// exceed the cap (toolPolicy.ts).
//
// Behaviour:
//   - Each connection used by a selected tool is started once, as a child of the bridge
//     (same process group, so the job's process-tree kill covers it), argv-only, cwd `/`,
//     with exactly its literal and bound environment: nothing from the bridge's, the
//     core's or the CLI's environment. The bridge resolves the bindings in memory (resolveEnvBindings)
//     immediately before the spawn and writes the values nowhere. A connection whose
//     bindings no longer resolve is not started: its tools are unavailable. Its stderr is
//     discarded.
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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, CallToolResultSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ExactEnvStdioTransport } from "./exactEnvTransport.js";
import { PrivateFileError, readPrivateFile } from "./privateFile.js";
import { ConnectionFields, envNamesDisjoint, MAX_CONNECTIONS, MAX_SELECTIONS, resolveEnvBindings, schemaHash, SELECTED_TOOL_RE, ToolSelectionFields } from "./toolProfile.js";

export const BRIDGE_JOB_MAX_BYTES = 1024 * 1024;
const MAX_LISTED_PAGES = 8;

export const BRIDGE_DEFAULT_LIMITS = Object.freeze({ startupMs: 5000, callMs: 15_000, maxReplyBytes: 32 * 1024, maxCalls: 20 });

export const BridgeJobSchema = z
  .strictObject({
    version: z.literal(1),
    limits: z.strictObject({
      startupMs: z.int().min(50).max(60_000),
      callMs: z.int().min(50).max(120_000),
      maxReplyBytes: z.int().min(256).max(1024 * 1024),
      maxCalls: z.int().min(0).max(1000),
    }),
    // Derived from the profile's schemas (toolProfile.ts) so the caps cannot drift.
    connections: z
      .array(ConnectionFields.omit({ transport: true }).refine(envNamesDisjoint))
      .min(1)
      .max(MAX_CONNECTIONS),
    tools: z
      .array(ToolSelectionFields.pick({ connectionId: true, description: true, inputSchema: true, schemaHash: true }).extend({ name: z.string().regex(SELECTED_TOOL_RE) }))
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

/** Read and validate the job file: a regular file owned by this user, no group/other bits, at most BRIDGE_JOB_MAX_BYTES. */
export function readBridgeJob(path: string): BridgeJob {
  let text: string;
  try {
    text = readPrivateFile(path, BRIDGE_JOB_MAX_BYTES, { private: true }).toString("utf8");
  } catch (e) {
    const code = e instanceof PrivateFileError ? e.code : "unreadable";
    if (code === "not_regular" || code === "not_private") throw new BridgeJobError("bridge: job file not private");
    if (code === "too_large") throw new BridgeJobError("bridge: job file invalid");
    throw new BridgeJobError("bridge: job file unreadable");
  }
  try {
    return BridgeJobSchema.parse(JSON.parse(text));
  } catch {
    throw new BridgeJobError("bridge: job file invalid");
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

export function createContextToolBridge(
  job: BridgeJob,
  onCode: (code: string) => void = () => {},
  resolve: (env: BridgeJob["connections"][number]["env"]) => Record<string, string> = (env) => resolveEnvBindings(env),
): ContextToolBridge {
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
    let env: Record<string, string>;
    try {
      env = resolve(conn.env); // in memory, just before the spawn; never written anywhere
    } catch {
      onCode("binding-unresolved");
      for (const t of selected) stats.dropped.push({ tool: t.name, code: "connection_unavailable" });
      return;
    }
    // Literal (non-secret) values first; the schema keeps the names disjoint from the bindings.
    const transport = new ExactEnvStdioTransport(conn.command, conn.args, { ...conn.literalEnv, ...env });
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
        const tool: Tool = { name, inputSchema: t.inputSchema };
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
      r = await backend.client.request({ method: "tools/call", params: { name: t.name, arguments: req.params.arguments ?? {} } }, CallToolResultSchema, {
        timeout: job.limits.callMs,
        maxTotalTimeout: job.limits.callMs,
      });
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
