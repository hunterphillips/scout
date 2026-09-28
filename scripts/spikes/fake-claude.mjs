// Test double for `claude -p` in the agent-smoke tests. Never calls a model or
// the network. Behaviour comes from FAKE_MODE (set by a wrapper script, since
// the launch profile drops unknown env keys). It logs its argv to FAKE_ARGV_LOG
// and, in retrieval modes, drives the REAL fixture MCP server from mcp.json
// over the MCP protocol, then emits stream-json (or json) envelopes.

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mode = process.env.FAKE_MODE ?? "ok";
const argv = process.argv.slice(2);
if (process.env.FAKE_ARGV_LOG) appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify({ argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort() }) + "\n");

const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const format = flag("--output-format");
const emit = (ev) => {
  if (format === "stream-json") process.stdout.write(JSON.stringify(ev) + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hang = () => setInterval(() => {}, 1000);

async function readStdin() {
  let s = "";
  for await (const c of process.stdin) s += c;
  return s;
}

const TOOLS = ["mcp__sources__list_sources", "mcp__sources__search_source", "mcp__sources__read_source", "StructuredOutput"];
const init = (extra = {}) => ({
  type: "system",
  subtype: "init",
  session_id: "fake-session-id",
  cwd: process.cwd(),
  tools: TOOLS,
  mcp_servers: [{ name: "sources", status: "connected" }],
  model: "fake-model-1",
  permissionMode: flag("--permission-mode"),
  apiKeySource: "none",
  ...extra,
});

async function connectSources() {
  const cfg = JSON.parse(readFileSync(flag("--mcp-config"), "utf8")).mcpServers.sources;
  const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args, env: process.env, stderr: "ignore" });
  const client = new Client({ name: "fake-claude", version: "0" });
  await client.connect(transport);
  return client;
}

let toolUseSeq = 0;
async function useTool(client, name, args) {
  const id = `toolu_${++toolUseSeq}`;
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id, name: `mcp__sources__${name}`, input: args }] } });
  const res = await client.callTool({ name, arguments: args });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: res.content }] } });
  return res.isError ? null : JSON.parse(res.content[0].text);
}

function result(extra) {
  const ev = {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1234,
    duration_api_ms: 1000,
    num_turns: 3,
    result: "",
    session_id: "fake-session-id",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 },
    modelUsage: { "fake-model-1": { inputTokens: 100, outputTokens: 20 } },
    ...extra,
  };
  if (format === "stream-json") emit(ev);
  else process.stdout.write(JSON.stringify(ev));
}

async function retrieveAndAnswer() {
  const client = await connectSources();
  await useTool(client, "list_sources", {});
  const s = await useTool(client, "search_source", { query: "usage metered billing invoice" });
  const r = await useTool(client, "read_source", { path: "notes/usage-billing-project.md" });
  await useTool(client, "read_source", { path: "escape/SENTINEL-DENIED.txt" });
  await client.close();
  const so = {
    status: "ok",
    items: [
      { id: "c02", reason: "Metering usage is open work", evidenceIds: [s.results[0].evidenceId, r.evidenceId] },
      { id: "c07", reason: "Invoice preview is open work", evidenceIds: [r.evidenceId] },
    ],
  };
  result({ structured_output: so });
}

await readStdin();

switch (mode) {
  case "ok":
    emit(init());
    await retrieveAndAnswer();
    break;
  case "no-init":
    // Starts normally but never reports its capabilities.
    await retrieveAndAnswer();
    break;
  case "malformed-arg": {
    // A source tool call with invalid arguments: rejected before the handler,
    // so it never reaches the audit log.
    emit(init());
    const client = await connectSources();
    const id = `toolu_${++toolUseSeq}`;
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__sources__read_source", input: { path: 42 } }] } });
    try {
      await client.callTool({ name: "read_source", arguments: { path: 42 } });
    } catch {
      // protocol-level rejection
    }
    await client.close();
    await retrieveAndAnswer();
    break;
  }
  case "extra-tool": {
    emit(init({ tools: [...TOOLS, "Bash"] }));
    await sleep(3000);
    // Only reached if the runner failed to abort: use a tool.
    const client = await connectSources();
    await useTool(client, "search_source", { query: "billing" });
    await client.close();
    result({ structured_output: { status: "empty" } });
    break;
  }
  case "hang": {
    emit(init());
    spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    hang();
    break;
  }
  case "escape-group": {
    emit(init());
    spawn("/bin/sleep", ["30"], { stdio: "ignore", detached: true }).unref();
    hang();
    break;
  }
  case "ignore-term": {
    emit(init());
    process.on("SIGTERM", () => {});
    hang();
    break;
  }
  case "flood":
    emit(init());
    for (let i = 0; i < 400; i++) process.stdout.write(JSON.stringify({ type: "assistant", pad: "x".repeat(10_000) }) + "\n");
    hang();
    break;
  case "auth-error":
    result({ subtype: "success", is_error: true, api_error_status: 401, result: "Invalid API key · Please run /login" });
    process.exitCode = 1;
    break;
  case "rate-limit":
    emit(init());
    emit({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 429, error: "rate_limit" });
    hang();
    break;
  case "unknown-option":
    if (argv.includes("--max-turns")) {
      process.stderr.write("error: unknown option '--max-turns'\n");
      process.exitCode = 1;
      break;
    }
    emit(init());
    await retrieveAndAnswer();
    break;
  case "cancel": {
    emit(init());
    const client = await connectSources();
    for (const path of ["notes/usage-billing-project.md", "notes/team-offsite.md", "notes/reading-list.md"]) await useTool(client, "read_source", { path });
    await client.close();
    result({ structured_output: { status: "empty" } });
    break;
  }
  case "stray-file":
    appendFileSync("stray.txt", "x");
    emit(init());
    await retrieveAndAnswer();
    break;
  default:
    process.stderr.write("fake: unknown mode\n");
    process.exitCode = 99;
}
