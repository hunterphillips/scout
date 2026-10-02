// The Sites list and the current tab's site, for the side panel. Pure: no `chrome.*`.
//
// Sites = every exact origin Chrome grants Scout (the worker's last permissions.getAll) plus
// every origin the core names in its `capabilities` frame (`origins`: the sites it holds
// settings or resources for). Each row can be allowed or removed; a request is always for the
// exact match pattern `https://<host>/*` (Chrome rejects a bare origin), and only for a site
// Scout may be allowed on at all (origin.ts). Which sites have recommendations on lives in the
// core's `config.json` `destinations`, which no frame carries, so the panel does not show it.

import type { OriginSetting } from "@scout/contracts";
import { checkSite, REFUSAL_TEXT, type SiteRefusal } from "../origin.js";

export interface SiteRow {
  /** `https://host` (or `https://host:port` for an origin the core named). */
  readonly origin: string;
  readonly host: string;
  /** The exact pattern Allow/Remove act on; null for an origin Scout can't be allowed on (a port). */
  readonly pattern: string | null;
  readonly granted: boolean;
  /** The core's auto-acquire setting for it; null when the core does not list the origin. */
  readonly autoAcquire: boolean | null;
}

const patternHost = (p: string): string | null => /^https:\/\/([^/*]+)\/\*$/.exec(p)?.[1] ?? null;

export function siteRows(granted: readonly string[], origins: readonly OriginSetting[]): SiteRow[] {
  const rows = new Map<string, SiteRow>();
  for (const p of granted) {
    const host = patternHost(p);
    if (host === null) continue;
    rows.set(`https://${host}`, { origin: `https://${host}`, host, pattern: p, granted: true, autoAcquire: null });
  }
  for (const o of origins) {
    const v = checkSite(`${o.origin}/`, false);
    const pattern = v.ok ? v.pattern : null;
    const prev = rows.get(o.origin);
    let host: string;
    try {
      host = new URL(o.origin).host;
    } catch {
      continue;
    }
    rows.set(o.origin, { origin: o.origin, host, pattern, granted: prev?.granted ?? false, autoAcquire: o.autoAcquire });
  }
  return [...rows.values()].sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}

/** What the worker knows about the panel window's active tab. */
export type CurrentSite =
  /** The tab's URL is not visible to Scout (no grant, no activeTab): the user clicks the icon. */
  | { kind: "unknown"; tabId: number | null; index: number | null }
  | { kind: "refused"; reason: SiteRefusal; tabId: number | null; index: number | null }
  | { kind: "ok"; origin: string; pattern: string; host: string; tabId: number | null; index: number | null }
  | { kind: "none" };

export const UNKNOWN_SITE_TEXT = "Click the Scout icon to check this site.";
export const refusalText = (r: SiteRefusal): string => REFUSAL_TEXT[r];

/** A site the user typed into Sites ("docs.stripe.com" or a full https URL), or why not. */
export function parseSiteInput(text: string): { ok: true; origin: string; pattern: string } | { ok: false; reason: string } {
  const t = text.trim().toLowerCase();
  if (t === "") return { ok: false, reason: "Type a site, like docs.stripe.com." };
  const url = /^[a-z][a-z0-9+.-]*:/.test(t) ? t : `https://${t}`;
  const v = checkSite(url.includes("/", "https://".length) ? url : `${url}/`, false);
  return v.ok ? { ok: true, origin: v.origin, pattern: v.pattern } : { ok: false, reason: REFUSAL_TEXT[v.reason] };
}
