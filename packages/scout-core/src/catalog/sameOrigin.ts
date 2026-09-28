/**
 * Resolve `raw` against `base` and return it only if it is an `https:` URL with the same
 * origin (scheme, host, port) as `origin` and no embedded credentials. Anything else,
 * including unparseable input, returns null. Site-published links never widen Scout's
 * reach beyond the origin being catalogued.
 */
export function sameOriginHttpsUrl(raw: string, origin: string, base: string = origin): URL | null {
  let url: URL;
  let expected: URL;
  try {
    expected = new URL(origin);
    url = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || expected.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.origin === expected.origin ? url : null;
}
