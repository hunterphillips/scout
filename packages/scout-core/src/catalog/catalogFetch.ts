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

/** Size cap for `robots.txt` and `llms.txt` files. */
export const TEXT_SOURCE_MAX_BYTES = 512 * 1024;

/** Size cap for each sitemap file. */
export const SITEMAP_MAX_BYTES = 2 * 1024 * 1024;
