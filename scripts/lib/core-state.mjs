// Read-only views of the running core's files under SCOUT_HOME, for doctor and uninstall.
// Nothing here connects to a socket, starts a process, or writes.
//
// The core holds `capabilities/store.lock` ({pid, instanceId, startedAt}; scout-core
// capabilities/storeLock.ts) for its lifetime, so a lock whose pid is alive means Scout is
// running. A pid we may not signal (EPERM) is not ours, which the core itself treats as stale.

import { lstatSync, readFileSync } from "node:fs";

/** { state: "absent" | "running" | "stale" | "unreadable", pid? } for the store lock. */
export function coreLockHolder(L, { probe = (pid) => process.kill(pid, 0) } = {}) {
  let text;
  try {
    text = readFileSync(L.storeLock, "utf8");
  } catch (e) {
    return { state: e?.code === "ENOENT" ? "absent" : "unreadable" };
  }
  let pid;
  try {
    pid = JSON.parse(text)?.pid;
  } catch {
    return { state: "unreadable" };
  }
  if (!Number.isInteger(pid) || pid <= 0) return { state: "unreadable" };
  try {
    probe(pid);
    return { state: "running", pid };
  } catch {
    return { state: "stale", pid };
  }
}

/**
 * A socket or private file's ownership and mode: { state: "absent" | "ok" | "bad", detail }.
 * `kind` is "socket" or "file"; `mode` the exact mode expected.
 */
export function inspectPrivate(path, kind, mode) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { state: "absent", detail: `${path} absent` };
  }
  const isKind = kind === "socket" ? st.isSocket() : st.isFile();
  const m = (st.mode & 0o777).toString(8).padStart(4, "0");
  const ok = isKind && st.uid === process.getuid() && (st.mode & 0o777) === mode;
  return { state: ok ? "ok" : "bad", detail: `${path} ${isKind ? kind : `not a ${kind}`} ${m} uid=${st.uid}` };
}

/**
 * The last `agent_preflight` diagnostics event the core logged ({ verdict, cliVersion?, t }),
 * or null. Reads at most the log's last 1 MiB; never runs a preflight.
 */
export function lastPreflight(logPath, { maxBytes = 1024 * 1024 } = {}) {
  let text;
  try {
    const buf = readFileSync(logPath);
    text = buf.subarray(Math.max(0, buf.length - maxBytes)).toString("utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"agent_preflight"')) continue;
    try {
      const e = JSON.parse(lines[i]);
      if (e?.event === "agent_preflight" && typeof e.verdict === "string") return { verdict: e.verdict, t: e.t, ...(typeof e.cliVersion === "string" ? { cliVersion: e.cliVersion } : {}) };
    } catch {
      // a torn line
    }
  }
  return null;
}
