// The Phase 1 in-memory backend. It answers the same requests with the same responses the
// Phase 2 core will, so tests and compatibility checks prove the wire interface without a
// production backend. It also serves `recent_activity`, which the product backend reports
// `unavailable` until Phase 3; that is fixture data, never history.
//
// Paging cursors pin what they page over, as the core's must:
// - `recent_activity`: the activity revision; any change to the window expires the cursor.
// - `site_links`: the origin and catalog version; a site or catalog change expires it.
// - `list_resources`: the resource IDs listed when the first page was served. Later pages
//   walk that snapshot, so an approval or revocation mid-listing neither skips nor repeats
//   an item; a resource no longer listable when its page is served is left out.
// - `read_resource`: the resource and version.
// A cursor whose offset is past the end of what it pins is `expired_snapshot`.

import { createHash, randomBytes } from "node:crypto";
import {
  AGENT_CURSOR_TTL_MS,
  AGENT_PROTOCOL_VERSION,
  AGENT_REQUEST_MAX_BYTES,
  AGENT_RESPONSE_MAX_BYTES,
  AgentRequestIdSchema,
  AgentRequestSchema,
  deriveResourceId,
  RECENT_ACTIVITY_MAX_LIMIT,
  RESOURCE_CHUNK_MAX_BYTES,
  ResourceSchema,
  type ActivityEntry,
  type AgentMethod,
  type AgentParams,
  type AgentRequestOf,
  type AgentResponse,
  type AgentResult,
  type AgentStatusCode,
  type CurrentSiteResult,
  type ResourceKind,
  type ResourceVersionState,
  type SiteLink,
} from "@scout/contracts";
import { BackendError, type ScoutAgentBackend } from "./client.js";

const byteLength = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");

export interface FixtureVersionSeed {
  text: string;
  state: ResourceVersionState;
  fetchedAt?: number;
  /** When the decision was made; ignored for pending versions. */
  decidedAt?: number;
}

export interface FixtureResourceSeed {
  kind: ResourceKind;
  siteOrigin: string;
  /** Canonical https URL. */
  sourceUrl: string;
  versions: FixtureVersionSeed[];
}

export interface FixtureSiteLinks {
  origin: string;
  catalogVersion: string;
  links: SiteLink[];
}

export interface FixtureSeed {
  coreInstanceId?: string;
  /** The token `hello` accepts. Unset, every `hello` is refused. */
  token?: string;
  /** The connection's browser-context grant. Off unless set, as in the product. */
  browserContextGranted?: boolean;
  paused?: boolean;
  currentSite?: CurrentSiteResult["site"];
  activity?: ActivityEntry[];
  siteLinks?: FixtureSiteLinks;
  resources?: FixtureResourceSeed[];
  now?: () => number;
}

export interface FixtureBackend extends ScoutAgentBackend {
  readonly coreInstanceId: string;
  /** Resource IDs in seed order. */
  readonly resourceIds: readonly string[];
  /** Version hashes of one resource, in seed order. */
  versionHashes(resourceId: string): string[];
  setBrowserContextGrant(granted: boolean): void;
  setPaused(paused: boolean): void;
  setCurrentSite(site: CurrentSiteResult["site"]): void;
  /** Replace the recent-activity window; bumps the activity revision. */
  setActivity(entries: ActivityEntry[]): void;
  /** Replace the cached catalog for the current site. */
  setSiteLinks(links: FixtureSiteLinks | undefined): void;
  /** Revoke the resource: it becomes blocked and every approved version revoked. */
  revoke(resourceId: string): void;
  /** Simulate the core being down: every call rejects with `unavailable`. */
  setOnline(online: boolean): void;
}

interface FixtureVersion {
  hash: string;
  bytes: Buffer;
  state: ResourceVersionState;
  fetchedAt: number;
  decidedAt: number;
}

interface FixtureResource {
  id: string;
  kind: ResourceKind;
  siteOrigin: string;
  publisherOrigin: string;
  sourceUrl: string;
  blocked: boolean;
  versions: FixtureVersion[];
}

type CursorState =
  | { method: "recent_activity"; offset: number; revision: number; expiresAt: number }
  | { method: "site_links"; offset: number; origin: string; catalogVersion: string; expiresAt: number }
  | { method: "list_resources"; offset: number; ids: readonly string[]; expiresAt: number }
  | { method: "read_resource"; resourceId: string; version: string; offset: number; expiresAt: number };

const MAX_CURSORS = 1000;
const DEFAULT_PAGE = 20;

/** The end of the longest prefix of `bytes[from..from+max)` that ends on a UTF-8 code point boundary. */
function utf8Cut(bytes: Buffer, from: number, max: number): number {
  let end = Math.min(bytes.length, from + max);
  while (end > from && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return end;
}

export async function createFixtureBackend(seed: FixtureSeed = {}): Promise<FixtureBackend> {
  const now = seed.now ?? (() => Date.now());
  const coreInstanceId = seed.coreInstanceId ?? randomBytes(8).toString("hex");
  let granted = seed.browserContextGranted ?? false;
  let paused = seed.paused ?? false;
  let online = true;
  let currentSite = seed.currentSite ?? null;
  let activity = seed.activity ?? [];
  let activityRevision = 0;
  let siteLinks = seed.siteLinks;
  const cursors = new Map<string, CursorState>();

  const resources: FixtureResource[] = [];
  for (const r of seed.resources ?? []) {
    const id = await deriveResourceId(r.kind, r.sourceUrl);
    const versions = r.versions.map((v, i): FixtureVersion => {
      // Fixture-only hash; the store defines the real content-hash input in P2.3.
      const hash = createHash("sha256").update(`${r.kind}\n${r.sourceUrl}\n${v.text}`).digest("hex");
      return { hash, bytes: Buffer.from(v.text, "utf8"), state: v.state, fetchedAt: v.fetchedAt ?? i, decidedAt: v.decidedAt ?? i };
    });
    const res: FixtureResource = {
      id, kind: r.kind, siteOrigin: r.siteOrigin, publisherOrigin: new URL(r.sourceUrl).origin, sourceUrl: r.sourceUrl, blocked: false, versions,
    };
    // The seed must be a valid stored resource.
    ResourceSchema.parse(toStored(res));
    resources.push(res);
  }

  function toStored(r: FixtureResource) {
    const def = defaultVersion(r);
    return {
      id: r.id, kind: r.kind, siteOrigin: r.siteOrigin, publisherOrigin: r.publisherOrigin, sourceUrl: r.sourceUrl, blocked: r.blocked,
      ...(def ? { defaultVersion: def.hash } : {}),
      versions: r.versions.map((v) => ({
        hash: v.hash, blobRef: createHash("sha256").update(v.bytes).digest("hex"), byteLength: v.bytes.length, fetchedAt: v.fetchedAt, state: v.state,
        ...(v.state === "pending" ? {} : { decision: { actor: "user" as const, at: v.decidedAt } }),
      })),
    };
  }

  function defaultVersion(r: FixtureResource): FixtureVersion | undefined {
    if (r.blocked) return undefined;
    return r.versions.findLast((v) => v.state === "approved");
  }

  function issueCursor(state: CursorState): string {
    for (const [k, c] of cursors) if (c.expiresAt <= now()) cursors.delete(k);
    while (cursors.size >= MAX_CURSORS) cursors.delete(cursors.keys().next().value!);
    const id = randomBytes(16).toString("base64url");
    cursors.set(id, state);
    return id;
  }

  function takeCursor<K extends CursorState["method"]>(id: string, method: K): Extract<CursorState, { method: K }> | undefined {
    const c = cursors.get(id);
    if (!c || c.method !== method || c.expiresAt <= now()) return undefined;
    return c as Extract<CursorState, { method: K }>;
  }

  type Answer<M extends AgentMethod> = { ok: AgentResult<M> } | { error: AgentStatusCode };
  const fail = (error: AgentStatusCode) => ({ error });

  /** Largest page of `items[start..]` (at most `limit`) whose response fits the cap. */
  function page<T, M extends AgentMethod>(
    items: readonly T[],
    start: number,
    limit: number,
    build: (slice: T[], nextCursor: (() => string) | undefined) => AgentResult<M>,
    cursorFor: (offset: number) => CursorState,
  ): Answer<M> {
    if (start > items.length) return fail("expired_snapshot");
    let n = Math.min(limit, items.length - start);
    for (; n >= 0; n--) {
      const end = start + n;
      const more = end < items.length;
      const probe = build(items.slice(start, end), more ? () => "x".repeat(22) : undefined);
      if (byteLength(envelopeOk(probe)) > AGENT_RESPONSE_MAX_BYTES) continue;
      if (n === 0 && more) return fail("limit_exceeded");
      return { ok: build(items.slice(start, end), more ? () => issueCursor(cursorFor(end)) : undefined) };
    }
    return fail("limit_exceeded");
  }

  const envelopeOk = (result: unknown) => ({ protocol: AGENT_PROTOCOL_VERSION, requestId: "x".repeat(64), coreInstanceId, status: "ok", result });
  const expires = () => now() + AGENT_CURSOR_TTL_MS;
  const withCursor = <T extends object>(o: T, next: (() => string) | undefined) => (next ? { ...o, nextCursor: next() } : o);

  function browserGate(): AgentStatusCode | undefined {
    if (!granted) return "not_granted";
    if (paused) return "paused";
    return undefined;
  }

  const handlers: { [M in AgentMethod]: (p: AgentParams<M>) => Answer<M> } = {
    hello: (p) => (seed.token !== undefined && p.token === seed.token ? { ok: { role: "interactive" } } : fail("not_granted")),

    current_site: () => {
      const gate = browserGate();
      return gate ? fail(gate) : { ok: { site: currentSite } };
    },

    recent_activity: (p) => {
      const gate = browserGate();
      if (gate) return fail(gate);
      let start = 0;
      if (p.cursor !== undefined) {
        const c = takeCursor(p.cursor, "recent_activity");
        if (!c || c.revision !== activityRevision) return fail("expired_snapshot");
        start = c.offset;
      }
      const revision = activityRevision;
      return page<ActivityEntry, "recent_activity">(
        activity, start, p.limit ?? RECENT_ACTIVITY_MAX_LIMIT,
        (entries, next) => withCursor({ entries }, next),
        (offset) => ({ method: "recent_activity", offset, revision, expiresAt: expires() }),
      );
    },

    site_links: (p) => {
      const gate = browserGate();
      if (gate) return fail(gate);
      const links = siteLinks;
      let start = 0;
      if (p.cursor !== undefined) {
        const c = takeCursor(p.cursor, "site_links");
        if (!c) return fail("expired_snapshot");
        // The site or its catalog changed since the first page: the listing is stale.
        if (currentSite?.origin !== c.origin || links?.origin !== c.origin || links.catalogVersion !== c.catalogVersion) {
          return fail("expired_snapshot");
        }
        start = c.offset;
      }
      if (!currentSite || !links || links.origin !== currentSite.origin) return fail("not_found");
      return page<SiteLink, "site_links">(
        links.links, start, p.limit ?? DEFAULT_PAGE,
        (slice, next) => withCursor({ origin: links.origin, catalogVersion: links.catalogVersion, total: links.links.length, links: slice }, next),
        (offset) => ({ method: "site_links", offset, origin: links.origin, catalogVersion: links.catalogVersion, expiresAt: expires() }),
      );
    },

    list_resources: (p) => {
      let start = 0;
      let ids: readonly string[];
      if (p.cursor !== undefined) {
        const c = takeCursor(p.cursor, "list_resources");
        if (!c) return fail("expired_snapshot");
        start = c.offset;
        ids = c.ids;
      } else {
        // Only resources with a current approved version: pending, declined and revoked never appear.
        ids = resources.filter((r) => defaultVersion(r) && (p.origin === undefined || r.siteOrigin === p.origin)).map((r) => r.id);
      }
      return page<string, "list_resources">(
        ids, start, p.limit ?? DEFAULT_PAGE,
        (slice, next) =>
          withCursor(
            {
              resources: slice.flatMap((id) => {
                // Re-checked per page, so a resource revoked since the snapshot is left out.
                const r = resources.find((x) => x.id === id);
                const v = r && defaultVersion(r);
                return r && v ? [{ ...identity(r, v), totalBytes: v.bytes.length, approvedAt: v.decidedAt }] : [];
              }),
            },
            next,
          ),
        (offset) => ({ method: "list_resources", offset, ids, expiresAt: expires() }),
      );
    },

    read_resource: (p) => {
      let version = p.version;
      let offset = 0;
      if (p.cursor !== undefined) {
        const c = takeCursor(p.cursor, "read_resource");
        if (!c) return fail("expired_snapshot");
        if (c.resourceId !== p.resourceId || (version !== undefined && version !== c.version)) return fail("not_found");
        version = c.version;
        offset = c.offset;
      }
      const r = resources.find((x) => x.id === p.resourceId);
      if (!r) return fail("not_found");
      // Checked on every chunk, so a revocation mid-read stops the next chunk.
      if (r.blocked) return fail("revoked");
      const v = version === undefined ? defaultVersion(r) : r.versions.find((x) => x.hash === version);
      if (!v) return fail("not_found");
      if (v.state === "revoked") return fail("revoked");
      if (v.state !== "approved" && v.state !== "superseded") return fail("not_found");
      if (offset > v.bytes.length) return fail("expired_snapshot");
      // Shrink the chunk until the whole response fits (escaping can grow text up to 6x).
      let max = RESOURCE_CHUNK_MAX_BYTES;
      for (;;) {
        const end = utf8Cut(v.bytes, offset, max);
        const more = end < v.bytes.length;
        const result = {
          ...identity(r, v), offset, totalBytes: v.bytes.length, text: v.bytes.subarray(offset, end).toString("utf8"),
        };
        if (byteLength(envelopeOk({ ...result, nextCursor: "x".repeat(22) })) <= AGENT_RESPONSE_MAX_BYTES) {
          if (!more) return { ok: result };
          return { ok: { ...result, nextCursor: issueCursor({ method: "read_resource", resourceId: r.id, version: v.hash, offset: end, expiresAt: expires() }) } };
        }
        if (end === offset) return fail("limit_exceeded");
        max = Math.floor((end - offset) / 2);
      }
    },
  };

  function identity(r: FixtureResource, v: FixtureVersion) {
    return {
      resourceId: r.id, kind: r.kind, siteOrigin: r.siteOrigin, publisherOrigin: r.publisherOrigin, sourceUrl: r.sourceUrl,
      version: v.hash, approval: v.state === "superseded" ? ("superseded" as const) : ("approved" as const),
    };
  }

  const respond = (requestId: string, a: Answer<AgentMethod>): AgentResponse => {
    const base = { protocol: AGENT_PROTOCOL_VERSION, requestId, coreInstanceId };
    if ("error" in a) return { ...base, status: "error", error: { code: a.error, message: a.error } };
    const res: AgentResponse = { ...base, status: "ok", result: a.ok };
    return byteLength(res) <= AGENT_RESPONSE_MAX_BYTES ? res : { ...base, status: "error", error: { code: "limit_exceeded", message: "limit_exceeded" } };
  };

  return {
    coreInstanceId,
    resourceIds: resources.map((r) => r.id),
    versionHashes: (id) => resources.find((r) => r.id === id)?.versions.map((v) => v.hash) ?? [],
    setBrowserContextGrant: (g) => void (granted = g),
    setPaused: (p) => void (paused = p),
    setCurrentSite: (s) => void (currentSite = s),
    setActivity(entries) {
      activity = entries;
      activityRevision++;
    },
    setSiteLinks: (l) => void (siteLinks = l),
    setOnline: (o) => void (online = o),
    revoke(id) {
      const r = resources.find((x) => x.id === id);
      if (!r) return;
      r.blocked = true;
      for (const v of r.versions) if (v.state === "approved" || v.state === "superseded") v.state = "revoked";
    },
    async call<M extends AgentMethod>(request: AgentRequestOf<M>): Promise<AgentResponse<M>> {
      if (!online) throw new BackendError("unavailable");
      const raw: unknown = request;
      const rid = (raw as { requestId?: unknown })?.requestId;
      const requestId = AgentRequestIdSchema.safeParse(rid).success ? (rid as string) : "invalid";
      if (byteLength(raw) > AGENT_REQUEST_MAX_BYTES) return respond(requestId, fail("limit_exceeded")) as AgentResponse<M>;
      const parsed = AgentRequestSchema.safeParse(raw);
      if (!parsed.success || parsed.data.protocol !== AGENT_PROTOCOL_VERSION) return respond(requestId, fail("protocol_mismatch")) as AgentResponse<M>;
      const handler = handlers[parsed.data.method] as (p: unknown) => Answer<AgentMethod>;
      return respond(requestId, handler(parsed.data.params)) as AgentResponse<M>;
    },
    close() {},
  };
}
