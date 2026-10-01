import type { GuardedFetchResult } from "../fetch/guardedFetch.js";

/**
 * The fetch the catalog parsers depend on. The resolver binds it to `guardedFetch` plus
 * per-host crawl-delay pacing; tests pass a fake, so parser tests never touch DNS or the
 * network. Only these options are meaningful here: the binding must not forward anything
 * else into `guardedFetch` options. The conditional-request validators are used by the
 * cache's revalidation pass; the parsers never send them.
 */
export type CatalogFetch = (url: string, opts?: CatalogFetchOptions) => Promise<GuardedFetchResult>;

export interface CatalogFetchOptions {
  maxBytes?: number;
  accept?: string;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
}

/**
 * `Accept` for `robots.txt`. The catalog and resource discovery both send exactly this, so
 * a shared origin session can answer both from one request.
 */
export const ROBOTS_ACCEPT = "text/plain";

/** `Accept` for `llms.txt` files, sent by the catalog and resource discovery alike (see `ROBOTS_ACCEPT`). */
export const LLMS_TXT_ACCEPT = "text/markdown, text/plain";

/** The conditional-request validators a cache keeps for a URL, verbatim as the site sent them. */
export interface Validators {
  etag?: string;
  lastModified?: string;
}

/**
 * The validators to keep after `result`. A 200 replaces both with what it carried; a 304
 * replaces each one it carried and keeps the other. Empty values count as absent. Every
 * cache uses this, so two caches that saw the same responses hold the same validators and
 * send the same conditional request (which a shared session needs to coalesce them).
 */
export function nextValidators(stored: Validators, result: GuardedFetchResult): Validators {
  const kept: Validators = {};
  if (result.kind !== "ok") {
    if (stored.etag) kept.etag = stored.etag;
    if (stored.lastModified) kept.lastModified = stored.lastModified;
  }
  if (result.kind !== "ok" && result.kind !== "not_modified") return kept;
  if (result.etag) kept.etag = result.etag;
  if (result.lastModified) kept.lastModified = result.lastModified;
  return kept;
}

/** Size cap for `robots.txt` and `llms.txt` files. */
export const TEXT_SOURCE_MAX_BYTES = 512 * 1024;

/** Size cap for each sitemap file. */
export const SITEMAP_MAX_BYTES = 2 * 1024 * 1024;
