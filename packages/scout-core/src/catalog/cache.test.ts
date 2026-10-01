import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheFileName } from "../privateCacheFile.js";
import { createDiagnostics, type DiagnosticFields, type Diagnostics } from "../diagnostics.js";
import type { GuardedFetchOptions, GuardedFetchResult } from "../fetch/guardedFetch.js";
import { CATALOG_CACHE_SCHEMA_VERSION, CATALOG_FRESH_MS, CATALOG_STALE_MAX_MS, createCatalogCache } from "./cache.js";
import { SITEMAP_MAX_BYTES, TEXT_SOURCE_MAX_BYTES } from "./catalogFetch.js";
import { createPacedCatalogFetch, type PacedCatalogFetchOptions } from "./pacing.js";

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
    guardedFetch,
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
    expect(statSync(join(dir, cacheFileName(ORIGIN))).mode & 0o777).toBe(0o600);
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

  it("revalidates at exactly 24 h and fails at exactly 7 days", async () => {
    const { site, cache } = await primed({ "/sitemap.xml": sitemapWith("/a") });
    const primedAt = now;
    now = primedAt + CATALOG_FRESH_MS;
    expect(await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) })).toMatchObject({ ok: true, source: "not_modified" });

    const bumpedAt = now;
    site.setDown(true);
    now = bumpedAt + CATALOG_STALE_MAX_MS - 1;
    expect(await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) })).toMatchObject({ ok: true, source: "stale" });
    now = bumpedAt + CATALOG_STALE_MAX_MS;
    expect(await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) })).toMatchObject({ ok: false, code: "discover_failed" });
  });

  it("revalidates each resource with the size cap discovery used", async () => {
    const { site, cache } = await primed({ "/robots.txt": `User-agent: *\nSitemap: ${ORIGIN}/sitemap.xml`, "/sitemap.xml": sitemapWith("/a") });
    now += 25 * HOUR;

    await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) });

    expect(site.requests.find((r) => r.path === "/robots.txt")?.options.maxBytes).toBe(TEXT_SOURCE_MAX_BYTES);
    expect(site.requests.find((r) => r.path === "/sitemap.xml")?.options.maxBytes).toBe(SITEMAP_MAX_BYTES);
  });

  it("treats a file for another origin as a miss, distinct from corrupt or wrong-schema", async () => {
    const { site, cache } = await primed({ "/sitemap.xml": sitemapWith("/a") });
    const path = join(dir, cacheFileName(ORIGIN));
    const file = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...file, catalog: { ...file.catalog, origin: "https://other.example" } }));
    events = [];

    expect(cache.load(ORIGIN)).toBeNull();
    expect(events).toEqual([{ name: "catalog_cache_invalid", fields: { origin: ORIGIN, code: "origin" } }]);
    expect(await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) })).toMatchObject({ ok: true, source: "miss" });
  });

  it("treats a fetchedAt more than 5 minutes in the future as invalid", async () => {
    const { cache } = await primed({ "/sitemap.xml": sitemapWith("/a") });
    const path = join(dir, cacheFileName(ORIGIN));
    const file = JSON.parse(readFileSync(path, "utf8"));
    const dated = (fetchedAt: number) => JSON.stringify({ ...file, fetchedAt, catalog: { ...file.catalog, fetchedAt } });
    writeFileSync(path, dated(now + 5 * 60 * 1000));
    expect(cache.load(ORIGIN)).not.toBeNull();

    writeFileSync(path, dated(now + 5 * 60 * 1000 + 1));
    events = [];
    expect(cache.load(ORIGIN)).toBeNull();
    expect(events).toEqual([{ name: "catalog_cache_invalid", fields: { origin: ORIGIN, code: "future" } }]);
  });

  // Zod already rejects a non-finite number (`parse`); the explicit finiteness check backs it up.
  it.each([
    ["an inner fetchedAt that differs from the outer", "fetched_at", (file: { fetchedAt: number; catalog: object }) => ({ ...file, catalog: { ...file.catalog, fetchedAt: 1e20 } })],
    ["a non-finite outer fetchedAt", "parse", (file: { fetchedAt: number }) => ({ ...file, fetchedAt: "__INF__" })],
  ])("treats %s as a miss", async (_label, code, tamper) => {
    const { site, cache } = await primed({ "/sitemap.xml": sitemapWith("/a") });
    const path = join(dir, cacheFileName(ORIGIN));
    const file = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify(tamper(file)).replace('"__INF__"', "1e400"));
    events = [];

    expect(cache.load(ORIGIN)).toBeNull();
    expect(events).toEqual([{ name: "catalog_cache_invalid", fields: { origin: ORIGIN, code } }]);
    expect(await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) })).toMatchObject({ ok: true, source: "miss" });
  });

  it("still returns the catalog when the cache cannot be written", async () => {
    const root = join(dir, "..", "..");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "cache"), "a file where the cache directory should be");
    const cache = createCatalogCache({ dir, clock, diagnostics });

    const result = await cache.resolve({ origin: ORIGIN, fetch: fakeSite({ "/sitemap.xml": sitemapWith("/a") }).fetch(clock) });

    expect(result).toMatchObject({ ok: true, source: "miss" });
    expect(result.ok && result.catalog.candidates).toHaveLength(1);
    expect(events.find((e) => e.name === "catalog_cache_write_failed")?.fields).toEqual({ origin: ORIGIN, code: "enotdir" });
  });

  it("reports not_directory when the cache directory path is a regular file", async () => {
    mkdirSync(join(dir, ".."), { recursive: true });
    writeFileSync(dir, "a file where the cache directory should be");
    const cache = createCatalogCache({ dir, clock, diagnostics });

    const result = await cache.resolve({ origin: ORIGIN, fetch: fakeSite({ "/sitemap.xml": sitemapWith("/a") }).fetch(clock) });

    expect(result).toMatchObject({ ok: true, source: "miss" });
    expect(events.find((e) => e.name === "catalog_cache_write_failed")?.fields).toEqual({ origin: ORIGIN, code: "not_directory" });
    expect(readFileSync(dir, "utf8")).toBe("a file where the cache directory should be");
  });

  it("refuses a symlinked cache directory without writing through it", async () => {
    const target = join(dir, "..", "elsewhere");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    symlinkSync(target, dir);
    const cache = createCatalogCache({ dir, clock, diagnostics });
    const site = fakeSite({ "/sitemap.xml": sitemapWith("/a") });

    const result = await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) });

    expect(result).toMatchObject({ ok: true, source: "miss" });
    expect(events.find((e) => e.name === "catalog_cache_write_failed")?.fields).toEqual({ origin: ORIGIN, code: "symlink" });
    expect(readdirSync(target)).toEqual([]);
    // A file planted behind the link is not read either.
    writeFileSync(join(target, cacheFileName(ORIGIN)), "{}");
    expect(cache.load(ORIGIN)).toBeNull();
  });

  it("refuses an existing directory with group or other permission bits, without chmodding it", async () => {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const cache = createCatalogCache({ dir, clock, diagnostics });

    const result = await cache.resolve({ origin: ORIGIN, fetch: fakeSite({ "/sitemap.xml": sitemapWith("/a") }).fetch(clock) });

    expect(result).toMatchObject({ ok: true });
    expect(events.find((e) => e.name === "catalog_cache_write_failed")?.fields).toEqual({ origin: ORIGIN, code: "not_private" });
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("caches an origin with a 249-character hostname", async () => {
    const label = "a".repeat(60);
    const host = `${label}.${label}.${label}.${label}.shops`; // 249 characters
    expect(host).toHaveLength(249);
    const origin = `https://${host}`;
    const guardedFetch = async (url: string): Promise<GuardedFetchResult> =>
      new URL(url).pathname === "/sitemap.xml"
        ? { kind: "ok", status: 200, body: `<urlset><url><loc>${origin}/a</loc></url></urlset>`, bytes: new Uint8Array(), finalUrl: url }
        : { kind: "absent", status: 404 };
    const cache = createCatalogCache({ dir, clock, diagnostics });

    const result = await cache.resolve({ origin, fetch: createPacedCatalogFetch({ origin, clock, guardedFetch }) });

    expect(result).toMatchObject({ ok: true, source: "miss" });
    expect(events.some((e) => e.name === "catalog_cache_write_failed")).toBe(false);
    expect(cache.load(origin)?.origin).toBe(origin);
  });

  it("survives two concurrent resolves on the same cache", async () => {
    const site = fakeSite({ "/sitemap.xml": sitemapWith("/a", "/b") });
    const cache = createCatalogCache({ dir, clock, diagnostics });

    const [a, b] = await Promise.all([cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) }), cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) })]);

    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    expect(cache.load(ORIGIN)?.catalog.candidates).toHaveLength(2);
    expect(readdirSync(dir)).toEqual([cacheFileName(ORIGIN)]);
  });

  it("emits only allowed diagnostic fields through the real diagnostics sink", async () => {
    const warnings: string[] = [];
    const lines: string[] = [];
    const real = createDiagnostics({ path: join(dir, "..", "diag.jsonl"), clock, appendFile: (_path, data) => void lines.push(data), warn: (m) => void warnings.push(m) });
    const site = fakeSite({ "/robots.txt": "User-agent: *\nDisallow: /private\nCrawl-delay: 1", "/llms.txt": `- [A](${ORIGIN}/a)`, "/sitemap.xml": sitemapWith("/b", "/private/c") });
    const cache = createCatalogCache({ dir, clock, diagnostics: real });

    await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) }); // miss: discovery
    now += 25 * HOUR;
    await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) }); // revalidation
    site.files["/sitemap.xml"] = sitemapWith("/b", "/d");
    now += 25 * HOUR;
    await cache.resolve({ origin: ORIGIN, fetch: site.fetch(clock) }); // refetch

    expect(lines.map((l) => JSON.parse(l).event)).toEqual(["catalog_discover", "catalog_cache", "catalog_cache", "catalog_discover", "catalog_cache"]);
    expect(warnings).toEqual([]);
    // The parser counters reach the sink under their prefixed names, none dropped by the key filter.
    const discover = JSON.parse(lines[0] as string);
    for (const key of [
      "resourceCount",
      "llmsDroppedOffOrigin",
      "llmsSkippedLines",
      "llmsNestedSkipped",
      "llmsNestedFailed",
      "sitemapChildrenSkipped",
      "sitemapNestedIndexesIgnored",
      "sitemapEntriesSkipped",
      "sitemapDroppedOffOrigin",
      "sitemapFilesAbsent",
      "robotsRulesTooLong",
      "robotsRulesOverLimit",
      "robotsRulesTooManyWildcards",
      "robotsChecks",
      "robotsWork",
    ]) {
      expect(JSON.stringify(discover), key).toContain(`"${key}":`);
    }
    expect(JSON.stringify(discover)).not.toContain('"requests":');
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

/**
 * A site with a sitemap index of `children` one-URL files and a robots crawl delay, on a
 * fake clock where every request takes 200 ms and sleeping advances time. Changing
 * `version` changes the last child's URL.
 */
function slowSite(children: number, delaySeconds: number) {
  let version = 1;
  const files = (): Record<string, string> => {
    const f: Record<string, string> = { "/robots.txt": `User-agent: *\nCrawl-delay: ${delaySeconds}\n` };
    let index = "<sitemapindex>";
    for (let i = 0; i < children; i++) {
      index += `<sitemap><loc>${ORIGIN}/s${i}.xml</loc></sitemap>`;
      f[`/s${i}.xml`] = sitemapWith(`/p${i}-v${i === children - 1 ? version : 1}`);
    }
    f["/sitemap.xml"] = `${index}</sitemapindex>`;
    return f;
  };
  let requests = 0;
  const guardedFetch = async (url: string, options: GuardedFetchOptions): Promise<GuardedFetchResult> => {
    requests += 1;
    now += 200;
    const path = new URL(url).pathname;
    const body = files()[path];
    if (body === undefined) return { kind: "absent", status: 404 };
    const etag = `"${Buffer.from(body).toString("base64url")}"`; // changes only when the body does
    if (options.ifNoneMatch === etag) return { kind: "not_modified", etag };
    return { kind: "ok", status: 200, body, bytes: new TextEncoder().encode(body), etag, finalUrl: url };
  };
  return {
    setVersion: (v: number) => void (version = v),
    requests: () => requests,
    fetch: (extra: Partial<PacedCatalogFetchOptions> = {}) =>
      createPacedCatalogFetch({ origin: ORIGIN, clock, guardedFetch, sleep: async (ms) => void (now += ms), ...extra }),
  };
}

describe("createCatalogCache run windows and refusals", () => {
  it("rediscovers in its own window: one change under a 5 s crawl delay rebuilds the whole 10-child catalog", async () => {
    const site = slowSite(10, 5);
    const cache = createCatalogCache({ dir, clock, diagnostics });
    const first = await cache.resolve({ origin: ORIGIN, fetch: site.fetch() });
    expect(first.ok && first.catalog.candidates).toHaveLength(10);

    now += 25 * HOUR;
    site.setVersion(2);
    const fetch = site.fetch();
    const second = await cache.resolve({ origin: ORIGIN, fetch });

    expect(second).toMatchObject({ ok: true, source: "refetched", stale: false });
    expect(second.ok && second.catalog.errors).toEqual([]);
    expect(second.ok && second.catalog.candidates.map((c) => c.sourceUrl)).toContain(`${ORIGIN}/p9-v2`);
    expect(second.ok && second.catalog.candidates).toHaveLength(10);
    expect(fetch.refused).toBe(0);
  });

  it("keeps a complete catalog, served stale, when a refused rediscovery finds fewer candidates", async () => {
    const site = slowSite(10, 5);
    const cache = createCatalogCache({ dir, clock, diagnostics });
    const first = await cache.resolve({ origin: ORIGIN, fetch: site.fetch() });
    expect(first.ok && first.catalog.candidates).toHaveLength(10);

    now += 25 * HOUR;
    site.setVersion(2);
    events = [];
    // A tighter window cuts rediscovery short partway through the children.
    const second = await cache.resolve({ origin: ORIGIN, fetch: site.fetch({ runDeadlineMs: 30_000 }) });

    expect(second).toMatchObject({ ok: true, source: "stale", stale: true });
    expect(second.ok && first.ok && second.catalog).toEqual(first.ok && first.catalog);
    expect(cache.load(ORIGIN)?.catalog).toEqual(first.ok && first.catalog);
    expect(events.find((e) => e.name === "catalog_cache")?.fields).toMatchObject({ source: "stale", code: "rediscovery_refused" });
  });

  it("never freezes a deadline-cut catalog: refused resources force rediscovery next time", async () => {
    const site = slowSite(10, 10);
    const cache = createCatalogCache({ dir, clock, diagnostics });
    const first = await cache.resolve({ origin: ORIGIN, fetch: site.fetch() });
    const firstCount = first.ok ? first.catalog.candidates.length : 0;
    expect(firstCount).toBeGreaterThan(0);
    expect(firstCount).toBeLessThan(10);
    const stored = cache.load(ORIGIN)?.resources ?? [];
    expect(stored.some((r) => r.status === "refused")).toBe(true);
    expect(stored.some((r) => r.status === "error")).toBe(false);

    now += 25 * HOUR;
    const before = site.requests();
    const second = await cache.resolve({ origin: ORIGIN, fetch: site.fetch() });

    expect(second).toMatchObject({ ok: true, source: "refetched" });
    // No revalidation probes were spent: the refused resource marked the catalog as changed up front.
    expect(site.requests() - before).toBeLessThanOrEqual(firstCount + 3);
    expect(cache.load(ORIGIN)?.fetchedAt).toBe(now);
  });

  it("gives rediscovery its own window after a slow revalidation", async () => {
    const site = slowSite(3, 10);
    const cache = createCatalogCache({ dir, clock, diagnostics });
    const first = await cache.resolve({ origin: ORIGIN, fetch: site.fetch() });
    expect(first.ok && first.catalog.candidates).toHaveLength(3);

    now += 25 * HOUR;
    site.setVersion(2);
    const started = now;
    const fetch = site.fetch();
    const second = await cache.resolve({ origin: ORIGIN, fetch });

    expect(second).toMatchObject({ ok: true, source: "refetched", stale: false });
    expect(second.ok && second.catalog.candidates.map((c) => c.sourceUrl)).toContain(`${ORIGIN}/p2-v2`);
    expect(fetch.refused).toBe(0);
    // Revalidation (~51 s) plus rediscovery (~51 s): more than one 90 s window in total.
    expect(now - started).toBeGreaterThan(90_000);
  });
});

describe("cacheFileName", () => {
  it("drops the scheme, replaces unsafe characters, and appends an origin hash", () => {
    expect(cacheFileName("https://Shop.Example")).toMatch(/^shop\.example-[0-9a-f]{16}\.json$/);
    expect(cacheFileName("https://Shop.Example")).toBe(cacheFileName("https://shop.example:443"));
    expect(cacheFileName("https://shop.example:8443")).toMatch(/^shop\.example_8443-[0-9a-f]{16}\.json$/);
    expect(cacheFileName("https://[::1]:8443")).toMatch(/^___1__8443-[0-9a-f]{16}\.json$/);
  });

  it("gives origins whose readable prefixes collide different files", () => {
    // `_` is legal in a hostname and `:` becomes `_`, so both prefixes read "a_8443".
    expect(cacheFileName("https://a_8443")).not.toBe(cacheFileName("https://a:8443"));
    expect(cacheFileName("https://a_8443").startsWith("a_8443-")).toBe(true);
    expect(cacheFileName("https://a:8443").startsWith("a_8443-")).toBe(true);
  });

  it("bounds the name length", () => {
    const name = cacheFileName(`https://${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(60)}.example`);
    expect(name.length).toBe(100 + 1 + 16 + 5);
  });
});
