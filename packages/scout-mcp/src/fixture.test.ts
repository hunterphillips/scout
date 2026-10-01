// The Phase 1 fixture backend answers the agent protocol the way the Phase 2 core must.

import { AGENT_RESPONSE_MAX_BYTES, agentResponseSchema, AGENT_CURSOR_TTL_MS, type AgentMethod, type AgentResponse } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import { BackendError } from "./client.js";
import { createFixtureBackend, type FixtureBackend } from "./fixture.js";
import { AGENTS_URL, LLMS_URL, LONG_TEXT, req, seed, SITE } from "./test-support/seed.js";

const ok = <M extends AgentMethod>(r: AgentResponse<M>) => {
  if (r.status !== "ok") throw new Error(`expected ok, got ${r.error.code}`);
  return r.result;
};
const code = (r: AgentResponse) => (r.status === "error" ? r.error.code : "ok");

async function readAll(b: FixtureBackend, resourceId: string, version?: string): Promise<{ text: string; chunks: number; versions: Set<string> }> {
  let text = "";
  let chunks = 0;
  const versions = new Set<string>();
  let cursor: string | undefined;
  do {
    const r = ok(await b.call(req("read_resource", { resourceId, ...(version ? { version } : {}), ...(cursor ? { cursor } : {}) })));
    text += r.text;
    chunks++;
    versions.add(r.version);
    cursor = r.nextCursor;
  } while (cursor);
  return { text, chunks, versions };
}

describe("fixture backend", () => {
  it("returns schema-valid responses carrying the core instance id", async () => {
    const b = await createFixtureBackend(seed());
    for (const [method, params] of [["current_site", {}], ["recent_activity", {}], ["site_links", {}], ["list_resources", {}]] as const) {
      const res = await b.call(req(method, params));
      expect(agentResponseSchema(method).safeParse(res).success).toBe(true);
      expect(res.coreInstanceId).toBe("core-a");
    }
  });

  it("lists only approved resources: pending, declined and revoked never appear", async () => {
    const b = await createFixtureBackend(seed());
    const listed = ok(await b.call(req("list_resources", {}))).resources;
    expect(listed.map((r) => r.sourceUrl).sort()).toEqual([LLMS_URL, "https://other.example.org/AGENTS.md", "https://cdn.example.net/skills/billing.md"].sort());
    expect(listed.every((r) => r.approval === "approved")).toBe(true);
    b.revoke(b.resourceIds[1]!);
    expect(ok(await b.call(req("list_resources", { origin: SITE }))).resources.map((r) => r.sourceUrl)).toEqual([LLMS_URL]);
  });

  it("never reads pending or declined text, even by explicit version", async () => {
    const b = await createFixtureBackend(seed());
    const [, , , pending, declined] = b.resourceIds;
    for (const id of [pending!, declined!]) {
      expect(code(await b.call(req("read_resource", { resourceId: id })))).toBe("not_found");
      expect(code(await b.call(req("read_resource", { resourceId: id, version: b.versionHashes(id)[0]! })))).toBe("not_found");
    }
  });

  it("reads a resource in UTF-8-safe chunks pinned to one version", async () => {
    const b = await createFixtureBackend(seed());
    const id = b.resourceIds[0]!;
    const { text, chunks, versions } = await readAll(b, id);
    expect(text).toBe(LONG_TEXT);
    expect(chunks).toBeGreaterThan(1);
    expect([...versions]).toEqual([b.versionHashes(id)[1]]);
    // The older approved version stays readable by explicit version, labeled superseded.
    const old = ok(await b.call(req("read_resource", { resourceId: id, version: b.versionHashes(id)[0]! })));
    expect(old.text).toBe("old guide");
    expect(old.approval).toBe("superseded");
  });

  it("refuses a cursor used for another resource or version", async () => {
    const b = await createFixtureBackend(seed());
    const [llms, skill] = b.resourceIds;
    const first = ok(await b.call(req("read_resource", { resourceId: llms! })));
    expect(code(await b.call(req("read_resource", { resourceId: skill!, cursor: first.nextCursor! })))).toBe("not_found");
    const other = b.versionHashes(llms!)[0]!;
    expect(code(await b.call(req("read_resource", { resourceId: llms!, version: other, cursor: first.nextCursor! })))).toBe("not_found");
  });

  it("checks revocation on every chunk", async () => {
    const b = await createFixtureBackend(seed());
    const id = b.resourceIds[0]!;
    const first = ok(await b.call(req("read_resource", { resourceId: id })));
    b.revoke(id);
    expect(code(await b.call(req("read_resource", { resourceId: id, cursor: first.nextCursor! })))).toBe("revoked");
    expect(code(await b.call(req("read_resource", { resourceId: id })))).toBe("revoked");
    expect(code(await b.call(req("read_resource", { resourceId: id, version: b.versionHashes(id)[0]! })))).toBe("revoked");
  });

  it("expires cursors", async () => {
    let t = 1_000;
    const b = await createFixtureBackend(seed({ now: () => t }));
    const first = ok(await b.call(req("read_resource", { resourceId: b.resourceIds[0]! })));
    t += AGENT_CURSOR_TTL_MS;
    expect(code(await b.call(req("read_resource", { resourceId: b.resourceIds[0]!, cursor: first.nextCursor! })))).toBe("expired_snapshot");
    expect(code(await b.call(req("site_links", { cursor: "made-up" })))).toBe("expired_snapshot");
  });

  it("gates browser context on the grant, then on pause; resources stay readable while paused", async () => {
    const b = await createFixtureBackend(seed({ browserContextGranted: false }));
    for (const m of ["current_site", "recent_activity", "site_links"] as const) expect(code(await b.call(req(m, {})))).toBe("not_granted");
    expect(code(await b.call(req("list_resources", {})))).toBe("ok");
    b.setBrowserContextGrant(true);
    b.setPaused(true);
    for (const m of ["current_site", "recent_activity", "site_links"] as const) expect(code(await b.call(req(m, {})))).toBe("paused");
    expect(code(await b.call(req("read_resource", { resourceId: b.resourceIds[1]! })))).toBe("ok");
  });

  it("reports no current site honestly and keeps site_links to the current site", async () => {
    const b = await createFixtureBackend(seed());
    const links = ok(await b.call(req("site_links", { limit: 25 })));
    expect(links.links).toHaveLength(25);
    const rest = ok(await b.call(req("site_links", { cursor: links.nextCursor! })));
    expect(rest.links).toHaveLength(5);
    expect(rest.nextCursor).toBeUndefined();
    b.setCurrentSite({ origin: "https://elsewhere.example", url: "https://elsewhere.example/", visitEpoch: 8 });
    expect(code(await b.call(req("site_links", {})))).toBe("not_found");
    b.setCurrentSite(null);
    expect(ok(await b.call(req("current_site", {})))).toEqual({ site: null });
  });

  it("pages lists down to the response cap", async () => {
    // Control characters escape to six bytes each: ten full entries would be ~480 KiB.
    const heavy = "\u0001".repeat(8 * 1024);
    const activity = Array.from({ length: 10 }, (_, i) => ({ origin: SITE, url: `${SITE}/${i}`, observedAt: i, title: `t${i}`, text: heavy, textTruncated: false }));
    const b = await createFixtureBackend(seed({ activity }));
    let seen = 0;
    let cursor: string | undefined;
    do {
      const res = await b.call(req("recent_activity", cursor ? { cursor } : {}));
      expect(Buffer.byteLength(JSON.stringify(res))).toBeLessThanOrEqual(AGENT_RESPONSE_MAX_BYTES);
      const r = ok(res);
      expect(r.entries.length).toBeGreaterThan(0);
      expect(r.entries.length).toBeLessThan(10);
      seen += r.entries.length;
      cursor = r.nextCursor;
    } while (cursor);
    expect(seen).toBe(10);
  });

  it("shrinks a resource chunk whose escaped text would overflow the response", async () => {
    const b = await createFixtureBackend(seed({ resources: [{ kind: "agents_md", siteOrigin: SITE, sourceUrl: AGENTS_URL, versions: [{ text: "\u0001".repeat(40_000), state: "approved" }] }] }));
    const id = b.resourceIds[0]!;
    const res = await b.call(req("read_resource", { resourceId: id }));
    expect(Buffer.byteLength(JSON.stringify(res))).toBeLessThanOrEqual(AGENT_RESPONSE_MAX_BYTES);
    expect((await readAll(b, id)).text).toBe("\u0001".repeat(40_000));
  });

  it("answers protocol_mismatch for another protocol version or a malformed request", async () => {
    const b = await createFixtureBackend(seed());
    expect(code(await b.call({ ...req("current_site", {}), protocol: 2 }))).toBe("protocol_mismatch");
    expect(code(await b.call({ ...req("current_site", {}), method: "approve_resource" } as never))).toBe("protocol_mismatch");
  });

  it("expires a site_links cursor when the site or its catalog changes mid-listing", async () => {
    const b = await createFixtureBackend(seed());
    const first = ok(await b.call(req("site_links", { limit: 10 })));
    b.setSiteLinks({ origin: SITE, catalogVersion: "cat-2", links: [] });
    expect(code(await b.call(req("site_links", { cursor: first.nextCursor! })))).toBe("expired_snapshot");

    const b2 = await createFixtureBackend(seed());
    const again = ok(await b2.call(req("site_links", { limit: 10 })));
    b2.setCurrentSite({ origin: "https://elsewhere.example", url: "https://elsewhere.example/", visitEpoch: 8 });
    expect(code(await b2.call(req("site_links", { cursor: again.nextCursor! })))).toBe("expired_snapshot");
  });

  it("pages list_resources over the first page's snapshot: a revocation mid-listing skips and repeats nothing", async () => {
    const b = await createFixtureBackend(seed());
    const first = ok(await b.call(req("list_resources", { limit: 1 })));
    expect(first.resources.map((r) => r.resourceId)).toEqual([b.resourceIds[0]]);
    // Revoke the item already listed: a live re-filter would shift the offset and skip one.
    b.revoke(b.resourceIds[0]!);
    const seen: string[] = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const r = ok(await b.call(req("list_resources", { limit: 1, cursor })));
      seen.push(...r.resources.map((x) => x.resourceId));
      cursor = r.nextCursor;
    }
    expect(seen).toEqual([b.resourceIds[1], b.resourceIds[2]]);
  });

  it("leaves out a resource revoked after the snapshot but before its page", async () => {
    const b = await createFixtureBackend(seed());
    const first = ok(await b.call(req("list_resources", { limit: 1 })));
    b.revoke(b.resourceIds[1]!);
    const rest = ok(await b.call(req("list_resources", { limit: 5, cursor: first.nextCursor! })));
    expect(rest.resources.map((r) => r.resourceId)).toEqual([b.resourceIds[2]]);
  });

  it("expires a recent_activity cursor when the activity window changes", async () => {
    const b = await createFixtureBackend(seed());
    const first = ok(await b.call(req("recent_activity", { limit: 1 })));
    expect(code(await b.call(req("recent_activity", { cursor: first.nextCursor! })))).toBe("ok");
    const again = ok(await b.call(req("recent_activity", { limit: 1 })));
    // Same length, so only the revision (not the offset) can expire the cursor.
    b.setActivity([...seed().activity!].reverse());
    expect(code(await b.call(req("recent_activity", { cursor: again.nextCursor! })))).toBe("expired_snapshot");
  });

  it("refuses every hello when no token is configured", async () => {
    const { token: _, ...noToken } = seed();
    const b = await createFixtureBackend(noToken);
    expect(code(await b.call(req("hello", { token: "fixture-token" })))).toBe("not_granted");
  });

  it("checks the hello token and rejects every call while offline", async () => {
    const b = await createFixtureBackend(seed());
    expect(code(await b.call(req("hello", { token: "fixture-token" })))).toBe("ok");
    expect(code(await b.call(req("hello", { token: "wrong" })))).toBe("not_granted");
    b.setOnline(false);
    await expect(b.call(req("list_resources", {}))).rejects.toBeInstanceOf(BackendError);
  });
});
