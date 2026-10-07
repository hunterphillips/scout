// Pi has no read-only `mcp get`: inspect its bounded mcp.json, and mutate only through the CLI.
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function piMcpGet(agentDir, name = "scout") {
  let fd;
  try {
    fd = openSync(join(agentDir, "mcp.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 64 * 1024) return { exists: "unknown" };
    const data = JSON.parse(readFileSync(fd, "utf8"));
    if (!data || typeof data !== "object" || !data.mcpServers || typeof data.mcpServers !== "object" || Array.isArray(data.mcpServers)) return { exists: "unknown" };
    const entry = data.mcpServers[name];
    return entry === undefined ? { exists: false } : { exists: true, entry };
  } catch (e) {
    return { exists: e.code === "ENOENT" ? false : "unknown" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function ownsPiRegistration(get, expected) {
  const e = get.entry;
  return get.exists === true && e && typeof e === "object" && !Array.isArray(e) &&
    Object.keys(e).sort().join(",") === "args,command,exposure" && e.command === expected.command &&
    e.exposure === "direct" && Array.isArray(e.args) && e.args.length === expected.args.length &&
    e.args.every((arg, i) => arg === expected.args[i]);
}

export function piRun(piPath, args, { env, cwd, agentDir, timeoutMs = 60_000 }) {
  const r = spawnSync(piPath, args, { env: { ...env, PI_CODING_AGENT_DIR: agentDir }, cwd, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: !r.error && r.status === 0 && !r.signal, status: r.status, signal: r.signal, timedOut: r.error?.code === "ETIMEDOUT" };
}

export function piMcpAdd(piPath, name, expected, opts) {
  return piRun(piPath, ["mcp", "add", name, "--exposure", "direct", "--", expected.command, ...expected.args], opts);
}

export function removeOwnedPiRegistration(piPath, name, expected, opts) {
  const before = piMcpGet(opts.agentDir, name);
  if (before.exists === false) return { state: "absent" };
  if (before.exists === "unknown") return { state: "unknown_state" };
  if (!ownsPiRegistration(before, expected)) return { state: "left_changed" };
  const rm = piRun(piPath, ["mcp", "remove", name], opts);
  if (!rm.ok) return { state: "remove_failed", exit: rm };
  const after = piMcpGet(opts.agentDir, name);
  return { state: after.exists === false ? "removed" : after.exists === "unknown" ? "removal_unverified" : "remove_failed" };
}
