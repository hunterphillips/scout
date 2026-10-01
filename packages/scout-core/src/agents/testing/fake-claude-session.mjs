// Extension of fake-claude.mjs for the compatibility-check scripts (scripts/agent-check).
// Never calls a model or the network. Loaded by fake-claude.mjs for:
//
//   --version                 `<version> (Claude Code)`
//   auth --help | auth status --help | auth status --json
//                             a subscription login (mode `auth-api-key`: an API-key login)
//   mcp add --scope user <name> -- <command> [args...] | mcp get <name> | mcp remove --scope user <name>
//                             user-scope registrations in `<config>/.claude.json`, where
//                             <config> is CLAUDE_CONFIG_DIR, else HOME (as the real CLI);
//                             messages and the `get` layout copied from CLI 2.1.286
//   -p --input-format stream-json --output-format stream-json ...
//                             a multi-turn session: one turn per stdin user message, each
//                             ending in a `result` event; init is emitted with the first turn
//
// Session emulation, from the flags and files it is launched with:
//   - skills: directories with a SKILL.md under `<CLAUDE_CONFIG_DIR or HOME/.claude>/skills`,
//     plus `<cwd>/.claude/skills` when --setting-sources includes `project`;
//   - MCP servers: the user-scope registrations (unless --strict-mcp-config, or --setting-sources
//     omits `user`) plus --mcp-config files; each is started and connected for real;
//   - tools: --tools as given (comma-separated), plus every connected server's tools.
// Modes:
//   hotload-watch (default)   the skills list is rescanned before every turn (hot-load works)
//   hotload-static            the skills list is fixed at startup (needs a restart)
//   hotload-never             no scout-proof-* skill is ever visible, in any session
//   mcp-ignore                user-scope registrations are not loaded (absent from init)
//   mcp-failed                user-scope registrations show `failed` in init, no tools
//   mcp-failed-first          like mcp-failed in the first session only (counted in FAKE_LOG)
//   mcp-pending-then-connected  init shows user-scope servers `pending` without tools, but
//                             they connect during startup and serve calls in later turns
//   mcp-pending-never         init shows them `pending`; they never connect (calls fail)
//   deferred                  with ToolSearch in --tools, MCP tools are left out of init and
//                             loaded with a ToolSearch call before first use (as 2.1.286
//                             defers MCP tools when tool search is on)
//   read-fail                 the skill's read uses an unknown resource ID (Scout not_found)
//   skill-no-read             the Skill tool is called, but no read follows
//   phrase-missing            the read succeeds, the answer omits the phrase
//   not-listed                the listing says none, but the skill is used anyway
//   hang-turn2                the second turn never answers
//   mcp-add-fail | mcp-add-hang   `mcp add` writes the entry, then exits 1 | never exits
// Turns are recognized by their text: "use it with the Skill tool" first writes a
// "Skills seen:" line, then (if a proof skill is visible) invokes the Skill tool, follows
// the SKILL.md it read (calls the read tool it names with the resource ID it names) and
// answers with the "Proof phrase:" line it got back, or a refusal; a message naming an
// `mcp__...__read_resource` tool and a resource ID calls it directly; anything else is
// answered with a "Skills seen:" line of the visible `scout-proof-*` skill names.
//
// FAKE_LOG lines: {subcommand}, {session: argv}, {turn, prompt}, {scoutPid}.

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const logLine = (obj) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(obj) + "\n");
};
const out = (s) => process.stdout.write(s);

export async function runExtended({ argv, mode, version }) {
  const has = (n) => argv.includes(n);
  const flag = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv[0] === "--version") return out(`${version} (Claude Code)\n`);
  if (argv[0] === "auth") return auth(argv, mode);
  if (argv[0] === "mcp") return mcp(argv.slice(1), mode);
  return session({ argv, has, flag, mode, version });
}

// ---------- auth ----------

function auth(argv, mode) {
  const key = argv.join(" ");
  if (key === "auth --help") return out("Usage: claude auth [options] [command]\n\nCommands:\n  login [options]   Sign in\n  status [options]  Show authentication status\n");
  if (key === "auth status --help") return out("Usage: claude auth status [options]\n\nOptions:\n  --json      Output as JSON (default)\n");
  if (key === "auth status --json") {
    const status = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "fake@example.invalid", subscriptionType: "max" };
    if (mode === "auth-api-key") status.authMethod = "api_key";
    return out(JSON.stringify(status));
  }
  process.exitCode = 1;
}

// ---------- mcp registry ----------

function configFile() {
  return join(process.env.CLAUDE_CONFIG_DIR ?? process.env.HOME ?? "/nonexistent", ".claude.json");
}
function readRegistry() {
  try {
    return JSON.parse(readFileSync(configFile(), "utf8"));
  } catch {
    return {};
  }
}
function writeRegistry(cfg) {
  writeFileSync(configFile(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function mcp(args, mode) {
  logLine({ subcommand: ["mcp", ...args] });
  const [cmd, ...rest] = args;
  const scopeAt = rest.findIndex((a) => a === "--scope" || a === "-s");
  const scope = scopeAt >= 0 ? rest[scopeAt + 1] : undefined;
  const plain = scopeAt >= 0 ? [...rest.slice(0, scopeAt), ...rest.slice(scopeAt + 2)] : rest;
  const cfg = readRegistry();
  const servers = (cfg.mcpServers ??= {});
  const fail = (msg) => {
    process.stderr.write(msg + "\n");
    process.exitCode = 1;
  };
  if (cmd === "add") {
    const dd = plain.indexOf("--");
    const name = plain[0];
    if (scope !== "user" || dd !== 1 || !name) return fail("fake: only `mcp add --scope user <name> -- <command> [args...]`");
    if (Object.hasOwn(servers, name)) return fail(`MCP server ${name} already exists in user config`);
    const [command, ...cargs] = plain.slice(dd + 1);
    servers[name] = { type: "stdio", command, args: cargs, env: {} };
    writeRegistry(cfg);
    if (mode === "mcp-add-fail") return fail("fake: failed after writing the entry");
    if (mode === "mcp-add-hang") return new Promise(() => setInterval(() => {}, 1000));
    return out(`Added stdio MCP server ${name} with command: ${[command, ...cargs].join(" ")} to user config\nFile modified: ${configFile()}\n`);
  }
  if (cmd === "get") {
    const name = plain[0];
    const s = Object.hasOwn(servers, name) ? servers[name] : undefined;
    if (!s) return fail(`No MCP server named "${name}". Run \`claude mcp add\` to add one.`);
    return out(
      `${name}:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected\n  Type: stdio\n  Command: ${s.command}\n  Args: ${s.args.join(" ")}\n  Environment:\n\nTo remove this server, run: claude mcp remove ${name} -s user\n`,
    );
  }
  if (cmd === "remove") {
    const name = plain[0];
    if (scope !== "user") return fail("fake: only `mcp remove --scope user <name>`");
    if (!Object.hasOwn(servers, name)) return fail(`No MCP server named "${name}" in user scope`);
    delete servers[name];
    writeRegistry(cfg);
    return out(`Removed MCP server ${name} from user config\nFile modified: ${configFile()}\n`);
  }
  fail("fake: unknown mcp command");
}

// ---------- multi-turn session ----------

const emit = (ev) => out(JSON.stringify(ev) + "\n");

function skillRoots(flag, cwd) {
  const sources = (flag("--setting-sources") ?? "user,project,local").split(",");
  const roots = [];
  if (sources.includes("user")) roots.push(join(process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "/nonexistent", ".claude"), "skills"));
  if (sources.includes("project")) roots.push(join(cwd, ".claude", "skills"));
  return roots;
}

function scanSkills(roots) {
  const names = new Map();
  for (const root of roots) {
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) if (existsSync(join(root, e, "SKILL.md"))) names.set(e, join(root, e, "SKILL.md"));
  }
  return names;
}

async function connect(name, cfg) {
  const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], stderr: "ignore", ...(cfg.env && Object.keys(cfg.env).length ? { env: cfg.env } : {}) });
  const client = new Client({ name: "fake-claude", version: "0" });
  try {
    await client.connect(transport);
    logLine({ scoutPid: transport.pid });
    const tools = (await client.listTools()).tools.map((t) => t.name);
    return { name, status: "connected", client, tools };
  } catch {
    return { name, status: "failed", tools: [] };
  }
}

function priorSessions() {
  try {
    return readFileSync(process.env.FAKE_LOG, "utf8").split("\n").filter((l) => l.startsWith('{"session":')).length;
  } catch {
    return 0;
  }
}

async function session({ argv, has, flag, mode, version }) {
  const earlier = priorSessions();
  logLine({ session: argv, pid: process.pid });
  const cwd = process.cwd();
  const roots = skillRoots(flag, cwd);
  const hideProof = (m) => (mode === "hotload-never" ? new Map([...m].filter(([n]) => !n.startsWith("scout-proof-"))) : m);
  const startupSkills = hideProof(scanSkills(roots));
  const sources = (flag("--setting-sources") ?? "user,project,local").split(",");

  const userStatus = mode === "mcp-pending-never" ? "pending" : mode === "mcp-failed" || (mode === "mcp-failed-first" && earlier === 0) ? "failed" : undefined;
  // Servers that init reports as pending although they connect (non-blocking MCP startup).
  const pendingAtInit = new Set();
  const configs = [];
  const servers = [];
  if (!has("--strict-mcp-config") && sources.includes("user") && mode !== "mcp-ignore") {
    for (const [name, cfg] of Object.entries(readRegistry().mcpServers ?? {})) {
      if (userStatus) servers.push({ name, status: userStatus, tools: [] });
      else configs.push([name, cfg]);
    }
  }
  const mcpConfig = flag("--mcp-config");
  if (mcpConfig) for (const [name, cfg] of Object.entries(JSON.parse(readFileSync(mcpConfig, "utf8")).mcpServers ?? {})) configs.push([name, cfg]);
  for (const [name, cfg] of configs) servers.push(await connect(name, cfg));
  if (mode === "mcp-pending-then-connected") for (const s of servers) if (s.status === "connected") pendingAtInit.add(s.name);

  const builtins = flag("--tools") === undefined ? ["Bash", "Read", "Edit", "Skill"] : flag("--tools").split(",").filter(Boolean);
  // Tool search is on only when ToolSearch is offered; then MCP tools start deferred.
  const deferred = mode === "deferred" && builtins.includes("ToolSearch");
  const loaded = new Set();
  const visible = () => (mode === "hotload-static" ? startupSkills : hideProof(scanSkills(roots)));
  let toolSeq = 0;
  let turn = 0;

  const toolUse = (name, input, result, isError = false) => {
    const id = `toolu_${++toolSeq}`;
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
    if (result !== undefined) emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: result }] } });
    return id;
  };
  const say = (text) => emit({ type: "assistant", message: { content: [{ type: "text", text }] } });

  async function callRead(toolName, resourceId) {
    if (deferred && !loaded.has(toolName)) {
      toolUse("ToolSearch", { query: `select:${toolName}` }, "Loaded 1 tool");
      loaded.add(toolName);
    }
    const id = `toolu_${++toolSeq}`;
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id, name: toolName, input: { resourceId } }] } });
    const m = /^mcp__(.+)__read_resource$/.exec(toolName);
    const server = m && servers.find((s) => s.name === m[1] && s.client);
    let text = "No such tool available";
    let isError = true;
    if (server) {
      const r = await server.client.callTool({ name: "read_resource", arguments: { resourceId } });
      text = r.content?.find((c) => c.type === "text")?.text ?? "";
      isError = r.isError === true;
    }
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: text }] } });
    return { text, isError };
  }

  const answerFromRead = ({ text, isError }) => {
    if (isError) return "Scout no longer provides this resource.";
    if (mode === "phrase-missing") return "I read the resource.";
    return /Proof phrase: (SCOUT-PROOF-[0-9a-f]+)/.exec(text)?.[0] ?? "The resource had no proof phrase.";
  };
  const proofNames = () => [...visible().keys()].filter((n) => n.startsWith("scout-proof-"));
  const listing = (names) => `Skills seen: ${names.length ? names.join(", ") : "none"}`;

  async function useSkill(name) {
    const file = builtins.includes("Skill") ? visible().get(name) : undefined;
    if (!file) {
      toolUse("Skill", { skill: name }, `Unknown skill: ${name}`, true);
      return `I can't find a skill named ${name}.`;
    }
    toolUse("Skill", { skill: name }, "Launching skill");
    if (mode === "skill-no-read") return "I opened the skill.";
    const body = readFileSync(file, "utf8");
    const tool = /(mcp__\S+__read_resource)/.exec(body)?.[1];
    const rid = mode === "read-fail" ? `res_${"0".repeat(64)}` : /res_[0-9a-f]{64}/.exec(body)?.[0];
    return tool && rid ? answerFromRead(await callRead(tool, rid)) : "The skill named no resource.";
  }

  async function handle(prompt) {
    turn++;
    if (turn === 1) {
      const tools = [...builtins];
      if (!deferred) for (const s of servers) if (!pendingAtInit.has(s.name)) tools.push(...s.tools.map((t) => `mcp__${s.name}__${t}`));
      emit({
        type: "system",
        subtype: "init",
        session_id: "fake-session",
        cwd,
        tools,
        mcp_servers: servers.map((s) => ({ name: s.name, status: pendingAtInit.has(s.name) ? "pending" : s.status })),
        model: flag("--model") ?? "gateway-default-model",
        permissionMode: flag("--permission-mode") ?? "default",
        skills: [...startupSkills.keys()],
        plugins: [{ name: "someone-elses-plugin", path: "/nonexistent" }],
        apiKeySource: "none",
        claude_code_version: version,
      });
    }
    if (mode === "hang-turn2" && turn === 2) return new Promise(() => {});
    let text;
    const direct = /(mcp__\S+__read_resource)\b[\s\S]*?(res_[0-9a-f]{64})/.exec(prompt);
    if (/use it with the Skill tool/.test(prompt)) {
      const names = proofNames();
      say(listing(mode === "not-listed" ? [] : names));
      text = names.length ? await useSkill(names[0]) : "I see no scout-proof skill.";
    } else if (direct) {
      text = answerFromRead(await callRead(direct[1], direct[2]));
    } else {
      text = listing(proofNames());
    }
    say(text);
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 900,
      num_turns: 2,
      result: text,
      session_id: "fake-session",
      usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
  }

  const rl = createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg?.type !== "user") return;
    const c = msg.message?.content;
    const prompt = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b?.text ?? "").join("\n") : "";
    logLine({ turn: turn + 1, prompt });
    chain = chain.then(() => handle(prompt));
  });
  await new Promise((resolve) => rl.on("close", resolve));
  if (mode !== "hang-turn2") await chain;
  for (const s of servers) await s.client?.close();
}
