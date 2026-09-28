import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GuardedFetchResult } from "../fetch/guardedFetch.js";
import type { CatalogFetch } from "./catalogFetch.js";
import { fetchSitemaps, MAX_SITEMAP_INDEX_CHILDREN, parseSitemap } from "./sitemap.js";

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
});
