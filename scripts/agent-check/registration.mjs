// The two proof-only additions the hot-load check makes, and their ownership-checked
// removal: one user-scope MCP registration (through `claude mcp add/get/remove`, never by
// editing the CLI's config file) and one skill directory under the skills root.
//
// The `claude mcp` handling (verified CLI syntax and output, the "absent only on the explicit
// not-found answer" rule, conditional removal) lives in ../lib/claude-mcp.mjs and is re-exported
// here unchanged.
//
// Removal is conditional: the registration only when `get` still shows exactly the command
// and args we added at user scope; the skill directory only when it holds exactly our
// SKILL.md with the content hash we recorded. Anything else is left in place and reported.
// Removal is attempted whenever `add` was attempted, whatever `add` reported: an `add` that
// wrote the entry and then failed or timed out must not leak it.
//
// A `get` that cannot tell (timeout, signal, odd exit, unparseable output) is `unknown`: cleanup
// then leaves the entry alone and reports `unknown_state` with the exit status/signal only (never
// the CLI's text). A `remove` whose result `get` cannot confirm is `removal_unverified`.

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorCode } from "./classify.mjs";
import { ownershipHash } from "../../packages/scout-core/dist/integrations/claudeCode/skillIdentity.js";
import { WRAPPER_FILE } from "../../packages/scout-core/dist/integrations/claudeCode/skillWrapper.js";

export { MCP_TIMEOUT_MS, claudeRun, exitOf, mcpAddUser, mcpGet, ownsRegistration, removeOwnedRegistration } from "../lib/claude-mcp.mjs";

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
