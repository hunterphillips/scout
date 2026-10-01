import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_CURSOR_TTL_MS,
  AGENT_PROTOCOL_VERSION,
  AGENT_REQUEST_MAX_BYTES,
  AGENT_RESPONSE_MAX_BYTES,
  agentResponseSchema,
  RESOURCE_CHUNK_MAX_BYTES,
  type AgentMethod,
  type AgentParams,
  type AgentResponse,
  type AgentResult,
  type ResourceKind,
} from "@scout/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiscoveryResult } from "../capabilities/discovery.js";
import { type CapabilityStore, createCapabilityStore } from "../capabilities/store.js";
import { CATALOG_CACHE_SCHEMA_VERSION, createCatalogCache } from "../catalog/cache.js";
import { cacheFileName } from "../privateCacheFile.js";
import { type AgentAuth, createAgentAuth } from "./auth.js";
import { type AgentConnection, type AgentHandlers, type AgentView, createAgentHandlers, MAX_CURSORS } from "./handlers.js";
import { createReadAudit, type ReadAudit } from "./readAudit.js";

const SITE = "https://docs.example.com";
const TOKEN = "interactive-test-token";
/** Mixed 1- to 4-byte characters, so chunk cuts land mid-character. */
const LONG_TEXT = Array.from({ length: 2500 }, (_, i) => `line ${i}: café ✓ 😀\n`).join("");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

let home: string;
let now: number;
let store: CapabilityStore;
let view: AgentView;
let granted: boolean;
let auth: AgentAuth;
let audit: ReadAudit;
let handlers: AgentHandlers;
let seq = 0;
let connSeq = 0;

function discovery(found: { kind: ResourceKind; path: string; text: string }[], origin = SITE): DiscoveryResult {
  return {
    origin,
    checkedAt: now,
    robots: "not_fetched",
    items: found.map((f) => {
      const sourceUrl = `${origin}${f.path}`;
      return {
        kind: f.kind,
        sourceUrl,
        status: "found",
        source: "network",
        resource: {
          kind: f.kind, siteOrigin: origin, publisherOrigin: origin, sourceUrl, finalUrl: sourceUrl,
          text: f.text, sha256: sha(f.text), byteLength: Buffer.byteLength(f.text), fetchedAt: now,
        },
      };
    }),
    externalReferences: [],
    skillsOverCap: 0,
    acceptedBytes: 0,
    stats: { requests: 0, refused: 0, ms: 0 },
  };
}

async function ingest(kind: ResourceKind, path: string, text: string, origin = SITE) {
  const r = (await store.ingest(discovery([{ kind, path, text }], origin), { chromePermitted: false })).results[0]!;
  return { id: r.resourceId, version: r.version };
}
const rev = (id: string) => store.getResource(id)!.revision;
const approve = (id: string, version: string) => store.approve({ resourceId: id, version, expectedRevision: rev(id) });

function req<M extends AgentMethod>(method: M, params: AgentParams<M>) {
  return { protocol: AGENT_PROTOCOL_VERSION, requestId: `t${++seq}`, method, params };
}

function call<M extends AgentMethod>(conn: AgentConnection, method: M, params: AgentParams<M>): AgentResponse<M> {
  const res = handlers.call(req(method, params), conn);
  // Every response must be one the production client accepts.
  expect(agentResponseSchema(method).safeParse(res).success).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(res))).toBeLessThanOrEqual(AGENT_RESPONSE_MAX_BYTES);
  expect(res.coreInstanceId).toBe("core-test");
  return res as AgentResponse<M>;
}
function ok<M extends AgentMethod>(conn: AgentConnection, method: M, params: AgentParams<M>): AgentResult<M> {
  const res = call(conn, method, params);
  if (res.status !== "ok") throw new Error(`expected ok, got ${res.error.code}`);
  return res.result;
}
function code<M extends AgentMethod>(conn: AgentConnection, method: M, params: AgentParams<M>): string {
  const res = call(conn, method, params);
  return res.status === "ok" ? "ok" : res.error.code;
}

function connect(token = TOKEN): AgentConnection {
  const conn: AgentConnection = { id: `conn-${++connSeq}`, principal: null };
  expect(code(conn, "hello", { token })).toBe("ok");
  return conn;
}

function seedCatalog(version: string, links: { title: string; description?: string; humanHref?: string }[], origin = SITE) {
  const dir = join(home, "cache", "catalog");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const catalog = {
    origin,
    version,
    fetchedAt: now,
    truncated: false,
    errors: [],
    candidates: links.map((l, i) => ({
      id: `c${i.toString(36)}`,
      sourceUrl: `${origin}/p${i}`,
      title: l.title,
      labelQuality: "published",
      provenance: "llms.txt",
      ...(l.description !== undefined ? { description: l.description } : {}),
      ...(l.humanHref !== undefined ? { humanHref: l.humanHref } : {}),
    })),
  };
  writeFileSync(join(dir, cacheFileName(origin)), JSON.stringify({ schemaVersion: CATALOG_CACHE_SCHEMA_VERSION, origin, fetchedAt: now, resources: [], catalog }), { mode: 0o600 });
}

/** Read a resource to the end, chunk by chunk. */
function readAll(conn: AgentConnection, resourceId: string, version?: string) {
  const chunks: AgentResult<"read_resource">[] = [];
  let cursor: string | undefined;
  do {
    const r = ok(conn, "read_resource", { resourceId, ...(version ? { version } : {}), ...(cursor ? { cursor } : {}) });
    chunks.push(r);
    cursor = r.nextCursor;
  } while (cursor);
  return chunks;
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "scout-agent-"));
  now = 1_800_000_000_000;
  const clock = { now: () => now };
  store = await createCapabilityStore({ scoutHome: home, clock, onRevoked: (id) => handlers.dropResource(id) });
  view = { currentSite: { origin: SITE, url: `${SITE}/billing`, visitEpoch: 7 }, paused: false };
  granted = true;
  auth = createAgentAuth({ interactiveToken: TOKEN });
  audit = createReadAudit();
  handlers = createAgentHandlers({
    coreInstanceId: "core-test",
    auth,
    store,
    view: () => view,
    catalog: createCatalogCache({ clock, dir: join(home, "cache", "catalog") }),
    browserContextGranted: () => granted,
    audit,
    clock,
  });
});
afterEach(async () => {
  await store.close();
  rmSync(home, { recursive: true, force: true });
});

describe("hello", () => {
  it("refuses a bad token and serves nothing before an accepted hello", () => {
    const conn: AgentConnection = { id: "c", principal: null };
    expect(code(conn, "hello", { token: "wrong" })).toBe("not_granted");
    expect(code(conn, "list_resources", {})).toBe("not_granted");
    expect(code(conn, "hello", { token: TOKEN })).toBe("ok");
    expect(code(conn, "list_resources", {})).toBe("ok");
  });

  it("answers protocol_mismatch to an unparseable or other-protocol request, and limit_exceeded to an oversized one", () => {
    const conn = connect();
    expect(handlers.call({ type: "hello", protocol: 1 }, conn)).toMatchObject({ status: "error", error: { code: "protocol_mismatch" } });
    expect(handlers.call({ ...req("list_resources", {}), protocol: 2 }, conn)).toMatchObject({ status: "error", error: { code: "protocol_mismatch" } });
    const big = { ...req("list_resources", {}), pad: "x".repeat(AGENT_REQUEST_MAX_BYTES) };
    expect(handlers.call(big, conn)).toMatchObject({ status: "error", error: { code: "limit_exceeded" } });
  });
});

describe("list_resources", () => {
  it("lists approved and superseded versions, never pending, declined or revoked ones", async () => {
    const v1 = await ingest("llms_txt", "/llms.txt", "guide v1\n");
    await approve(v1.id, v1.version);
    const v2 = await ingest("llms_txt", "/llms.txt", "guide v2\n");
    await approve(v1.id, v2.version);
    await ingest("agents_md", "/AGENTS.md", "pending\n");
    const declined = await ingest("agents_md", "/docs/AGENTS.md", "declined\n");
    await store.decline({ resourceId: declined.id, version: declined.version, expectedRevision: rev(declined.id) });
    const revoked = await ingest("agents_md", "/team/AGENTS.md", "revoked\n");
    await approve(revoked.id, revoked.version);
    await store.revoke(revoked.id);

    const listed = ok(connect(), "list_resources", {}).resources.map((r) => [r.resourceId, r.version, r.approval]);
    expect(listed.sort()).toEqual(
      [
        [v1.id, v2.version, "approved"],
        [v1.id, v1.version, "superseded"],
      ].sort(),
    );
  });

  it("a later page re-checks its items: after a revoke it may be shorter than the limit and still carry nextCursor", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await ingest("agents_md", `/t${i}/AGENTS.md`, `team ${i}\n`);
      await approve(r.id, r.version);
      ids.push(r.id);
    }
    const conn = connect();
    const first = ok(conn, "list_resources", { limit: 2 });
    expect(first.resources).toHaveLength(2);
    // Revoke both items of the second page.
    await store.revoke(ids[2]!);
    await store.revoke(ids[3]!);
    const second = ok(conn, "list_resources", { limit: 2, cursor: first.nextCursor! });
    expect(second.resources).toEqual([]);
    expect(second.nextCursor).toBeDefined();
    const third = ok(conn, "list_resources", { limit: 2, cursor: second.nextCursor! });
    expect(third.resources.map((r) => r.resourceId)).toEqual([ids[4]]);
    expect(third.nextCursor).toBeUndefined();
  });

  it("stays usable while paused and without the browser grant", async () => {
    const r = await ingest("llms_txt", "/llms.txt", "guide\n");
    await approve(r.id, r.version);
    granted = false;
    view = { ...view, paused: true };
    const conn = connect();
    expect(ok(conn, "list_resources", {}).resources).toHaveLength(1);
    expect(readAll(conn, r.id).map((c) => c.text).join("")).toBe("guide\n");
  });
});

describe("read_resource", () => {
  it("reads multi-byte text in UTF-8-safe chunks of at most 16 KiB", async () => {
    const r = await ingest("llms_txt", "/llms.txt", LONG_TEXT);
    await approve(r.id, r.version);
    const chunks = readAll(connect(), r.id);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(Buffer.byteLength(c.text)).toBeLessThanOrEqual(RESOURCE_CHUNK_MAX_BYTES);
      expect(c.text).not.toContain("�");
      expect(c.version).toBe(r.version);
    }
    expect(chunks.map((c) => c.text).join("")).toBe(LONG_TEXT);
    expect(chunks.map((c) => c.offset)).toEqual(chunks.map((_, i) => chunks.slice(0, i).reduce((n, c) => n + Buffer.byteLength(c.text), 0)));
  });

  it("refuses the next chunk once the resource is revoked mid-read", async () => {
    const r = await ingest("llms_txt", "/llms.txt", LONG_TEXT);
    await approve(r.id, r.version);
    const conn = connect();
    const first = ok(conn, "read_resource", { resourceId: r.id });
    await store.revoke(r.id);
    expect(code(conn, "read_resource", { resourceId: r.id, cursor: first.nextCursor! })).toBe("revoked");
    expect(code(conn, "read_resource", { resourceId: r.id })).toBe("revoked");
    // Re-approval does not bring the old cursor back.
    await approve(r.id, r.version);
    expect(code(conn, "read_resource", { resourceId: r.id, cursor: first.nextCursor! })).toBe("revoked");
  });

  it("answers unavailable when the version's blob on disk no longer matches its hash", async () => {
    const r = await ingest("llms_txt", "/llms.txt", "guide v1\n");
    await approve(r.id, r.version);
    const conn = connect();
    expect(ok(conn, "read_resource", { resourceId: r.id }).text).toBe("guide v1\n");
    const resolved = store.resolveRead(r.id, r.version);
    if (!resolved.ok) throw new Error("expected a readable version");
    writeFileSync(join(store.dir, "blobs", `${resolved.version.blobRef}.txt`), "tampered\n");
    expect(code(conn, "read_resource", { resourceId: r.id })).toBe("unavailable");
  });

  it("keeps reading the pinned version after a newer one is approved", async () => {
    const v1 = await ingest("llms_txt", "/llms.txt", LONG_TEXT);
    await approve(v1.id, v1.version);
    const conn = connect();
    const first = ok(conn, "read_resource", { resourceId: v1.id });
    const v2 = await ingest("llms_txt", "/llms.txt", "short v2\n");
    await approve(v1.id, v2.version);
    const second = ok(conn, "read_resource", { resourceId: v1.id, cursor: first.nextCursor! });
    expect(second.version).toBe(v1.version);
    expect(second.approval).toBe("superseded");
  });

  it("expires a cursor after five minutes", async () => {
    const r = await ingest("llms_txt", "/llms.txt", LONG_TEXT);
    await approve(r.id, r.version);
    const conn = connect();
    const first = ok(conn, "read_resource", { resourceId: r.id });
    now += AGENT_CURSOR_TTL_MS;
    expect(code(conn, "read_resource", { resourceId: r.id, cursor: first.nextCursor! })).toBe("expired_snapshot");
  });

  it("refuses a cursor on any connection but the one it was issued to", async () => {
    const r = await ingest("llms_txt", "/llms.txt", LONG_TEXT);
    await approve(r.id, r.version);
    const a = connect();
    const b = connect();
    const first = ok(a, "read_resource", { resourceId: r.id });
    expect(code(b, "read_resource", { resourceId: r.id, cursor: first.nextCursor! })).toBe("expired_snapshot");
    expect(code(a, "read_resource", { resourceId: r.id, cursor: first.nextCursor! })).toBe("ok");
  });

  it("refuses a job-token cursor on the interactive connection and the reverse", async () => {
    const r = await ingest("llms_txt", "/llms.txt", LONG_TEXT);
    await approve(r.id, r.version);
    const job = connect(auth.issueJobToken({ jobId: "job-1", resourceIds: [r.id] }));
    expect(job.principal?.role).toBe("job");
    const interactive = connect();
    const jobCursor = ok(job, "read_resource", { resourceId: r.id }).nextCursor!;
    const interactiveCursor = ok(interactive, "read_resource", { resourceId: r.id }).nextCursor!;
    expect(code(interactive, "read_resource", { resourceId: r.id, cursor: jobCursor })).toBe("expired_snapshot");
    expect(code(job, "read_resource", { resourceId: r.id, cursor: interactiveCursor })).toBe("expired_snapshot");
  });

  it("serves an explicit superseded version as superseded, and answers not_found for a pending or declined version", async () => {
    const v1 = await ingest("llms_txt", "/llms.txt", "guide v1\n");
    await approve(v1.id, v1.version);
    const v2 = await ingest("llms_txt", "/llms.txt", "guide v2\n");
    await approve(v1.id, v2.version);
    const pending = await ingest("llms_txt", "/llms.txt", "guide v3\n");
    const declined = await ingest("llms_txt", "/llms.txt", "guide v4\n");
    await store.decline({ resourceId: v1.id, version: declined.version, expectedRevision: rev(v1.id) });
    const conn = connect();
    const old = ok(conn, "read_resource", { resourceId: v1.id, version: v1.version });
    expect([old.version, old.approval, old.text]).toEqual([v1.version, "superseded", "guide v1\n"]);
    expect(ok(conn, "read_resource", { resourceId: v1.id }).approval).toBe("approved");
    expect(code(conn, "read_resource", { resourceId: v1.id, version: pending.version })).toBe("not_found");
    expect(code(conn, "read_resource", { resourceId: v1.id, version: declined.version })).toBe("not_found");
  });
});

describe("read pins", () => {
  /** Live store pins by pin ID, as the handlers set and release them. */
  function trackPins(): Map<string, number> {
    const live = new Map<string, number>();
    const pin = store.pinVersion;
    const release = store.releasePins;
    store.pinVersion = (id, resourceId, version) => {
      const r = pin(id, resourceId, version);
      if (r.ok) live.set(id, (live.get(id) ?? 0) + 1);
      return r;
    };
    store.releasePins = (id) => {
      live.delete(id);
      release(id);
    };
    return live;
  }

  it("pins a multi-chunk read between chunks under one ID and releases it with the last chunk", async () => {
    const r = await ingest("llms_txt", "/llms.txt", LONG_TEXT);
    await approve(r.id, r.version);
    const pins = trackPins();
    const conn = connect();
    let cursor: string | undefined;
    let chunks = 0;
    do {
      const c = ok(conn, "read_resource", { resourceId: r.id, ...(cursor ? { cursor } : {}) });
      cursor = c.nextCursor;
      chunks++;
      if (cursor) {
        expect(pins.size).toBe(1);
        expect([...pins.keys()][0]).not.toBe(conn.id);
      }
    } while (cursor);
    expect(chunks).toBeGreaterThan(2);
    expect(pins.size).toBe(0);
  });

  it("pins nothing for a single-chunk read", async () => {
    const r = await ingest("llms_txt", "/llms.txt", "short\n");
    await approve(r.id, r.version);
    const pins = trackPins();
    const released: string[] = [];
    const release = store.releasePins;
    store.releasePins = (id) => {
      released.push(id);
      release(id);
    };
    expect(ok(connect(), "read_resource", { resourceId: r.id }).nextCursor).toBeUndefined();
    expect(pins.size).toBe(0);
    expect(released).toEqual([]);
  });

  it("gives each read on one connection its own pin", async () => {
    const r = await ingest("llms_txt", "/llms.txt", LONG_TEXT);
    await approve(r.id, r.version);
    const pins = trackPins();
    const conn = connect();
    ok(conn, "read_resource", { resourceId: r.id });
    expect(pins.size).toBe(1);
    readAll(conn, r.id);
    // The finished read released its own pin; the abandoned one is still open.
    expect(pins.size).toBe(1);
  });

  it("releases an abandoned read's pin once its cursor expires", async () => {
    const r = await ingest("llms_txt", "/llms.txt", LONG_TEXT);
    await approve(r.id, r.version);
    const other = await ingest("agents_md", "/AGENTS.md", LONG_TEXT);
    await approve(other.id, other.version);
    const pins = trackPins();
    const conn = connect();
    const first = ok(conn, "read_resource", { resourceId: r.id });
    expect(pins.size).toBe(1);
    now += AGENT_CURSOR_TTL_MS;
    // Found expired when presented.
    expect(code(conn, "read_resource", { resourceId: r.id, cursor: first.nextCursor! })).toBe("expired_snapshot");
    expect(pins.size).toBe(0);

    // Swept when a later cursor is issued, without being presented again.
    ok(conn, "read_resource", { resourceId: r.id });
    const [abandoned] = pins.keys();
    now += AGENT_CURSOR_TTL_MS;
    ok(conn, "read_resource", { resourceId: other.id });
    expect(pins.has(abandoned!)).toBe(false);
    expect(pins.size).toBe(1);
  });

  it("releases an open read's pin when the resource is revoked", async () => {
    const r = await ingest("llms_txt", "/llms.txt", LONG_TEXT);
    await approve(r.id, r.version);
    const pins = trackPins();
    const conn = connect();
    ok(conn, "read_resource", { resourceId: r.id });
    expect(pins.size).toBe(1);
    await store.revoke(r.id);
    expect(pins.size).toBe(0);
  });

  it("releases every open read's pin when the connection ends, and no other connection's", async () => {
    const r = await ingest("llms_txt", "/llms.txt", LONG_TEXT);
    await approve(r.id, r.version);
    const pins = trackPins();
    const a = connect();
    const b = connect();
    ok(a, "read_resource", { resourceId: r.id });
    ok(a, "read_resource", { resourceId: r.id });
    ok(b, "read_resource", { resourceId: r.id });
    expect(pins.size).toBe(3);
    handlers.endConnection(a);
    expect(pins.size).toBe(1);
    handlers.endConnection(b);
    expect(pins.size).toBe(0);
  });

  it("keeps a superseded version from collection during a read, and lets it go after the read ends", async () => {
    const v1 = await ingest("llms_txt", "/llms.txt", LONG_TEXT);
    await approve(v1.id, v1.version);
    const conn = connect();
    const first = ok(conn, "read_resource", { resourceId: v1.id });
    // More newer versions than collection retains.
    for (let i = 2; i <= 8; i++) {
      now += 1000;
      const v = await ingest("llms_txt", "/llms.txt", `guide v${i}\n`);
      await approve(v1.id, v.version);
    }
    await store.collectGarbage();
    expect(store.resolveRead(v1.id, v1.version).ok).toBe(true);

    let text = first.text;
    let cursor = first.nextCursor;
    while (cursor) {
      const c = ok(conn, "read_resource", { resourceId: v1.id, cursor });
      expect(c.version).toBe(v1.version);
      text += c.text;
      cursor = c.nextCursor;
    }
    expect(text).toBe(LONG_TEXT);

    // The connection is still open; the read is over.
    await store.collectGarbage();
    expect(store.resolveRead(v1.id, v1.version)).toEqual({ ok: false, code: "not_found" });
  });

  /** Approve more newer versions of `id` than collection retains, so its first version is collectable unless pinned. */
  async function supersede(id: string) {
    for (let i = 2; i <= 8; i++) {
      now += 1000;
      const v = await ingest("llms_txt", "/llms.txt", `guide v${i}\n`);
      await approve(id, v.version);
    }
  }

  it("keeps the pin when continuing from the oldest cursor at the cursor cap evicts it", async () => {
    const v1 = await ingest("llms_txt", "/llms.txt", LONG_TEXT);
    await approve(v1.id, v1.version);
    const conn = connect();
    const first = ok(conn, "read_resource", { resourceId: v1.id });
    await supersede(v1.id);
    // Fill the table so the read's cursor is the oldest of MAX_CURSORS.
    for (let i = 1; i < MAX_CURSORS; i++) expect(ok(conn, "list_resources", { limit: 1 }).nextCursor).toBeDefined();
    const second = ok(conn, "read_resource", { resourceId: v1.id, cursor: first.nextCursor! });
    expect(second.nextCursor).toBeDefined();
    // The consumed cursor was evicted to make room; the new one still carries the pin.
    expect(code(conn, "read_resource", { resourceId: v1.id, cursor: first.nextCursor! })).toBe("expired_snapshot");
    await store.collectGarbage();
    expect(store.resolveRead(v1.id, v1.version).ok).toBe(true);
    expect(ok(conn, "read_resource", { resourceId: v1.id, cursor: second.nextCursor! }).version).toBe(v1.version);
  });

  it("sweepExpired releases an abandoned read's pin without another call, so collection takes the version", async () => {
    const v1 = await ingest("llms_txt", "/llms.txt", LONG_TEXT);
    await approve(v1.id, v1.version);
    const pins = trackPins();
    const conn = connect();
    ok(conn, "read_resource", { resourceId: v1.id });
    await supersede(v1.id);
    expect(pins.size).toBe(1);
    // Not yet expired: the sweep keeps it.
    handlers.sweepExpired();
    expect(pins.size).toBe(1);
    await store.collectGarbage();
    expect(store.resolveRead(v1.id, v1.version).ok).toBe(true);

    now += AGENT_CURSOR_TTL_MS;
    handlers.sweepExpired();
    expect(pins.size).toBe(0);
    await store.collectGarbage();
    expect(store.resolveRead(v1.id, v1.version)).toEqual({ ok: false, code: "not_found" });
  });
});

describe("browser context", () => {
  it("answers not_granted before paused, and paused with the grant", () => {
    const conn = connect();
    granted = false;
    view = { ...view, paused: true };
    for (const m of ["current_site", "recent_activity", "site_links"] as const) expect(code(conn, m, {})).toBe("not_granted");
    granted = true;
    for (const m of ["current_site", "recent_activity", "site_links"] as const) expect(code(conn, m, {})).toBe("paused");
  });

  it("serves the current site without a title, recent_activity as unavailable, and nothing to a job", () => {
    const conn = connect();
    expect(ok(conn, "current_site", {})).toEqual({ site: { origin: SITE, url: `${SITE}/billing`, visitEpoch: 7 } });
    expect(code(conn, "recent_activity", {})).toBe("unavailable");
    view = { ...view, currentSite: null };
    expect(ok(conn, "current_site", {})).toEqual({ site: null });
    const job = connect(auth.issueJobToken({ jobId: "job-1", resourceIds: [] }));
    expect(code(job, "current_site", {})).toBe("not_granted");
  });

  it("turning the grant off reaches an open connection on its next call", () => {
    const conn = connect();
    expect(code(conn, "current_site", {})).toBe("ok");
    granted = false;
    expect(code(conn, "current_site", {})).toBe("not_granted");
  });

  it("records bounded audit entries with the origin only", () => {
    const conn = connect();
    ok(conn, "current_site", {});
    granted = false;
    code(conn, "site_links", {});
    ok(conn, "list_resources", {});
    expect(audit.entries()).toEqual([
      { at: now, role: "interactive", method: "current_site", outcome: "ok", origin: SITE },
      { at: now, role: "interactive", method: "site_links", outcome: "not_granted" },
    ]);
  });
});

describe("site_links", () => {
  it("pages the current site's cached catalog and expires its cursor when the catalog version changes", () => {
    seedCatalog("cat-1", Array.from({ length: 30 }, (_, i) => ({ title: `Page ${i}`, ...(i === 0 ? { humanHref: `${SITE}/human` } : {}) })));
    const conn = connect();
    const first = ok(conn, "site_links", { limit: 20 });
    expect(first).toMatchObject({ origin: SITE, catalogVersion: "cat-1", total: 30 });
    expect(first.links).toHaveLength(20);
    expect(first.links[0]).toEqual({ id: "c0", href: `${SITE}/human`, title: "Page 0" });
    expect(first.links[1]!.href).toBe(`${SITE}/p1`);
    const second = ok(conn, "site_links", { limit: 20, cursor: first.nextCursor! });
    expect(second.links).toHaveLength(10);
    expect(second.nextCursor).toBeUndefined();

    seedCatalog("cat-2", [{ title: "Only" }]);
    expect(code(conn, "site_links", { cursor: first.nextCursor! })).toBe("expired_snapshot");
  });

  it("expires its cursor when the site changes, and has nothing for a site without a cached catalog", () => {
    seedCatalog("cat-1", Array.from({ length: 30 }, (_, i) => ({ title: `Page ${i}` })));
    const conn = connect();
    const first = ok(conn, "site_links", {});
    view = { ...view, currentSite: { origin: "https://other.example.org", url: "https://other.example.org/", visitEpoch: 8 } };
    expect(code(conn, "site_links", { cursor: first.nextCursor! })).toBe("expired_snapshot");
    expect(code(conn, "site_links", {})).toBe("not_found");
  });

  it("shrinks a page to fit the 64 KiB response cap", () => {
    // Control characters escape to six bytes each in JSON.
    const big = { title: "\u0001".repeat(160), description: "\u0001".repeat(400) };
    seedCatalog("cat-1", Array.from({ length: 50 }, () => big));
    const first = ok(connect(), "site_links", { limit: 50 });
    expect(first.links.length).toBeGreaterThan(0);
    expect(first.links.length).toBeLessThan(50);
    expect(first.nextCursor).toBeDefined();
  });
});
