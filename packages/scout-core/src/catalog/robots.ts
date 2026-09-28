import { type CatalogFetch, TEXT_SOURCE_MAX_BYTES } from "./catalogFetch.js";

/** Scout's product token for `User-agent` matching (case-insensitive). */
export const ROBOTS_PRODUCT_TOKEN = "scout";

/** Upper bound on an honored `Crawl-delay`, so a hostile robots.txt cannot stall Scout. */
export const MAX_CRAWL_DELAY_MS = 10_000;

export interface RobotsRule {
  allow: boolean;
  /** The path pattern as written, e.g. `/private/*.pdf$`. */
  pattern: string;
}

export interface RobotsRules {
  /** Rules of the group that applies to Scout; empty means everything is allowed. */
  rules: RobotsRule[];
  /** Crawl delay for Scout's own requests to the host, capped at `MAX_CRAWL_DELAY_MS`. */
  crawlDelayMs?: number;
  /** `Sitemap:` URLs exactly as listed, from any group. Not yet origin-filtered. */
  sitemaps: string[];
}

/** Where the rules came from, so the resolver can log a code. */
export type RobotsSource = "fetched" | "absent" | "error";

export type FetchedRobots = RobotsRules & { source: RobotsSource };

interface Group {
  agents: string[];
  rules: RobotsRule[];
  crawlDelayMs?: number;
}

/**
 * Parse a robots.txt file (RFC 9309, plus the common `Crawl-delay` and `Sitemap`
 * extensions).
 *
 * Group selection: groups naming Scout's product token apply if any exist; otherwise
 * the `*` groups apply; otherwise nothing applies. Several groups for the same agent are
 * merged. An empty `Disallow:` is not a rule. `Sitemap:` lines are global.
 */
export function parseRobots(text: string): RobotsRules {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.split("/")[0]?.trim().toLowerCase() ?? "");
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue; // rules before any User-agent line belong to no group
    if (key === "allow" || key === "disallow") {
      if (value) current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay" && current.crawlDelayMs === undefined) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelayMs = Math.min(seconds * 1000, MAX_CRAWL_DELAY_MS);
    }
  }

  const forScout = groups.filter((group) => group.agents.includes(ROBOTS_PRODUCT_TOKEN));
  const applicable = forScout.length > 0 ? forScout : groups.filter((group) => group.agents.includes("*"));
  const rules = applicable.flatMap((group) => group.rules);
  const crawlDelayMs = applicable.find((group) => group.crawlDelayMs !== undefined)?.crawlDelayMs;
  return crawlDelayMs === undefined ? { rules, sitemaps } : { rules, crawlDelayMs, sitemaps };
}

/**
 * Match a robots path pattern: `*` matches any run of characters, a trailing `$` anchors
 * the end, otherwise the pattern is a prefix. Iterative wildcard matching (no RegExp), so
 * a hostile pattern with many `*` costs at most O(pattern × path).
 */
function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const p = anchored ? pattern.slice(0, -1) : `${pattern}*`;
  let pi = 0;
  let si = 0;
  let star = -1;
  let resume = 0;
  while (si < path.length) {
    if (pi < p.length && p[pi] === "*") {
      star = pi++;
      resume = si;
    } else if (pi < p.length && p[pi] === path[si]) {
      pi++;
      si++;
    } else if (star >= 0) {
      pi = star + 1;
      si = ++resume;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

/**
 * Whether `path` (pathname plus any query string) may be used. The longest matching
 * pattern wins; on equal length `Allow` wins. No match means allowed.
 */
export function isAllowed(rules: RobotsRules, path: string): boolean {
  let best: RobotsRule | null = null;
  for (const rule of rules.rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

/**
 * Fetch and parse `${origin}/robots.txt`. A missing file or any fetch error yields
 * allow-all rules with no sitemaps and no crawl delay; `source` records which case applied.
 */
export async function fetchRobots(origin: string, fetch: CatalogFetch): Promise<FetchedRobots> {
  const result = await fetch(`${origin}/robots.txt`, { maxBytes: TEXT_SOURCE_MAX_BYTES, accept: "text/plain" });
  if (result.kind === "ok") return { ...parseRobots(result.body), source: "fetched" };
  return { rules: [], sitemaps: [], source: result.kind === "absent" ? "absent" : "error" };
}
