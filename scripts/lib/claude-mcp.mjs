// `claude mcp add/get/remove` at user scope, run through the supported CLI and never by
// editing its config file. Shared by the installer (lib/agent-integration.mjs) and the
// compatibility check (agent-check/registration.mjs).
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
// Args are joined by spaces in `get`, so registered paths must not contain spaces.
//
// `get` output is found by its `<name>:` line wherever it appears (the CLI may print a notice
// first); the field rows are read from the lines after it.
//
// `get` means absent only on exit 1 with the CLI's "No MCP server named ..." message. A
// timeout, a signal, any other exit, or unparseable output is `unknown`. A registration is
// removed only when `get` still shows exactly the expected command and args at user scope.

import { spawnSync } from "node:child_process";

export const MCP_TIMEOUT_MS = 60_000;

/**
 * Run `claude <args>` argv-only with the given env and cwd. `status` is null when it timed
 * out (killed) or could not run.
 */
export function claudeRun(claudePath, args, { env, cwd, timeoutMs = MCP_TIMEOUT_MS }) {
  const r = spawnSync(claudePath, args, { env: { ...env }, cwd, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.error ? null : r.status, signal: r.signal ?? null, timedOut: r.error?.code === "ETIMEDOUT", stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** How a `claude mcp` run ended, for a report: exit status, signal, timeout. No output text. */
export const exitOf = (r) => ({ status: r.status, signal: r.signal, timedOut: r.timedOut });

const notFound = (name, r) => r.status === 1 && r.signal === null && !r.timedOut && [r.stdout, r.stderr].some((t) => t.includes(`No MCP server named "${name}"`));

/**
 * `claude mcp get <name>`, parsed. `exists` is true, false (only the CLI's explicit not-found
 * answer) or "unknown" (with `exit`). Only the descriptive fields are kept.
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

/** True when a parsed `get` shows exactly `expected` ({ command, args[] }) as a user-scope stdio server. */
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
