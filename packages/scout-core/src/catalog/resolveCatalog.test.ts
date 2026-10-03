import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiagnosticFields, Diagnostics } from "../diagnostics.js";
import type { GuardedFetchOptions, GuardedFetchResult } from "../fetch/guardedFetch.js";
import { createOriginFetchSession, type OriginFetchSession } from "../fetch/originSession.js";
import { cacheFileName } from "../privateCacheFile.js";
import { createParsePool } from "./parseWorker.js";
import { createCatalogResolver } from "./resolveCatalog.js";

const ORIGIN = "https://s.example";
const LLMS = "# Site\n\n- [Docs](/docs): the docs\n- [API](/api): the API\n";
const SITEMAP = "<urlset><url><loc>https://s.example/a</loc></url><url><loc>https://s.example/b</loc></url></urlset>";

let home: string;
let events: { name: string; fields: DiagnosticFields }[];
const clock = { now: () => 1_800_000_000_000 };
const diagnostics: Diagnostics = { event: (name, fields = {}) => void events.push({ name, fields }), failures: 0 };
const cacheFile = () => join(home, "cache", "catalog", cacheFileName(ORIGIN));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "scout-resolve-catalog-"));
  events = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/**
 * A fake site. `onFetch` runs as each request reaches the network, before its answer, so a
 * test can cancel the session mid-pass the way the coordinator does.
 */
function site(responses: Record<string, string | number>, onFetch: (path: string) => void = () => {}) {
  const paths: string[] = [];
  const guardedFetch = async (url: string, _options: GuardedFetchOptions): Promise<GuardedFetchResult> => {
    const path = new URL(url).pathname;
    paths.push(path);
    onFetch(path);
    const r = responses[path];
    if (r === undefined || r === 404) return { kind: "absent", status: 404 };
    if (typeof r === "number") return { kind: "error", reason: "http", status: r, message: "http" };
    const bytes = new TextEncoder().encode(r);
    return { kind: "ok", status: 200, body: r, bytes, finalUrl: url };
  };
  return { guardedFetch, paths };
}

async function pass(guardedFetch: ReturnType<typeof site>["guardedFetch"], prepare: (session: OriginFetchSession) => void = () => {}) {
  const session = createOriginFetchSession({ origin: ORIGIN, clock, guardedFetch, sleep: async () => undefined });
  prepare(session);
  session.startWindow();
  const resolver = createCatalogResolver({ scoutHome: home, clock, diagnostics, guardedFetch, sleep: async () => undefined });
  return resolver.resolve(ORIGIN, { session });
}

describe("createCatalogResolver on a shared session", () => {
  it("never caches the partial catalog of a pass cancelled mid-way; the next uncancelled pass does", async () => {
    let session!: OriginFetchSession;
    // Cancel as llms.txt goes out: it still answers, and the sitemap after it is refused.
    const cancelling = site({ "/llms.txt": LLMS, "/sitemap.xml": SITEMAP }, (path) => {
      if (path === "/llms.txt") session.cancel();
    });
    const cancelled = await pass(cancelling.guardedFetch, (s) => (session = s));

    expect(cancelling.paths).not.toContain("/sitemap.xml");
    // Since P4.4 the resolver's pass also stops at its first yield once cancelled, so nothing usable comes back.
    expect(cancelled.result).toMatchObject({ ok: false, code: "discover_failed" });
    expect(!cancelled.result.ok && cancelled.result.errors).toEqual(expect.arrayContaining(["pass:cancelled", "fetch:refused"]));
    expect(existsSync(cacheFile())).toBe(false);
    // An empty cancelled catalog is a failed discovery: nothing to persist, so no skip either.
    expect(events.filter((e) => e.name === "catalog_cache").map((e) => e.fields["source"])).toEqual(["failed"]);

    events = [];
    const live = site({ "/llms.txt": LLMS, "/sitemap.xml": SITEMAP });
    const resolved = await pass(live.guardedFetch);
    expect(resolved.result).toMatchObject({ ok: true, source: "miss" });
    expect(existsSync(cacheFile())).toBe(true);
    expect(events.some((e) => e.name === "catalog_cache_skipped")).toBe(false);

    // The live pass's catalog is what the next visit reads.
    const again = await pass(site({}).guardedFetch);
    expect(again.result).toMatchObject({ ok: true, source: "fresh" });
    expect(again.result.ok && again.result.catalog.candidates.length).toBe(resolved.result.ok ? resolved.result.catalog.candidates.length : -1);
  });

  it("a pass cancelled after its last fetch answered (empty but not failed) is not saved: catalog_cache_skipped", async () => {
    let session!: OriginFetchSession;
    // Every file is absent: an empty catalog with no request error. The cancel lands as the last file answers.
    const s = site({}, (path) => {
      if (path === "/sitemap.xml") session.cancel();
    });
    const cancelled = await pass(s.guardedFetch, (x) => (session = x));
    expect(s.paths.at(-1)).toBe("/sitemap.xml");
    expect(cancelled.result).toMatchObject({ ok: true, source: "miss" });
    expect(cancelled.result.ok && cancelled.result.catalog.errors).toContain("pass:cancelled");
    expect(existsSync(cacheFile())).toBe(false);
    expect(events.filter((e) => e.name === "catalog_cache_skipped").map((e) => e.fields)).toEqual([{ origin: ORIGIN, reason: "cancelled" }]);
  });

  it("a cancel during revalidation leaves the cached file untouched: catalog_cache_skipped", async () => {
    const first = await pass(site({}).guardedFetch);
    expect(first.result).toMatchObject({ ok: true, source: "miss" });
    const before = readFileSync(cacheFile(), "utf8");
    const mtime = statSync(cacheFile()).mtimeMs;
    events = [];
    let session!: OriginFetchSession;
    // Revalidation asks for each stored file again; the cancel lands as the last one answers (still absent).
    const s = site({}, (path) => {
      if (path === "/sitemap.xml") session.cancel();
    });
    const session2 = createOriginFetchSession({ origin: ORIGIN, clock, guardedFetch: s.guardedFetch, sleep: async () => undefined });
    session = session2;
    session2.startWindow();
    const resolver = createCatalogResolver({ scoutHome: home, clock, diagnostics, guardedFetch: s.guardedFetch, sleep: async () => undefined });
    const again = await resolver.resolve(ORIGIN, { session: session2, refresh: true });
    expect(s.paths.at(-1)).toBe("/sitemap.xml");
    expect(again.result).toMatchObject({ ok: true, source: "not_modified" });
    expect(readFileSync(cacheFile(), "utf8")).toBe(before);
    expect(statSync(cacheFile()).mtimeMs).toBe(mtime);
    expect(events.filter((e) => e.name === "catalog_cache_skipped").map((e) => e.fields)).toEqual([{ origin: ORIGIN, reason: "cancelled" }]);
  });

  it("still caches a live pass whose sitemap failed, from its llms.txt", async () => {
    const failing = site({ "/llms.txt": LLMS, "/sitemap.xml": 500 });
    const resolved = await pass(failing.guardedFetch);

    expect(failing.paths).toContain("/sitemap.xml");
    expect(resolved.result).toMatchObject({ ok: true, source: "miss" });
    expect(resolved.result.ok && resolved.result.catalog.candidates.length).toBeGreaterThan(0);
    expect(resolved.result.ok && resolved.result.catalog.errors.length).toBeGreaterThan(0);
    expect(existsSync(cacheFile())).toBe(true);
    expect(events.some((e) => e.name === "catalog_cache_skipped")).toBe(false);
  });
});

describe("createCatalogResolver with the parse worker", () => {
  it("builds the same catalog as inline parsing, with every llms.txt and sitemap file parsed in the worker", async () => {
    const pool = createParsePool();
    let parsed = 0;
    const counting = {
      sitemap: (xml: string, origin: string) => (parsed++, pool.parsers.sitemap(xml, origin)),
      llmsTxt: (text: string, origin: string, base: string) => (parsed++, pool.parsers.llmsTxt(text, origin, base)),
    };
    try {
      const responses = { "/llms.txt": LLMS, "/sitemap.xml": SITEMAP };
      const inline = await createCatalogResolver({ scoutHome: home, clock, guardedFetch: site(responses).guardedFetch, sleep: async () => undefined }).resolve(ORIGIN, { refresh: true });
      rmSync(cacheFile(), { force: true });
      const viaWorker = await createCatalogResolver({ scoutHome: home, clock, guardedFetch: site(responses).guardedFetch, sleep: async () => undefined, parsers: counting }).resolve(ORIGIN, { refresh: true });
      expect(parsed).toBe(2);
      expect(viaWorker.result.ok && viaWorker.result.catalog.candidates).toEqual(inline.result.ok && inline.result.catalog.candidates);
    } finally {
      await pool.close();
    }
  });

  it("a parse cancelled mid-pass leaves no catalog in the cache", async () => {
    const pool = createParsePool();
    try {
      const responses = site({ "/llms.txt": LLMS, "/sitemap.xml": SITEMAP });
      const s = createOriginFetchSession({ origin: ORIGIN, clock, guardedFetch: responses.guardedFetch, sleep: async () => undefined });
      s.startWindow();
      // The pass is cancelled while the sitemap is in the worker: its parse rejects.
      const parsers = {
        llmsTxt: pool.parsers.llmsTxt,
        sitemap: (xml: string, origin: string) => {
          const parsing = pool.parsers.sitemap(xml, origin);
          s.cancel();
          pool.cancel();
          return parsing;
        },
      };
      const resolver = createCatalogResolver({ scoutHome: home, clock, guardedFetch: responses.guardedFetch, sleep: async () => undefined, parsers });
      const out = await resolver.resolve(ORIGIN, { session: s });
      expect(out.result.ok).toBe(false);
      expect(existsSync(cacheFile())).toBe(false);
    } finally {
      await pool.close();
    }
  });
});
