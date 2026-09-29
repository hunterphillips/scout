import { createHash } from "node:crypto";
import { type Candidate, type SiteCatalog, SiteCatalogSchema } from "@scout/contracts";
import type { Clock } from "../clock.js";
import type { Diagnostics } from "../diagnostics.js";
import type { GuardedFetchResult } from "../fetch/guardedFetch.js";
import type { CatalogFetch } from "./catalogFetch.js";
import { fetchLlmsTxt } from "./llmsTxt.js";
import { fetchRobots, isAllowed, type RobotsSource } from "./robots.js";
import { sameOriginHttpsUrl } from "./sameOrigin.js";
import { CANDIDATE_TITLE_MAX, sanitizeLabel } from "./sanitizeLabel.js";
import { fetchSitemaps } from "./sitemap.js";

/** Most candidates in one catalog. */
export const MAX_CANDIDATES = 500;

/** Most UTF-8 bytes of label text (title plus description) across one catalog. */
export const MAX_LABEL_BYTES = 256 * 1024;

/** Query parameters dropped when comparing URLs for duplicates. `utm_*` is matched by prefix. */
export const TRACKING_PARAMS: ReadonlySet<string> = new Set(["gclid", "fbclid", "mc_cid", "mc_eid", "ref", "_hsenc", "_hsmi"]);

/** One URL a discovery run requested, with what came back. Stored by the cache for revalidation. */
export interface CatalogResource {
  url: string;
  status: "ok" | "not_modified" | "absent" | "error";
  etag?: string;
  lastModified?: string;
}

export interface DiscoveryStats {
  robotsSource: RobotsSource;
  llmsEntries: number;
  sitemapEntries: number;
  /** Paths refused by robots.txt. */
  disallowed: number;
  /** Entries whose normalized URL was already taken by a higher-priority entry. */
  duplicates: number;
  /** Entries with no usable label, even from the URL. */
  unlabeled: number;
  /** Entries that failed the resolver's own same-origin re-check. */
  offOrigin: number;
  /** Entries dropped by the candidate or label-byte cap. */
  capped: number;
}

export interface Discovery {
  catalog: SiteCatalog;
  resources: CatalogResource[];
  /** Crawl delay robots.txt asked for, so a later revalidation can honor it without refetching robots. */
  crawlDelayMs?: number;
  stats: DiscoveryStats;
  /** True when the catalog is empty and at least one request failed: nothing usable came back. */
  failed: boolean;
}

export interface DiscoverOptions {
  origin: string;
  /** Usually a paced fetch; its `setCrawlDelay`, if present, receives robots' crawl delay. */
  fetch: CatalogFetch & { setCrawlDelay?: (ms: number | undefined) => void; readonly refused?: number };
  clock: Clock;
  diagnostics?: Diagnostics;
  /** Test hooks for the caps. */
  maxCandidates?: number;
  maxLabelBytes?: number;
}

/** The comparison key for duplicate detection: lowercase scheme and host, default port dropped, no fragment, no tracking parameters. The path is kept as written. */
export function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  if (url.search) {
    const params = new URLSearchParams(url.search);
    for (const key of [...params.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_") || TRACKING_PARAMS.has(lower)) params.delete(key);
    }
    url.search = params.toString();
  }
  return url.toString();
}

/**
 * A label derived from the URL: the last path segment that is not empty or `index`,
 * percent-decoded, file extension removed, `-` `_` `+` turned into spaces
 * (`/products/travel-backpack` → "travel backpack"). The root path gives the hostname.
 */
export function slugTitle(raw: string): string {
  const url = new URL(raw);
  const segments = url.pathname.split("/");
  for (let i = segments.length - 1; i >= 0; i--) {
    let segment = segments[i] ?? "";
    try {
      segment = decodeURIComponent(segment);
    } catch {
      // Keep a malformed escape as written.
    }
    const words = segment.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[-_+]+/g, " ");
    const label = sanitizeLabel(words, CANDIDATE_TITLE_MAX);
    if (label && label.toLowerCase() !== "index") return label;
  }
  return sanitizeLabel(url.hostname, CANDIDATE_TITLE_MAX);
}

type Draft = Omit<Candidate, "id">;

const encoder = new TextEncoder();
const labelBytes = (draft: Draft): number => encoder.encode(draft.title).length + (draft.description ? encoder.encode(draft.description).length : 0);

function catalogVersion(candidates: readonly Draft[]): string {
  const hash = createHash("sha256");
  for (const c of candidates) hash.update(`${c.sourceUrl}\n${c.title}\n${c.description ?? ""}\n`);
  return hash.digest("hex").slice(0, 16);
}

function recordResource(resources: Map<string, CatalogResource>, url: string, result: GuardedFetchResult): void {
  const resource: CatalogResource = { url, status: result.kind };
  if ((result.kind === "ok" || result.kind === "not_modified") && result.etag) resource.etag = result.etag;
  if ((result.kind === "ok" || result.kind === "not_modified") && result.lastModified) resource.lastModified = result.lastModified;
  resources.set(url, resource);
}

/**
 * Turn an origin into a `SiteCatalog`.
 *
 * Policy: robots.txt is read first and its crawl delay applied to the fetch. Candidates
 * come in priority order: `llms.txt` links (`published`), then sitemap URLs with an image
 * title (`image_title`, caption as description), then everything else labeled from its
 * URL (`slug`); a published entry whose label sanitizes to nothing is relabeled from its
 * URL and ranks as `slug`. Paths robots.txt disallows are dropped. Duplicates by
 * `normalizeUrl` keep the first (highest-priority) entry, and `sourceUrl` stays exactly
 * as published. The caps (500 candidates, 256 KiB of label text) keep a prefix of that
 * order, so whole classes survive before any lower class, and document order decides
 * within a class; `truncated` is set if either cap dropped anything. `errors` holds short
 * codes only, never URLs or messages.
 */
export async function discoverCatalog(options: DiscoverOptions): Promise<Discovery> {
  const origin = new URL(options.origin).origin;
  if (!origin.startsWith("https://")) throw new TypeError("catalog origin must be https");
  const started = options.clock.now();
  const maxCandidates = options.maxCandidates ?? MAX_CANDIDATES;
  const maxLabelBytes = options.maxLabelBytes ?? MAX_LABEL_BYTES;

  const resources = new Map<string, CatalogResource>();
  const recording: CatalogFetch = async (url, opts) => {
    const result = await options.fetch(url, opts);
    recordResource(resources, url, result);
    return result;
  };

  const robots = await fetchRobots(origin, recording);
  options.fetch.setCrawlDelay?.(robots.crawlDelayMs);
  const llms = await fetchLlmsTxt(origin, recording);
  const sitemaps = await fetchSitemaps(origin, robots.sitemaps, recording);

  const stats: DiscoveryStats = {
    robotsSource: robots.source,
    llmsEntries: llms.found ? llms.entries.length : 0,
    sitemapEntries: sitemaps.entries.length,
    disallowed: 0,
    duplicates: 0,
    unlabeled: 0,
    offOrigin: 0,
    capped: 0,
  };

  const published: Draft[] = [];
  const imageTitled: Draft[] = [];
  const slugged: Draft[] = [];
  const slugDraft = (url: string, provenance: Draft["provenance"]): Draft | null => {
    const title = slugTitle(url);
    if (!title) {
      stats.unlabeled += 1;
      return null;
    }
    return { sourceUrl: url, title, labelQuality: "slug", provenance };
  };

  for (const entry of llms.found ? llms.entries : []) {
    if (entry.title) {
      published.push({
        sourceUrl: entry.url,
        title: entry.title,
        ...(entry.description ? { description: entry.description } : {}),
        labelQuality: "published",
        provenance: "llms.txt",
      });
    } else {
      const draft = slugDraft(entry.url, "llms.txt");
      if (draft) slugged.push(draft);
    }
  }
  for (const entry of sitemaps.entries) {
    if (entry.imageTitle) {
      imageTitled.push({
        sourceUrl: entry.url,
        title: entry.imageTitle,
        ...(entry.imageCaption ? { description: entry.imageCaption } : {}),
        labelQuality: "image_title",
        provenance: "sitemap-image",
      });
    } else {
      const draft = slugDraft(entry.url, "sitemap");
      if (draft) slugged.push(draft);
    }
  }

  const seen = new Set<string>();
  const kept: Draft[] = [];
  let bytes = 0;
  let truncated = false;
  for (const draft of [...published, ...imageTitled, ...slugged]) {
    const url = sameOriginHttpsUrl(draft.sourceUrl, origin);
    if (!url) {
      stats.offOrigin += 1;
      continue;
    }
    if (!isAllowed(robots, url.pathname + url.search)) {
      stats.disallowed += 1;
      continue;
    }
    const key = normalizeUrl(draft.sourceUrl);
    if (seen.has(key)) {
      stats.duplicates += 1;
      continue;
    }
    seen.add(key);
    // Once a cap is hit everything after it is dropped, so the kept set is a prefix of the priority order.
    const size = labelBytes(draft);
    if (truncated || kept.length >= maxCandidates || bytes + size > maxLabelBytes) {
      truncated = true;
      stats.capped += 1;
      continue;
    }
    bytes += size;
    kept.push(draft);
  }

  const errors: string[] = [];
  if (robots.source === "error") errors.push("robots:error");
  if (!llms.found && llms.source === "error") errors.push("llms:error");
  if (llms.found && llms.nestedFailed > 0) errors.push("llms:nested_failed");
  if (sitemaps.counters.fetchErrors > 0) errors.push("sitemap:fetch_error");
  if (sitemaps.counters.rejected > 0) errors.push("sitemap:rejected");
  if ((options.fetch.refused ?? 0) > 0) errors.push("fetch:refused");

  const catalog = SiteCatalogSchema.parse({
    origin,
    version: catalogVersion(kept),
    fetchedAt: options.clock.now(),
    candidates: kept.map((draft, index) => ({ id: `c${index.toString(36)}`, ...draft })),
    truncated,
    errors,
  });
  const resourceList = [...resources.values()];
  const failed = catalog.candidates.length === 0 && resourceList.some((resource) => resource.status === "error");

  options.diagnostics?.event("catalog_discover", {
    origin,
    ms: options.clock.now() - started,
    candidateCount: catalog.candidates.length,
    truncated,
    failed,
    labelBytes: bytes,
    requests: resourceList.length,
    errorCount: errors.length,
    ...stats,
  });

  return {
    catalog,
    resources: resourceList,
    ...(robots.crawlDelayMs !== undefined ? { crawlDelayMs: robots.crawlDelayMs } : {}),
    stats,
    failed,
  };
}
