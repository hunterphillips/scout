import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Diagnostics, DiagnosticFields } from "../diagnostics.js";
import type { GuardedFetchResult } from "../fetch/guardedFetch.js";
import type { CatalogFetch } from "./catalogFetch.js";
import { discoverCatalog, MAX_CANDIDATES, normalizeUrl, slugTitle } from "./resolver.js";

const ORIGIN = "https://shop.example";
const clock = { now: () => 1_000 };
const llmsFixture = (name: string) => readFileSync(new URL(`../../test/fixtures/llms/${name}`, import.meta.url), "utf8");

function fakeFetch(files: Record<string, string>) {
  const calls: string[] = [];
  const fetch: CatalogFetch = async (url) => {
    calls.push(url);
    const body = files[url];
    const result: GuardedFetchResult =
      body === undefined ? { kind: "absent", status: 404 } : { kind: "ok", status: 200, body, bytes: new Uint8Array(), etag: `"${url.length}"`, finalUrl: url };
    return result;
  };
  return { fetch, calls };
}

interface Loc {
  loc: string;
  imageTitle?: string;
  caption?: string;
}
const urlset = (locs: Loc[]) =>
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${locs
    .map(
      ({ loc, imageTitle, caption }) =>
        `<url><loc>${loc}</loc>${
          imageTitle ? `<image:image><image:title>${imageTitle}</image:title>${caption ? `<image:caption>${caption}</image:caption>` : ""}</image:image>` : ""
        }</url>`,
    )
    .join("")}</urlset>`;

/** 3,000 product URLs; every 12th (250 total) has an image title and they sit at the end of the document. */
function bigSitemap(titleFor: (i: number) => string = (i) => `Product ${i}`): string {
  const locs: Loc[] = [];
  for (let i = 0; i < 3000; i++) locs.push(i % 12 === 11 ? { loc: `${ORIGIN}/products/item-${i}`, imageTitle: titleFor(i) } : { loc: `${ORIGIN}/products/item-${i}` });
  // Put the image-titled entries last in document order so position alone would drop them.
  locs.sort((a, b) => Number(a.imageTitle !== undefined) - Number(b.imageTitle !== undefined));
  return urlset(locs);
}

function recordingDiagnostics() {
  const events: { name: string; fields: DiagnosticFields }[] = [];
  const diagnostics: Diagnostics = { event: (name, fields = {}) => void events.push({ name, fields }), failures: 0 };
  return { diagnostics, events };
}

describe("discoverCatalog", () => {
  it("caps a 3,000-URL sitemap at 500, keeping every image_title entry", async () => {
    const { fetch } = fakeFetch({ [`${ORIGIN}/sitemap.xml`]: bigSitemap() });

    const { catalog, stats } = await discoverCatalog({ origin: ORIGIN, fetch, clock });

    expect(catalog.candidates).toHaveLength(MAX_CANDIDATES);
    expect(catalog.truncated).toBe(true);
    const imageTitled = catalog.candidates.filter((c) => c.labelQuality === "image_title");
    expect(imageTitled).toHaveLength(250);
    // Classes stay contiguous: every image_title entry precedes every slug entry.
    expect(catalog.candidates.slice(0, 250).every((c) => c.labelQuality === "image_title")).toBe(true);
    // The kept slugs are the first 250 in document order.
    expect(catalog.candidates[250]).toMatchObject({ sourceUrl: `${ORIGIN}/products/item-0`, title: "item 0", labelQuality: "slug", provenance: "sitemap" });
    expect(catalog.candidates.map((c) => c.id).slice(0, 3)).toEqual(["c0", "c1", "c2"]);
    expect(catalog.candidates.at(-1)?.id).toBe(`c${(MAX_CANDIDATES - 1).toString(36)}`);
    expect(stats.capped).toBe(2500);
  });

  it("produces a stable version that changes when a label changes", async () => {
    const run = (titleFor?: (i: number) => string) =>
      discoverCatalog({ origin: ORIGIN, fetch: fakeFetch({ [`${ORIGIN}/sitemap.xml`]: bigSitemap(titleFor) }).fetch, clock });

    const [a, b, c] = await Promise.all([run(), run(), run((i) => (i === 11 ? "Renamed" : `Product ${i}`))]);

    expect(a.catalog.version).toMatch(/^[0-9a-f]{16}$/);
    expect(b.catalog.version).toBe(a.catalog.version);
    expect(c.catalog.version).not.toBe(a.catalog.version);
  });

  it("drops robots-disallowed paths and honors robots Sitemap lines", async () => {
    const { fetch } = fakeFetch({
      [`${ORIGIN}/robots.txt`]: `User-agent: *\nDisallow: /cart\nDisallow: /*?sort=\nSitemap: ${ORIGIN}/products.xml`,
      [`${ORIGIN}/products.xml`]: urlset([{ loc: `${ORIGIN}/cart/checkout` }, { loc: `${ORIGIN}/bags?sort=price` }, { loc: `${ORIGIN}/bags/tote` }]),
    });

    const { catalog, stats } = await discoverCatalog({ origin: ORIGIN, fetch, clock });

    expect(catalog.candidates.map((c) => c.sourceUrl)).toEqual([`${ORIGIN}/bags/tote`]);
    expect(stats.disallowed).toBe(2);
  });

  it("keeps an injection llms.txt to plain same-origin labels", async () => {
    const origin = "https://docs.stripe.com";
    const { fetch } = fakeFetch({ [`${origin}/llms.txt`]: llmsFixture("injection.txt") });

    const { catalog } = await discoverCatalog({ origin, fetch, clock });

    expect(catalog.candidates.length).toBeGreaterThan(0);
    for (const candidate of catalog.candidates) {
      expect(new URL(candidate.sourceUrl).origin).toBe(origin);
      expect(JSON.stringify(candidate)).not.toContain("evil.example/");
      for (const label of [candidate.title, candidate.description ?? ""]) expect(label).not.toMatch(/[<>[\]`]|\]\(|\p{Cf}/u);
    }
    expect(catalog.candidates[0]).toMatchObject({ labelQuality: "published", provenance: "llms.txt" });
  });

  it("dedupes by normalized URL, letting the published entry win and keeping sourceUrl as published", async () => {
    const { fetch } = fakeFetch({
      [`${ORIGIN}/llms.txt`]: `- [Travel Backpack](${ORIGIN}/products/travel-backpack?utm_source=llms): The bag.\n- [](${ORIGIN}/guides/packing-list)`,
      [`${ORIGIN}/sitemap.xml`]: urlset([
        { loc: `${ORIGIN}/products/travel-backpack` },
        { loc: `${ORIGIN}/products/travel-backpack#reviews` },
        { loc: `${ORIGIN}/products/travel-backpack/` },
        { loc: `${ORIGIN}/guides/packing-list`, imageTitle: "Packing list" },
      ]),
    });

    const { catalog, stats } = await discoverCatalog({ origin: ORIGIN, fetch, clock });

    expect(catalog.candidates).toEqual([
      {
        id: "c0",
        sourceUrl: `${ORIGIN}/products/travel-backpack?utm_source=llms`,
        title: "Travel Backpack",
        description: "The bag.",
        labelQuality: "published",
        provenance: "llms.txt",
      },
      // The untitled llms entry ranks as a slug, so the image-titled sitemap entry wins.
      { id: "c1", sourceUrl: `${ORIGIN}/guides/packing-list`, title: "Packing list", labelQuality: "image_title", provenance: "sitemap-image" },
      // Trailing slash is a different path.
      { id: "c2", sourceUrl: `${ORIGIN}/products/travel-backpack/`, title: "travel backpack", labelQuality: "slug", provenance: "sitemap" },
    ]);
    expect(stats.duplicates).toBe(3);
    expect(catalog.truncated).toBe(false);
  });

  it("caps label bytes by keeping a prefix of the class order", async () => {
    const description = "d".repeat(390);
    const llms = Array.from({ length: 4 }, (_, i) => `- [Doc ${i}](${ORIGIN}/docs/${i}): ${description}`).join("\n");
    const { fetch } = fakeFetch({
      [`${ORIGIN}/llms.txt`]: llms,
      [`${ORIGIN}/sitemap.xml`]: urlset([{ loc: `${ORIGIN}/a` }, { loc: `${ORIGIN}/b`, imageTitle: "B" }]),
    });

    // Room for three published entries (~395 bytes each) and then some, but not the fourth.
    const { catalog } = await discoverCatalog({ origin: ORIGIN, fetch, clock, maxLabelBytes: 1300 });

    expect(catalog.candidates.map((c) => c.title)).toEqual(["Doc 0", "Doc 1", "Doc 2"]);
    expect(catalog.truncated).toBe(true);
  });

  it("records resources, short error codes, and URL-free diagnostics", async () => {
    const fetch: CatalogFetch = async (url) =>
      url.endsWith("/robots.txt")
        ? { kind: "error", reason: "network", message: `failed ${url}` }
        : url.endsWith("/sitemap.xml")
          ? { kind: "ok", status: 200, body: urlset([{ loc: `${ORIGIN}/x` }]), bytes: new Uint8Array(), etag: '"s1"', lastModified: "Mon, 01 Sep 2026 00:00:00 GMT", finalUrl: url }
          : { kind: "absent", status: 404 };
    const { diagnostics, events } = recordingDiagnostics();

    const result = await discoverCatalog({ origin: ORIGIN, fetch, clock, diagnostics });

    expect(result.catalog.errors).toEqual(["robots:error"]);
    expect(result.failed).toBe(false);
    expect(result.resources).toEqual([
      { url: `${ORIGIN}/robots.txt`, status: "error" },
      { url: `${ORIGIN}/llms.txt`, status: "absent" },
      { url: `${ORIGIN}/sitemap.xml`, status: "ok", etag: '"s1"', lastModified: "Mon, 01 Sep 2026 00:00:00 GMT" },
    ]);
    const event = events.find((e) => e.name === "catalog_discover");
    expect(event?.fields).toMatchObject({ origin: ORIGIN, candidateCount: 1, robotsSource: "error" });
    for (const [key, value] of Object.entries(event?.fields ?? {})) if (key !== "origin") expect(String(value)).not.toContain("://");
  });

  it("marks a run with only failures as failed", async () => {
    const fetch: CatalogFetch = async () => ({ kind: "error", reason: "timeout", message: "t" });
    const result = await discoverCatalog({ origin: ORIGIN, fetch, clock });
    expect(result.failed).toBe(true);
    expect(result.catalog.candidates).toEqual([]);
  });

  it("passes robots' crawl delay to the fetch", async () => {
    const { fetch: base } = fakeFetch({ [`${ORIGIN}/robots.txt`]: "User-agent: *\nCrawl-delay: 2" });
    const delays: (number | undefined)[] = [];
    const fetch = Object.assign(base, { setCrawlDelay: (ms: number | undefined) => void delays.push(ms) });

    const result = await discoverCatalog({ origin: ORIGIN, fetch, clock });

    expect(delays).toEqual([2000]);
    expect(result.crawlDelayMs).toBe(2000);
  });
});

describe("normalizeUrl", () => {
  it("strips fragments and tracking parameters and lowercases the host", () => {
    expect(normalizeUrl("https://Shop.Example:443/P?utm_source=x&id=1&gclid=2&REF=3#top")).toBe("https://shop.example/P?id=1");
    expect(normalizeUrl("https://shop.example/p?utm_medium=a")).toBe("https://shop.example/p");
  });
});

describe("slugTitle", () => {
  it("labels a URL from its last meaningful path segment", () => {
    expect(slugTitle("https://shop.example/products/travel-backpack")).toBe("travel backpack");
    expect(slugTitle("https://shop.example/docs/api_keys.html")).toBe("api keys");
    expect(slugTitle("https://shop.example/guides/camera%20straps+clips/")).toBe("camera straps clips");
    expect(slugTitle("https://shop.example/guides/index.html")).toBe("guides");
    expect(slugTitle("https://shop.example/")).toBe("shop.example");
  });
});
