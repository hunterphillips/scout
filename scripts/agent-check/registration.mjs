// The two proof-only additions the hot-load check makes, and their ownership-checked
// removal: one user-scope MCP registration (through `claude mcp add/get/remove`, never by
// editing the CLI's config file) and one skill directory under the skills root.
//
// `claude mcp` syntax and output verified against CLI 2.1.286 in a throwaway config dir:
//   add --scope user <name> -- <command> [args...]    exit 1 if <name> exists in user scope
//   get <name>                                        exit 1 "No MCP server named ..." if absent;
//                                                     otherwise "<name>:" then indented
//                                                     "Scope: User config (...)", "Status: ...",
//                                                     "Type: stdio", "Command: <cmd>",
//                                                     "Args: <args joined by spaces>"; it also
//                                                     health-checks (starts) the server
//   remove --scope user <name>                        exit 1 if absent in user scope
// Args are joined by spaces in `get`, so the check's paths must not contain spaces.
//
// Removal is conditional: the registration only when `get` still shows exactly the command
// and args we added at user scope; the skill directory only when it holds exactly our
// SKILL.md with the content hash we recorded. Anything else is left in place and reported.

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownershipHash } from "../../packages/scout-core/dist/capabilities/identity.js";
import { WRAPPER_FILE } from "../../packages/scout-core/dist/capabilities/wrapper.js";

const TIMEOUT_MS = 60_000;

/** Run `claude <args>` argv-only with the session's exact env and cwd. stdout only; stderr is dropped. */
export function claudeRun(claudePath, args, { env, cwd }) {
  const r = spawnSync(claudePath, args, { env: { ...env }, cwd, encoding: "utf8", timeout: TIMEOUT_MS, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "" };
}

/** `claude mcp get <name>`, parsed. `lines` holds only the descriptive fields, for the report. */
export function mcpGet(claudePath, name, opts) {
  const r = claudeRun(claudePath, ["mcp", "get", name], opts);
  const rows = r.stdout.split("\n");
  if (r.status !== 0 || rows[0] !== `${name}:`) return { exists: r.status === 0 ? "unknown" : false, status: r.status };
  const field = (k) => rows.map((l) => new RegExp(`^\\s+${k}: ?(.*)$`).exec(l)?.[1]).find((v) => v !== undefined);
  return {
    exists: true,
    scope: field("Scope"),
    health: field("Status"),
    type: field("Type"),
    command: field("Command"),
    args: field("Args"),
  };
}

export function ownsRegistration(get, expected) {
  return get.exists === true && typeof get.scope === "string" && get.scope.startsWith("User config") && get.type === "stdio" && get.command === expected.command && get.args === expected.args.join(" ");
}

export function mcpAddUser(claudePath, name, command, args, opts) {
  return claudeRun(claudePath, ["mcp", "add", "--scope", "user", name, "--", command, ...args], opts).status === 0;
}

/**
 * Remove our registration if, and only if, it is still exactly ours. Returns
 * `removed` | `absent` | `left_changed` | `remove_failed`.
 */
export function removeOwnedRegistration(claudePath, name, expected, opts) {
  const before = mcpGet(claudePath, name, opts);
  if (before.exists === false) return "absent";
  if (!ownsRegistration(before, expected)) return "left_changed";
  if (claudeRun(claudePath, ["mcp", "remove", "--scope", "user", name], opts).status !== 0) return "remove_failed";
  return mcpGet(claudePath, name, opts).exists === false ? "removed" : "remove_failed";
}

/** Whether anything exists at `path` (a dangling symlink counts). */
export function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Create `<root>/<name>/SKILL.md` exclusively. Returns the dir and the ownership hash of what was written. */
export function writeProofSkill(root, name, text) {
  const dir = join(root, name);
  mkdirSync(dir, { mode: 0o700 }); // exclusive: an existing entry is refused
  writeFileSync(join(dir, WRAPPER_FILE), text, { mode: 0o600, flag: "wx" });
  return { dir, hash: ownershipHash({ [WRAPPER_FILE]: text }) };
}

/**
 * Remove the proof skill dir only if it is a real directory holding exactly our SKILL.md
 * with the recorded hash. Returns `removed` | `absent` | `left_modified`.
 */
export function removeOwnedSkill(dir, hash) {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return "absent";
  }
  if (!st.isDirectory()) return "left_modified";
  const entries = readdirSync(dir);
  const file = join(dir, WRAPPER_FILE);
  if (entries.length !== 1 || entries[0] !== WRAPPER_FILE || !lstatSync(file).isFile()) return "left_modified";
  if (ownershipHash({ [WRAPPER_FILE]: readFileSync(file, "utf8") }) !== hash) return "left_modified";
  unlinkSync(file);
  rmdirSync(dir);
  return "removed";
}
