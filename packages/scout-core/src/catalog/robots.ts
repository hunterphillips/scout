import { type CatalogFetch, TEXT_SOURCE_MAX_BYTES } from "./catalogFetch.js";

/** Scout's product token for `User-agent` matching (case-insensitive). */
export const ROBOTS_PRODUCT_TOKEN = "scout";

/** Upper bound on an honored `Crawl-delay`, so a hostile robots.txt cannot stall Scout. */
export const MAX_CRAWL_DELAY_MS = 10_000;

/** Longest `Allow`/`Disallow` pattern kept (after encoding normalization); longer rules are skipped. */
export const MAX_RULE_PATTERN_LENGTH = 512;

/** Most `Allow`/`Disallow` rules kept from one file, across all groups; extra rules are skipped. */
export const MAX_RULES = 2000;

export interface RobotsRule {
  allow: boolean;
  /**
   * The path pattern, e.g. `/private/*.pdf$`, with `%xx` escapes uppercased and non-ASCII
   * characters percent-encoded (UTF-8) so it compares against URL paths.
   */
  pattern: string;
}

export interface RobotsRules {
  /** Rules of the group that applies to Scout; empty means everything is allowed. */
  rules: RobotsRule[];
  /** Crawl delay for Scout's own requests to the host, capped at `MAX_CRAWL_DELAY_MS`. */
  crawlDelayMs?: number;
  /** `Sitemap:` URLs exactly as listed, from any group. Not yet origin-filtered. */
  sitemaps: string[];
  /** Rules skipped anywhere in the file (not only Scout's group), for diagnostics. */
  skippedRules: {
    /** Patterns longer than `MAX_RULE_PATTERN_LENGTH`. */
    tooLong: number;
    /** Rules beyond `MAX_RULES`. */
    overLimit: number;
  };
}

/** Where the rules came from, so the resolver can log a code. */
export type RobotsSource = "fetched" | "absent" | "error";

export type FetchedRobots = RobotsRules & { source: RobotsSource };

// A plain decimal number of seconds, e.g. `2` or `0.5`.
const CRAWL_DELAY = /^\d+(\.\d+)?$/;

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
 *
 * Bounds: patterns over `MAX_RULE_PATTERN_LENGTH` and rules beyond `MAX_RULES` are skipped
 * and counted in `skippedRules`. `Crawl-delay` must be a plain decimal number of seconds;
 * any other value is ignored, so a later valid line in the group still applies.
 */
export function parseRobots(text: string): RobotsRules {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  const skippedRules = { tooLong: 0, overLimit: 0 };
  let ruleCount = 0;
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
      if (!value) continue;
      // Check the raw length first so normalization never runs on a huge value.
      const pattern = value.length > MAX_RULE_PATTERN_LENGTH ? null : normalizeEncoding(value);
      if (pattern === null || pattern.length > MAX_RULE_PATTERN_LENGTH) {
        skippedRules.tooLong += 1;
      } else if (ruleCount >= MAX_RULES) {
        skippedRules.overLimit += 1;
      } else {
        ruleCount += 1;
        current.rules.push({ allow: key === "allow", pattern });
      }
    } else if (key === "crawl-delay" && current.crawlDelayMs === undefined && CRAWL_DELAY.test(value)) {
      current.crawlDelayMs = Math.min(Number(value) * 1000, MAX_CRAWL_DELAY_MS);
    }
  }

  const forScout = groups.filter((group) => group.agents.includes(ROBOTS_PRODUCT_TOKEN));
  const applicable = forScout.length > 0 ? forScout : groups.filter((group) => group.agents.includes("*"));
  const rules = applicable.flatMap((group) => group.rules);
  const crawlDelayMs = applicable.find((group) => group.crawlDelayMs !== undefined)?.crawlDelayMs;
  return crawlDelayMs === undefined ? { rules, sitemaps, skippedRules } : { rules, crawlDelayMs, sitemaps, skippedRules };
}

/**
 * Minimal percent-encoding normalization so patterns and paths compare equal: `%xx`
 * escapes get uppercase hex digits and non-ASCII characters are UTF-8 percent-encoded.
 * Other escapes are left as written (`%2F` and `/` stay distinct).
 */
function normalizeEncoding(text: string): string {
  return text
    .replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase())
    .replace(/[^\u0000-\u007F]/gu, (char) => {
      try {
        return encodeURIComponent(char);
      } catch {
        return "%EF%BF%BD"; // a lone surrogate encodes as U+FFFD, as URL parsing does
      }
    });
}

/** A rule with its pattern split once, so matching a path does no per-call string work. */
interface CompiledRule {
  allow: boolean;
  /** Length of the original pattern, for longest-match precedence. */
  length: number;
  anchored: boolean;
  /** The pattern (minus any trailing `$`) split on `*`. */
  pieces: string[];
}

/** Rules prepared by `compileRobots`; pass to `isAllowed` when checking many paths against one file. */
export interface CompiledRobots {
  readonly compiled: readonly CompiledRule[];
}

/** Split every rule pattern once. Use this before checking many paths against the same rules. */
export function compileRobots(rules: Pick<RobotsRules, "rules">): CompiledRobots {
  return {
    compiled: rules.rules.map((rule) => {
      const anchored = rule.pattern.endsWith("$");
      return { allow: rule.allow, length: rule.pattern.length, anchored, pieces: (anchored ? rule.pattern.slice(0, -1) : rule.pattern).split("*") };
    }),
  };
}

/**
 * Match a robots path pattern: `*` matches any run of characters, a trailing `$` anchors
 * the end, otherwise the pattern is a prefix. The pattern is split on `*` and each piece is
 * found at its leftmost position after the previous one, with no backtracking (leftmost
 * matching is correct when `*` is the only wildcard), so a rule costs about O(path) no
 * matter how many `*` it has. A `$` anywhere but the end is literal.
 */
function ruleMatches(rule: CompiledRule, path: string): boolean {
  const { anchored, pieces } = rule;
  const first = pieces[0] ?? "";
  if (pieces.length === 1) return anchored ? path === first : path.startsWith(first);
  if (!path.startsWith(first)) return false;
  let pos = first.length;
  for (let i = 1; i < pieces.length - 1; i++) {
    const piece = pieces[i] ?? "";
    if (!piece) continue;
    const found = path.indexOf(piece, pos);
    if (found < 0) return false;
    pos = found + piece.length;
  }
  const last = pieces[pieces.length - 1] ?? "";
  if (anchored) return path.length - last.length >= pos && path.endsWith(last);
  return path.indexOf(last, pos) >= 0;
}

/**
 * Whether `path` (pathname plus any query string) may be used. The longest matching
 * pattern wins; on equal length `Allow` wins. No match means allowed. The path gets the
 * same encoding normalization as patterns. Accepts raw rules (compiled on every call) or
 * the output of `compileRobots`.
 */
export function isAllowed(rules: Pick<RobotsRules, "rules"> | CompiledRobots, rawPath: string): boolean {
  const compiled = "compiled" in rules ? rules.compiled : compileRobots(rules).compiled;
  const path = normalizeEncoding(rawPath);
  let best: CompiledRule | null = null;
  for (const rule of compiled) {
    if (!ruleMatches(rule, path)) continue;
    if (!best || rule.length > best.length || (rule.length === best.length && rule.allow && !best.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

/**
 * Fetch and parse `${origin}/robots.txt`. A missing file or any fetch error yields
 * allow-all rules with no sitemaps and no crawl delay; `source` records which case applied.
 *
 * Allow-all on a fetch error (including 5xx) is deliberate proof-of-concept policy. RFC 9309
 * says a crawler should treat an unreachable robots.txt as disallow-all; `source: "error"`
 * is exposed so the resolver can tighten this without changing the parser.
 */
export async function fetchRobots(origin: string, fetch: CatalogFetch): Promise<FetchedRobots> {
  const result = await fetch(`${origin}/robots.txt`, { maxBytes: TEXT_SOURCE_MAX_BYTES, accept: "text/plain" });
  if (result.kind === "ok") return { ...parseRobots(result.body), source: "fetched" };
  return { rules: [], sitemaps: [], skippedRules: { tooLong: 0, overLimit: 0 }, source: result.kind === "absent" ? "absent" : "error" };
}
