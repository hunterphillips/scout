// Pi 1.0.4 JSON CLI double. No model call or network request is made.
//
// Subcommands:
//   --version                print FAKE_VERSION (default 1.0.4)
//   --list-models [search]   print a table, no models, or no matching model
//   mcp add|remove|list      edit or read the private mcp.json (Phase 3 test support)
//   --mode json ...          record launch and prompt, connect to Scout's fixture MCP
//                          servers, then emit Pi's JSON event shapes
//
// Run modes: ok, empty, bridge-call, tool-errors, answer-rejected, no-answer,
// builtin-tool, codemode, no-scout-tools, model-error, retry, many-turns, hang,
// ignore-term, late-output, flood. hang waits for a stop; ignore-term ignores
// SIGTERM; late-output writes after agent_settled; flood exceeds the stdout cap.

import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_MODE ?? "ok";
const agentDir = process.env.PI_CODING_AGENT_DIR;
const envKeys = Object.keys(process.env).sort();

function log(entry) {
  if (process.env.FAKE_LOG) {
    appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
  }
}

function emit(entry) {
  process.stdout.write(JSON.stringify(entry) + "\n");
}

function authLinked() {
  try {
    return statSync(join(agentDir, "auth.json")).isFile();
  } catch {
    return false;
  }
}

if (argv[0] === "--version") {
  log({ sub: true, argv, envKeys });
  process.stdout.write(`${process.env.FAKE_VERSION ?? "1.0.4"}\n`);
  process.exit(0);
}

if (argv[0] === "--list-models") {
  log({ sub: true, argv, envKeys });
  if (!authLinked() || process.env.FAKE_LOGIN === "none") {
    process.stdout.write("No models available\n");
  } else if (argv[1] && !"openai/gpt-6-sol".includes(argv[1])) {
    process.stdout.write(`No models matching "${argv[1]}"\n`);
  } else {
    process.stdout.write("provider  model\nopenai    gpt-6-sol\n");
  }
  process.exit(0);
}

if (argv[0] === "mcp") {
  const skills = [];
  try {
    for (const dir of readdirSync(join(agentDir, "skills"))) {
      const text = readFileSync(join(agentDir, "skills", dir, "SKILL.md"), "utf8");
      const name = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)/.exec(text)?.[1];
      if (name) skills.push(name);
    }
  } catch {
    // No user skills yet.
  }
  log({ sub: true, argv, envKeys, skills });
  const path = join(agentDir, "mcp.json");
  let data = { mcpServers: {} };
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Start with an empty registry.
  }
  if (argv[1] === "list") {
    process.stdout.write(`${JSON.stringify(data)}\n`);
  } else if (argv[1] === "remove") {
    delete data.mcpServers[argv[2]];
    writeFileSync(path, JSON.stringify(data));
  } else if (argv[1] === "add") {
    const separator = argv.indexOf("--");
    if (!argv.includes("--exposure") || argv[argv.indexOf("--exposure") + 1] !== "direct" || separator < 0) process.exit(2);
    data.mcpServers[argv[2]] = {
      command: argv[separator + 1],
      args: argv.slice(separator + 2),
      exposure: "direct",
    };
    writeFileSync(path, JSON.stringify(data));
  } else {
    process.exitCode = 2;
  }
  process.exit();
}

const flag = (name) => argv[argv.indexOf(name) + 1];
const forbidden = ["--approve", "--api-key", "--session", "--continue", "--resume"];
const violations = forbidden.filter((name) => argv.includes(name)).map((name) => `forbidden ${name}`);
if (flag("--mode") !== "json") violations.push("mode");
for (const name of [
  "--no-session", "-na", "-ns", "-nc", "-np", "--no-themes",
  "-e", "--tools", "--thinking", "--append-system-prompt",
]) {
  if (!argv.includes(name)) violations.push(`missing ${name}`);
}
log({ argv, cwd: process.cwd(), envKeys, pid: process.pid, violations, authLinked: authLinked() });

let prompt = "";
for await (const chunk of process.stdin) {
  prompt += chunk;
}
log({ prompt });
const ids = prompt
  .split("\n")
  .filter((line) => /^c[0-9a-z]+ \| /.test(line))
  .map((line) => line.split(" | ")[0]);
const pick = ids[0] ?? "c1";

let servers = {};
try {
  servers = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8")).mcpServers;
} catch {
  // A failed MCP startup is silent in Pi JSON mode; the answer reports zero tools.
}
const clients = [];
for (const [name, config] of Object.entries(servers)) {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    stderr: "ignore",
  });
  const client = new Client({ name: "fake-pi", version: "0" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    clients.push({ name, client, tools });
    log({ scoutPid: transport.pid });
  } catch {
    clients.push({ name, tools: [] });
  }
}

async function closeClients() {
  for (const connection of clients) {
    await connection.client?.close();
  }
}

process.on("SIGTERM", () => {
  if (mode === "ignore-term") return;
  void closeClients().then(() => process.exit(143));
});

const scoutTools = mode === "no-scout-tools"
  ? 0
  : clients.find((connection) => connection.name === "scout")?.tools.length ?? 0;
let bridgeReply;
emit({ type: "session", version: 3, id: "fake", cwd: process.cwd() });
emit({ type: "agent_start" });

function turn() {
  emit({ type: "turn_start" });
}

function endTurn(reason = "toolUse", errorMessage) {
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      provider: "openai",
      model: "gpt-6-sol",
      stopReason: reason,
      ...(errorMessage ? { errorMessage } : {}),
      usage: { input: 12, output: 8, cacheRead: 2, cacheWrite: 0 },
    },
  });
  emit({ type: "turn_end" });
}

async function useTool(connection, tool, args = {}, fail = false) {
  const toolName = `mcp__${connection.name}__${tool}`;
  emit({ type: "tool_execution_start", toolCallId: toolName, toolName, args });
  let reply;
  try {
    reply = await connection.client.callTool({ name: tool, arguments: args });
  } catch {
    // The stream still reports the call; the monitor owns the outcome.
  }
  emit({
    type: "tool_execution_end",
    toolCallId: toolName,
    toolName,
    result: { details: { server: connection.name, tool } },
    isError: fail,
  });
  return reply?.content?.find((item) => item.type === "text")?.text;
}

turn();
if (mode === "many-turns") {
  for (let index = 0; index < 17; index++) {
    turn();
  }
}
if (mode === "retry") {
  endTurn("error", "transient failure");
  emit({ type: "agent_end", willRetry: true });
  emit({ type: "auto_retry_start" });
  emit({ type: "auto_retry_end" });
  turn();
}
if (mode === "builtin-tool" || mode === "codemode") {
  emit({
    type: "tool_execution_start",
    toolCallId: "bad",
    toolName: mode === "codemode" ? "codemode" : "bash",
    args: {},
  });
}

const callTools = [
  "ok", "bridge-call", "tool-errors", "answer-rejected", "retry", "empty",
  "no-scout-tools", "late-output", "hang", "ignore-term",
].includes(mode);
if (callTools) {
  const scout = clients.find((connection) => connection.name === "scout" && connection.client);
  if (scout) await useTool(scout, "recent_activity", { limit: 5 }, mode === "tool-errors");
  const bridge = clients.find((connection) => connection.name === "scout_bridge" && connection.client);
  if (bridge && ["bridge-call", "tool-errors"].includes(mode) && bridge.tools[0]) {
    bridgeReply = await useTool(bridge, bridge.tools[0].name, { query: "metered" }, mode === "tool-errors");
  }
}

if (mode === "hang" || mode === "ignore-term") {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (mode === "flood") {
  // Valid events past the cap, then wait to be stopped (as the Codex fake does): exiting right
  // after a large write would drop what the pipe has not taken yet.
  for (let i = 0; i < 4500; i++) emit({ type: "message_update", delta: "x".repeat(1024) });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (mode === "model-error") {
  endTurn("error", "429 usage limit");
} else if (mode === "no-answer") {
  endTurn("stop");
} else {
  if (mode === "answer-rejected") {
    emit({ type: "tool_execution_start", toolCallId: "answer-bad", toolName: "scout_answer", args: {} });
    emit({ type: "tool_execution_end", toolCallId: "answer-bad", toolName: "scout_answer", result: {}, isError: true });
  }
  const reason = bridgeReply ? `Matches ${bridgeReply}`.slice(0, 140) : "Relevant to the current work.";
  const answer = mode === "empty"
    ? { status: "empty" }
    : { status: "ok", items: [{ id: pick, reason }] };
  emit({ type: "tool_execution_start", toolCallId: "answer", toolName: "scout_answer", args: answer });
  emit({
    type: "tool_execution_end",
    toolCallId: "answer",
    toolName: "scout_answer",
    result: { details: { answer, scoutTools } },
    isError: false,
  });
  endTurn();
}

emit({ type: "agent_end", willRetry: false });
emit({ type: "agent_settled" });
if (mode === "late-output") {
  emit({ type: "tool_execution_start", toolCallId: "late", toolName: "bash", args: {} });
  emit({
    type: "tool_execution_end",
    toolCallId: "answer-late",
    toolName: "scout_answer",
    result: { details: { answer: { status: "empty" }, scoutTools } },
    isError: false,
  });
}
await closeClients();
