// Which recommended links the side panel may open: only a target the core sent back in the ok
// ack of the user's own `open_link`, checked again here. A port of ScoutKit's LinkOpener rules
// (native/Scout/Sources/ScoutKit/LinkOpener.swift): `https`, no user or password, no explicit
// port (not even 443, nor an empty one), and exactly the result's host, compared byte for byte
// with the link's authority as written. Any path, query or fragment on that host passes, so a
// verified HTML twin does. The panel opens a passing link with chrome.tabs.create; a failed
// create is refused as `open_failed`. Pure: no `chrome.*`.

/** `SOURCE_URL_MAX_CHARS` in @scout/contracts (the app's `PanelLimits.urlMaxBytes`). */
export const URL_MAX_BYTES = 2048;

export type LinkRefusal = "malformed" | "not_https" | "credentials" | "port" | "wrong_host" | "open_failed";
export const LINK_REFUSALS: readonly LinkRefusal[] = ["malformed", "not_https", "credentials", "port", "wrong_host", "open_failed"];

const REFUSAL_TEXT: Record<LinkRefusal, string> = {
  malformed: "the link was malformed",
  not_https: "the link was not https",
  credentials: "the link carried a user name or password",
  port: "the link named a port",
  wrong_host: "the link pointed at another site",
  open_failed: "Chrome could not open it",
};
export const refusalText = (r: LinkRefusal): string => REFUSAL_TEXT[r];

export type LinkCheck = { ok: true; url: string } | { ok: false; refusal: LinkRefusal };
const refuse = (refusal: LinkRefusal): LinkCheck => ({ ok: false, refusal });

/** The host of a bare `https://host` origin, or null (a port, a path, anything else). */
function originHost(origin: string): string | null {
  if (!origin.startsWith("https://")) return null;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username !== "" || u.password !== "") return null;
  const host = origin.slice("https://".length);
  return host !== "" && u.hostname === host ? host : null;
}

/** `href` as a URL to open for a result from `origin` (`https://host`), or why not. */
export function checkLink(href: string, origin: string): LinkCheck {
  // Nothing a parser might read two ways: no whitespace, controls, backslashes, or non-ASCII.
  if (href.length === 0 || href.length > URL_MAX_BYTES) return refuse("malformed");
  for (let i = 0; i < href.length; i++) {
    const c = href.charCodeAt(i);
    if (c <= 0x20 || c >= 0x7f || c === 0x5c) return refuse("malformed");
  }
  if (!href.startsWith("https://")) return refuse(href.includes(":") ? "not_https" : "malformed");
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return refuse("malformed");
  }
  if (u.protocol !== "https:") return refuse("not_https");
  // The authority as written: after `https://`, up to the first `/`, `?` or `#`.
  const rest = href.slice("https://".length);
  const authority = rest.slice(0, rest.search(/[/?#]|$/));
  if (u.username !== "" || u.password !== "" || authority.includes("@")) return refuse("credentials");
  // WHATWG URL drops a default or empty port, so the written authority decides.
  if (u.port !== "" || /:\d*$/.test(authority)) return refuse("port");
  const host = originHost(origin);
  if (host === null) return refuse("wrong_host");
  if (authority !== host || u.hostname !== host) return refuse("wrong_host");
  return { ok: true, url: href };
}
