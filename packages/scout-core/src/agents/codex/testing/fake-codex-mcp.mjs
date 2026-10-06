// `codex mcp add/get/remove` for the fake Codex CLI (fake-codex.mjs dispatches here). The
// shapes copy Codex CLI 0.155.1, checked in a throwaway CODEX_HOME on 2026-10-06:
//
//   add <name> -- <command> [args...]  stdout "Added global MCP server '<name>'." exit 0; an
//                                      existing entry of that name is overwritten silently
//   get <name> --json                  the entry as JSON: {name, enabled, disabled_reason,
//                                      transport: {type: "stdio", command, args, env, env_vars,
//                                      cwd}, enabled_tools, disabled_tools, startup_timeout_sec,
//                                      tool_timeout_sec}, exit 0; absent: stderr "Error: No MCP
//                                      server named '<name>' found." exit 1. Never starts it.
//   remove <name>                      "Removed global MCP server '<name>'." exit 0; absent:
//                                      "No MCP server named '<name>' found." also exit 0
//   any, with CODEX_HOME missing       stderr "Error: failed to resolve CODEX_HOME", exit 1
//
// The registry is `$CODEX_HOME/config.toml`, read and written as `[mcp_servers.<name>]` tables
// whose values are JSON-compatible TOML (strings, string arrays, booleans, integers, inline
// `env = { "K" = "V" }` tables). Tests write a foreign entry in the same form.
//
// FAKE_MODE: mcp-add-fail (writes the entry, then exits 1), mcp-get-killed (`get` of an
// existing entry is SIGKILLed), mcp-get-hang (`get` of an existing entry never exits),
// mcp-remove-fail (exits 1 without removing).

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RECOGNIZED = new Set(["command", "args", "env", "cwd", "enabled"]);

function parseValue(text) {
  const t = text.trim();
  const inline = /^\{(.*)\}$/.exec(t);
  if (inline) {
    const out = {};
    for (const part of inline[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      const m = /^"?([^"=]+)"?\s*=\s*(.+)$/.exec(part);
      if (!m) throw new Error("bad inline table");
      out[m[1]] = JSON.parse(m[2]);
    }
    return out;
  }
  return JSON.parse(t);
}

function readRegistry(file) {
  const servers = {};
  if (!existsSync(file)) return servers;
  let current = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const table = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/.exec(line);
    if (table) {
      current = servers[table[1]] = {};
      continue;
    }
    if (/^\[/.test(line)) {
      current = null;
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) throw new Error(`config.toml: cannot parse ${JSON.stringify(line.slice(0, 40))}`);
    if (current && RECOGNIZED.has(kv[1])) current[kv[1]] = parseValue(kv[2]);
  }
  return servers;
}

function writeRegistry(file, servers) {
  const out = [];
  for (const [name, s] of Object.entries(servers)) {
    out.push(`[mcp_servers.${name}]`);
    for (const k of ["command", "args", "cwd", "enabled"]) if (s[k] !== undefined) out.push(`${k} = ${JSON.stringify(s[k])}`);
    if (s.env && Object.keys(s.env).length) out.push(`env = { ${Object.entries(s.env).map(([k, v]) => `"${k}" = ${JSON.stringify(v)}`).join(", ")} }`);
    out.push("");
  }
  writeFileSync(file, out.join("\n"), { mode: 0o600 });
}

/** Emulate `codex mcp <args>`; sets process.exitCode, or never returns (hang modes). */
export async function runMcp({ args, mode }) {
  const home = process.env.CODEX_HOME;
  const fail = (msg, code = 1) => {
    process.stderr.write(`${msg}\n`);
    process.exitCode = code;
  };
  let homeOk = false;
  try {
    homeOk = !!home && statSync(home).isDirectory();
  } catch {
    homeOk = false;
  }
  if (!homeOk) return fail("Error: failed to resolve CODEX_HOME");
  const file = join(home, "config.toml");
  let servers;
  try {
    servers = readRegistry(file);
  } catch (e) {
    return fail(`Error: failed to load configuration: ${e.message}`);
  }
  const [sub, name, ...rest] = args;
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) return fail("error: a valid NAME is required", 2);

  if (sub === "add") {
    if (rest[0] !== "--" || !rest[1]) return fail("error: -- <COMMAND>... is required", 2);
    servers[name] = { command: rest[1], args: rest.slice(2) };
    writeRegistry(file, servers);
    if (mode === "mcp-add-fail") return fail("fake: failed after writing the entry");
    process.stdout.write(`Added global MCP server '${name}'.\n`);
    return;
  }
  if (sub === "get") {
    if (rest.length !== 1 || rest[0] !== "--json") return fail("fake: only `get <name> --json` is emulated", 2);
    const s = servers[name];
    if (!s) return fail(`Error: No MCP server named '${name}' found.`);
    if (mode === "mcp-get-hang") return new Promise(() => setInterval(() => {}, 1000));
    if (mode === "mcp-get-killed") process.kill(process.pid, "SIGKILL");
    const entry = {
      name,
      enabled: s.enabled ?? true,
      disabled_reason: null,
      transport: { type: "stdio", command: s.command, args: s.args ?? [], env: s.env && Object.keys(s.env).length ? s.env : null, env_vars: [], cwd: s.cwd ?? null },
      enabled_tools: null,
      disabled_tools: null,
      startup_timeout_sec: null,
      tool_timeout_sec: null,
    };
    process.stdout.write(JSON.stringify(entry, null, 2) + "\n");
    return;
  }
  if (sub === "remove") {
    if (rest.length) return fail("error: unexpected argument", 2);
    if (mode === "mcp-remove-fail") return fail("fake: remove failed");
    if (!servers[name]) {
      process.stdout.write(`No MCP server named '${name}' found.\n`);
      return;
    }
    delete servers[name];
    writeRegistry(file, servers);
    process.stdout.write(`Removed global MCP server '${name}'.\n`);
    return;
  }
  return fail(`fake: \`mcp ${sub}\` is not emulated`, 2);
}
