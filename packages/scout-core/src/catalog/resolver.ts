import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { type Candidate, type SiteCatalog, SiteCatalogSchema } from "@scout/contracts";
import type { Clock } from "../clock.js";
import type { Diagnostics } from "../diagnostics.js";
import type { GuardedFetchResult } from "../fetch/guardedFetch.js";
import { type CatalogFetch, type CatalogFetchOptions, nextValidators } from "./catalogFetch.js";
import { fetchLlmsTxt, type ParsedLlmsTxt } from "./llmsTxt.js";
import { isRefusal } from "./pacing.js";
import { compileRobots, fetchRobots, isAllowed, type RobotsSource } from "./robots.js";
import { sameOriginHttpsUrl } from "./sameOrigin.js";
import { CANDIDATE_TITLE_MAX, sanitizeLabel } from "./sanitizeLabel.js";
import { fetchSitemaps, type ParsedSitemap } from "./sitemap.js";

/**
 * Where discovery parses what it fetched. The parsers are pure; the core runs them in its
 * bounded parse worker (parseWorker.ts) so a large sitemap never blocks its input handling.
 */
export interface CatalogParsers {
  sitemap(xml: string, origin: string): Promise<ParsedSitemap>;
  llmsTxt(text: string, origin: string, baseUrl: string): Promise<ParsedLlmsTxt>;
}

/**
 * The dedupe/robots pass runs on the core's main thread (P4.4 decision): it gives the event
 * loop back (setImmediate) whenever it has run this long, checked every `SLICE_CHECK_EVERY`
 * entries. Unsliced, the worst bounded shape (50,000 sitemap entries that are all spellings
 * of one URL: a URL parse and a normalization each) held the loop ~60-70 ms, and a robots.txt
 * at the rule cap spends ~25 ms of `MAX_ROBOTS_WORK`; sliced, the longest event-loop gap from a
 * parsed 50,000-entry sitemap to the catalog is ~11-13 ms on an idle machine (resolver.test.ts
 * bounds each shape under 50 ms; responsiveness.test.ts measures the whole pass inside the
 * coordinator). Moving the pass into the parse worker would instead clone up
 * to 50,000 entries across the thread boundary, itself a main-thread cost of the same order.
 */
export const PASS_SLICE_MS = 8;
const SLICE_CHECK_EVERY = 16;
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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
 * Most robots.txt work in one run, counted as rule pieces searched (`CompiledRobots.work`
 * per check, summed over checks). With up to 2,000 rules of up to 16 pieces, a check can
 * cost 32,000 searches, so `MAX_ROBOTS_CHECKS` alone would allow hundreds of millions.
 * Past this budget the remaining entries are dropped as capped and the catalog is marked
 * truncated, like the check ceiling.
 */
export const MAX_ROBOTS_WORK = 5_000_000;

/**
 * Query parameters dropped when comparing URLs for duplicates, matched case-insensitively.
 * `utm_*` is matched by prefix. `ref` is deliberately absent: docs sites use it as a real
 * parameter (a git ref, an API reference).
 */
export const TRACKING_PARAMS: ReadonlySet<string> = new Set(["gclid", "fbclid", "mc_cid", "mc_eid", "_hsenc", "_hsmi"]);

/**
 * One URL a discovery run requested, with what came back. Stored by the cache for
 * revalidation. `refused` means the paced fetch never asked the site (budget or deadline),
 * so the resource's real state is unknown; the cache treats it as changed. Discovery sends
 * no validators, so a 304 it receives anyway is recorded as `error`, as the parsers treat it.
 */
export interface CatalogResource {
  url: string;
  status: "ok" | "absent" | "error" | "refused";
  etag?: string;
  lastModified?: string;
  /** The size cap discovery used for this URL, so revalidation probes use the same one. */
  maxBytes?: number;
  /** The `Accept` discovery sent, so revalidation sends the same request (and can share it with resource discovery). */
  accept?: string;
}

export interface DiscoveryStats {
  robotsSource: RobotsSource;
  llmsEntries: number;
  sitemapEntries: number;
  /** Paths refused by robots.txt. */
  disallowed: number;
  /**
   * Entries whose normalized URL an earlier (higher-priority) entry already had. Dedupe
   * runs before the robots check, so the first entry for a URL decides its fate and
   * duplicates cost no robots work.
   */
  duplicates: number;
  /** Entries with no usable label, even from the URL. */
  unlabeled: number;
  /** Entries that failed the resolver's own same-origin re-check. */
  offOrigin: number;
  /**
   * Entries dropped by the candidate cap, the label-byte cap, or the robots ceilings
   * (`MAX_ROBOTS_CHECKS`, `MAX_ROBOTS_WORK`). Once any cap is hit, every later entry lands
   * here unexamined.
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
  /** Off-thread parsers; without them each file is parsed inline. */
  parsers?: CatalogParsers;
  /** Test hooks for the caps. */
  maxCandidates?: number;
  maxLabelBytes?: number;
}

/**
 * The comparison key for duplicate detection: lowercase scheme and host, default port
 * dropped, no fragment, no tracking parameters (`TRACKING_PARAMS`, case-insensitive). The
 * path is kept as written. A non-empty query is re-serialized through `URLSearchParams`,
 * so equivalent spellings compare equal: `?x` becomes `?x=` and `%20` becomes `+`.
 * Credentials are not part of the key; the resolver only passes credential-free URLs.
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
  return `${url.protocol}//${url.host}${url.pathname}${search}`;
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

function recordResource(resources: Map<string, CatalogResource>, url: string, result: GuardedFetchResult, opts: CatalogFetchOptions | undefined): void {
  const status: CatalogResource["status"] = isRefusal(result) ? "refused" : result.kind === "not_modified" ? "error" : result.kind;
  const resource: CatalogResource = { url, status, ...(result.kind === "ok" ? nextValidators({}, result) : {}) };
  if (opts?.maxBytes !== undefined) resource.maxBytes = opts.maxBytes;
  if (opts?.accept !== undefined) resource.accept = opts.accept;
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
 * URL and ranks as `slug`. Duplicates by `normalizeUrl` keep the first (highest-priority)
 * entry and are dropped before any robots check; then paths robots.txt disallows are
 * dropped. `sourceUrl` stays exactly as published. The caps (500 candidates, 256 KiB of label text) keep a prefix of that
 * order, so whole classes survive before any lower class, and document order decides
 * within a class; `truncated` is set if either cap dropped anything. Robots evaluations
 * are also capped, by count (`MAX_ROBOTS_CHECKS`) and by work (`MAX_ROBOTS_WORK`); hitting
 * either ceiling drops the rest and sets `truncated` too. `errors` holds short codes only, never URLs or messages.
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
    recordResource(resources, url, result, opts);
    return result;
  };

  const robots = await fetchRobots(origin, recording);
  if (robots.source === "fetched") options.fetch.setCrawlDelay?.(robots.crawlDelayMs);
  const parsers = options.parsers;
  const llms = await fetchLlmsTxt(origin, recording, parsers ? (text, o, base) => parsers.llmsTxt(text, o, base) : undefined);
  const sitemaps = await fetchSitemaps(origin, robots.sitemaps, recording, parsers ? { parse: (xml, o) => parsers.sitemap(xml, o) } : {});

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
  let robotsWork = 0;
  const seen = new Set<string>();
  const kept: Draft[] = [];
  let bytes = 0;
  let truncated = false;
  // Building the priority lists above is its own stretch (up to 50,000 entries); give the loop back before the pass.
  await yieldToLoop();
  let sliceStart = performance.now();
  let examined = 0;
  for (const entry of [...published, ...imageTitled, ...slugged]) {
    if (++examined % SLICE_CHECK_EVERY === 0 && performance.now() - sliceStart >= PASS_SLICE_MS) {
      await yieldToLoop();
      sliceStart = performance.now();
    }
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
    const key = normalizeUrl(url);
    if (seen.has(key)) {
      stats.duplicates += 1;
      continue;
    }
    seen.add(key);
    if (checkRobots) {
      if (robotsChecks >= MAX_ROBOTS_CHECKS || robotsWork + compiledRobots.work > MAX_ROBOTS_WORK) {
        truncated = true;
        stats.capped += 1;
        continue;
      }
      robotsChecks += 1;
      robotsWork += compiledRobots.work;
      if (!isAllowed(compiledRobots, url.pathname + url.search)) {
        stats.disallowed += 1;
        continue;
      }
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
  const failed = catalog.candidates.length === 0 && resourceList.some((resource) => resource.status === "error" || resource.status === "refused");

  options.diagnostics?.event("catalog_discover", {
    origin,
    ms: options.clock.now() - started,
    candidateCount: catalog.candidates.length,
    truncated,
    failed,
    labelBytes: bytes,
    resourceCount: resourceList.length,
    errorCount: errors.length,
    ...stats,
    llmsDroppedOffOrigin: llms.found ? llms.droppedOffOrigin : 0,
    llmsSkippedLines: llms.found ? llms.skippedLines : 0,
    llmsNestedSkipped: llms.found ? llms.nestedSkipped : 0,
    llmsNestedFailed: llms.found ? llms.nestedFailed : 0,
    sitemapChildrenSkipped: sitemaps.counters.childrenSkipped,
    sitemapNestedIndexesIgnored: sitemaps.counters.nestedIndexesIgnored,
    sitemapEntriesSkipped: sitemaps.counters.entriesSkipped,
    sitemapDroppedOffOrigin: sitemaps.counters.droppedOffOrigin,
    sitemapFilesAbsent: sitemaps.counters.filesAbsent,
    robotsRulesTooLong: robots.skippedRules.tooLong,
    robotsRulesOverLimit: robots.skippedRules.overLimit,
    robotsRulesTooManyWildcards: robots.skippedRules.tooManyWildcards,
    robotsChecks,
    robotsWork,
  });

  return {
    catalog,
    resources: resourceList,
    ...(robots.crawlDelayMs !== undefined ? { crawlDelayMs: robots.crawlDelayMs } : {}),
    stats,
    failed,
  };
}
