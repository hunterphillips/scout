// Test double for the Codex CLI (0.155.1 shapes) in the Codex adapter's tests. Never calls a
// model or the network.
//
// Behaviour comes from FAKE_MODE, FAKE_VERSION and FAKE_LOGIN, set by the wrapper fakeCodex.ts
// writes (the launch drops unknown env keys). Every invocation appends a line to FAKE_LOG:
// `--version` and `login status` log {sub, argv, envKeys}; `exec` logs {argv, cwd, envKeys,
// pid, violations, authLinked}, then {scoutPid} per MCP server it started and {prompt}.
//
//   --version       stdout `codex-cli <FAKE_VERSION>`
//   login status    stderr per FAKE_LOGIN: chatgpt "Logged in using ChatGPT" (exit 0), api-key
//                   "Logged in using an API key - sk-***" (exit 0), none "Not logged in"
//                   (exit 1); "Not logged in" too when $CODEX_HOME/auth.json does not resolve
//   mcp add|get|remove  the user MCP registry in $CODEX_HOME/config.toml (fake-codex-mcp.mjs,
//                   for the install scripts' tests); logged as {sub, argv, envKeys}
//   exec            the job (below); anything else exits 2
//
// `exec` emulates the CLI from its argv: flags no job may pass are recorded as `violations`
// (tests assert there are none), as are missing required flags and `-c` values that are not
// valid TOML (the overrides are parsed with a small TOML tokenizer: basic strings with TOML's
// escapes, arrays of them, booleans, integers). It starts every `mcp_servers.<name>` server
// from the overrides over a REAL stdio MCP client (Scout's scout-mcp talks to the fixture
// core; the bridge to its fake backends), reads the prompt from stdin, takes the candidate ids
// from the untrusted block, and answers as `--json` events: thread.started, turn.started, an
// item.started/item.completed pair per tool call, the agent_message, turn.completed. Without
// a resolvable $CODEX_HOME/auth.json it behaves like mode `auth`.
//
// Modes: ok, empty, bridge-call (also calls the bridge's first tool; its reply goes in the first
// reason), tool-errors (bridge-call with Scout's and the bridge's calls reported failed),
// invalid-shape, no-message, shell-item, web-item, foreign-server, approval-denied, quota,
// auth, hang, ignore-term, late-output, flood (> 4 MiB of events), garbage-lines,
// no-thread-started.

import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mode = process.env.FAKE_MODE ?? "ok";
const version = process.env.FAKE_VERSION ?? "0.155.1";
const login = process.env.FAKE_LOGIN ?? "chatgpt";
const argv = process.argv.slice(2);
const logLine = (obj) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(obj) + "\n");
};
const envKeys = Object.keys(process.env).sort();

function authLinked() {
  const home = process.env.CODEX_HOME;
  if (!home) return false;
  try {
    return statSync(join(home, "auth.json")).isFile(); // follows the link
  } catch {
    return false;
  }
}

if (argv[0] === "--version") {
  logLine({ sub: true, argv, envKeys });
  process.stdout.write(`codex-cli ${version}\n`);
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status" && argv.length === 2) {
  logLine({ sub: true, argv, envKeys });
  if (!authLinked() || login === "none") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  process.stderr.write(login === "api-key" ? "Logged in using an API key - sk-***\n" : "Logged in using ChatGPT\n");
  process.exit(0);
}
if (argv[0] === "mcp") {
  logLine({ sub: true, argv, envKeys });
  const { runMcp } = await import("./fake-codex-mcp.mjs");
  await runMcp({ args: argv.slice(1), mode });
  process.exit(process.exitCode ?? 0);
}
if (argv[0] !== "exec") {
  logLine({ sub: true, argv, envKeys, unexpected: true });
  process.stderr.write("fake-codex: unexpected invocation\n");
  process.exit(2);
}

// ---------- exec ----------

const has = (name) => argv.includes(name);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** A TOML value as renderCodexServerOverrides and the fixed overrides emit it; throws on anything else. */
function parseTomlValue(text) {
  let i = 0;
  const fail = () => {
    throw new Error("not a TOML value");
  };
  const ws = () => {
    while (text[i] === " " || text[i] === "\t") i++;
  };
  const str = () => {
    if (text[i] !== '"') fail();
    i++;
    let out = "";
    for (;;) {
      if (i >= text.length) fail();
      const c = text[i++];
      if (c === '"') return out;
      if (c === "\\") {
        const e = text[i++];
        const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
        if (e in simple) out += simple[e];
        else if (e === "u" || e === "U") {
          const n = e === "u" ? 4 : 8;
          const hex = text.slice(i, i + n);
          if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== n) fail();
          out += String.fromCodePoint(parseInt(hex, 16));
          i += n;
        } else fail();
      } else if (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) fail();
      else out += c;
    }
  };
  const value = () => {
    ws();
    if (text[i] === '"') return str();
    if (text[i] === "[") {
      i++;
      const arr = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value());
        ws();
        if (text[i] === ",") {
          i++;
          ws();
          if (text[i] === "]") {
            i++;
            return arr;
          }
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        fail();
      }
    }
    const m = /^(true|false|-?\d+)/.exec(text.slice(i));
    if (!m) fail();
    i += m[0].length;
    return m[0] === "true" ? true : m[0] === "false" ? false : Number(m[0]);
  };
  const v = value();
  ws();
  if (i !== text.length) fail();
  return v;
}

const overrides = new Map();
const badOverrides = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "-c") continue;
  const kv = argv[i + 1] ?? "";
  const eq = kv.indexOf("=");
  const key = kv.slice(0, eq);
  try {
    if (eq <= 0 || !/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error("bad key");
    overrides.set(key, parseTomlValue(kv.slice(eq + 1)));
  } catch {
    badOverrides.push(key || kv.slice(0, 40));
  }
}

const FORBIDDEN = ["--yolo", "--full-auto", "--dangerously-bypass-approvals-and-sandbox", "workspace-write", "danger-full-access", "--oss", "--add-dir", "resume", "fork"];
const REQUIRED = ["--json", "--ephemeral", "--ignore-user-config", "--output-schema"];
const REQUIRED_OVERRIDES = { "features.shell_tool": false, "features.hooks": false, web_search: "disabled", "history.persistence": "none" };
const violations = [
  ...FORBIDDEN.filter(has).map((f) => `forbidden ${f}`),
  ...REQUIRED.filter((f) => !has(f)).map((f) => `missing ${f}`),
  ...(flag("-s") === "read-only" ? [] : ["missing -s read-only"]),
  ...Object.entries(REQUIRED_OVERRIDES)
    .filter(([k, v]) => overrides.get(k) !== v)
    .map(([k]) => `missing -c ${k}`),
  ...badOverrides.map((k) => `invalid -c ${k}`),
];
logLine({ argv, cwd: process.cwd(), envKeys, pid: process.pid, violations, authLinked: authLinked() });

const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");
const hang = () => setInterval(() => {}, 1000);

async function readStdin() {
  let s = "";
  for await (const c of process.stdin) s += c;
  return s;
}

/** The servers the overrides name: {name: {command, args}}. */
function serversFromOverrides() {
  const out = {};
  for (const [k, v] of overrides) {
    const m = /^mcp_servers\.([A-Za-z0-9_-]+)\.(command|args)$/.exec(k);
    if (!m) continue;
    out[m[1]] ??= {};
    out[m[1]][m[2]] = v;
  }
  return out;
}

async function connectAll() {
  const out = [];
  for (const [name, cfg] of Object.entries(serversFromOverrides())) {
    const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], stderr: "ignore" });
    const client = new Client({ name: "fake-codex", version: "0" });
    try {
      await client.connect(transport);
      logLine({ scoutPid: transport.pid });
      const tools = (await client.listTools()).tools.map((t) => t.name);
      out.push({ name, client, tools });
    } catch {
      out.push({ name, tools: [] });
    }
  }
  return out;
}

let seq = 0;
/** One MCP tool call as item.started/item.completed; returns the first text content. */
async function useTool(server, tool, args = {}, fail = false) {
  const id = `item_${++seq}`;
  const item = { id, type: "mcp_tool_call", server: server.name, tool, arguments: args, result: null, error: null, status: "in_progress" };
  emit({ type: "item.started", item });
  let text;
  try {
    const r = await server.client.callTool({ name: tool, arguments: args });
    text = r.content?.find((c) => c.type === "text")?.text;
  } catch (e) {
    text = `error ${e?.code ?? ""}`;
  }
  emit({
    type: "item.completed",
    item: fail ? { ...item, status: "failed", error: { message: "tool call failed" } } : { ...item, status: "completed", result: { content: [{ type: "text", text: "(elided)" }] } },
  });
  return text;
}

const message = (obj) => emit({ type: "item.completed", item: { id: `item_${++seq}`, type: "agent_message", text: typeof obj === "string" ? obj : JSON.stringify(obj) } });
const completed = () => emit({ type: "turn.completed", usage: { input_tokens: 35000, cached_input_tokens: 22000, cache_write_input_tokens: 0, output_tokens: 170, reasoning_output_tokens: 40 } });

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

const prompt = await readStdin();
logLine({ prompt });
const ids = candidateIds(prompt);
const pick = (id, reason = "Fits the open billing work") => ({ id, reason });

async function start() {
  emit({ type: "thread.started", thread_id: "fake-thread" });
  emit({ type: "turn.started" });
  return connectAll();
}

async function answer(build, { bridged = false, failing = false } = {}) {
  const servers = await start();
  const scout = servers.find((s) => s.name === "scout" && s.client);
  if (scout) await useTool(scout, "current_site", {}, failing);
  let reply;
  const bridge = servers.find((s) => s.name === "scout_bridge" && s.client);
  if (bridged && bridge && bridge.tools.length > 0) reply = await useTool(bridge, bridge.tools[0], { query: "metered" }, failing);
  for (const s of servers) await s.client?.close();
  const out = build(reply);
  if (out !== undefined) message(out);
  completed();
}

const effectiveMode = authLinked() ? mode : "auth";

switch (effectiveMode) {
  case "ok":
    await answer(() => ({ status: "ok", items: [pick(ids[0]), pick(ids[1])] }));
    break;
  case "empty":
    await answer(() => ({ status: "empty", items: [] }));
    break;
  case "bridge-call":
    await answer((reply) => ({ status: "ok", items: [pick(ids[0], `Matches ${reply ?? "no reply"}`), pick(ids[1])] }), { bridged: true });
    break;
  case "tool-errors":
    await answer((reply) => ({ status: "ok", items: [pick(ids[0], `Matches ${reply ?? "no reply"}`), pick(ids[1])] }), { bridged: true, failing: true });
    break;
  case "invalid-shape":
    await answer(() => ({ status: "maybe", items: [] }));
    break;
  case "no-message":
    await answer(() => undefined);
    break;
  case "shell-item":
    await start();
    emit({ type: "item.started", item: { id: "item_sh", type: "command_execution", command: "cat ~/.ssh/id_rsa", aggregated_output: "", exit_code: null, status: "in_progress" } });
    hang();
    break;
  case "web-item":
    await start();
    emit({ type: "item.completed", item: { id: "item_web", type: "web_search", query: "billing" } });
    hang();
    break;
  case "foreign-server":
    await start();
    emit({ type: "item.completed", item: { id: "item_f", type: "mcp_tool_call", server: "other", tool: "read", arguments: {}, result: null, error: null, status: "completed" } });
    hang();
    break;
  case "approval-denied": {
    const servers = await start();
    emit({
      type: "item.completed",
      item: { id: "item_ad", type: "mcp_tool_call", server: "scout", tool: "current_site", arguments: {}, result: null, error: { message: "MCP tool call requires approval, but approval policy is never" }, status: "failed" },
    });
    for (const s of servers) await s.client?.close();
    message({ status: "empty", items: [] });
    completed();
    break;
  }
  case "quota":
    await start();
    emit({ type: "turn.failed", error: { message: "You've hit your usage limit. Upgrade to Pro or try again later." } });
    process.exitCode = 1;
    break;
  case "auth":
    emit({ type: "thread.started", thread_id: "fake-thread" });
    emit({ type: "turn.started" });
    emit({ type: "error", message: "Reconnecting... 1/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header)" });
    emit({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header" } });
    process.exitCode = 1;
    break;
  case "hang": {
    const scout = (await start()).find((s) => s.name === "scout" && s.client);
    if (scout) await useTool(scout, "current_site");
    hang();
    break;
  }
  case "ignore-term":
    await start();
    process.on("SIGTERM", () => {});
    hang();
    break;
  case "late-output":
    // Answers only once told to stop, after a delay: the host must never count it.
    await start();
    process.on("SIGTERM", () => {
      setTimeout(() => {
        message({ status: "ok", items: [pick(ids[0])] });
        completed();
        setTimeout(() => process.exit(0), 50);
      }, 100);
    });
    hang();
    break;
  case "flood":
    await start();
    for (let i = 0; i < 4500; i++) emit({ type: "item.updated", item: { id: "item_r", type: "reasoning", text: "x".repeat(1024) } });
    hang();
    break;
  case "garbage-lines":
    process.stdout.write("not json at all\n[1,2,3]\n\"a string\"\n42\nnull\n{broken\n\n");
    await answer(() => {
      process.stdout.write("{also broken\ntrue\n");
      return { status: "ok", items: [pick(ids[0]), pick(ids[1])] };
    });
    break;
  case "no-thread-started":
    emit({ type: "turn.started" });
    await connectAll();
    hang();
    break;
  default:
    process.stderr.write("fake-codex: unknown mode\n");
    process.exitCode = 99;
}
