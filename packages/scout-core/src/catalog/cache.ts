import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SiteCatalog, SiteCatalogSchema } from "@scout/contracts";
import { z } from "zod";
import type { Clock } from "../clock.js";
import { type Diagnostics, scoutHome } from "../diagnostics.js";
import { type CatalogFetchOptions, SITEMAP_MAX_BYTES } from "./catalogFetch.js";
import type { PacedCatalogFetch } from "./pacing.js";
import { type CatalogResource, discoverCatalog, type Discovery, type DiscoverOptions } from "./resolver.js";

/** Bump when the file shape or the resolver's output changes meaning; every older file is then ignored. */
export const CATALOG_CACHE_SCHEMA_VERSION = 1;

/** A cached catalog is used without any network request for this long. */
export const CATALOG_FRESH_MS = 24 * 60 * 60 * 1000;

/** When a refresh fails, a cached catalog younger than this is still served, marked stale. */
export const CATALOG_STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

const CacheFileSchema = z.object({
  schemaVersion: z.number(),
  origin: z.string(),
  fetchedAt: z.number(),
  crawlDelayMs: z.number().optional(),
  resources: z.array(
    z.object({
      url: z.string(),
      status: z.enum(["ok", "not_modified", "absent", "error"]),
      etag: z.string().optional(),
      lastModified: z.string().optional(),
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
  /** One paced fetch for this origin; revalidation and discovery share its pacing and budget. */
  fetch: PacedCatalogFetch;
  /** Skip the 24 h freshness window (the CLI's `--refresh`). Validators are still sent. */
  refresh?: boolean;
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

/** File name for an origin: scheme dropped, host lowercased, `:` and any other unsafe character become `_`. */
export function cacheFileName(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:") throw new TypeError("catalog origin must be https");
  const name = url.host.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
  if (!name || /^\.+$/.test(name)) throw new TypeError("catalog origin has no usable host");
  return `${name}.json`;
}

/**
 * Ask the site whether each resource the cached catalog was built from has changed.
 * Returns true only if every one answers as before: `ok` resources return 304 to their
 * stored ETag / Last-Modified, `absent` ones are still absent, `error` ones still fail.
 * A resource with no validators counts as changed. Stops at the first change.
 */
async function unchanged(resources: readonly CatalogResource[], fetch: PacedCatalogFetch): Promise<boolean> {
  if (resources.length === 0) return false;
  for (const resource of resources) {
    const opts: CatalogFetchOptions = { maxBytes: SITEMAP_MAX_BYTES };
    if (resource.status === "ok" || resource.status === "not_modified") {
      if (!resource.etag && !resource.lastModified) return false;
      if (resource.etag) opts.ifNoneMatch = resource.etag;
      if (resource.lastModified) opts.ifModifiedSince = resource.lastModified;
    }
    const result = await fetch(resource.url, opts);
    const expected = resource.status === "ok" || resource.status === "not_modified" ? "not_modified" : resource.status;
    if (result.kind !== expected) return false;
  }
  return true;
}

/**
 * The on-disk catalog cache, one JSON file per origin (dir 0700, files 0600, written
 * atomically).
 *
 * Policy: a catalog under 24 h old is served with no network request. After that, every
 * stored resource is revalidated with a conditional request; if all come back unchanged,
 * the cached catalog is kept and its `fetchedAt` bumped, and no body is downloaded.
 * Otherwise the whole catalog is rediscovered without validators: the resolver needs
 * every file's body to rebuild it, and a 304 carries none, so a partial rebuild is not
 * possible. If rediscovery fails (throws, or yields nothing with a request error) a
 * cached catalog under 7 days old is served marked stale. A file from another schema
 * version, or one that fails to parse, is treated as missing and overwritten.
 */
export function createCatalogCache(options: CatalogCacheOptions): CatalogCache {
  const dir = options.dir ?? join(scoutHome(), "cache", "catalog");
  const { clock, diagnostics } = options;

  const load = (origin: string): CatalogCacheFile | null => {
    const canonical = new URL(origin).origin;
    let raw: string;
    try {
      raw = readFileSync(join(dir, cacheFileName(canonical)), "utf8");
    } catch {
      return null;
    }
    let parsed: CatalogCacheFile;
    try {
      // zod omits absent optional keys, so the parsed value satisfies the exact-optional interface.
      parsed = CacheFileSchema.parse(JSON.parse(raw)) as CatalogCacheFile;
    } catch {
      diagnostics?.event("catalog_cache_invalid", { origin: canonical, code: "parse" });
      return null;
    }
    if (parsed.schemaVersion !== CATALOG_CACHE_SCHEMA_VERSION || parsed.origin !== canonical) {
      diagnostics?.event("catalog_cache_invalid", { origin: canonical, code: parsed.origin !== canonical ? "origin" : "schema" });
      return null;
    }
    return parsed;
  };

  const save = (file: CatalogCacheFile): void => {
    const path = join(dir, cacheFileName(file.origin));
    const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      writeFileSync(temp, JSON.stringify(file), { mode: 0o600, flag: "wx" });
      renameSync(temp, path);
    } catch {
      rmSync(temp, { force: true });
      diagnostics?.event("catalog_cache_write_failed", { origin: file.origin });
    }
  };

  const fromDiscovery = (origin: string, discovery: Discovery): CatalogCacheFile => ({
    schemaVersion: CATALOG_CACHE_SCHEMA_VERSION,
    origin,
    fetchedAt: discovery.catalog.fetchedAt,
    ...(discovery.crawlDelayMs !== undefined ? { crawlDelayMs: discovery.crawlDelayMs } : {}),
    resources: discovery.resources,
    catalog: discovery.catalog,
  });

  const resolve = async (request: ResolveWithCacheOptions): Promise<CatalogCacheResult> => {
    const origin = new URL(request.origin).origin;
    const discover = request.discover ?? discoverCatalog;
    const cached = load(origin);
    const now = clock.now();
    const report = (source: CatalogCacheSource, catalog: SiteCatalog): CatalogCacheResult => {
      const stale = source === "stale";
      diagnostics?.event("catalog_cache", {
        origin,
        source,
        stale,
        candidateCount: catalog.candidates.length,
        ageMs: clock.now() - catalog.fetchedAt,
      });
      return { ok: true, catalog, source, stale };
    };

    if (cached && !request.refresh && now - cached.fetchedAt < CATALOG_FRESH_MS) return report("fresh", cached.catalog);

    if (cached) {
      request.fetch.setCrawlDelay(cached.crawlDelayMs);
      let same = false;
      try {
        same = await unchanged(cached.resources, request.fetch);
      } catch {
        same = false;
      }
      if (same) {
        const bumped = clock.now();
        const file: CatalogCacheFile = { ...cached, fetchedAt: bumped, catalog: { ...cached.catalog, fetchedAt: bumped } };
        save(file);
        return report("not_modified", file.catalog);
      }
    }

    let discovery: Discovery | null = null;
    try {
      discovery = await discover({ origin, fetch: request.fetch, clock, ...(diagnostics ? { diagnostics } : {}) });
    } catch {
      discovery = null;
    }
    if (discovery && !discovery.failed) {
      save(fromDiscovery(origin, discovery));
      return report(cached ? "refetched" : "miss", discovery.catalog);
    }
    if (cached && clock.now() - cached.fetchedAt < CATALOG_STALE_MAX_MS) return report("stale", cached.catalog);
    diagnostics?.event("catalog_cache", { origin, source: "failed", stale: false, hadCache: cached !== null });
    return discovery ? { ok: false, code: "discover_failed", errors: discovery.catalog.errors } : { ok: false, code: "discover_threw", errors: [] };
  };

  return { load, resolve };
}
