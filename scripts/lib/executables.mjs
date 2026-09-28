// Scout setup: resolve `node` and `claude` to absolute paths once, at setup time.

import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/** True when `p` is an absolute path to a regular file we can execute. */
export function isExecutableFile(p) {
  if (typeof p !== "string" || !isAbsolute(p)) return false;
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First executable `name` on a PATH string, or null. Relative PATH entries are skipped. */
export function findOnPath(name, pathVar = process.env.PATH ?? "") {
  for (const dir of pathVar.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export function defaultClaudeFallbacks(env = process.env) {
  return [join(env.HOME || homedir(), ".local", "bin", "claude"), "/opt/homebrew/bin/claude"];
}

/** `claude` via PATH, then the fallbacks; null when none is executable. */
export function resolveClaude({ pathVar = process.env.PATH ?? "", fallbacks = defaultClaudeFallbacks() } = {}) {
  return findOnPath("claude", pathVar) ?? fallbacks.find(isExecutableFile) ?? null;
}

/** The node running this script. */
export function resolveNode() {
  return process.execPath;
}
