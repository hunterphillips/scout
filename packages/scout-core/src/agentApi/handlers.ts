// The production answers to agent-protocol requests: a pure backend over the capability
// store, the coordinator's read-only view, and the catalog cache, testable without a socket.
// The reference behaviour is the Phase 1 fixture (`@scout/scout-mcp/fixture`); differences
// are deliberate and listed here:
// - `list_resources` lists every readable version: each resource's approved default and its
//   superseded versions, one entry per version. Pending, declined and revoked never appear.
// - `site_links` reads only the cached catalog of the current permitted site. It never
//   fetches, so no caller can cause a network request or learn about other sites.
// - `recent_activity` is `unavailable` (behind the browser gate) until Phase 3.
//
// Every request is checked against the connection's principal (auth.ts) and, for browser
// context, the stored grant (grants.ts), both re-read on every call. Resource reads re-check
// authorization and revocation on every chunk.
//
// Cursors are opaque random IDs into an in-memory table, bound to this core instance, the
// connection and the token that received them, and the method; they expire after
// AGENT_CURSOR_TTL_MS, and at most MAX_CURSORS live (oldest evicted first). Each pins what it
// pages over: `site_links` the origin and catalog version, `list_resources` the version list
// of the first page (later pages re-check each item, so a page may be short, or empty, and
// still carry `nextCursor`), `read_resource` the resource and version. A revocation
// invalidates the resource's read cursors for good: they keep answering `revoked` until they
// expire.
//
// A multi-chunk read is one read session: its first chunk draws a random pin ID, every
// cursor of the chain carries it, and every chunk with a next cursor pins the version in the
// store under it. The pin is released when the session ends: on the last chunk, on
// revocation, on the connection closing, or once no live cursor of the chain is left
// (expired or evicted). A single-chunk read pins nothing. Expired cursors are swept whenever
// a cursor is issued or presented, and by `sweepExpired`, which main runs before each
// collection so an abandoned read on a quiet connection does not hold its pin.

import { randomBytes } from "node:crypto";
import {
  AGENT_CURSOR_TTL_MS,
  AGENT_PROTOCOL_VERSION,
  AGENT_REQUEST_MAX_BYTES,
  AGENT_RESPONSE_MAX_BYTES,
  AgentRequestIdSchema,
  AgentRequestSchema,
  isHttpsOrigin,
  RESOURCE_CHUNK_MAX_BYTES,
  SiteLinkSchema,
  SOURCE_URL_MAX_CHARS,
  type AgentMethod,
  type AgentParams,
  type AgentResponse,
  type AgentResult,
  type AgentStatusCode,
  type CurrentSiteResult,
  type Resource,
  type ResourceSummary,
  type ResourceVersion,
  type SiteLink,
} from "@scout/contracts";
import type { CapabilityStore } from "../capabilities/store.js";
import type { CatalogCache } from "../catalog/cache.js";
import type { Clock } from "../clock.js";
import type { AgentAuth, AgentPrincipal } from "./auth.js";
import { browserContextGate } from "./grants.js";
import type { ReadAudit } from "./readAudit.js";

export const MAX_CURSORS = 1000;
export const DEFAULT_PAGE = 20;
/** Catalog versions longer than this are not served (the wire allows 128 characters). */
const CATALOG_VERSION_MAX_CHARS = 128;
/** Stands in for a request ID or cursor while sizing a response. */
const PROBE_REQUEST_ID = "x".repeat(64);
const PROBE_CURSOR = "x".repeat(22);

/** What the coordinator lets the agent socket see; built fresh on every call. */
export interface AgentView {
  /** The focused permitted visit, or null. No title: the core does not keep one. */
  currentSite: { origin: string; url: string; visitEpoch: number } | null;
  paused: boolean;
}

/** One agent.sock connection. `principal` is set by an accepted `hello`. */
export interface AgentConnection {
  readonly id: string;
  principal: AgentPrincipal | null;
}

export type AgentStoreReader = Pick<CapabilityStore, "listApproved" | "resolveRead" | "readBlob" | "pinVersion" | "releasePins">;

export interface AgentHandlerOptions {
  coreInstanceId: string;
  auth: Pick<AgentAuth, "verify" | "isCurrent">;
  store: AgentStoreReader;
  view: () => AgentView;
  catalog: Pick<CatalogCache, "load">;
  /** The stored browser-context grant, read on every call. */
  browserContextGranted: () => boolean;
  audit: ReadAudit;
  clock: Clock;
}

export interface AgentHandlers {
  readonly coreInstanceId: string;
  /** Answer one decoded frame on `connection`; an accepted `hello` sets its principal. */
  call(frame: unknown, connection: AgentConnection): AgentResponse;
  /** An error response for a frame that could not be decoded at all. */
  refuse(code: AgentStatusCode): AgentResponse;
  /** The connection closed: drop its cursors and release the pins of its open read sessions. */
  endConnection(connection: AgentConnection): void;
  /** The resource was revoked: its read cursors answer `revoked` from now on. Synchronous and idempotent. */
  dropResource(resourceId: string): void;
  /** Drop every expired cursor and release the pins of the read sessions that left. */
  sweepExpired(): void;
}

interface CursorScope {
  coreInstanceId: string;
  connectionId: string;
  tokenId: string;
  expiresAt: number;
}

interface VersionRef {
  resourceId: string;
  version: string;
}

type CursorState = CursorScope &
  (
    | { method: "site_links"; offset: number; origin: string; catalogVersion: string }
    | { method: "list_resources"; offset: number; entries: readonly VersionRef[] }
    /** `revoked` is set when the resource is revoked; such a cursor only ever answers `revoked`, even after a re-approval. */
    | { method: "read_resource"; resourceId: string; version: string; offset: number; pinId: string; revoked?: true }
  );
type CursorBody = CursorState extends infer S ? (S extends CursorState ? Omit<S, keyof CursorScope> : never) : never;

type Answer<M extends AgentMethod> = { ok: AgentResult<M> } | { error: AgentStatusCode };
const fail = (error: AgentStatusCode) => ({ error });
const byteLength = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");

/** The end of the longest prefix of `bytes[from..from+max)` that ends on a UTF-8 code point boundary. */
export function utf8Cut(bytes: Buffer, from: number, max: number): number {
  let end = Math.min(bytes.length, from + max);
  while (end > from && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return end;
}

/** The site origin a browser-context result was about (`site_links`' origin, `current_site`'s site), if any. */
function auditOrigin(result: AgentResult<AgentMethod>): string | undefined {
  if ("origin" in result) return result.origin;
  if ("site" in result) return result.site?.origin;
  return undefined;
}

const BROWSER_METHODS: ReadonlySet<AgentMethod> = new Set(["current_site", "recent_activity", "site_links"]);

export function createAgentHandlers(options: AgentHandlerOptions): AgentHandlers {
  const { coreInstanceId, store, clock, audit } = options;
  const cursors = new Map<string, CursorState>();

  const envelope = (requestId: string) => ({ protocol: AGENT_PROTOCOL_VERSION, requestId, coreInstanceId });
  const errorResponse = (requestId: string, code: AgentStatusCode): AgentResponse => ({
    ...envelope(requestId),
    status: "error",
    error: { code, message: code },
  });
  const fitsResponse = (result: unknown): boolean =>
    byteLength({ ...envelope(PROBE_REQUEST_ID), status: "ok", result }) <= AGENT_RESPONSE_MAX_BYTES;

  /** Delete the cursors `drop` selects, then release each read session's pin that no remaining cursor carries. */
  function dropCursors(drop: (c: CursorState, id: string) => boolean): void {
    const ended = new Set<string>();
    for (const [k, c] of cursors) {
      if (!drop(c, k)) continue;
      cursors.delete(k);
      if (c.method === "read_resource") ended.add(c.pinId);
    }
    if (ended.size === 0) return;
    for (const c of cursors.values()) if (c.method === "read_resource") ended.delete(c.pinId);
    for (const pinId of ended) store.releasePins(pinId);
  }

  /** Store the new cursor first, so a read session continuing from a cursor swept or evicted here keeps its pin. */
  function issueCursor(conn: AgentConnection, body: CursorBody): string {
    const now = clock.now();
    const id = randomBytes(16).toString("base64url");
    const scope: CursorScope = { coreInstanceId, connectionId: conn.id, tokenId: conn.principal!.tokenId, expiresAt: now + AGENT_CURSOR_TTL_MS };
    cursors.set(id, { ...body, ...scope } as CursorState);
    dropCursors((c) => c.expiresAt <= now);
    if (cursors.size > MAX_CURSORS) {
      // Oldest first; the new cursor is last in insertion order.
      const evicted = new Set([...cursors.keys()].slice(0, cursors.size - MAX_CURSORS));
      dropCursors((_c, k) => evicted.has(k));
    }
    return id;
  }

  /** The cursor if it was issued by this core to this connection and token for `method` and is unexpired. */
  function takeCursor<K extends CursorState["method"]>(id: string, method: K, conn: AgentConnection): Extract<CursorState, { method: K }> | undefined {
    const c = cursors.get(id);
    if (c && c.expiresAt <= clock.now()) {
      dropCursors((_c, k) => k === id);
      return undefined;
    }
    if (!c || c.method !== method) return undefined;
    if (c.coreInstanceId !== coreInstanceId || c.connectionId !== conn.id || c.tokenId !== conn.principal?.tokenId) return undefined;
    return c as Extract<CursorState, { method: K }>;
  }

  /** Largest page of `items[start..]` (at most `limit`) whose response fits the cap. */
  function page<T, M extends AgentMethod>(
    items: readonly T[],
    start: number,
    limit: number,
    build: (slice: T[], nextCursor: (() => string) | undefined) => AgentResult<M>,
    cursorFor: (offset: number) => string,
  ): Answer<M> {
    if (start > items.length) return fail("expired_snapshot");
    for (let n = Math.min(limit, items.length - start); n >= 0; n--) {
      const end = start + n;
      const more = end < items.length;
      if (!fitsResponse(build(items.slice(start, end), more ? () => PROBE_CURSOR : undefined))) continue;
      if (n === 0 && more) return fail("limit_exceeded");
      return { ok: build(items.slice(start, end), more ? () => cursorFor(end) : undefined) };
    }
    return fail("limit_exceeded");
  }

  const withCursor = <T extends object>(o: T, next: (() => string) | undefined) => (next ? { ...o, nextCursor: next() } : o);

  const identity = (r: Resource, v: ResourceVersion, approval: "approved" | "superseded") => ({
    resourceId: r.id,
    kind: r.kind,
    siteOrigin: r.siteOrigin,
    publisherOrigin: r.publisherOrigin,
    sourceUrl: r.sourceUrl,
    version: v.hash,
    approval,
  });

  const gate = (conn: AgentConnection): AgentStatusCode | undefined =>
    browserContextGate(conn.principal!, options.browserContextGranted(), options.view().paused);

  /** The current site if it is one the wire can carry; never a placeholder. */
  function currentSite(): CurrentSiteResult["site"] {
    const site = options.view().currentSite;
    if (!site || !isHttpsOrigin(site.origin) || site.url.length > SOURCE_URL_MAX_CHARS) return null;
    return { origin: site.origin, url: site.url, visitEpoch: site.visitEpoch };
  }

  /** The cached catalog of `origin` as site links, or null when there is none to serve. */
  function cachedLinks(origin: string): { catalogVersion: string; links: SiteLink[] } | null {
    const file = options.catalog.load(origin);
    if (!file || file.catalog.origin !== origin) return null;
    const version = file.catalog.version;
    if (version.length === 0 || version.length > CATALOG_VERSION_MAX_CHARS) return null;
    const links = file.catalog.candidates.flatMap((c): SiteLink[] => {
      const link = { id: c.id, href: c.humanHref ?? c.sourceUrl, title: c.title, ...(c.description !== undefined ? { description: c.description } : {}) };
      return SiteLinkSchema.safeParse(link).success ? [link] : [];
    });
    return { catalogVersion: version, links };
  }

  type Handler<M extends AgentMethod> = (p: AgentParams<M>, conn: AgentConnection) => Answer<M>;
  const handlers: { [M in Exclude<AgentMethod, "hello">]: Handler<M> } = {
    current_site: (_p, conn) => {
      const refused = gate(conn);
      return refused ? fail(refused) : { ok: { site: currentSite() } };
    },

    recent_activity: (_p, conn) => fail(gate(conn) ?? "unavailable"),

    site_links: (p, conn) => {
      const refused = gate(conn);
      if (refused) return fail(refused);
      const site = currentSite();
      let start = 0;
      if (p.cursor !== undefined) {
        const c = takeCursor(p.cursor, "site_links", conn);
        if (!c || site?.origin !== c.origin) return fail("expired_snapshot");
        // The catalog changed since the first page: the listing is stale.
        if (cachedLinks(c.origin)?.catalogVersion !== c.catalogVersion) return fail("expired_snapshot");
        start = c.offset;
      }
      if (!site) return fail("not_found");
      const cached = cachedLinks(site.origin);
      if (!cached) return fail("not_found");
      const { catalogVersion, links } = cached;
      return page<SiteLink, "site_links">(
        links,
        start,
        p.limit ?? DEFAULT_PAGE,
        (slice, next) => withCursor({ origin: site.origin, catalogVersion, total: links.length, links: slice }, next),
        (offset) => issueCursor(conn, { method: "site_links", offset, origin: site.origin, catalogVersion }),
      );
    },

    list_resources: (p, conn) => {
      let start = 0;
      let entries: readonly VersionRef[];
      if (p.cursor !== undefined) {
        const c = takeCursor(p.cursor, "list_resources", conn);
        if (!c) return fail("expired_snapshot");
        start = c.offset;
        entries = c.entries;
      } else {
        entries = store.listApproved(p.origin).flatMap((l) => [
          { resourceId: l.resource.id, version: l.version.hash },
          ...l.superseded.map((v) => ({ resourceId: l.resource.id, version: v.hash })),
        ]);
      }
      return page<VersionRef, "list_resources">(
        entries,
        start,
        p.limit ?? DEFAULT_PAGE,
        (slice, next) =>
          withCursor(
            {
              // Re-checked per page: a version no longer readable since the snapshot is left out.
              resources: slice.flatMap((e): ResourceSummary[] => {
                const r = store.resolveRead(e.resourceId, e.version);
                if (!r.ok) return [];
                return [{ ...identity(r.resource, r.version, r.approval), totalBytes: r.version.byteLength, approvedAt: r.version.decision?.at ?? 0 }];
              }),
            },
            next,
          ),
        (offset) => issueCursor(conn, { method: "list_resources", offset, entries }),
      );
    },

    read_resource: (p, conn) => {
      let version = p.version;
      let offset = 0;
      let pinId: string | undefined;
      if (p.cursor !== undefined) {
        const c = takeCursor(p.cursor, "read_resource", conn);
        if (!c) return fail("expired_snapshot");
        if (c.resourceId !== p.resourceId || (version !== undefined && version !== c.version)) return fail("not_found");
        if (c.revoked) return fail("revoked");
        version = c.version;
        offset = c.offset;
        pinId = c.pinId;
      }
      // Checked on every chunk, so a revocation mid-read stops the next chunk.
      const resolved = store.resolveRead(p.resourceId, version);
      if (!resolved.ok) return fail(resolved.code);
      const { resource: r, version: v, approval } = resolved;
      let bytes: Buffer;
      try {
        bytes = store.readBlob(v.blobRef);
      } catch {
        return fail("unavailable");
      }
      if (offset > bytes.length) return fail("expired_snapshot");
      // Shrink the chunk until the whole response fits (escaping can grow text up to 6x).
      let max = RESOURCE_CHUNK_MAX_BYTES;
      for (;;) {
        const end = utf8Cut(bytes, offset, max);
        const more = end < bytes.length;
        const result = { ...identity(r, v, approval), offset, totalBytes: bytes.length, text: bytes.subarray(offset, end).toString("utf8") };
        if (fitsResponse(more ? { ...result, nextCursor: PROBE_CURSOR } : result)) {
          if (!more) {
            // The read session is over: its bytes are all served.
            if (pinId !== undefined) store.releasePins(pinId);
            return { ok: result };
          }
          // Keep the version from collection while the read session may still need it.
          pinId ??= randomBytes(16).toString("base64url");
          const pinned = store.pinVersion(pinId, r.id, v.hash);
          if (!pinned.ok) return fail(pinned.code);
          return { ok: { ...result, nextCursor: issueCursor(conn, { method: "read_resource", resourceId: r.id, version: v.hash, offset: end, pinId }) } };
        }
        if (end === offset) return fail("limit_exceeded");
        max = Math.floor((end - offset) / 2);
      }
    },
  };

  function answer(requestId: string, a: Answer<AgentMethod>): AgentResponse {
    if ("error" in a) return errorResponse(requestId, a.error);
    const res: AgentResponse = { ...envelope(requestId), status: "ok", result: a.ok };
    return byteLength(res) <= AGENT_RESPONSE_MAX_BYTES ? res : errorResponse(requestId, "limit_exceeded");
  }

  return {
    coreInstanceId,
    refuse: (code) => errorResponse("invalid", code),
    call(frame, conn) {
      const rid = (frame as { requestId?: unknown } | null)?.requestId;
      const requestId = AgentRequestIdSchema.safeParse(rid).success ? (rid as string) : "invalid";
      if (byteLength(frame) > AGENT_REQUEST_MAX_BYTES) return errorResponse(requestId, "limit_exceeded");
      const parsed = AgentRequestSchema.safeParse(frame);
      if (!parsed.success || parsed.data.protocol !== AGENT_PROTOCOL_VERSION) return errorResponse(requestId, "protocol_mismatch");
      const request = parsed.data;

      if (request.method === "hello") {
        if (conn.principal !== null) return errorResponse(requestId, "protocol_mismatch");
        const principal = options.auth.verify(request.params.token);
        if (!principal) return errorResponse(requestId, "not_granted");
        conn.principal = principal;
        return answer(requestId, { ok: { role: principal.role } });
      }
      // A revoked token loses access on its next call, on every connection it opened.
      if (conn.principal === null || !options.auth.isCurrent(conn.principal)) return errorResponse(requestId, "not_granted");

      const handler = handlers[request.method] as Handler<AgentMethod>;
      const result = answer(requestId, handler(request.params as AgentParams<AgentMethod>, conn));
      if (BROWSER_METHODS.has(request.method)) {
        const origin = result.status === "ok" ? auditOrigin(result.result) : undefined;
        audit.record({
          at: clock.now(),
          role: conn.principal.role,
          method: request.method,
          outcome: result.status === "ok" ? "ok" : result.error.code,
          ...(origin !== undefined ? { origin } : {}),
        });
      }
      return result;
    },
    endConnection(conn) {
      dropCursors((c) => c.connectionId === conn.id);
    },
    dropResource(resourceId) {
      for (const c of cursors.values()) {
        if (c.method !== "read_resource" || c.resourceId !== resourceId) continue;
        c.revoked = true;
        store.releasePins(c.pinId);
      }
    },
    sweepExpired() {
      const now = clock.now();
      dropCursors((c) => c.expiresAt <= now);
    },
  };
}
