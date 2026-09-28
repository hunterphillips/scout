// Scout native host: filesystem configuration.
//
// Where the host finds its config and core socket, and the ownership/mode check
// it runs on the core's runtime directory before every connect attempt.

import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The ~/.scout root, overridable with SCOUT_HOME. */
export function scoutHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.SCOUT_HOME || join(homedir(), ".scout");
}

/** <scoutHome>/run/core.sock: the core's Unix socket. */
export function coreSocketPath(home: string): string {
  return join(home, "run", "core.sock");
}

/** Reads `extensionId` from <scoutHome>/config.json; undefined when missing or malformed. */
export function readExtensionId(home: string): string | undefined {
  try {
    const cfg: unknown = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    if (cfg !== null && typeof cfg === "object" && "extensionId" in cfg) {
      const id = (cfg as { extensionId: unknown }).extensionId;
      if (typeof id === "string") return id;
    }
  } catch {
    // missing or unreadable config: the host refuses the caller
  }
  return undefined;
}

export type RuntimeRefusal =
  | "runtime-dir-not-directory"
  | "runtime-dir-wrong-owner"
  | "runtime-dir-not-private"
  | "socket-not-socket"
  | "socket-wrong-owner"
  | "socket-not-private";

/**
 * Result of checking the core's runtime dir and socket:
 * - `ok`: both exist and are private to us; connect.
 * - `missing`: the dir or socket does not exist yet; treat like ENOENT and retry.
 * - `refused`: something exists but is not ours or not private; never connect.
 */
export type RuntimeCheck = { status: "ok" } | { status: "missing" } | { status: "refused"; reason: RuntimeRefusal };

/**
 * Checks the socket's parent dir (real directory, owned by us, mode 0700) and the
 * socket itself (real socket, owned by us, no group/other bits). Ported from the
 * Phase 0 bridge spike's checkPrivateRuntimeDir / checkOwnSocket. Read-only: it
 * never creates, chmods, or removes anything.
 */
export function checkRuntimeDir(socketPath: string, uid: number = process.getuid?.() ?? -1): RuntimeCheck {
  const refuse = (reason: RuntimeRefusal): RuntimeCheck => ({ status: "refused", reason });

  let dir;
  try {
    dir = lstatSync(dirname(socketPath));
  } catch {
    return { status: "missing" };
  }
  if (dir.isSymbolicLink() || !dir.isDirectory()) return refuse("runtime-dir-not-directory");
  if (dir.uid !== uid) return refuse("runtime-dir-wrong-owner");
  if ((dir.mode & 0o777) !== 0o700) return refuse("runtime-dir-not-private");

  let sock;
  try {
    sock = lstatSync(socketPath);
  } catch {
    return { status: "missing" };
  }
  if (!sock.isSocket()) return refuse("socket-not-socket");
  if (sock.uid !== uid) return refuse("socket-wrong-owner");
  if ((sock.mode & 0o077) !== 0) return refuse("socket-not-private");
  return { status: "ok" };
}
