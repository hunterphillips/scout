import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SiteCatalog, SiteCatalogSchema } from "@scout/contracts";
import { z } from "zod";
import type { Clock } from "../clock.js";
import { type Diagnostics, scoutHome } from "../diagnostics.js";
import { type CatalogFetchOptions, SITEMAP_MAX_BYTES } from "./catalogFetch.js";
import type { PacedCatalogFetch } from "./pacing.js";
import { type CatalogResource, discoverCatalog, type Discovery, type DiscoverOptions } from "./resolver.js";

/** Bump when the file shape or the resolver's output changes meaning; every older file is then ignored. */
export const CATALOG_CACHE_SCHEMA_VERSION = 2;

/** A cached catalog is used without any network request for this long. */
export const CATALOG_FRESH_MS = 24 * 60 * 60 * 1000;

/** When a refresh fails, a cached catalog younger than this is still served, marked stale. */
export const CATALOG_STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** A cached `fetchedAt` further than this in the future is treated as invalid (clock skew or tampering). */
export const CATALOG_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Longest readable host prefix in a cache file name; the hash suffix keeps names unique. */
const FILE_PREFIX_MAX = 100;

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
      maxBytes: z.number().int().positive().optional(),
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

/**
 * File name for an origin: a readable prefix (host lowercased, `:` and any other unsafe
 * character turned into `_`, at most 100 characters) then `-` and the first 16 hex digits
 * of the SHA-256 of the origin. The hash keeps names unique where the prefix collides
 * (`a_8443` vs `a:8443`) or is cut short, and the length bound keeps the temp name under
 * the file-system limit for any host.
 */
export function cacheFileName(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:") throw new TypeError("catalog origin must be https");
  const name = url.host.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
  if (!name || /^\.+$/.test(name)) throw new TypeError("catalog origin has no usable host");
  const hash = createHash("sha256").update(url.origin).digest("hex").slice(0, 16);
  return `${name.slice(0, FILE_PREFIX_MAX)}-${hash}.json`;
}

type DirRefusal = "symlink" | "not_directory" | "wrong_owner" | "not_private";

/** Why `dir` is unsafe to use for the cache, or null if it is a private directory we own. Mirrors `ensurePrivateRunDir`. Throws if lstat fails. */
function checkPrivateDir(dir: string, uid: number = process.getuid?.() ?? -1): DirRefusal | null {
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) return "symlink";
  if (!st.isDirectory()) return "not_directory";
  if (st.uid !== uid) return "wrong_owner";
  if ((st.mode & 0o077) !== 0) return "not_private";
  return null;
}

/** A short code for a file-system error, safe for diagnostics. */
function fsErrorCode(error: unknown): string {
  switch ((error as NodeJS.ErrnoException | null)?.code) {
    case "ENOTDIR":
      return "enotdir";
    case "EEXIST":
      // mkdir hit an existing non-directory: most likely the cache dir path is a regular file.
      return "not_directory";
    case "ENAMETOOLONG":
      return "enametoolong";
    case "EACCES":
    case "EPERM":
      return "eacces";
    default:
      return "other";
  }
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
    const opts: CatalogFetchOptions = { maxBytes: resource.maxBytes ?? SITEMAP_MAX_BYTES };
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
 * Partial failures: any run that produces a non-empty catalog replaces the cached one,
 * even if some of its requests failed (`catalog.errors` is non-empty). This is a deliberate
 * proof-of-concept choice: a fresh catalog with gaps is preferred over a richer but stale
 * one, and the next refresh fills the gaps.
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
      // zod omits absent optional keys, so the parsed value satisfies the exact-optional interface.
      parsed = CacheFileSchema.parse(JSON.parse(raw)) as CatalogCacheFile;
    } catch {
      diagnostics?.event("catalog_cache_invalid", { origin: canonical, code: "parse" });
      return null;
    }
    const invalid =
      parsed.schemaVersion !== CATALOG_CACHE_SCHEMA_VERSION
        ? "schema"
        : parsed.origin !== canonical || parsed.catalog.origin !== canonical
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
      save(fromDiscovery(origin, discovery, cached));
      return report(cached ? "refetched" : "miss", discovery.catalog);
    }
    if (cached && clock.now() - cached.fetchedAt < CATALOG_STALE_MAX_MS) return report("stale", cached.catalog);
    diagnostics?.event("catalog_cache", { origin, source: "failed", stale: false, hadCache: cached !== null });
    return discovery ? { ok: false, code: "discover_failed", errors: discovery.catalog.errors } : { ok: false, code: "discover_threw", errors: [] };
  };

  return { load, resolve };
}
