import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildFixture } from "./smoke-fixture.mjs";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "fixture-source-server.mjs");
const dirs = [];
const clients = [];

function makeRunDir(opts) {
  const runDir = realpathSync(mkdtempSync(join(tmpdir(), "scout-srv-test-")));
  dirs.push(runDir);
  return { runDir, ...buildFixture(runDir, opts) };
}

async function connect(runDir, extraArgs = []) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, runDir, ...extraArgs],
    env: { PATH: process.env.PATH ?? "" },
    stderr: "pipe",
  });
  const client = new Client({ name: "scout-test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function payload(res) {
  return JSON.parse(res.content[0].text);
}

describe("fixture source server: catalog", () => {
  it("exposes exactly list_sources, search_source and read_source", async () => {
    const { runDir } = makeRunDir();
    const { client } = await connect(runDir);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["list_sources", "read_source", "search_source"]);
  });

  it("lists regular markdown documents only, with no evidence ids", async () => {
    const { runDir } = makeRunDir();
    const { client } = await connect(runDir);
    const res = await client.callTool({ name: "list_sources", arguments: {} });
    const p = payload(res);
    const paths = p.sources[0].documents.map((d) => d.path).sort();
    expect(paths).toEqual(["notes/reading-list.md", "notes/team-offsite.md", "notes/usage-billing-project.md"]);
    expect(JSON.stringify(p)).not.toMatch(/"e\d+"/);
  });
});

function readAudit(runDir) {
  const p = join(runDir, "audit.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
}

describe("fixture source server: retrieval and evidence", () => {
  it("search returns snippets with fresh evidence ids; read returns content with its own id", async () => {
    const { runDir } = makeRunDir();
    const { client } = await connect(runDir);
    const s = payload(await client.callTool({ name: "search_source", arguments: { query: "metered usage invoice" } }));
    expect(s.results.length).toBeGreaterThan(0);
    expect(s.results.every((r) => /^e\d+$/.test(r.evidenceId) && r.path === "notes/usage-billing-project.md")).toBe(true);
    const r = payload(await client.callTool({ name: "read_source", arguments: { path: "notes/usage-billing-project.md" } }));
    expect(r.content).toContain("usage-based billing");
    const ids = [...s.results.map((x) => x.evidenceId), r.evidenceId];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("audits each call with name, args hash, evidence ids, bytes and timing, never content or queries", async () => {
    const { runDir } = makeRunDir();
    const { client } = await connect(runDir);
    const query = "zebra-unique-query-term metering";
    await client.callTool({ name: "search_source", arguments: { query } });
    await client.callTool({ name: "read_source", arguments: { path: "notes/usage-billing-project.md" } });
    const recs = readAudit(runDir).filter((r) => r.type === "tool_call");
    expect(recs.map((r) => r.tool)).toEqual(["search_source", "read_source"]);
    for (const r of recs) {
      expect(r).toMatchObject({ outcome: "ok", argsHash: expect.stringMatching(/^[0-9a-f]{16}$/) });
      expect(r.bytes).toBeGreaterThan(0);
      expect(typeof r.durationMs).toBe("number");
      expect(r.evidenceIds.length).toBeGreaterThan(0);
    }
    const text = readFileSync(join(runDir, "audit.jsonl"), "utf8");
    expect(text).not.toContain("zebra-unique-query-term");
    expect(text).not.toContain("usage-based billing");
    expect(text).not.toContain("Record usage events");
  });
});

describe("fixture source server: containment and budgets", () => {
  it("rejects absolute, parent-relative, symlink-escape and non-document paths without leaking", async () => {
    const { runDir, outsideDir, sentinel } = makeRunDir();
    const { client } = await connect(runDir);
    const attempts = [
      join(outsideDir, "SENTINEL-DENIED.txt"),
      "../outside/SENTINEL-DENIED.txt",
      "notes/../../outside/SENTINEL-DENIED.txt",
      "escape/SENTINEL-DENIED.txt",
      "escape",
      "notes",
      ".",
      "missing.md",
    ];
    for (const path of attempts) {
      const res = await client.callTool({ name: "read_source", arguments: { path } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).not.toContain(sentinel);
      expect(res.content[0].text).not.toContain(outsideDir);
    }
    const s = await client.callTool({ name: "search_source", arguments: { query: "SENTINEL DENIED outside granted" } });
    expect(JSON.stringify(s)).not.toContain(sentinel);
    const l = await client.callTool({ name: "list_sources", arguments: {} });
    expect(JSON.stringify(l)).not.toContain("SENTINEL");
    const audit = readFileSync(join(runDir, "audit.jsonl"), "utf8");
    expect(audit).not.toContain(sentinel);
    expect(readAudit(runDir).filter((r) => r.outcome === "denied")).toHaveLength(attempts.length);
  });

  it("caps a single read at 16 KiB", async () => {
    const { runDir } = makeRunDir({ extraFiles: { "notes/big.md": "x".repeat(40 * 1024) } });
    const { client } = await connect(runDir);
    const r = payload(await client.callTool({ name: "read_source", arguments: { path: "notes/big.md" } }));
    expect(Buffer.byteLength(r.content)).toBe(16 * 1024);
    expect(r.truncated).toBe(true);
  });

  it("stops at 20 tool calls", async () => {
    const { runDir } = makeRunDir();
    const { client } = await connect(runDir);
    for (let i = 0; i < 20; i++) expect((await client.callTool({ name: "list_sources", arguments: {} })).isError).toBeFalsy();
    const over = await client.callTool({ name: "search_source", arguments: { query: "billing" } });
    expect(over.isError).toBe(true);
    expect(over.content[0].text).toMatch(/budget exhausted/);
    expect(readAudit(runDir).at(-1)).toMatchObject({ outcome: "budget", evidenceIds: [] });
  });

  it("stops at 128 KiB of returned content", async () => {
    const { runDir } = makeRunDir({ extraFiles: { "notes/big.md": "y".repeat(40 * 1024) } });
    const { client } = await connect(runDir);
    let total = 0;
    let last;
    for (let i = 0; i < 12; i++) {
      last = await client.callTool({ name: "read_source", arguments: { path: "notes/big.md" } });
      if (last.isError) break;
      total += Buffer.byteLength(last.content[0].text);
    }
    expect(last.isError).toBe(true);
    expect(last.content[0].text).toMatch(/budget exhausted/);
    expect(total).toBeLessThanOrEqual(128 * 1024);
  });

  it("never modifies fixture files", async () => {
    const { runDir, fixtureRoot } = makeRunDir();
    const before = snapshotTree(fixtureRoot);
    const { client } = await connect(runDir);
    await client.callTool({ name: "search_source", arguments: { query: "billing" } });
    await client.callTool({ name: "read_source", arguments: { path: "notes/usage-billing-project.md" } });
    await client.callTool({ name: "read_source", arguments: { path: "escape/SENTINEL-DENIED.txt" } });
    expect(snapshotTree(fixtureRoot)).toEqual(before);
  });
});

function snapshotTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      const st = lstatSync(p);
      out[p] = ent.isFile() ? `${st.mode}:${st.size}:${st.mtimeMs}:${readFileSync(p, "utf8")}` : `${st.mode}:${ent.isSymbolicLink() ? "link" : "dir"}`;
      if (ent.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("fixture source server: lifecycle", () => {
  it("exits promptly on stdin EOF even with a delayed call pending, and records it", async () => {
    const { runDir } = makeRunDir();
    const child = spawn(process.execPath, [SERVER, runDir, "--delay-ms", "2000"], { stdio: ["pipe", "pipe", "pipe"] });
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
    child.stdin.write(JSON.stringify(init) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_sources", arguments: {} } }) + "\n");
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    child.stdin.end();
    expect(await waitExit(child, 1500)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(readAudit(runDir).at(-1)).toMatchObject({ type: "lifecycle", event: "exit", reason: "stdin_eof" });
  });

  it("writes only MCP JSON-RPC lines to stdout", async () => {
    const { runDir } = makeRunDir();
    const child = spawn(process.execPath, [SERVER, runDir], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
    child.stdin.write(JSON.stringify(init) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_source", arguments: { path: "../x" } } }) + "\n");
    await new Promise((r) => setTimeout(r, 500));
    child.stdin.end();
    await waitExit(child, 1500);
    const lines = out.trim().split("\n");
    expect(lines.length).toBe(2);
    for (const l of lines) expect(JSON.parse(l).jsonrpc).toBe("2.0");
  });

  it("exits when orphaned even though its stdin stays open", async () => {
    const { runDir } = makeRunDir();
    // An intermediate parent starts a holder (sleep) whose stdout feeds the
    // server's stdin, prints both pids, and exits. The holder keeps the
    // server's stdin open, so only orphan detection can end the server.
    const launcher = `const {spawn}=require("node:child_process");
const h=spawn("/bin/sleep",["8"],{stdio:["ignore","pipe","ignore"],detached:true});
const c=spawn(process.execPath,${JSON.stringify([SERVER, runDir])},{stdio:[h.stdout,"ignore","ignore"],detached:true});
console.log(c.pid+" "+h.pid);h.unref();c.unref();setTimeout(()=>process.exit(0),300);`;
    const mid = spawn(process.execPath, ["-e", launcher], { stdio: ["ignore", "pipe", "ignore"] });
    let pidText = "";
    mid.stdout.on("data", (d) => (pidText += d));
    await waitExit(mid, 3000);
    const [pid, holder] = pidText.trim().split(" ").map(Number);
    expect(pid).toBeGreaterThan(0);
    const deadline = Date.now() + 3000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const stillAlive = alive(pid);
    if (stillAlive) process.kill(pid, "SIGKILL");
    const holderAlive = alive(holder);
    if (holderAlive) process.kill(holder, "SIGKILL");
    expect(holderAlive).toBe(true); // stdin really stayed open
    expect(stillAlive).toBe(false);
    expect(readAudit(runDir).at(-1)).toMatchObject({ type: "lifecycle", event: "exit", reason: "orphaned" });
  });
});
