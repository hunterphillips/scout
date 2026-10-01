// B13: the per-job bridge, driven directly with the MCP SDK client (no model, no CLI): the
// built entrypoint (dist/agents/bridgeMain.js) against fake-backend.mjs in each adversarial
// mode. Unselected names and changed schemas must never reach a backend.

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_DEFAULT_LIMITS, type BridgeJob } from "./contextToolBridge.js";
import { fakeBackend, selection, type FakeBackendDef } from "./testing/fakeBackend.js";
import { defaultBridgeEntrypoint } from "./toolPolicy.js";
import type { ToolSelection } from "./toolProfile.js";

const ENTRY = defaultBridgeEntrypoint();
const dirs: string[] = [];
const clients: Client[] = [];
const backends: FakeBackendDef[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const b of backends.splice(0)) for (const pid of b.pids()) killQuietly(pid);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // gone
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function tempDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "scb-")));
  chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}

interface Setup {
  dir: string;
  backend: FakeBackendDef;
  client: Client;
  listChanged: number;
}

function jobFor(defs: { def: FakeBackendDef; env: Record<string, string> }[], selections: ToolSelection[], limits: Partial<BridgeJob["limits"]> = {}): BridgeJob {
  return {
    version: 1,
    limits: { ...BRIDGE_DEFAULT_LIMITS, ...limits },
    connections: defs.map(({ def, env }) => ({ id: def.connection.id, command: def.connection.command, args: def.connection.args, env })),
    tools: selections.map((s) => ({ name: s.toolName, connectionId: s.connectionId, description: s.description, inputSchema: s.inputSchema, schemaHash: s.schemaHash })),
  };
}

async function connect(dir: string, job: BridgeJob): Promise<{ client: Client; listChanged: () => number }> {
  const jobFile = join(dir, "bridge.json");
  writeFileSync(jobFile, JSON.stringify(job), { mode: 0o600 });
  const client = new Client({ name: "test", version: "0" });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    listChanged++;
  });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY, "--job", jobFile], stderr: "ignore" }));
  clients.push(client);
  return { client, listChanged: () => listChanged };
}

async function setup(mode: string, selections: (id: string) => ToolSelection[], opts: { env?: Record<string, string>; touch?: string; limits?: Partial<BridgeJob["limits"]> } = {}): Promise<Setup> {
  const dir = tempDir();
  const backend = fakeBackend(dir, "notes", mode, opts);
  backends.push(backend);
  const { client, listChanged } = await connect(dir, jobFor([{ def: backend, env: opts.env ?? {} }], selections("notes"), opts.limits));
  return {
    dir,
    backend,
    client,
    get listChanged() {
      return listChanged();
    },
  };
}

const textOf = (r: unknown): string => ((r as CallToolResult).content[0] as { text: string }).text;
const names = async (c: Client): Promise<string[]> => (await c.listTools()).tools.map((t) => t.name);

describe("context tool bridge (B13)", () => {
  it("advertises only the selected tool, with its frozen description and schema, and forwards its calls", async () => {
    const s = await setup("honest", (id) => [selection(id, "lookup", true)]);
    const { tools } = await s.client.listTools();
    expect(tools).toEqual([{ name: "lookup", description: "Reviewed lookup", inputSchema: selection("notes", "lookup", true).inputSchema }]);
    const r = await s.client.callTool({ name: "lookup", arguments: { query: "metered" } });
    expect(textOf(r)).toBe("lookup:metered");
    expect(s.backend.calls()).toEqual(["lookup"]);
  });

  it("refuses unselected tool names before they reach the backend, even when called directly", async () => {
    const s = await setup("honest", (id) => [selection(id, "lookup", true)]);
    for (const name of ["secret_tool", "peek", "late_tool", "mcp__notes__secret_tool", "../lookup"]) {
      await expect(s.client.callTool({ name, arguments: {} })).rejects.toThrow();
    }
    expect(s.backend.calls()).toEqual([]);
  });

  it("a changed schema: the tool is neither advertised nor forwarded", async () => {
    const s = await setup("schema-change", (id) => [selection(id, "lookup", true)]);
    expect(await names(s.client)).toEqual([]);
    await expect(s.client.callTool({ name: "lookup", arguments: { query: "x", deleteAll: true } })).rejects.toThrow();
    expect(s.backend.calls()).toEqual([]);
    expect(s.backend.lines().filter((l) => l.method === "tools/list")).toHaveLength(1);
  });

  it("a tool added after startup (list_changed) is ignored: never advertised, re-listed or forwarded", async () => {
    const s = await setup("list-changed", (id) => [selection(id, "lookup", false)]);
    expect(await names(s.client)).toEqual(["lookup"]);
    await s.client.callTool({ name: "lookup", arguments: { query: "a" } }); // the backend announces late_tool again
    expect(await names(s.client)).toEqual(["lookup"]);
    await expect(s.client.callTool({ name: "late_tool", arguments: {} })).rejects.toThrow();
    expect(s.backend.calls()).toEqual(["lookup"]);
    expect(s.backend.lines().filter((l) => l.method === "tools/list")).toHaveLength(1);
    expect(s.listChanged).toBe(0);
  });

  it("refuses the backend's sampling, elicitation and roots requests; the call itself still completes", async () => {
    const s = await setup("sampling", (id) => [selection(id, "lookup", true)]);
    expect(textOf(await s.client.callTool({ name: "lookup", arguments: { query: "q" } }))).toBe("lookup:q");
    expect(s.backend.lines().flatMap((l) => (l.reply ? [l.reply] : []))).toEqual([
      { method: "sampling/createMessage", error: -32601 },
      { method: "elicitation/create", error: -32601 },
      { method: "roots/list", error: -32601 },
    ]);
  });

  it("an oversized reply becomes an error result without the content", async () => {
    const s = await setup("oversized", (id) => [selection(id, "lookup", true)]);
    const r = (await s.client.callTool({ name: "lookup", arguments: { query: "q" } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r).length).toBeLessThan(1024);
  });

  it("the call budget: calls past it are refused without forwarding", async () => {
    const s = await setup("honest", (id) => [selection(id, "lookup", true)], { limits: { maxCalls: 2 } });
    for (let i = 0; i < 2; i++) expect(textOf(await s.client.callTool({ name: "lookup", arguments: { query: "q" } }))).toBe("lookup:q");
    const r = (await s.client.callTool({ name: "lookup", arguments: { query: "q" } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(s.backend.calls()).toEqual(["lookup", "lookup"]);
  });

  it("a read-only annotation is not enforced: a selected tool's side effect happens (the user's declaration, not a sandbox)", async () => {
    const dir = tempDir();
    const touched = join(dir, "touched");
    const s = await setup("honest", (id) => [selection(id, "peek", false)], { touch: touched });
    expect(textOf(await s.client.callTool({ name: "peek", arguments: {} }))).toBe("peeked");
    expect(existsSync(touched)).toBe(true);
    expect(s.backend.calls()).toEqual(["peek"]);
  });

  it("the backend sees exactly its bound environment, cwd /", async () => {
    const env = { NOTES_TOKEN: "SENTINEL-BACKEND-SECRET-1d2e", LANG: "C" };
    const s = await setup("honest", (id) => [selection(id, "lookup", true)], { env });
    await names(s.client);
    const start = s.backend.lines().find((l) => l.env)!;
    // Node itself may add nothing; macOS may add __CF_USER_TEXT_ENCODING to a child's env.
    const { __CF_USER_TEXT_ENCODING: _cf, ...seen } = start.env!;
    expect(seen).toEqual(env);
    expect(start.cwd).toBe("/");
  });

  it("a backend that never starts: its tools are not advertised; others still are; it dies with the bridge", async () => {
    const dir = tempDir();
    const dead = fakeBackend(dir, "dead", "never-start");
    const live = fakeBackend(dir, "live", "honest");
    backends.push(dead, live);
    const { client } = await connect(dir, jobFor([{ def: dead, env: {} }, { def: live, env: {} }], [selection("dead", "lookup", false), { ...selection("live", "peek", false) }], { startupMs: 300 }));
    expect(await names(client)).toEqual(["peek"]);
    await waitFor(() => dead.pids().length === 1 && live.pids().length === 1);
    const pids = [...dead.pids(), ...live.pids()];
    await client.close(); // stdin EOF: the bridge exits and kills its backends
    await waitFor(() => pids.every((p) => !alive(p)));
  });

  it("refuses a job file that is not private", async () => {
    const dir = tempDir();
    const jobFile = join(dir, "bridge.json");
    const backend = fakeBackend(dir, "notes", "honest");
    writeFileSync(jobFile, JSON.stringify(jobFor([{ def: backend, env: {} }], [selection("notes", "lookup", true)])), { mode: 0o644 });
    const code = await new Promise<number | null>((resolve) => spawn(process.execPath, [ENTRY, "--job", jobFile], { stdio: "ignore" }).on("exit", resolve));
    expect(code).toBe(2);
    expect(backend.lines()).toEqual([]); // nothing started
  });
});
