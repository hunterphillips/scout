import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiagnosticFields, Diagnostics } from "../diagnostics.js";
import type { GuardedFetchOptions, GuardedFetchResult } from "../fetch/guardedFetch.js";
import { cacheFileName, CATALOG_CACHE_SCHEMA_VERSION, createCatalogCache } from "./cache.js";
import { createPacedCatalogFetch } from "./pacing.js";

const ORIGIN = "https://shop.example";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const sitemapWith = (...paths: string[]) => `<urlset>${paths.map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`).join("")}</urlset>`;

/** A fake site: each file has an ETag; a matching If-None-Match gets a 304 with no body. */
function fakeSite(files: Record<string, string>) {
  const requests: { path: string; options: GuardedFetchOptions; kind: GuardedFetchResult["kind"] }[] = [];
  let down = false;
  const etagOf = (path: string) => `"${path}:${(files[path] ?? "").length}"`;
  const guardedFetch = async (url: string, options: GuardedFetchOptions): Promise<GuardedFetchResult> => {
    const path = new URL(url).pathname;
    const body = files[path];
    let result: GuardedFetchResult;
    if (down) result = { kind: "error", reason: "network", message: `down ${url}` };
    else if (body === undefined) result = { kind: "absent", status: 404 };
    else if (options.ifNoneMatch === etagOf(path)) result = { kind: "not_modified", etag: etagOf(path) };
    else result = { kind: "ok", status: 200, body, bytes: new TextEncoder().encode(body), etag: etagOf(path), lastModified: "Mon, 01 Sep 2026 00:00:00 GMT", finalUrl: url };
    requests.push({ path, options, kind: result.kind });
    return result;
  };
  return {
    files,
    requests,
    setDown: (value: boolean) => void (down = value),
    fetch: (clock: { now(): number }) => createPacedCatalogFetch({ origin: ORIGIN, clock, guardedFetch, sleep: async () => undefined }),
  };
}

let dir: string;
let now: number;
const clock = { now: () => now };
let events: { name: string; fields: DiagnosticFields }[];
const diagnostics: Diagnostics = { event: (name, fields = {}) => void events.push({ name, fields }), failures: 0 };

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "scout-catalog-cache-")), "cache", "catalog");
  now = 1_000_000_000_000;
  events = [];
});
afterEach(() => rmSync(join(dir, "..", ".."), { recursive: true, force: true }));

async function primed(files: Record<string, string>) {
  const site = fakeSite(files);
  const cache = createCatalogCache({ dir, clock, diagnostics });
  const first = await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) });
  expect(first).toMatchObject({ ok: true, source: "miss", stale: false });
  site.requests.length = 0;
  return { site, cache, first };
}

describe("createCatalogCache", () => {
  it("writes a private file and serves it for 24 h with no requests", async () => {
    const { site, cache, first } = await primed({ "/sitemap.xml": sitemapWith("/a") });

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "shop.example.json")).mode & 0o777).toBe(0o600);
    now += 23 * HOUR;
    const second = await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) });

    expect(second).toMatchObject({ ok: true, source: "fresh", stale: false });
    expect(second.ok && first.ok && second.catalog).toEqual(first.ok && first.catalog);
    expect(site.requests).toEqual([]);
  });

  it("after 24 h revalidates conditionally and keeps the catalog when everything is 304", async () => {
    const { site, cache, first } = await primed({ "/sitemap.xml": sitemapWith("/a"), "/llms.txt": `- [A](${ORIGIN}/a)` });
    now += 25 * HOUR;

    const result = await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) });

    expect(result).toMatchObject({ ok: true, source: "not_modified", stale: false });
    expect(result.ok && result.catalog.fetchedAt).toBe(now);
    expect(result.ok && first.ok && result.catalog.version).toBe(first.ok && first.catalog.version);
    // No body came back: robots.txt stayed absent, the two files answered 304 to their validators.
    expect(site.requests.map((r) => [r.path, r.kind])).toEqual([
      ["/robots.txt", "absent"],
      ["/llms.txt", "not_modified"],
      ["/sitemap.xml", "not_modified"],
    ]);
    const conditional = site.requests.filter((r) => r.kind === "not_modified");
    for (const request of conditional) {
      expect(request.options.ifNoneMatch).toBeDefined();
      expect(request.options.ifModifiedSince).toBe("Mon, 01 Sep 2026 00:00:00 GMT");
    }
    expect(cache.load(ORIGIN)?.fetchedAt).toBe(now);
  });

  it("rediscovers when a resource changed", async () => {
    const { site, cache } = await primed({ "/sitemap.xml": sitemapWith("/a") });
    site.files["/sitemap.xml"] = sitemapWith("/a", "/b");
    now += 25 * HOUR;

    const result = await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) });

    expect(result).toMatchObject({ ok: true, source: "refetched" });
    expect(result.ok && result.catalog.candidates).toHaveLength(2);
  });

  it("refresh skips the freshness window but still sends validators", async () => {
    const { site, cache } = await primed({ "/sitemap.xml": sitemapWith("/a") });

    const result = await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock), refresh: true });

    expect(result).toMatchObject({ ok: true, source: "not_modified" });
    expect(site.requests.find((r) => r.path === "/sitemap.xml")?.options.ifNoneMatch).toBeDefined();
  });

  it("a schema bump refetches everything without validators", async () => {
    const { site, cache } = await primed({ "/sitemap.xml": sitemapWith("/a") });
    const path = join(dir, cacheFileName(ORIGIN));
    const file = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...file, schemaVersion: CATALOG_CACHE_SCHEMA_VERSION + 1 }));
    now += HOUR; // still inside the freshness window

    const result = await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) });

    expect(result).toMatchObject({ ok: true, source: "miss" });
    expect(site.requests.length).toBeGreaterThan(0);
    expect(site.requests.every((r) => r.options.ifNoneMatch === undefined && r.options.ifModifiedSince === undefined)).toBe(true);
    expect(cache.load(ORIGIN)?.schemaVersion).toBe(CATALOG_CACHE_SCHEMA_VERSION);
  });

  it("treats a corrupt file as a miss", async () => {
    const { site, cache } = await primed({ "/sitemap.xml": sitemapWith("/a") });
    writeFileSync(join(dir, cacheFileName(ORIGIN)), "{not json");

    expect(cache.load(ORIGIN)).toBeNull();
    const result = await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) });
    expect(result).toMatchObject({ ok: true, source: "miss" });
  });

  it("serves a 3-day-old catalog marked stale when the site fails", async () => {
    const { site, cache, first } = await primed({ "/sitemap.xml": sitemapWith("/a") });
    site.setDown(true);
    now += 3 * DAY;
    events = [];

    const result = await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) });

    expect(result).toMatchObject({ ok: true, source: "stale", stale: true });
    expect(result.ok && first.ok && result.catalog.version).toBe(first.ok && first.catalog.version);
    expect(events.find((e) => e.name === "catalog_cache")?.fields).toMatchObject({ origin: ORIGIN, stale: true });
  });

  it("fails when the only cached catalog is 8 days old", async () => {
    const { site, cache } = await primed({ "/sitemap.xml": sitemapWith("/a") });
    site.setDown(true);
    now += 8 * DAY;

    expect(await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) })).toMatchObject({ ok: false, code: "discover_failed" });
  });

  it("serves stale when discovery throws", async () => {
    const { site, cache } = await primed({ "/sitemap.xml": sitemapWith("/a") });
    site.files["/sitemap.xml"] = sitemapWith("/a", "/b"); // changed, so revalidation falls through to discovery
    now += 2 * DAY;
    const result = await cache.resolve({
      origin: ORIGIN,
      fetch: site.fetch(clock),
      discover: async () => {
        throw new Error("boom");
      },
    });
    expect(result).toMatchObject({ ok: true, source: "stale", stale: true });
  });
});

describe("cacheFileName", () => {
  it("drops the scheme and replaces unsafe characters", () => {
    expect(cacheFileName("https://Shop.Example")).toBe("shop.example.json");
    expect(cacheFileName("https://shop.example:8443")).toBe("shop.example_8443.json");
    expect(cacheFileName("https://[::1]:8443")).toBe("___1__8443.json");
  });
});
