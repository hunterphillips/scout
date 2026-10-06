// Executable lookup without a shell: whether a path is runnable, a PATH search, and a PATH search
// with fallback locations. An app started from Finder or at login gets launchd's minimal PATH, so
// each adapter lists where its CLI usually lives (agents/<adapter>/profile.ts); nothing here names
// an agent or a location.

import { accessSync, constants as fsc, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** An environment as a child process gets it. */
export type Env = Readonly<Record<string, string | undefined>>;

/** Resolve a command to an absolute executable path from a PATH value. No config writes. */
export function resolveOnPath(cmd: string, pathValue: string | undefined): string | undefined {
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, cmd);
    try {
      if (statSync(p).isFile()) {
        accessSync(p, fsc.X_OK);
        return p;
      }
    } catch {
      // not here
    }
  }
  return undefined;
}

/** Whether `p` is an existing file the current user may execute. */
export function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsc.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Version directories `versionedBins` looks at, newest first. */
export const VERSIONED_BINS_MAX = 16;

/**
 * `<root>/<version>/bin/<cmd>` for the newest (by numeric-aware name) VERSIONED_BINS_MAX entries
 * of `root`, a version manager's install root such as nvm's. A plain directory listing, no shell
 * and no glob; an unreadable or relative root lists nothing. Candidates only: the caller checks
 * each one.
 */
export function versionedBins(root: string, cmd: string, max = VERSIONED_BINS_MAX): string[] {
  if (!isAbsolute(root)) return [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => n !== "" && !n.startsWith(".") && !n.includes("/"))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
    .slice(0, max)
    .map((n) => join(root, n, "bin", cmd));
}

/** Search options for an adapter's executable lookup (tests pin the system locations). */
export interface ExecutableSearch {
  /** Absolute system directories searched after PATH; default: the adapter's own list. */
  systemDirs?: readonly string[];
}

/**
 * The first executable `cmd` on PATH, else the first of `fallbacks` (absolute paths only) that is
 * an existing file the current user may execute. No shell; same checks as `resolveOnPath`.
 */
export function resolveExecutable(cmd: string, pathValue: string | undefined, fallbacks: readonly string[]): string | undefined {
  return resolveOnPath(cmd, pathValue) ?? fallbacks.find((p) => isAbsolute(p) && isExecutableFile(p));
}

/** `env.HOME` when it is an absolute path, else undefined (never os.homedir(): the lookup reads only the env it is given). */
export function homeOf(env: Env): string | undefined {
  const h = env["HOME"];
  return h !== undefined && isAbsolute(h) ? h : undefined;
}
