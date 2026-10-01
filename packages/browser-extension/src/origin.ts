// Which pages Scout may be allowed on, and the one exact-origin permission
// pattern for each. Used by the popup (to decide whether to offer "Allow
// Scout on this site") and by the focus observer (to send a tab's URL only
// when its exact origin is granted). No imports, so the popup bundle stays
// free of zod.
//
// The host rule mirrors isHttpsOrigin in @scout/contracts (RFC 1123 hostname,
// no IP literals) so every pattern built here is one the core accepts.

/** Pages Chrome never lets an extension touch, even with a host grant. */
const BLOCKED_HOSTS: ReadonlySet<string> = new Set(["chrome.google.com", "chromewebstore.google.com"]);

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

export type SiteRefusal = "no-page" | "internal" | "not-https" | "credentials" | "port" | "host" | "incognito";

export type SiteVerdict = { ok: true; origin: string; pattern: string } | { ok: false; reason: SiteRefusal };

/** Short popup text for each refusal. */
export const REFUSAL_TEXT: Record<SiteRefusal, string> = {
  "no-page": "Scout can't read this tab.",
  internal: "Browser pages can't use Scout.",
  "not-https": "Only https sites can use Scout.",
  credentials: "This address has sign-in details in it.",
  port: "Sites on a non-standard port can't use Scout.",
  host: "This host name isn't supported.",
  incognito: "Scout doesn't run in private windows.",
};

function hostOk(host: string): boolean {
  if (host.length > 253 || !HOSTNAME_RE.test(host)) return false;
  const labels = host.split(".");
  return labels.every((l) => l.length <= 63) && !/^\d+$/.test(labels.at(-1)!);
}

/** May Scout be allowed on the page at `url` (in a tab that is or is not incognito)? */
export function checkSite(url: string | undefined, incognito: boolean): SiteVerdict {
  if (incognito) return { ok: false, reason: "incognito" };
  if (typeof url !== "string" || url === "") return { ok: false, reason: "no-page" };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "no-page" };
  }
  if (u.protocol === "http:") return { ok: false, reason: "not-https" };
  if (u.protocol !== "https:") return { ok: false, reason: "internal" };
  if (u.username !== "" || u.password !== "") return { ok: false, reason: "credentials" };
  if (u.port !== "") return { ok: false, reason: "port" };
  if (BLOCKED_HOSTS.has(u.hostname)) return { ok: false, reason: "internal" };
  if (!hostOk(u.hostname)) return { ok: false, reason: "host" };
  return { ok: true, origin: u.origin, pattern: `https://${u.hostname}/*` };
}

/** The exact-origin pattern for a URL Scout may be allowed on, else null. */
export function sitePattern(url: string | undefined): string | null {
  const v = checkSite(url, false);
  return v.ok ? v.pattern : null;
}
