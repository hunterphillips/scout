// What an authenticated agent connection may read beyond approved resources. Only the
// browser-context grant exists: `agentBrowserContext` in config.json, set by the user (P2.5
// adds the toggle). It is read on every call and never cached per connection, so turning it
// off reaches connections that are already open, and reconnecting cannot bring it back.
// A job connection never carries it in Phase 2.

import type { AgentStatusCode } from "@scout/contracts";
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
