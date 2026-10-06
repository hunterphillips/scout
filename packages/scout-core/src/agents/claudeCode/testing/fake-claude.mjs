// Test double for `claude -p` in the agent-job tests, adapted from the removed
// personal-context package (see git history before 2026-10-02). Never calls a model
// or the network.
//
// Behaviour comes from FAKE_MODE (and FAKE_VERSION, the version its init reports), set by
// the wrapper script fakeCli.ts writes, since the launch profile drops unknown env keys. It
// appends {argv, cwd, envKeys, pid, violations} and later {scoutPid} and {prompt} lines to
// FAKE_LOG.
//
// It emulates the CLI from the flags it was launched with, so a launch regression shows up
// the way it would in the real CLI and the host's checks are what catch it:
//   - no --model: reports a gateway-style default model;
//   - --permission-mode: reported as given ("default" if absent);
//   - --tools other than "": built-in tools appear in init;
//   - no --disable-slash-commands: the Skill tool appears in init;
//   - no --strict-mcp-config: a user-installed server appears in init;
//   - --settings without disableAllHooks: a user SessionStart hook runs (hook events);
//   - user-level instructions (CLAUDE.md in the config dir) are visible unless the default
//     system prompt was replaced or --bare/--safe-mode was passed.
// Flags no job may ever pass (resume, replacement prompts, permission bypass, ...) are
// recorded as `violations`; tests assert there are none.
//
// In the answering modes it connects to the REAL scout-mcp server named in the job's
// mcp.json (which talks to the fixture core socket) and calls Scout tools before answering.
// With selected user tools, mcp.json also names the REAL per-job bridge (scout_bridge),
// which it starts like any server; `bridge-call` calls the bridged `lookup` and puts its
// reply in the first pick's reason, so a test sees the tool was called, not just listed.
// `tool-errors` is `bridge-call` with Scout's `current_site` and the bridged `lookup` results
// reported as `is_error` (a tool that failed at runtime), then the same answer.
// `sleep-ignore-term` (job shutdown) starts like `ignore-term` (every server connected, no
// final response, SIGTERM ignored) and also starts two `sleep` descendants that ignore SIGTERM:
// one in its process group, one that leaves it (its own group); their pids go to the log as
// {descendantPids}.

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mode = process.env.FAKE_MODE ?? "ok";
const version = process.env.FAKE_VERSION ?? "2.1.286";
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

// Subcommands (`--version`, `auth ...`, `mcp ...`) and multi-turn stream-json sessions
// (`--input-format stream-json`) are emulated by fake-claude-session.mjs; see its header.
if (["--version", "auth", "mcp"].includes(argv[0] ?? "") || flag("--input-format") === "stream-json") {
  const { runExtended } = await import("./fake-claude-session.mjs");
  await runExtended({ argv, mode, version });
  process.exit(process.exitCode ?? 0);
}

const FORBIDDEN = [
  "--resume",
  "-r",
  "--continue",
  "-c",
  "--session-id",
  "--fork-session",
  "--system-prompt",
  "--system-prompt-file",
  "--fallback-model",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--bare",
  "--add-dir",
];
const REQUIRED = ["-p", "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands", "--json-schema"];
const violations = [...FORBIDDEN.filter(has).map((f) => `forbidden ${f}`), ...REQUIRED.filter((f) => !has(f)).map((f) => `missing ${f}`)];
const logLine = (obj) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(obj) + "\n");
};
logLine({ argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), pid: process.pid, violations });

const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");
const hang = () => setInterval(() => {}, 1000);

async function readStdin() {
  let s = "";
  for await (const c of process.stdin) s += c;
  return s;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

const mcpServers = readJson(flag("--mcp-config") ?? "")?.mcpServers ?? {};
const settings = has("--settings") ? (readJson(flag("--settings")) ?? {}) : {};
const hooksDisabled = settings.disableAllHooks === true;

/** Connect to every configured server, as the CLI does at startup. */
async function connectAll() {
  const out = [];
  for (const [name, cfg] of Object.entries(mcpServers)) {
    const params = { command: cfg.command, args: cfg.args, stderr: "ignore" };
    if (cfg.env) params.env = cfg.env;
    const transport = new StdioClientTransport(params);
    const client = new Client({ name: "fake-claude", version: "0" });
    try {
      await client.connect(transport);
      logLine({ scoutPid: transport.pid });
      const tools = (await client.listTools()).tools.map((t) => `mcp__${name}__${t.name}`);
      out.push({ name, status: "connected", client, tools });
    } catch {
      out.push({ name, status: "failed", tools: [] });
    }
  }
  return out;
}

function initEvent(servers, extra = {}) {
  const tools = [];
  if (flag("--tools") !== "") tools.push("Bash", "Read", "Edit");
  if (!has("--disable-slash-commands")) tools.push("Skill");
  for (const s of servers) tools.push(...s.tools);
  tools.push("StructuredOutput");
  const mcp = servers.map((s) => ({ name: s.name, status: s.status }));
  if (!has("--strict-mcp-config")) mcp.push({ name: "user-installed", status: "connected" });
  return {
    type: "system",
    subtype: "init",
    session_id: "fake-session-id",
    cwd: process.cwd(),
    tools,
    mcp_servers: mcp,
    model: flag("--model") ?? "gateway-default-model",
    permissionMode: flag("--permission-mode") ?? "default",
    apiKeySource: "none",
    claude_code_version: version,
    ...extra,
  };
}

function startup() {
  if (!hooksDisabled) {
    emit({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" });
    emit({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", exit_code: 0 });
  }
}

let toolUseSeq = 0;
/** Call a tool; returns its first text content (or the error text). `reportError` marks its result `is_error`. */
async function useTool(server, tool, args = {}, reportError = false) {
  const id = `toolu_${++toolUseSeq}`;
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id, name: `mcp__${server.name}__${tool}`, input: args }] } });
  let text;
  try {
    const r = await server.client.callTool({ name: tool, arguments: args });
    text = r.content?.find((c) => c.type === "text")?.text;
  } catch (e) {
    text = `error ${e?.code ?? ""}`;
  }
  const res = { type: "tool_result", tool_use_id: id, content: "(elided)" };
  if (reportError) res.is_error = true;
  emit({ type: "user", message: { content: [res] } });
  return text;
}

function result(extra) {
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1234,
    num_turns: 3,
    result: "",
    session_id: "fake-session-id",
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

/** The user-level instruction marker, when the CLI would have loaded user instructions. */
function visibleMarker() {
  if (has("--system-prompt") || has("--system-prompt-file") || has("--bare") || has("--safe-mode")) return undefined;
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "/nonexistent", ".claude");
  try {
    return /Scout compatibility marker: (SCOUTMARK[0-9a-f]{12})/.exec(readFileSync(join(configDir, "CLAUDE.md"), "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

const prompt = await readStdin();
logLine({ prompt });
const ids = candidateIds(prompt);
const probe = prompt.includes("Compatibility check:");

const item = (id, reason = "Fits the open billing work") => ({ id, reason });

/** Start up, call two Scout tools (and, if `bridged`, the bridge's `lookup`), answer. `failing` reports current_site and lookup as errors. */
async function answer(build, bridged = false, failing = false) {
  startup();
  const servers = await connectAll();
  emit(initEvent(servers));
  const scout = servers.find((s) => s.name === "scout" && s.client);
  if (scout) {
    await useTool(scout, "current_site", {}, failing);
    await useTool(scout, "recent_activity");
  }
  let reply;
  const bridge = servers.find((s) => s.name === "scout_bridge" && s.client);
  if (bridged && bridge?.tools.includes("mcp__scout_bridge__lookup")) reply = await useTool(bridge, "lookup", { query: "metered" }, failing);
  for (const s of servers) await s.client?.close();
  result({ structured_output: build(reply) });
}

/** Start up, close the servers, then emit the final event(s). */
async function initThen(finish) {
  startup();
  const servers = await connectAll();
  emit(initEvent(servers));
  for (const s of servers) await s.client?.close();
  finish();
}

async function startAndHang(extra = {}) {
  startup();
  const servers = await connectAll();
  emit(initEvent(servers, extra));
  return servers;
}

switch (mode) {
  case "ok":
    await answer(() => {
      const first = item(ids[0]);
      const marker = probe ? visibleMarker() : undefined;
      if (marker) first.reason = `${marker} ${first.reason}`;
      return { status: "ok", items: [first, item(ids[1])] };
    });
    break;
  case "bridge-call":
    await answer((reply) => ({ status: "ok", items: [item(ids[0], `Matches ${reply ?? "no reply"}`), item(ids[1])] }), true);
    break;
  case "tool-errors":
    await answer((reply) => ({ status: "ok", items: [item(ids[0], `Matches ${reply ?? "no reply"}`), item(ids[1])] }), true, true);
    break;
  case "marker-only":
    // The first reason is the visible marker and nothing else.
    await answer(() => ({ status: "ok", items: [item(ids[0], (probe ? visibleMarker() : undefined) ?? "no marker"), item(ids[1])] }));
    break;
  case "empty":
    await answer(() => ({ status: "empty" }));
    break;
  case "invalid-shape":
    await answer(() => ({ status: "maybe" }));
    break;
  case "all-invalid":
    await answer(() => ({ status: "ok", items: [item("c999"), item("c998")] }));
    break;
  case "some-invalid":
    await answer(() => ({ status: "ok", items: [item("c999"), item(ids[0])] }));
    break;
  case "duplicate":
    await answer(() => ({ status: "ok", items: [item(ids[0]), item(ids[0], "again")] }));
    break;
  case "url-reason":
    await answer(() => ({ status: "ok", items: [item(ids[0], "See https://evil.example/x?a=1 and www.evil.example now")] }));
    break;
  case "no-structured":
    await initThen(() => result({ result: "here are some links" }));
    break;
  case "extra-server":
    await startAndHang({ mcp_servers: [{ name: "scout", status: "connected" }, { name: "other", status: "connected" }] });
    hang();
    break;
  case "missing-scout":
    startup();
    emit(initEvent([{ name: "scout", status: "failed", tools: [] }]));
    hang();
    break;
  case "wrong-model":
    await startAndHang({ model: "claude-other-model" });
    hang();
    break;
  case "bad-billing":
    await startAndHang({ apiKeySource: "ANTHROPIC_API_KEY" });
    hang();
    break;
  case "max-turns":
    await initThen(() => result({ subtype: "error_max_turns", is_error: false }));
    break;
  case "quota":
    await startAndHang();
    emit({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 5000, error_status: 429, error: "rate_limit" });
    hang();
    break;
  case "auth":
    await initThen(() => result({ is_error: true, api_error_status: 401, result: "Invalid API key · Please run /login" }));
    process.exitCode = 1;
    break;
  case "hang": {
    // Starts, reads the current site (so scout-mcp holds a core connection), never answers.
    const scout = (await startAndHang()).find((s) => s.name === "scout" && s.client);
    if (scout) await useTool(scout, "current_site");
    hang();
    break;
  }
  case "ignore-term":
    process.on("SIGTERM", () => {});
    await startAndHang();
    hang();
    break;
  case "sleep-ignore-term": {
    process.on("SIGTERM", () => {});
    await startAndHang();
    const sleeper = (detached) => spawn("/bin/sh", ["-c", "trap '' TERM; exec /bin/sleep 300"], { stdio: "ignore", detached }).pid;
    logLine({ descendantPids: [sleeper(false), sleeper(true)] });
    hang();
    break;
  }
  case "late-output":
    // Answers only once told to stop: the host must never count it.
    await startAndHang();
    process.on("SIGTERM", () => {
      result({ structured_output: { status: "ok", items: [item(ids[0])] } });
      setTimeout(() => process.exit(0), 50);
    });
    hang();
    break;
  case "no-init":
    startup();
    await connectAll();
    emit({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    hang();
    break;
  case "garbage-init":
    startup();
    await connectAll();
    emit({ type: "system", subtype: "init", model: flag("--model") });
    hang();
    break;
  case "extra-tool-use":
    await startAndHang();
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "true" } }] } });
    hang();
    break;
  case "flood":
    // Starts, then writes far more stdout than any job may (about 1 MiB), then hangs.
    await startAndHang();
    for (let i = 0; i < 1024; i++) emit({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(1024) }] } });
    hang();
    break;
  case "no-trailing-newline":
    // A valid answer whose final result line has no newline before EOF.
    await initThen(() => process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, structured_output: { status: "ok", items: [item(ids[0])] } })));
    break;
  case "garbage-lines":
    // Lines that are not stream-json objects, before and after init, then a valid answer.
    process.stdout.write("not json at all\n[1,2,3]\n\"a string\"\n42\nnull\n{broken\n\n");
    await answer(() => {
      process.stdout.write("{also broken\ntrue\n");
      return { status: "ok", items: [item(ids[0]), item(ids[1])] };
    });
    break;
  case "hook-event":
    // A hook event after init even though hooks are disabled (e.g. a managed-policy hook).
    await startAndHang();
    emit({ type: "system", subtype: "hook_started", hook_name: "PreToolUse:managed" });
    hang();
    break;
  case "auth-retry":
    // A 401 while retrying the API: the login is not usable.
    await startAndHang();
    emit({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 5000, error_status: 401, error: "authentication_failed" });
    hang();
    break;
  default:
    process.stderr.write("fake: unknown mode\n");
    process.exitCode = 99;
}
