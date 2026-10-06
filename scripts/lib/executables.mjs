// Scout setup: resolve `node` and the agent CLIs (`claude`, `codex`) to absolute paths once, at
// setup time.

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

/** The usual install places for an agent CLI `name`, searched after PATH. */
export function defaultAgentFallbacks(name, env = process.env) {
  return [join(env.HOME || homedir(), ".local", "bin", name), `/opt/homebrew/bin/${name}`];
}

export function defaultClaudeFallbacks(env = process.env) {
  return defaultAgentFallbacks("claude", env);
}

/** `name` via PATH, then the fallbacks; null when none is executable. */
export function resolveAgentBinary(name, { pathVar = process.env.PATH ?? "", fallbacks = defaultAgentFallbacks(name) } = {}) {
  return findOnPath(name, pathVar) ?? fallbacks.find(isExecutableFile) ?? null;
}

/** `claude` via PATH, then the fallbacks; null when none is executable. */
export function resolveClaude({ pathVar = process.env.PATH ?? "", fallbacks = defaultClaudeFallbacks() } = {}) {
  return resolveAgentBinary("claude", { pathVar, fallbacks });
}

/** The node running this script. */
export function resolveNode() {
  return process.execPath;
}
