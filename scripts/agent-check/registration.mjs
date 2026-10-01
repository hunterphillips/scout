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
// Removal is attempted whenever `add` was attempted, whatever `add` reported: an `add` that
// wrote the entry and then failed or timed out must not leak it.
//
// `get` output is found by its `<name>:` line wherever it appears (the CLI may print a notice
// first); the field rows are read from the lines after it.
//
// `get` means absent only on exit 1 with the CLI's "No MCP server named ..." message. A
// timeout, a signal, any other exit, or unparseable output is `unknown`: cleanup then leaves
// the entry alone and reports `unknown_state` with the exit status/signal only (never the
// CLI's text). A `remove` whose result `get` cannot confirm is `removal_unverified`.

import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorCode } from "./classify.mjs";
import { ownershipHash } from "../../packages/scout-core/dist/capabilities/identity.js";
import { WRAPPER_FILE } from "../../packages/scout-core/dist/capabilities/wrapper.js";

export const MCP_TIMEOUT_MS = 60_000;

/**
 * Run `claude <args>` argv-only with the session's exact env and cwd. stdout only; stderr is
 * dropped. `status` is null when it timed out (killed) or could not run.
 */
export function claudeRun(claudePath, args, { env, cwd, timeoutMs = MCP_TIMEOUT_MS }) {
  const r = spawnSync(claudePath, args, { env: { ...env }, cwd, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.error ? null : r.status, signal: r.signal ?? null, timedOut: r.error?.code === "ETIMEDOUT", stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** How a `claude mcp` run ended, for the report: exit status, signal, timeout. No output text. */
export const exitOf = (r) => ({ status: r.status, signal: r.signal, timedOut: r.timedOut });

const notFound = (name, r) => r.status === 1 && r.signal === null && !r.timedOut && [r.stdout, r.stderr].some((t) => t.includes(`No MCP server named "${name}"`));

/**
 * `claude mcp get <name>`, parsed. `exists` is true, false (only the CLI's explicit not-found
 * answer) or "unknown" (with `exit`). Only the descriptive fields are kept, for the report.
 */
export function mcpGet(claudePath, name, opts) {
  const r = claudeRun(claudePath, ["mcp", "get", name], opts);
  if (notFound(name, r)) return { exists: false };
  const all = r.stdout.split("\n");
  const at = all.indexOf(`${name}:`);
  if (r.status !== 0 || r.signal !== null || at < 0) return { exists: "unknown", exit: exitOf(r) };
  const rows = all.slice(at + 1);
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

/** `claude mcp add --scope user`. Returns `{ ok, status, signal, timedOut }`; the caller cleans up either way. */
export function mcpAddUser(claudePath, name, command, args, opts) {
  const r = claudeRun(claudePath, ["mcp", "add", "--scope", "user", name, "--", command, ...args], opts);
  return { ok: r.status === 0 && r.signal === null, ...exitOf(r) };
}

/**
 * Remove our registration if, and only if, it is still exactly ours. Returns `{ state, exit? }`,
 * state one of `removed` | `absent` | `left_changed` | `unknown_state` (the first `get` could not
 * tell; nothing touched) | `remove_failed` | `removal_unverified` (removed, but `get` could not
 * confirm it). `exit` is the failing run's status/signal.
 */
export function removeOwnedRegistration(claudePath, name, expected, opts) {
  const before = mcpGet(claudePath, name, opts);
  if (before.exists === false) return { state: "absent" };
  if (before.exists === "unknown") return { state: "unknown_state", exit: before.exit };
  if (!ownsRegistration(before, expected)) return { state: "left_changed" };
  const rm = claudeRun(claudePath, ["mcp", "remove", "--scope", "user", name], opts);
  if (rm.status !== 0 || rm.signal !== null) return { state: "remove_failed", exit: exitOf(rm) };
  const after = mcpGet(claudePath, name, opts);
  if (after.exists === false) return { state: "removed" };
  return after.exists === "unknown" ? { state: "removal_unverified", exit: after.exit } : { state: "remove_failed" };
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
 * Remove the proof skill dir only if it is a real directory (not a symlink) holding exactly
 * our SKILL.md with the recorded hash. Never throws. Returns `removed` | `absent` |
 * `left_modified` | `left_symlink` (the dir or its SKILL.md is a symlink) | `error_<code>`
 * (e.g. `error_EACCES`). An entry that vanishes midway counts as modified.
 */
export function removeOwnedSkill(dir, hash) {
  try {
    let st;
    try {
      st = lstatSync(dir);
    } catch (e) {
      return e?.code === "ENOENT" ? "absent" : errorCode(e);
    }
    if (st.isSymbolicLink()) return "left_symlink";
    if (!st.isDirectory()) return "left_modified";
    const entries = readdirSync(dir);
    if (entries.length !== 1 || entries[0] !== WRAPPER_FILE) return "left_modified";
    const file = join(dir, WRAPPER_FILE);
    let fd;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      if (e?.code === "ELOOP") return "left_symlink";
      return e?.code === "ENOENT" ? "left_modified" : errorCode(e);
    }
    let text;
    try {
      if (!fstatSync(fd).isFile()) return "left_modified";
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    if (ownershipHash({ [WRAPPER_FILE]: text }) !== hash) return "left_modified";
    // The dir must still be the one we checked: a swap for a symlink is left alone.
    const again = lstatSync(dir);
    if (again.isSymbolicLink()) return "left_symlink";
    if (again.ino !== st.ino || again.dev !== st.dev) return "left_modified";
    unlinkSync(file);
    rmdirSync(dir);
    return "removed";
  } catch (e) {
    return e?.code === "ENOENT" ? "left_modified" : errorCode(e);
  }
}

/** The CLI's user config file: `$CLAUDE_CONFIG_DIR/.claude.json`, else `$HOME/.claude.json`. */
export function userConfigFile(env) {
  return join(env.CLAUDE_CONFIG_DIR ?? env.HOME, ".claude.json");
}

/** The user settings file: `$CLAUDE_CONFIG_DIR/settings.json`, else `$HOME/.claude/settings.json`. */
export function userSettingsFile(env) {
  return join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME, ".claude"), "settings.json");
}

/**
 * The user-scope `mcpServers` key names in the CLI's config file, read-only. Values are never
 * returned. `undefined` when the file is missing, unreadable or not JSON with an object there
 * (a missing file is an empty registry: `[]`).
 */
export function registryNames(env) {
  let text;
  try {
    text = readFileSync(userConfigFile(env), "utf8");
  } catch (e) {
    return e?.code === "ENOENT" ? [] : undefined;
  }
  try {
    const servers = JSON.parse(text)?.mcpServers;
    if (servers === undefined) return [];
    return servers && typeof servers === "object" && !Array.isArray(servers) ? Object.keys(servers).sort() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Counts of the user's own allow rules (`permissions.allow` in the user settings file), read
 * only to count: `{ count, mcpCount }` (zero when the file is missing), or `undefined` if it
 * cannot be read or parsed.
 */
export function userAllowRuleCounts(env) {
  let text;
  try {
    text = readFileSync(userSettingsFile(env), "utf8");
  } catch (e) {
    return e?.code === "ENOENT" ? { count: 0, mcpCount: 0 } : undefined;
  }
  try {
    const allow = JSON.parse(text)?.permissions?.allow;
    const rules = Array.isArray(allow) ? allow.filter((r) => typeof r === "string") : [];
    return { count: rules.length, mcpCount: rules.filter((r) => r.startsWith("mcp__")).length };
  } catch {
    return undefined;
  }
}
