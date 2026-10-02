/** Longest URL Scout accepts from a site, before and after normalization. */
export const MAX_URL_LENGTH = 2048;

function check(url: URL, origin: string): URL | null {
  let expected: URL;
  try {
    expected = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || expected.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.href.length > MAX_URL_LENGTH) return null;
  return url.origin === expected.origin ? url : null;
}

/**
 * Resolve `raw` against `base` and return it only if it is an `https:` URL with the same
 * origin (scheme, host, port) as `origin`, no embedded credentials, and at most
 * `MAX_URL_LENGTH` characters. Anything else, including unparseable input, returns null.
 * Site-published links never widen Scout's reach beyond the origin being catalogued.
 *
 * Relative input is allowed; use this only where the format permits relative links
 * (llms.txt). Sitemaps and robots `Sitemap:` lines use `sameOriginAbsoluteHttpsUrl`.
 */
export function sameOriginHttpsUrl(raw: string, origin: string, base: string = origin): URL | null {
  const trimmed = raw.trim();
  if (trimmed.length > MAX_URL_LENGTH) return null;
  try {
    return check(new URL(trimmed, base), origin);
  } catch {
    return null;
  }
}

/**
 * Like `sameOriginHttpsUrl`, but `raw` must already be an absolute URL: it is parsed with
 * no base, so empty, relative, and scheme-less input returns null.
 */
export function sameOriginAbsoluteHttpsUrl(raw: string, origin: string): URL | null {
  const trimmed = raw.trim();
  if (trimmed.length > MAX_URL_LENGTH) return null;
  try {
    return check(new URL(trimmed), origin);
  } catch {
    return null;
  }
}

/**
 * `href` as a URL Scout may open for `origin`, or null: the same rule as above (https, no
 * credentials, the same origin, at most `MAX_URL_LENGTH` characters), plus no explicit port (so
 * only origins on the default port qualify) and `href` exactly as the WHATWG parser writes it.
 * No trimming, no base: whitespace, backslashes, upper-case hosts, and any other form the parser
 * rewrites (and another parser might read differently) return null. Any path, query, or
 * fragment on the origin passes. A `humanHref` from verifyTargets.ts passes, because it is a
 * parsed URL's `href`. Scout's window opens only targets that pass this (results.ts).
 */
export function exactSameOriginHttpsUrl(href: string, origin: string): URL | null {
  if (typeof href !== "string" || href.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.port !== "" || url.href !== href) return null;
  return check(url, origin);
}
