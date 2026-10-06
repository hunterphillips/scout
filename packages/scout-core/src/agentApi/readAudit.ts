// The in-memory record of browser-context reads over agent.sock, for the side panel
// to show what the user's agent looked at. Bounded to the last READ_AUDIT_MAX_ENTRIES and
// never persisted. An entry holds the method, the caller's role, the outcome and at most
// the site origin: never a full URL, title, page text, or token.

import type { AgentMethod, AgentStatusCode } from "@scout/contracts";

export const READ_AUDIT_MAX_ENTRIES = 200;

export interface ReadAuditEntry {
  at: number;
  role: "interactive" | "job";
  method: AgentMethod;
  outcome: "ok" | AgentStatusCode;
  origin?: string;
}

export interface ReadAudit {
  record(entry: ReadAuditEntry): void;
  /** Oldest first; a copy. */
  entries(): ReadAuditEntry[];
}

export function createReadAudit(max: number = READ_AUDIT_MAX_ENTRIES): ReadAudit {
  const ring: ReadAuditEntry[] = [];
  return {
    record(entry) {
      ring.push({ ...entry });
      if (ring.length > max) ring.splice(0, ring.length - max);
    },
    entries: () => ring.map((e) => ({ ...e })),
  };
}
