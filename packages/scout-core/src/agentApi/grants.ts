// What an authenticated agent connection may read beyond approved resources. Only the
// browser-context grant exists: `agentBrowserContext` in config.json, set by the user (P2.5
// adds the toggle). It is read on every call and never cached per connection, so turning it
// off reaches connections that are already open, and reconnecting cannot bring it back.
// A job connection never carries it in Phase 2. Scout's window turns it on or off through
// `writeBrowserContextGrant`, which rewrites config.json atomically and keeps every other key.

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AgentStatusCode } from "@scout/contracts";
import { writeFileAtomic } from "../capabilities/atomicWrite.js";
import { readConfig } from "../config.js";
import type { AgentPrincipal } from "./auth.js";

/** The stored grant; an unreadable or malformed config.json counts as not granted. */
export function readBrowserContextGrant(home: string): boolean {
  try {
    return readConfig(home).agentBrowserContext;
  } catch {
    return false;
  }
}

/**
 * Why a browser-context call is refused, or undefined to serve it. `not_granted` comes
 * before `paused`: a caller without the grant learns nothing about Scout's state.
 */
export function browserContextGate(principal: AgentPrincipal, granted: boolean, paused: boolean): AgentStatusCode | undefined {
  if (principal.role !== "interactive" || !granted) return "not_granted";
  if (paused) return "paused";
  return undefined;
}

/** Undoes one grant write: puts the file's previous contents back (atomically) or removes the file it created. */
export interface GrantWrite {
  restore(): void;
}

/**
 * Set `agentBrowserContext` in config.json, keeping every other key as it is. A missing file
 * becomes one holding only the grant. Throws (writing nothing) when the existing file is
 * unreadable or not a JSON object.
 */
export function writeBrowserContextGrant(home: string, enabled: boolean): GrantWrite {
  const path = join(home, "config.json");
  let config: Record<string, unknown> = {};
  let raw: string | null = null;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (raw !== null) {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("config.json is not an object");
    config = parsed as Record<string, unknown>;
  }
  config.agentBrowserContext = enabled;
  writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
  const previous = raw;
  return {
    restore() {
      if (previous !== null) writeFileAtomic(path, previous);
      else unlinkSync(path);
    },
  };
}
