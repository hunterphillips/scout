import { XMLParser } from "fast-xml-parser";
import { type CatalogFetch, SITEMAP_MAX_BYTES } from "./catalogFetch.js";
import { sameOriginHttpsUrl } from "./sameOrigin.js";
import { CANDIDATE_DESCRIPTION_MAX, CANDIDATE_TITLE_MAX, sanitizeLabel } from "./sanitizeLabel.js";

/** Most child sitemaps read from one sitemap index. */
export const MAX_SITEMAP_INDEX_CHILDREN = 10;

/** Most top-level sitemap files read: `/sitemap.xml` plus robots `Sitemap:` URLs. */
export const MAX_ROOT_SITEMAPS = 5;

export interface SitemapImage {
  title?: string;
  caption?: string;
}

export interface SitemapUrl {
  url: string;
  images: SitemapImage[];
}

export type SitemapRejectReason = "doctype" | "malformed" | "not_sitemap";

export type ParsedSitemap =
  | { kind: "urlset"; entries: SitemapUrl[]; droppedOffOrigin: number }
  | { kind: "index"; children: string[]; droppedOffOrigin: number }
  | { kind: "rejected"; reason: SitemapRejectReason };

export interface SitemapEntry {
  url: string;
  imageTitle?: string;
  imageCaption?: string;
  /** `sitemap-image` when an image title is present; the resolver decides label quality. */
  provenance: "sitemap" | "sitemap-image";
}

export interface SitemapCounters {
  /** Files that returned a body. */
  filesFetched: number;
  /** Files that were absent (404/410). */
  filesAbsent: number;
  /** Files whose fetch failed for any other reason. */
  fetchErrors: number;
  /** Files rejected by the parser (DOCTYPE, malformed, not a sitemap). */
  rejected: number;
  /** Index children beyond `MAX_SITEMAP_INDEX_CHILDREN`, and top-level sitemaps beyond `MAX_ROOT_SITEMAPS`. */
  childrenSkipped: number;
  /** Index children that were themselves indexes (depth 2), not followed. */
  nestedIndexesIgnored: number;
  /** `loc`s and robots `Sitemap:` URLs dropped for not being same-origin `https:`. */
  droppedOffOrigin: number;
}

export interface FetchedSitemaps {
  entries: SitemapEntry[];
  counters: SitemapCounters;
}

// DTDs are refused outright: no internal subset, entity declarations, or external references.
const FORBIDDEN_DECLARATION = /<!(?:DOCTYPE|ENTITY)/i;

const ARRAY_TAGS = new Set(["url", "sitemap", "image"]);

// Entity expansion, DTD handling, attributes, and processing instructions are all off.
// `removeNSPrefix` lets `image:image` (or any prefix bound to the image namespace) and an
// unprefixed `image` read the same way.
const parser = new XMLParser({
  processEntities: false,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  allowBooleanAttributes: false,
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (tagName) => ARRAY_TAGS.has(tagName),
});

const PREDEFINED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Decode XML's five predefined entities and numeric character references in one pass.
 * The parser leaves entities alone (expansion is off), and sitemaps must escape `&` in
 * URLs. A single non-recursive pass cannot expand.
 */
function decodeXmlText(text: string): string {
  return text.replace(/&(?:#x([0-9a-f]{1,6})|#([0-9]{1,7})|(amp|lt|gt|quot|apos));/gi, (whole, hex?: string, dec?: string, name?: string) => {
    if (name !== undefined) return PREDEFINED_ENTITIES[name.toLowerCase()] ?? whole;
    const codePoint = hex !== undefined ? Number.parseInt(hex, 16) : Number(dec);
    return codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff) ? String.fromCodePoint(codePoint) : "";
  });
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return decodeXmlText(value);
  if (value !== null && typeof value === "object" && "#text" in value) return textOf((value as Record<string, unknown>)["#text"]);
  return undefined;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function field(node: unknown, key: string): unknown {
  return node !== null && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
}

/**
 * Parse a sitemap document (`urlset` or `sitemapindex`).
 *
 * Policy: any document containing `<!DOCTYPE` or `<!ENTITY` is rejected before parsing,
 * and the parser runs with entity processing, DTDs, and attributes off. Only same-origin
 * `https:` `loc`s are kept; the rest are counted. Image titles and captions pass through
 * `sanitizeLabel`.
 */
export function parseSitemap(xml: string, origin: string): ParsedSitemap {
  if (FORBIDDEN_DECLARATION.test(xml)) return { kind: "rejected", reason: "doctype" };
  let document: unknown;
  try {
    document = parser.parse(xml);
  } catch {
    return { kind: "rejected", reason: "malformed" };
  }

  let droppedOffOrigin = 0;
  const keep = (loc: unknown): string | null => {
    const text = textOf(loc);
    const url = text === undefined ? null : sameOriginHttpsUrl(text, origin);
    if (!url) droppedOffOrigin += 1;
    return url ? url.toString() : null;
  };

  const urlset = field(document, "urlset");
  if (urlset !== undefined) {
    const entries: SitemapUrl[] = [];
    for (const node of arrayOf(field(urlset, "url"))) {
      const url = keep(field(node, "loc"));
      if (!url) continue;
      const images: SitemapImage[] = [];
      for (const image of arrayOf(field(node, "image"))) {
        const title = sanitizeLabel(textOf(field(image, "title")) ?? "", CANDIDATE_TITLE_MAX);
        const caption = sanitizeLabel(textOf(field(image, "caption")) ?? "", CANDIDATE_DESCRIPTION_MAX);
        images.push({ ...(title ? { title } : {}), ...(caption ? { caption } : {}) });
      }
      entries.push({ url, images });
    }
    return { kind: "urlset", entries, droppedOffOrigin };
  }

  const index = field(document, "sitemapindex");
  if (index !== undefined) {
    const children: string[] = [];
    for (const node of arrayOf(field(index, "sitemap"))) {
      const url = keep(field(node, "loc"));
      if (url) children.push(url);
    }
    return { kind: "index", children, droppedOffOrigin };
  }

  return { kind: "rejected", reason: "not_sitemap" };
}

function toEntries(urls: SitemapUrl[]): SitemapEntry[] {
  return urls.map(({ url, images }) => {
    const titled = images.find((image) => image.title !== undefined);
    if (!titled?.title) return { url, provenance: "sitemap" };
    return {
      url,
      imageTitle: titled.title,
      ...(titled.caption ? { imageCaption: titled.caption } : {}),
      provenance: "sitemap-image",
    };
  });
}

/**
 * Read `${origin}/sitemap.xml` plus the robots `Sitemap:` URLs (same-origin only,
 * deduplicated, at most `MAX_ROOT_SITEMAPS`). A `sitemapindex` contributes its first
 * `MAX_SITEMAP_INDEX_CHILDREN` children, depth 1: a child that is itself an index is
 * ignored. Each file is capped at 2 MiB. Returns raw entries in document order plus
 * counters for diagnostics.
 */
export async function fetchSitemaps(origin: string, sitemapUrls: readonly string[], fetch: CatalogFetch): Promise<FetchedSitemaps> {
  const counters: SitemapCounters = {
    filesFetched: 0,
    filesAbsent: 0,
    fetchErrors: 0,
    rejected: 0,
    childrenSkipped: 0,
    nestedIndexesIgnored: 0,
    droppedOffOrigin: 0,
  };
  const entries: SitemapEntry[] = [];
  const visited = new Set<string>();

  const roots: string[] = [];
  for (const candidate of [`${origin}/sitemap.xml`, ...sitemapUrls]) {
    const url = sameOriginHttpsUrl(candidate, origin);
    if (!url) {
      counters.droppedOffOrigin += 1;
      continue;
    }
    if (!roots.includes(url.toString())) roots.push(url.toString());
  }
  counters.childrenSkipped += Math.max(0, roots.length - MAX_ROOT_SITEMAPS);

  const read = async (url: string): Promise<Exclude<ParsedSitemap, { kind: "rejected" }> | null> => {
    visited.add(url);
    const result = await fetch(url, { maxBytes: SITEMAP_MAX_BYTES, accept: "application/xml, text/xml" });
    if (result.kind === "absent") {
      counters.filesAbsent += 1;
      return null;
    }
    if (result.kind !== "ok") {
      counters.fetchErrors += 1;
      return null;
    }
    counters.filesFetched += 1;
    const parsed = parseSitemap(result.body, origin);
    if (parsed.kind === "rejected") {
      counters.rejected += 1;
      return null;
    }
    counters.droppedOffOrigin += parsed.droppedOffOrigin;
    return parsed;
  };

  for (const root of roots.slice(0, MAX_ROOT_SITEMAPS)) {
    if (visited.has(root)) continue;
    const parsed = await read(root);
    if (!parsed) continue;
    if (parsed.kind === "urlset") {
      entries.push(...toEntries(parsed.entries));
      continue;
    }
    counters.childrenSkipped += Math.max(0, parsed.children.length - MAX_SITEMAP_INDEX_CHILDREN);
    for (const child of parsed.children.slice(0, MAX_SITEMAP_INDEX_CHILDREN)) {
      if (visited.has(child)) continue;
      const childParsed = await read(child);
      if (!childParsed) continue;
      if (childParsed.kind === "index") {
        counters.nestedIndexesIgnored += 1;
        continue;
      }
      entries.push(...toEntries(childParsed.entries));
    }
  }
  return { entries, counters };
}
