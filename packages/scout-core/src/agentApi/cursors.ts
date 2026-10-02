// The agent API's paging cursors: opaque random IDs into an in-memory table, bound to this
// core instance, the connection and the token that received them, and the method. They
// expire after AGENT_CURSOR_TTL_MS. Each pins what it pages over: `recent_activity` the
// snapshot id or the store revision, `site_links` the origin and catalog version,
// `list_resources` the version list of the first page, `read_resource` the resource and
// version. A revocation invalidates the resource's read cursors for good: they keep
// answering `revoked` until they expire.
//
// Caps: each job token holds at most MAX_JOB_CURSORS (its own oldest go first), and the
// table at most MAX_CURSORS. Past that, job cursors are evicted before the interactive
// connection's (oldest first), so a job adapter cannot push out the interactive
// connection's cursors; the interactive token's cap is the table's. The cursor just issued
// is never the one evicted.
//
// A multi-chunk read is one read session: every cursor of the chain carries its pin ID. The
// pin is released once no live cursor of the chain is left (expired, evicted, or its
// connection closed), on revocation, and by the handlers on the last chunk. Expired cursors
// are swept whenever a cursor is issued or presented, and by `sweepExpired`.

import { randomBytes } from "node:crypto";
import { AGENT_CURSOR_TTL_MS } from "@scout/contracts";
import type { Clock } from "../clock.js";
import type { AgentPrincipal } from "./auth.js";

/** The most cursors live at once, across every connection. */
export const MAX_CURSORS = 1000;
/** The most cursors one job token holds at once. */
export const MAX_JOB_CURSORS = 256;

export interface VersionRef {
  resourceId: string;
  version: string;
}

interface CursorScope {
  coreInstanceId: string;
  connectionId: string;
  tokenId: string;
  role: AgentPrincipal["role"];
  expiresAt: number;
}

export type CursorState = CursorScope &
  (
    /** `pin` is `snap:<id>` for a job's snapshot or `rev:<n>` for the live store's revision. */
    | { method: "recent_activity"; offset: number; pin: string }
    | { method: "site_links"; offset: number; origin: string; catalogVersion: string }
    | { method: "list_resources"; offset: number; entries: readonly VersionRef[] }
    /** `revoked` is set when the resource is revoked; such a cursor only ever answers `revoked`, even after a re-approval. */
    | { method: "read_resource"; resourceId: string; version: string; offset: number; pinId: string; revoked?: true }
  );
export type CursorBody = CursorState extends infer S ? (S extends CursorState ? Omit<S, keyof CursorScope> : never) : never;

/** Who a cursor is issued to: an authenticated agent connection. */
export interface CursorOwner {
  readonly id: string;
  readonly principal: Pick<AgentPrincipal, "role" | "tokenId"> | null;
}

export interface CursorTable {
  /** A new cursor for `owner`. Stored first, so a read session continuing from a cursor swept or evicted here keeps its pin. */
  issueCursor(owner: CursorOwner, body: CursorBody): string;
  /** The cursor if it was issued by this core to this connection and token for `method` and is unexpired. */
  takeCursor<K extends CursorState["method"]>(id: string, method: K, owner: CursorOwner): Extract<CursorState, { method: K }> | undefined;
  /** Delete the cursors `drop` selects, then release each read session's pin that no remaining cursor carries. */
  dropCursors(drop: (c: CursorState, id: string) => boolean): void;
  /** The resource was revoked: its read cursors answer `revoked` from now on, and their pins are released. */
  revokeResource(resourceId: string): void;
  /** Drop every expired cursor and release the pins of the read sessions that left. */
  sweepExpired(): void;
}

export function createCursorTable(options: { coreInstanceId: string; clock: Clock; releasePins: (pinId: string) => void }): CursorTable {
  const { coreInstanceId, clock, releasePins } = options;
  const cursors = new Map<string, CursorState>();

  function dropCursors(drop: (c: CursorState, id: string) => boolean): void {
    const ended = new Set<string>();
    for (const [k, c] of cursors) {
      if (!drop(c, k)) continue;
      cursors.delete(k);
      if (c.method === "read_resource") ended.add(c.pinId);
    }
    if (ended.size === 0) return;
    for (const c of cursors.values()) if (c.method === "read_resource") ended.delete(c.pinId);
    for (const pinId of ended) releasePins(pinId);
  }

  /** Keys to evict so the table fits its caps, oldest first, never `issued`. */
  function overCap(issued: string, tokenId: string, role: AgentPrincipal["role"]): Set<string> {
    const evicted = new Set<string>();
    // Insertion order is age order.
    const keys = [...cursors.keys()].filter((k) => k !== issued);
    if (role === "job") {
      const own = keys.filter((k) => cursors.get(k)!.tokenId === tokenId);
      for (const k of own.slice(0, Math.max(0, own.length + 1 - MAX_JOB_CURSORS))) evicted.add(k);
    }
    let excess = cursors.size - evicted.size - MAX_CURSORS;
    if (excess <= 0) return evicted;
    const rest = keys.filter((k) => !evicted.has(k));
    const byJobsFirst = [...rest.filter((k) => cursors.get(k)!.role === "job"), ...rest.filter((k) => cursors.get(k)!.role !== "job")];
    for (const k of byJobsFirst) {
      if (excess-- <= 0) break;
      evicted.add(k);
    }
    return evicted;
  }

  return {
    issueCursor(owner, body) {
      const now = clock.now();
      const id = randomBytes(16).toString("base64url");
      const { tokenId, role } = owner.principal!;
      const scope: CursorScope = { coreInstanceId, connectionId: owner.id, tokenId, role, expiresAt: now + AGENT_CURSOR_TTL_MS };
      cursors.set(id, { ...body, ...scope } as CursorState);
      dropCursors((c) => c.expiresAt <= now);
      const evicted = overCap(id, tokenId, role);
      if (evicted.size > 0) dropCursors((_c, k) => evicted.has(k));
      return id;
    },
    takeCursor<K extends CursorState["method"]>(id: string, method: K, owner: CursorOwner) {
      const c = cursors.get(id);
      if (c && c.expiresAt <= clock.now()) {
        dropCursors((_c, k) => k === id);
        return undefined;
      }
      if (!c || c.method !== method) return undefined;
      if (c.coreInstanceId !== coreInstanceId || c.connectionId !== owner.id || c.tokenId !== owner.principal?.tokenId) return undefined;
      return c as Extract<CursorState, { method: K }>;
    },
    dropCursors,
    revokeResource(resourceId) {
      for (const c of cursors.values()) {
        if (c.method !== "read_resource" || c.resourceId !== resourceId) continue;
        c.revoked = true;
        releasePins(c.pinId);
      }
    },
    sweepExpired() {
      const now = clock.now();
      dropCursors((c) => c.expiresAt <= now);
    },
  };
}
