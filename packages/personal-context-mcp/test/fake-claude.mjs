// Test double for `claude -p` in the agent-runner tests, adapted from the Phase 0 spike
// (scripts/spikes/fake-claude.mjs). Never calls a model or the network.
//
// Behaviour comes from FAKE_MODE, set by a wrapper script (fake-claude-wrapper.sh
// pattern, written by the tests), since the launch profile drops unknown env keys. It
// appends {argv, cwd, envKeys, pid} and later {sourcesPid} and {prompt} lines to
// FAKE_LOG. In retrieval modes it drives the REAL source-tools server named in mcp.json
// over MCP, then emits stream-json envelopes.

import { appendFileSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mode = process.env.FAKE_MODE ?? "ok";
const argv = process.argv.slice(2);
const logLine = (obj) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(obj) + "\n");
};
logLine({ argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), pid: process.pid });

const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");
const hang = () => setInterval(() => {}, 1000);

async function readStdin() {
  let s = "";
  for await (const c of process.stdin) s += c;
  return s;
}

const TOOLS = [
  "mcp__sources__list_sources",
  "mcp__sources__read_recent_activity",
  "mcp__sources__search_source",
  "mcp__sources__read_source",
  "mcp__sources__get_focus",
  "StructuredOutput",
];
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
  const params = { command: cfg.command, args: cfg.args, stderr: "ignore" };
  if (cfg.env) params.env = cfg.env;
  const transport = new StdioClientTransport(params);
  const client = new Client({ name: "fake-claude", version: "0" });
  await client.connect(transport);
  logLine({ sourcesPid: transport.pid });
  return client;
}

let toolUseSeq = 0;
async function useTool(client, name, args) {
  const id = `toolu_${++toolUseSeq}`;
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id, name: `mcp__sources__${name}`, input: args }] } });
  const res = await client.callTool({ name, arguments: args });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "(elided)" }] } });
  return res.isError ? null : JSON.parse(res.content[0].text);
}

function result(extra) {
  emit({
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
    ...extra,
  });
}

/** Candidate ids from the untrusted block, in order. */
function candidateIds(prompt) {
  const ids = [];
  let inBlock = false;
  for (const line of prompt.split("\n")) {
    if (line.startsWith("<<<BEGIN UNTRUSTED SITE DATA")) inBlock = true;
    else if (line.startsWith("<<<END UNTRUSTED SITE DATA")) inBlock = false;
    else if (inBlock && line.includes(" | ") && !line.startsWith("id | ")) ids.push(line.split(" | ")[0]);
  }
  return ids;
}

/** list_sources, read_recent_activity, one search_source: real evidence ids. */
async function retrieve() {
  const client = await connectSources();
  const list = await useTool(client, "list_sources", {});
  const activity = await useTool(client, "read_recent_activity", {});
  const noteSource = list.sources.find((s) => s.kind === "markdown_dir");
  const search = noteSource ? await useTool(client, "search_source", { sourceId: noteSource.id, query: process.env.FAKE_QUERY ?? "billing" }) : null;
  await client.close();
  return {
    activityIds: activity.observations.map((o) => o.evidenceId),
    noteIds: (search?.hits ?? []).map((h) => h.evidenceId),
    notePaths: (search?.hits ?? []).map((h) => h.path),
  };
}

const prompt = await readStdin();
logLine({ prompt });
const ids = candidateIds(prompt);

async function answer(build) {
  emit(init());
  const ev = await retrieve();
  result({ structured_output: build(ev) });
}

const item = (id, evidenceIds, reason = "Fits the open billing work") => ({ id, reason, evidenceIds });

switch (mode) {
  case "ok":
    await answer((ev) => ({
      status: "ok",
      items: [item(ids[0], [ev.activityIds[0], ev.noteIds[0]]), item(ids[1], [ev.noteIds[0]])],
    }));
    break;
  case "label":
    // A model-supplied label and path on an item: never read.
    await answer((ev) => ({ status: "ok", items: [{ ...item(ids[0], [ev.noteIds[0]]), label: "MODEL-LABEL-SENTINEL", path: "/etc/passwd" }] }));
    break;
  case "empty":
    await answer(() => ({ status: "empty" }));
    break;
  case "is_error":
    emit(init());
    result({ is_error: true, result: "something went wrong" });
    process.exitCode = 1;
    break;
  case "max-turns":
    emit(init());
    result({ subtype: "error_max_turns", is_error: false });
    break;
  case "bad-json":
    emit(init());
    process.stdout.write("{not json\n");
    result({ result: "{not json" }); // no structured_output
    break;
  case "bad-shape":
    await answer(() => ({ status: "maybe" }));
    break;
  case "unknown-id":
    await answer((ev) => ({ status: "ok", items: [item("c999", [ev.noteIds[0]]), item(ids[0], [ev.noteIds[0]])] }));
    break;
  case "all-invalid":
    await answer((ev) => ({ status: "ok", items: [item("c999", [ev.noteIds[0]]), item(ids[0], ["e999"])] }));
    break;
  case "path-citation":
    await answer((ev) => ({ status: "ok", items: [item(ids[0], [ev.notePaths[0]])] }));
    break;
  case "four-items":
    await answer((ev) => ({ status: "ok", items: ids.slice(0, 4).map((id) => item(id, [ev.noteIds[0]])) }));
    break;
  case "duplicate-id":
    await answer((ev) => ({ status: "ok", items: [item(ids[0], [ev.noteIds[0]]), item(ids[0], [ev.activityIds[0]])] }));
    break;
  case "url-in-reason":
    await answer((ev) => ({ status: "ok", items: [item(ids[0], [ev.noteIds[0]], "See https://evil.example/x?a=1 and www.evil.example now")] }));
    break;
  case "unissued-evidence":
    await answer((ev) => ({ status: "ok", items: [item(ids[0], [ev.noteIds[0], "e999"]), item(ids[1], ["e998"])] }));
    break;
  case "hang": {
    // Starts the real source-tools server, then never answers.
    emit(init());
    await connectSources();
    hang();
    break;
  }
  case "hang-fast": {
    // Answers only after FAKE_DELAY_MS; used as the "unrelated request" in concurrency tests.
    emit(init());
    const client = await connectSources();
    await new Promise((r) => setTimeout(r, Number(process.env.FAKE_DELAY_MS ?? 300)));
    await client.close();
    result({ structured_output: { status: "empty" } });
    break;
  }
  case "ignore-term": {
    emit(init());
    await connectSources();
    process.on("SIGTERM", () => {});
    hang();
    break;
  }
  case "no-init":
    await connectSources();
    emit({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    hang();
    break;
  case "wrong-apikeysource":
    await connectSources();
    emit(init({ apiKeySource: "ANTHROPIC_API_KEY" }));
    hang();
    break;
  case "extra-mcp-server":
    await connectSources();
    emit(init({ mcp_servers: [{ name: "sources", status: "connected" }, { name: "other", status: "connected" }] }));
    hang();
    break;
  case "extra-tool-use": {
    emit(init());
    await connectSources();
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "true" } }] } });
    hang();
    break;
  }
  default:
    process.stderr.write("fake: unknown mode\n");
    process.exitCode = 99;
}
