// `codex mcp add/get/remove`, run through the supported CLI and never by editing its
// config.toml. Used by the installer (lib/agent-integration.mjs) for the Codex integration.
//
// Syntax and output verified against Codex CLI 0.155.1 in a throwaway CODEX_HOME (2026-10-06):
//   add <name> -- <command> [args...]   writes `[mcp_servers.<name>]` to $CODEX_HOME/config.toml;
//                                       an existing entry of that name is OVERWRITTEN without a
//                                       word, so callers `get` first and refuse a foreign one
//   get <name> --json                   exit 0 and the entry as JSON ({name, enabled, transport:
//                                       {type, command, args[], env, env_vars, cwd}, ...}); it
//                                       does not start the server. Absent: exit 1, stderr
//                                       "Error: No MCP server named '<name>' found."
//   remove <name>                       exit 0 whether or not the entry existed, so removal is
//                                       confirmed with a second `get`
// Codex has no scopes: the entry is in the user's config.toml, read by every Codex session.
// The CLI needs CODEX_HOME to exist; every run gets the Codex home explicitly.
//
// `get` means absent only on exit 1 with the not-found message. A timeout, a signal, any other
// exit or unparseable JSON is `unknown`. An entry is ours only when it is a stdio server with
// exactly the expected command and args and no env or cwd of its own.

import { spawnSync } from "node:child_process";

export const CODEX_MCP_TIMEOUT_MS = 60_000;

/** Run `codex <args>` argv-only with CODEX_HOME set. `status` is null when it timed out or could not run. */
export function codexRun(codexPath, args, { env, cwd, codexHome, timeoutMs = CODEX_MCP_TIMEOUT_MS }) {
  const r = spawnSync(codexPath, args, { env: { ...env, CODEX_HOME: codexHome }, cwd, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.error ? null : r.status, signal: r.signal ?? null, timedOut: r.error?.code === "ETIMEDOUT", stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** How a run ended, for a report: exit status, signal, timeout. No output text. */
export const exitOf = (r) => ({ status: r.status, signal: r.signal, timedOut: r.timedOut });

const notFound = (name, r) => r.status === 1 && r.signal === null && !r.timedOut && [r.stdout, r.stderr].some((t) => t.includes(`No MCP server named '${name}' found.`));

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const at = text.indexOf("\n{");
    if (at < 0) return null;
    try {
      return JSON.parse(text.slice(at + 1));
    } catch {
      return null;
    }
  }
}

/**
 * `codex mcp get <name> --json`, parsed. `exists` is true, false (only the CLI's explicit
 * not-found answer) or "unknown" (with `exit`). Only the descriptive fields are kept.
 */
export function codexMcpGet(codexPath, name, opts) {
  const r = codexRun(codexPath, ["mcp", "get", name, "--json"], opts);
  if (notFound(name, r)) return { exists: false };
  const data = r.status === 0 && r.signal === null ? parseJson(r.stdout.trim()) : null;
  const t = data?.transport;
  if (!data || data.name !== name || !t || typeof t !== "object") return { exists: "unknown", exit: exitOf(r) };
  const hasEnv = (t.env !== null && t.env !== undefined && Object.keys(t.env).length > 0) || (Array.isArray(t.env_vars) && t.env_vars.length > 0);
  return {
    exists: true,
    enabled: data.enabled !== false,
    type: t.type,
    command: typeof t.command === "string" ? t.command : undefined,
    args: Array.isArray(t.args) && t.args.every((a) => typeof a === "string") ? t.args : undefined,
    hasEnv,
    hasCwd: t.cwd !== null && t.cwd !== undefined,
  };
}

/** True when a parsed `get` shows exactly `expected` ({ command, args[] }) as a plain stdio server. */
export function ownsCodexRegistration(get, expected) {
  return (
    get.exists === true &&
    get.type === "stdio" &&
    get.command === expected.command &&
    Array.isArray(get.args) &&
    get.args.length === expected.args.length &&
    get.args.every((a, i) => a === expected.args[i]) &&
    !get.hasEnv &&
    !get.hasCwd
  );
}

/** `codex mcp add <name> -- <command> [args...]`. Returns `{ ok, status, signal, timedOut }`. */
export function codexMcpAdd(codexPath, name, command, args, opts) {
  const r = codexRun(codexPath, ["mcp", "add", name, "--", command, ...args], opts);
  return { ok: r.status === 0 && r.signal === null, ...exitOf(r) };
}

/**
 * Remove our entry if, and only if, it is still exactly ours. Returns `{ state, exit? }`, state
 * one of `removed` | `absent` | `left_changed` | `unknown_state` (the first `get` could not
 * tell; nothing touched) | `remove_failed` | `removal_unverified`.
 */
export function removeOwnedCodexRegistration(codexPath, name, expected, opts) {
  const before = codexMcpGet(codexPath, name, opts);
  if (before.exists === false) return { state: "absent" };
  if (before.exists === "unknown") return { state: "unknown_state", exit: before.exit };
  if (!ownsCodexRegistration(before, expected)) return { state: "left_changed" };
  const rm = codexRun(codexPath, ["mcp", "remove", name], opts);
  if (rm.status !== 0 || rm.signal !== null) return { state: "remove_failed", exit: exitOf(rm) };
  const after = codexMcpGet(codexPath, name, opts);
  if (after.exists === false) return { state: "removed" };
  return after.exists === "unknown" ? { state: "removal_unverified", exit: after.exit } : { state: "remove_failed" };
}
