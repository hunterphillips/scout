import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SiteCatalog, SiteCatalogSchema } from "@scout/contracts";
import { z } from "zod";
import type { Clock } from "../clock.js";
import { type Diagnostics, scoutHome } from "../diagnostics.js";
import { CACHE_STALE_MAX_MS, cacheFileName, checkPrivateDir, type DirRefusal, fsErrorCode } from "../privateCacheFile.js";
import { type CatalogFetchOptions, nextValidators, SITEMAP_MAX_BYTES } from "./catalogFetch.js";
import { isRefusal, type PacedFetch } from "./pacing.js";
import { type CatalogParsers, type CatalogResource, discoverCatalog, type Discovery, type DiscoverOptions } from "./resolver.js";

/** Bump when the file shape or the resolver's output changes meaning; every older file is then ignored. */
export const CATALOG_CACHE_SCHEMA_VERSION = 3;

/** A cached catalog is used without any network request for this long. */
export const CATALOG_FRESH_MS = 24 * 60 * 60 * 1000;

/** When a refresh fails, a cached catalog younger than this is still served, marked stale. */
export const CATALOG_STALE_MAX_MS = CACHE_STALE_MAX_MS;

/** A cached `fetchedAt` further than this in the future is treated as invalid (clock skew or tampering). */
export const CATALOG_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const CacheFileSchema = z.object({
  schemaVersion: z.number(),
  origin: z.string(),
  fetchedAt: z.number(),
  crawlDelayMs: z.number().optional(),
  resources: z.array(
    z.object({
      url: z.string(),
      status: z.enum(["ok", "absent", "error", "refused"]),
      etag: z.string().optional(),
      lastModified: z.string().optional(),
      maxBytes: z.number().int().positive().optional(),
      accept: z.string().max(256).optional(),
    }),
  ),
  catalog: SiteCatalogSchema,
});

export interface CatalogCacheFile {
  schemaVersion: number;
  origin: string;
  fetchedAt: number;
  crawlDelayMs?: number;
  resources: CatalogResource[];
  catalog: SiteCatalog;
}

export type CatalogCacheSource = "fresh" | "not_modified" | "refetched" | "stale" | "miss";

export type CatalogCacheResult =
  | { ok: true; catalog: SiteCatalog; source: CatalogCacheSource; stale: boolean }
  /** Discovery failed and no cached catalog young enough to serve. `errors` are the resolver's codes. */
  | { ok: false; code: "discover_failed" | "discover_threw"; errors: string[] };

export interface ResolveWithCacheOptions {
  origin: string;
  /** One paced fetch for this origin; revalidation and discovery share its pacing. */
  fetch: PacedFetch & { startWindow?: () => void };
  /**
   * Opens a new pacing window. Revalidation and rediscovery each call it when given, or
   * else the fetch's own `startWindow` when it has one (a private paced fetch). A shared
   * session's fetch has neither: the session's owner opened one window for the whole pass.
   */
  startWindow?: () => void;
  /** Skip the 24 h freshness window (the CLI's `--refresh`). Validators are still sent. */
  refresh?: boolean;
  /**
   * Whether the pass this resolve runs in was cancelled (the origin session's
   * `isCancelled`). Checked before every write: a cancelled pass's catalog is never saved.
   */
  isCancelled?: () => boolean;
  /** Off-thread parsers for discovery; without them files are parsed inline. */
  parsers?: CatalogParsers;
  /** Test hook; defaults to `discoverCatalog`. */
  discover?: (options: DiscoverOptions) => Promise<Discovery>;
}

export interface CatalogCache {
  /** The cached file for `origin`, or null when missing, unreadable, invalid, or from another schema version. */
  load(origin: string): CatalogCacheFile | null;
  resolve(options: ResolveWithCacheOptions): Promise<CatalogCacheResult>;
}

export interface CatalogCacheOptions {
  clock: Clock;
  /** Defaults to `~/.scout/cache/catalog`. */
  dir?: string;
  diagnostics?: Diagnostics;
}

/**
 * Ask the site whether each resource the cached catalog was built from has changed.
 * Returns the resources with refreshed validators only if every one answers as before:
 * `ok` resources return 304 to their stored ETag / Last-Modified, `absent` ones are still
 * absent, `error` ones still fail; otherwise null. Each probe repeats the original
 * request's `Accept` and size cap. A resource with no validators counts as changed. A
 * `refused` resource (never asked when the catalog was built) counts as changed before
 * any request is made, and so does a probe the paced fetch refuses: neither says anything
 * about the site. Stops at the first change. Validators a 304 carries replace the stored
 * ones (`nextValidators`), as resource discovery does, so the two caches keep sending the
 * same conditional request for a URL they share.
 */
async function revalidate(resources: readonly CatalogResource[], fetch: PacedFetch): Promise<CatalogResource[] | null> {
  if (resources.length === 0 || resources.some((resource) => resource.status === "refused")) return null;
  const updated: CatalogResource[] = [];
  for (const resource of resources) {
    const opts: CatalogFetchOptions = { maxBytes: resource.maxBytes ?? SITEMAP_MAX_BYTES };
    if (resource.accept !== undefined) opts.accept = resource.accept;
    if (resource.status === "ok") {
      if (!resource.etag && !resource.lastModified) return null;
      if (resource.etag) opts.ifNoneMatch = resource.etag;
      if (resource.lastModified) opts.ifModifiedSince = resource.lastModified;
    }
    const result = await fetch(resource.url, opts);
    if (isRefusal(result)) return null;
    const expected = resource.status === "ok" ? "not_modified" : resource.status;
    if (result.kind !== expected) return null;
    if (resource.status === "ok") {
      const { etag: _etag, lastModified: _lastModified, ...rest } = resource;
      updated.push({ ...rest, ...nextValidators(resource, result) });
    } else {
      updated.push(resource);
    }
  }
  return updated;
}

/**
 * The on-disk catalog cache, one JSON file per origin (files 0600, written atomically).
 * The directory is created 0700; an existing one is never chmodded, and is refused if it
 * is a symlink, not a directory, owned by someone else, or has group/other permission
 * bits. A refused directory means no write (a `catalog_cache_write_failed` event) and
 * every load is a miss. A failed write never fails `resolve`: the catalog is still returned.
 *
 * Policy: a catalog under 24 h old is served with no network request. After that, every
 * stored resource is revalidated with a conditional request; if all come back unchanged,
 * the cached catalog is kept and its `fetchedAt` bumped, and no body is downloaded.
 * Otherwise the whole catalog is rediscovered without validators: the resolver needs
 * every file's body to rebuild it, and a 304 carries none, so a partial rebuild is not
 * possible. If rediscovery fails (throws, or yields nothing with a request error) a
 * cached catalog under 7 days old is served marked stale. A file from another schema
 * version, for another origin, whose outer and inner `fetchedAt` differ or are not finite,
 * dated more than 5 minutes in the future, or one that fails to parse, is treated as
 * missing and overwritten.
 *
 * Run windows: with a private paced fetch, revalidation and rediscovery each get their
 * own window (`startWindow`), so a slow revalidation under a long crawl delay cannot spend
 * the deadline or budget rediscovery needs. The crawl delay carries across both. On a
 * shared origin session the session's owner opens the window, and the whole resolve
 * (with whatever else runs in the pass) shares it.
 *
 * Refusals: a request the paced fetch refused (budget or deadline) is stored as a
 * `refused` resource, never as the site's answer. A cached catalog with any `refused`
 * resource always counts as changed, so a catalog cut short by the deadline is rebuilt at
 * the next refresh instead of revalidating as complete forever.
 *
 * Partial failures: any run that produces a non-empty catalog replaces the cached one,
 * even if some of its requests failed (`catalog.errors` is non-empty). This is a deliberate
 * proof-of-concept choice: a fresh catalog with gaps is preferred over a richer but stale
 * one, and the next refresh fills the gaps. One exception: when rediscovery had requests
 * refused (`fetch:refused`) and found fewer candidates than the cached catalog, and the
 * cached catalog is under 7 days old, the cached one is kept and served stale (diagnostics
 * code `rediscovery_refused`). A run cut short by Scout's own limits says nothing about
 * the site, so it must not shrink a complete catalog.
 *
 * Cancellation: when the pass was cancelled (`isCancelled`; pause, permission loss,
 * disconnect, stop), nothing is written, whatever the run produced: its requests after the
 * cancel were refused, so its catalog is partial and says nothing about the site. A
 * `catalog_cache_skipped` event (`reason: "cancelled"`) records the skip. A live pass with
 * a failed sub-fetch (a sitemap that 500s, say) is not cancelled and still saves.
 */
export function createCatalogCache(options: CatalogCacheOptions): CatalogCache {
  const dir = options.dir ?? join(scoutHome(), "cache", "catalog");
  const { clock, diagnostics } = options;

  const load = (origin: string): CatalogCacheFile | null => {
    const canonical = new URL(origin).origin;
    let refusal: DirRefusal | null;
    try {
      refusal = checkPrivateDir(dir);
    } catch {
      return null; // no directory yet
    }
    if (refusal) {
      diagnostics?.event("catalog_cache_invalid", { origin: canonical, code: `dir_${refusal}` });
      return null;
    }
    let raw: string;
    try {
      raw = readFileSync(join(dir, cacheFileName(canonical)), "utf8");
    } catch {
      return null;
    }
    let parsed: CatalogCacheFile;
    try {
      const json: unknown = JSON.parse(raw);
      // Check the version first: an older file may not fit today's shape, and that is "schema", not "parse".
      if ((json as { schemaVersion?: unknown } | null)?.schemaVersion !== CATALOG_CACHE_SCHEMA_VERSION) {
        diagnostics?.event("catalog_cache_invalid", { origin: canonical, code: "schema" });
        return null;
      }
      // zod omits absent optional keys, so the parsed value satisfies the exact-optional interface.
      parsed = CacheFileSchema.parse(json) as CatalogCacheFile;
    } catch {
      diagnostics?.event("catalog_cache_invalid", { origin: canonical, code: "parse" });
      return null;
    }
    const invalid =
      parsed.origin !== canonical || parsed.catalog.origin !== canonical
        ? "origin"
        : !Number.isFinite(parsed.fetchedAt) || !Number.isFinite(parsed.catalog.fetchedAt) || parsed.catalog.fetchedAt !== parsed.fetchedAt
          ? "fetched_at"
          : parsed.fetchedAt > clock.now() + CATALOG_FUTURE_TOLERANCE_MS
            ? "future"
            : null;
    if (invalid) {
      diagnostics?.event("catalog_cache_invalid", { origin: canonical, code: invalid });
      return null;
    }
    return parsed;
  };

  const save = (file: CatalogCacheFile): void => {
    const failed = (code: string) => diagnostics?.event("catalog_cache_write_failed", { origin: file.origin, code });
    let temp: string | null = null;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const refusal = checkPrivateDir(dir);
      if (refusal) {
        failed(refusal);
        return;
      }
      const path = join(dir, cacheFileName(file.origin));
      temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(temp, JSON.stringify(file), { mode: 0o600, flag: "wx" });
      renameSync(temp, path);
    } catch (error) {
      if (temp !== null) {
        try {
          unlinkSync(temp);
        } catch {
          // Never written, or already gone.
        }
      }
      failed(fsErrorCode(error));
    }
  };

  const fromDiscovery = (origin: string, discovery: Discovery, cached: CatalogCacheFile | null): CatalogCacheFile => {
    // Keep the cached crawl delay unless this run actually read robots.txt, matching what the resolver applied.
    const crawlDelayMs = discovery.stats.robotsSource === "fetched" ? discovery.crawlDelayMs : cached?.crawlDelayMs;
    return {
      schemaVersion: CATALOG_CACHE_SCHEMA_VERSION,
      origin,
      fetchedAt: discovery.catalog.fetchedAt,
      ...(crawlDelayMs !== undefined ? { crawlDelayMs } : {}),
      resources: discovery.resources,
      catalog: discovery.catalog,
    };
  };

  const resolve = async (request: ResolveWithCacheOptions): Promise<CatalogCacheResult> => {
    const origin = new URL(request.origin).origin;
    const discover = request.discover ?? discoverCatalog;
    const cached = load(origin);
    const now = clock.now();
    const report = (source: CatalogCacheSource, catalog: SiteCatalog, code?: string): CatalogCacheResult => {
      const stale = source === "stale";
      diagnostics?.event("catalog_cache", {
        origin,
        source,
        stale,
        candidateCount: catalog.candidates.length,
        ageMs: clock.now() - catalog.fetchedAt,
        ...(code ? { code } : {}),
      });
      return { ok: true, catalog, source, stale };
    };

    if (cached && !request.refresh && now - cached.fetchedAt < CATALOG_FRESH_MS) return report("fresh", cached.catalog);

    /** Save unless the pass was cancelled. */
    const persist = (file: CatalogCacheFile): void => {
      if (request.isCancelled?.()) {
        diagnostics?.event("catalog_cache_skipped", { origin, reason: "cancelled" });
        return;
      }
      save(file);
    };

    const startWindow = (): void => {
      if (request.startWindow) request.startWindow();
      else request.fetch.startWindow?.();
    };

    if (cached) {
      request.fetch.setCrawlDelay(cached.crawlDelayMs);
      startWindow();
      let same: CatalogResource[] | null = null;
      try {
        same = await revalidate(cached.resources, request.fetch);
      } catch {
        same = null;
      }
      if (same) {
        const bumped = clock.now();
        const file: CatalogCacheFile = { ...cached, fetchedAt: bumped, resources: same, catalog: { ...cached.catalog, fetchedAt: bumped } };
        persist(file);
        return report("not_modified", file.catalog);
      }
    }

    const young = cached !== null && clock.now() - cached.fetchedAt < CATALOG_STALE_MAX_MS;
    let discovery: Discovery | null = null;
    startWindow();
    try {
      discovery = await discover({ origin, fetch: request.fetch, clock, ...(diagnostics ? { diagnostics } : {}), ...(request.parsers ? { parsers: request.parsers } : {}) });
    } catch {
      discovery = null;
    }
    if (
      discovery &&
      !discovery.failed &&
      cached &&
      young &&
      discovery.catalog.errors.includes("fetch:refused") &&
      discovery.catalog.candidates.length < cached.catalog.candidates.length
    ) {
      return report("stale", cached.catalog, "rediscovery_refused");
    }
    if (discovery && !discovery.failed) {
      persist(fromDiscovery(origin, discovery, cached));
      return report(cached ? "refetched" : "miss", discovery.catalog);
    }
    if (cached && young) return report("stale", cached.catalog);
    diagnostics?.event("catalog_cache", { origin, source: "failed", stale: false, hadCache: cached !== null });
    return discovery ? { ok: false, code: "discover_failed", errors: discovery.catalog.errors } : { ok: false, code: "discover_threw", errors: [] };
  };

  return { load, resolve };
}
