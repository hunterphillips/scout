import { createHash } from "node:crypto";
import { type Candidate, type SiteCatalog, SiteCatalogSchema } from "@scout/contracts";
import type { Clock } from "../clock.js";
import type { Diagnostics } from "../diagnostics.js";
import type { GuardedFetchResult } from "../fetch/guardedFetch.js";
import type { CatalogFetch, CatalogFetchOptions } from "./catalogFetch.js";
import { fetchLlmsTxt } from "./llmsTxt.js";
import { compileRobots, fetchRobots, isAllowed, type RobotsSource } from "./robots.js";
import { sameOriginHttpsUrl } from "./sameOrigin.js";
import { CANDIDATE_TITLE_MAX, sanitizeLabel } from "./sanitizeLabel.js";
import { fetchSitemaps } from "./sitemap.js";

/** Most candidates in one catalog. */
export const MAX_CANDIDATES = 500;

/** Most UTF-8 bytes of label text (title plus description) across one catalog. */
export const MAX_LABEL_BYTES = 256 * 1024;

/**
 * Most robots.txt evaluations in one run. Each checks one path against up to `MAX_RULES`
 * patterns; past this many, the remaining entries are dropped as capped and the catalog is
 * marked truncated, so a sitemap of disallowed or duplicate URLs cannot stall the loop.
 */
export const MAX_ROBOTS_CHECKS = 10_000;

/**
 * Query parameters dropped when comparing URLs for duplicates, matched case-insensitively.
 * `utm_*` is matched by prefix. `ref` is deliberately absent: docs sites use it as a real
 * parameter (a git ref, an API reference).
 */
export const TRACKING_PARAMS: ReadonlySet<string> = new Set(["gclid", "fbclid", "mc_cid", "mc_eid", "_hsenc", "_hsmi"]);

/** One URL a discovery run requested, with what came back. Stored by the cache for revalidation. */
export interface CatalogResource {
  url: string;
  status: "ok" | "not_modified" | "absent" | "error";
  etag?: string;
  lastModified?: string;
  /** The size cap discovery used for this URL, so revalidation probes use the same one. */
  maxBytes?: number;
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
  /**
   * Entries dropped by the candidate cap, the label-byte cap, or the robots-check ceiling
   * (`MAX_ROBOTS_CHECKS`). Once any cap is hit, every later entry lands here unexamined.
   */
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

/**
 * The comparison key for duplicate detection: lowercase scheme and host, default port
 * dropped, no fragment, no tracking parameters (`TRACKING_PARAMS`, case-insensitive). The
 * path is kept as written. A non-empty query is re-serialized through `URLSearchParams`,
 * so equivalent spellings compare equal: `?x` becomes `?x=` and `%20` becomes `+`.
 * Accepts an already-parsed URL, which it does not modify.
 */
export function normalizeUrl(input: string | URL): string {
  const url = typeof input === "string" ? new URL(input) : input;
  let search = url.search;
  if (search) {
    const params = new URLSearchParams(search);
    for (const key of [...params.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_") || TRACKING_PARAMS.has(lower)) params.delete(key);
    }
    const serialized = params.toString();
    search = serialized ? `?${serialized}` : "";
  }
  const credentials = url.username || url.password ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
  return `${url.protocol}//${credentials}${url.host}${url.pathname}${search}`;
}

/**
 * A label derived from the URL: the last path segment that is not empty or `index`,
 * percent-decoded, file extension removed, `-` `_` `+` turned into spaces
 * (`/products/travel-backpack` → "travel backpack"). The root path gives the hostname.
 */
export function slugTitle(input: string | URL): string {
  const url = typeof input === "string" ? new URL(input) : input;
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

/** A catalog entry before filtering; slug-class entries get their title only if they survive to the cap check. */
type Entry = Omit<Draft, "title"> & { title?: string };

const encoder = new TextEncoder();
const labelBytes = (draft: Draft): number => encoder.encode(draft.title).length + (draft.description ? encoder.encode(draft.description).length : 0);

function catalogVersion(candidates: readonly Draft[]): string {
  const hash = createHash("sha256");
  for (const c of candidates) hash.update(`${c.sourceUrl}\n${c.title}\n${c.description ?? ""}\n`);
  return hash.digest("hex").slice(0, 16);
}

function recordResource(resources: Map<string, CatalogResource>, url: string, result: GuardedFetchResult, maxBytes: number | undefined): void {
  const resource: CatalogResource = { url, status: result.kind };
  if ((result.kind === "ok" || result.kind === "not_modified") && result.etag) resource.etag = result.etag;
  if ((result.kind === "ok" || result.kind === "not_modified") && result.lastModified) resource.lastModified = result.lastModified;
  if (maxBytes !== undefined) resource.maxBytes = maxBytes;
  resources.set(url, resource);
}

/**
 * Turn an origin into a `SiteCatalog`.
 *
 * Policy: robots.txt is read first and, if it was fetched, its crawl delay applied to the
 * fetch (otherwise any delay already set, e.g. from the cache, stays). Candidates
 * come in priority order: `llms.txt` links (`published`), then sitemap URLs with an image
 * title (`image_title`, caption as description), then everything else labeled from its
 * URL (`slug`); a published entry whose label sanitizes to nothing is relabeled from its
 * URL and ranks as `slug`. Paths robots.txt disallows are dropped. Duplicates by
 * `normalizeUrl` keep the first (highest-priority) entry, and `sourceUrl` stays exactly
 * as published. The caps (500 candidates, 256 KiB of label text) keep a prefix of that
 * order, so whole classes survive before any lower class, and document order decides
 * within a class; `truncated` is set if either cap dropped anything. Robots evaluations
 * are also capped (`MAX_ROBOTS_CHECKS`); hitting that ceiling drops the rest and sets
 * `truncated` too. `errors` holds short codes only, never URLs or messages.
 */
export async function discoverCatalog(options: DiscoverOptions): Promise<Discovery> {
  const origin = new URL(options.origin).origin;
  if (!origin.startsWith("https://")) throw new TypeError("catalog origin must be https");
  const started = options.clock.now();
  const maxCandidates = options.maxCandidates ?? MAX_CANDIDATES;
  const maxLabelBytes = options.maxLabelBytes ?? MAX_LABEL_BYTES;

  const refusedAtStart = options.fetch.refused ?? 0;
  const resources = new Map<string, CatalogResource>();
  const recording: CatalogFetch = async (url, opts?: CatalogFetchOptions) => {
    const result = await options.fetch(url, opts);
    recordResource(resources, url, result, opts?.maxBytes);
    return result;
  };

  const robots = await fetchRobots(origin, recording);
  if (robots.source === "fetched") options.fetch.setCrawlDelay?.(robots.crawlDelayMs);
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

  const published: Entry[] = [];
  const imageTitled: Entry[] = [];
  const slugged: Entry[] = [];

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
      slugged.push({ sourceUrl: entry.url, labelQuality: "slug", provenance: "llms.txt" });
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
      slugged.push({ sourceUrl: entry.url, labelQuality: "slug", provenance: "sitemap" });
    }
  }

  const compiledRobots = compileRobots(robots);
  const checkRobots = compiledRobots.compiled.length > 0;
  let robotsChecks = 0;
  const seen = new Set<string>();
  const kept: Draft[] = [];
  let bytes = 0;
  let truncated = false;
  for (const entry of [...published, ...imageTitled, ...slugged]) {
    // Once a cap is hit everything after it is dropped unexamined, so the kept set is a prefix of the priority order.
    if (truncated) {
      stats.capped += 1;
      continue;
    }
    const url = sameOriginHttpsUrl(entry.sourceUrl, origin);
    if (!url) {
      stats.offOrigin += 1;
      continue;
    }
    if (checkRobots) {
      if (robotsChecks >= MAX_ROBOTS_CHECKS) {
        truncated = true;
        stats.capped += 1;
        continue;
      }
      robotsChecks += 1;
      if (!isAllowed(compiledRobots, url.pathname + url.search)) {
        stats.disallowed += 1;
        continue;
      }
    }
    const key = normalizeUrl(url);
    if (seen.has(key)) {
      stats.duplicates += 1;
      continue;
    }
    if (kept.length >= maxCandidates) {
      truncated = true;
      stats.capped += 1;
      continue;
    }
    const title = entry.title ?? slugTitle(url);
    if (!title) {
      stats.unlabeled += 1;
      continue;
    }
    seen.add(key);
    const draft: Draft = { ...entry, title };
    const size = labelBytes(draft);
    if (bytes + size > maxLabelBytes) {
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
  // Only this run's refusals: an earlier revalidation pass on the same fetch may have been refused too.
  if ((options.fetch.refused ?? 0) - refusedAtStart > 0) errors.push("fetch:refused");

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
