import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GuardedFetchResult } from "../fetch/guardedFetch.js";
import type { CatalogFetch } from "./catalogFetch.js";
import { fetchSitemaps, MAX_SITEMAP_INDEX_CHILDREN, parseSitemap } from "./sitemap.js";
import { MAX_URL_LENGTH } from "./sameOrigin.js";

const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/sitemap/${name}`, import.meta.url), "utf8");
const ORIGIN = "https://www.peakdesign.com";

function fakeFetch(files: Record<string, string>) {
  const calls: string[] = [];
  const fetch: CatalogFetch = async (url) => {
    calls.push(url);
    const body = files[url];
    const result: GuardedFetchResult =
      body === undefined ? { kind: "absent", status: 404 } : { kind: "ok", status: 200, body, bytes: new Uint8Array(), finalUrl: url };
    return result;
  };
  return { fetch, calls };
}

const urlset = (...locs: string[]) =>
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((loc) => `<url><loc>${loc}</loc></url>`).join("")}</urlset>`;
const index = (...locs: string[]) =>
  `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`).join("")}</sitemapindex>`;

describe("parseSitemap", () => {
  it("parses a urlset with image titles and captions, keeping only same-origin https locs", () => {
    const parsed = parseSitemap(fixture("peak-urlset.xml"), ORIGIN);

    expect(parsed).toEqual({
      kind: "urlset",
      entries: [
        {
          url: "https://www.peakdesign.com/products/everyday-backpack",
          images: [
            { title: "Everyday Backpack 20L", caption: "Everyday Backpack 20L in Black, shown with the side access zip open" },
            { title: "Everyday Backpack 30L" },
          ],
        },
        {
          url: "https://www.peakdesign.com/products/capture-camera-clip?variant=1&color=black",
          images: [{ title: "Capture Camera Clip V3", caption: "Clip & plate, sold together" }],
        },
        { url: "https://www.peakdesign.com/pages/warranty", images: [] },
      ],
      droppedOffOrigin: 2,
    });
  });

  it("rejects XXE and billion-laughs documents before parsing", () => {
    expect(parseSitemap(fixture("xxe.xml"), ORIGIN)).toEqual({ kind: "rejected", reason: "doctype" });
    expect(parseSitemap(fixture("billion-laughs.xml"), ORIGIN)).toEqual({ kind: "rejected", reason: "doctype" });
    expect(parseSitemap(`<?xml version="1.0"?><!doctype urlset SYSTEM "x.dtd">${urlset(`${ORIGIN}/a`)}`, ORIGIN)).toEqual({
      kind: "rejected",
      reason: "doctype",
    });
  });

  it("keeps only absolute locs: empty, self-closing, and relative locs are dropped and counted", () => {
    const xml = `<urlset><url><loc></loc></url><url><loc/></url><url><loc>/rel</loc></url><url><loc>rel</loc></url><url><loc>${ORIGIN}/ok</loc></url></urlset>`;
    expect(parseSitemap(xml, ORIGIN)).toEqual({ kind: "urlset", entries: [{ url: `${ORIGIN}/ok`, images: [] }], droppedOffOrigin: 4 });
    expect(parseSitemap(index("/child.xml", ""), ORIGIN)).toEqual({ kind: "index", children: [], droppedOffOrigin: 2 });
  });

  it("does not turn a truncated document's open loc into the origin root", () => {
    const parsed = parseSitemap(`<urlset><url><loc>${ORIGIN}/a</loc></url><url><loc>`, ORIGIN);
    expect(parsed).toEqual({ kind: "urlset", entries: [{ url: `${ORIGIN}/a`, images: [] }], droppedOffOrigin: 1 });
  });

  it("drops locs longer than MAX_URL_LENGTH", () => {
    const long = `${ORIGIN}/${"p".repeat(MAX_URL_LENGTH)}`;
    expect(parseSitemap(urlset(long), ORIGIN)).toEqual({ kind: "urlset", entries: [], droppedOffOrigin: 1 });
  });

  it("reads a sitemap index's same-origin children", () => {
    expect(parseSitemap(fixture("index.xml"), ORIGIN)).toEqual({
      kind: "index",
      children: [`${ORIGIN}/sitemap_products_1.xml?from=1&to=99`, `${ORIGIN}/sitemap_nested_index.xml`],
      droppedOffOrigin: 1,
    });
  });

  it("rejects a document that is not a sitemap", () => {
    expect(parseSitemap("<html><body>hi</body></html>", ORIGIN)).toMatchObject({ kind: "rejected" });
  });
});

describe("fetchSitemaps", () => {
  it("turns image titles into sitemap-image entries", async () => {
    const { fetch } = fakeFetch({ [`${ORIGIN}/sitemap.xml`]: fixture("peak-urlset.xml") });

    const { entries } = await fetchSitemaps(ORIGIN, [], fetch);

    expect(entries).toEqual([
      {
        url: `${ORIGIN}/products/everyday-backpack`,
        imageTitle: "Everyday Backpack 20L",
        imageCaption: "Everyday Backpack 20L in Black, shown with the side access zip open",
        provenance: "sitemap-image",
      },
      {
        url: `${ORIGIN}/products/capture-camera-clip?variant=1&color=black`,
        imageTitle: "Capture Camera Clip V3",
        imageCaption: "Clip & plate, sold together",
        provenance: "sitemap-image",
      },
      { url: `${ORIGIN}/pages/warranty`, provenance: "sitemap" },
    ]);
  });

  it("reads only the first ten children of a fifty-child index", async () => {
    const children = Array.from({ length: 50 }, (_, i) => `${ORIGIN}/sitemap_${i}.xml`);
    const files: Record<string, string> = { [`${ORIGIN}/sitemap.xml`]: index(...children) };
    for (const [i, child] of children.entries()) files[child] = urlset(`${ORIGIN}/page-${i}`);
    const { fetch, calls } = fakeFetch(files);

    const { entries, counters } = await fetchSitemaps(ORIGIN, [], fetch);

    expect(calls).toEqual([`${ORIGIN}/sitemap.xml`, ...children.slice(0, MAX_SITEMAP_INDEX_CHILDREN)]);
    expect(entries).toHaveLength(MAX_SITEMAP_INDEX_CHILDREN);
    expect(counters.childrenSkipped).toBe(40);
  });

  it("ignores an index nested inside an index (depth 2)", async () => {
    const { fetch, calls } = fakeFetch({
      [`${ORIGIN}/sitemap.xml`]: index(`${ORIGIN}/nested-index.xml`, `${ORIGIN}/products.xml`),
      [`${ORIGIN}/nested-index.xml`]: index(`${ORIGIN}/deep.xml`),
      [`${ORIGIN}/products.xml`]: urlset(`${ORIGIN}/products/a`),
      [`${ORIGIN}/deep.xml`]: urlset(`${ORIGIN}/products/deep`),
    });

    const { entries, counters } = await fetchSitemaps(ORIGIN, [], fetch);

    expect(calls).not.toContain(`${ORIGIN}/deep.xml`);
    expect(entries.map((entry) => entry.url)).toEqual([`${ORIGIN}/products/a`]);
    expect(counters.nestedIndexesIgnored).toBe(1);
  });

  it("adds same-origin robots sitemaps, deduplicated, and counts rejected documents", async () => {
    const { fetch, calls } = fakeFetch({
      [`${ORIGIN}/sitemap.xml`]: fixture("xxe.xml"),
      [`${ORIGIN}/sitemap_pages.xml`]: urlset(`${ORIGIN}/pages/about`),
    });

    const { entries, counters } = await fetchSitemaps(
      ORIGIN,
      [`${ORIGIN}/sitemap.xml`, `${ORIGIN}/sitemap_pages.xml`, "https://evil.example/sitemap.xml"],
      fetch,
    );

    expect(calls).toEqual([`${ORIGIN}/sitemap.xml`, `${ORIGIN}/sitemap_pages.xml`]);
    expect(entries).toEqual([{ url: `${ORIGIN}/pages/about`, provenance: "sitemap" }]);
    expect(counters).toMatchObject({ rejected: 1, droppedOffOrigin: 1, filesFetched: 2 });
  });

  it("drops relative robots Sitemap: lines instead of fetching them", async () => {
    const { fetch, calls } = fakeFetch({ [`${ORIGIN}/sitemap.xml`]: urlset(`${ORIGIN}/a`) });

    const { counters } = await fetchSitemaps(ORIGIN, ["/sitemap_rel.xml", "sitemap_rel2.xml", ""], fetch);

    expect(calls).toEqual([`${ORIGIN}/sitemap.xml`]);
    expect(counters.droppedOffOrigin).toBe(3);
  });

  it("stops collecting and fetching once the entry cap is reached", async () => {
    const page = (file: number, count: number) => Array.from({ length: count }, (_, i) => `${ORIGIN}/f${file}/p${i}`);
    const children = [0, 1, 2, 3].map((i) => `${ORIGIN}/sitemap_${i}.xml`);
    const files: Record<string, string> = { [`${ORIGIN}/sitemap.xml`]: index(...children) };
    for (const [i, child] of children.entries()) files[child] = urlset(...page(i, 4));
    const { fetch, calls } = fakeFetch(files);

    const { entries, counters } = await fetchSitemaps(ORIGIN, [], fetch, { maxEntries: 10 });

    expect(entries.map((entry) => entry.url)).toEqual([...page(0, 4), ...page(1, 4), ...page(2, 2)]);
    expect(counters.entriesSkipped).toBe(2);
    expect(calls).toEqual([`${ORIGIN}/sitemap.xml`, ...children.slice(0, 3)]);
  });
});
