import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GuardedFetchResult } from "../fetch/guardedFetch.js";
import { fetchRobots, isAllowed, MAX_CRAWL_DELAY_MS, MAX_RULE_PATTERN_LENGTH, MAX_RULES, parseRobots } from "./robots.js";

const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/robots/${name}`, import.meta.url), "utf8");

describe("parseRobots", () => {
  it("applies the * group to Scout and reads crawl delay and sitemaps", () => {
    const rules = parseRobots(fixture("peak.txt"));

    expect(rules.crawlDelayMs).toBe(2000);
    expect(rules.sitemaps).toEqual(["https://www.peakdesign.com/sitemap.xml"]);
    expect(isAllowed(rules, "/products/everyday-backpack")).toBe(true);
    expect(isAllowed(rules, "/admin/settings")).toBe(false);
    expect(isAllowed(rules, "/cart")).toBe(false);
    expect(isAllowed(rules, "/cart/shared/abc")).toBe(true); // longer Allow wins
    expect(isAllowed(rules, "/collections/bags?oseid=12")).toBe(false); // * wildcard
    expect(isAllowed(rules, "/manuals/backpack.pdf")).toBe(false); // $ anchor
    expect(isAllowed(rules, "/manuals/backpack.pdf?download=1")).toBe(true);
  });

  it("uses a Scout group instead of * when one exists, matching the token case-insensitively", () => {
    const rules = parseRobots(["User-agent: *", "Disallow: /", "", "User-agent: Googlebot", "User-agent: SCOUT/1.0", "Disallow: /private"].join("\n"));

    expect(isAllowed(rules, "/products")).toBe(true);
    expect(isAllowed(rules, "/private/x")).toBe(false);
  });

  it("lets Allow win a tie and treats an empty Disallow as allow", () => {
    expect(isAllowed(parseRobots("User-agent: *\nDisallow: /page\nAllow: /page"), "/page")).toBe(true);
    // Equal-length, different patterns that both match: Allow still wins.
    expect(isAllowed(parseRobots("User-agent: *\nDisallow: /pag*\nAllow: /page"), "/page/x")).toBe(true);
    expect(isAllowed(parseRobots("User-agent: *\nAllow: /page\nDisallow: /pag*"), "/page/x")).toBe(true);
    expect(isAllowed(parseRobots("User-agent: *\nDisallow:"), "/anything")).toBe(true);
  });

  it("caps a hostile crawl delay", () => {
    expect(parseRobots("User-agent: *\nCrawl-delay: 86400").crawlDelayMs).toBe(MAX_CRAWL_DELAY_MS);
  });

  it("ignores a non-decimal crawl delay so a later valid one applies", () => {
    expect(parseRobots("User-agent: *\nCrawl-delay:\nCrawl-delay: 1e3\nCrawl-delay: 0x10\nCrawl-delay: 1.5").crawlDelayMs).toBe(1500);
    expect(parseRobots("User-agent: *\nCrawl-delay: soon").crawlDelayMs).toBeUndefined();
  });

  it("matches non-ASCII patterns and escapes regardless of percent-encoding case", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /café\nDisallow: /a%2fb");
    expect(isAllowed(rules, "/caf%C3%A9")).toBe(false);
    expect(isAllowed(rules, "/caf%c3%a9/menu")).toBe(false);
    expect(isAllowed(rules, "/a%2Fb")).toBe(false);
    expect(isAllowed(rules, "/cafe")).toBe(true);
  });

  it("skips over-long patterns and rules beyond the cap, and counts them", () => {
    const long = `Disallow: /*${"x".repeat(2000)}`;
    const many = Array.from({ length: MAX_RULES + 5 }, (_, i) => `Disallow: /r${i}/`);
    const rules = parseRobots(["User-agent: *", long, ...many].join("\n"));

    expect(rules.rules).toHaveLength(MAX_RULES);
    expect(rules.skippedRules).toEqual({ tooLong: 1, overLimit: 5 });
    expect(isAllowed(rules, `/${"x".repeat(2000)}`)).toBe(true);
    expect(isAllowed(rules, `/r${MAX_RULES}/`)).toBe(true);
    expect(isAllowed(rules, `/r${MAX_RULES - 1}/`)).toBe(false);
  });

  it("matches many-wildcard patterns without pathological backtracking", () => {
    const rules = parseRobots(`User-agent: *\nDisallow: /${"*a".repeat(40)}b`);
    const started = performance.now();
    expect(isAllowed(rules, `/${"a".repeat(5000)}`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("matches a maximal-length pattern against a 2,048-character path quickly", () => {
    const pattern = `/${"*a".repeat((MAX_RULE_PATTERN_LENGTH - 2) / 2)}b`;
    expect(pattern).toHaveLength(MAX_RULE_PATTERN_LENGTH);
    const rules = parseRobots(`User-agent: *\nDisallow: ${pattern}`);
    expect(rules.rules).toHaveLength(1);
    const started = performance.now();
    expect(isAllowed(rules, `/${"a".repeat(2047)}`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("checks the maximum number of worst-case wildcard rules against a 2,048-character path quickly", () => {
    const pattern = `/*${"a".repeat(MAX_RULE_PATTERN_LENGTH - 3)}b`;
    expect(pattern).toHaveLength(MAX_RULE_PATTERN_LENGTH);
    const rules = parseRobots(["User-agent: *", ...Array.from({ length: MAX_RULES }, () => `Disallow: ${pattern}`)].join("\n"));
    expect(rules.rules).toHaveLength(MAX_RULES);
    const started = performance.now();
    expect(isAllowed(rules, `/${"a".repeat(2047)}`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("keeps anchor, prefix, and multi-wildcard semantics", () => {
    const matches = (pattern: string, path: string) => !isAllowed(parseRobots(`User-agent: *\nDisallow: ${pattern}`), path);
    expect(matches("/a", "/abc")).toBe(true);
    expect(matches("/a$", "/a")).toBe(true);
    expect(matches("/a$", "/ab")).toBe(false);
    expect(matches("/a$b", "/a$bc")).toBe(true); // a $ not at the end is literal
    expect(matches("/*.pdf$", "/x.pdf.pdf")).toBe(true);
    expect(matches("/*.pdf$", "/x.pdfx")).toBe(false);
    expect(matches("/a*b*c", "/aXbYc/z")).toBe(true);
    expect(matches("/a*b*c", "/aXcYb")).toBe(false);
    expect(matches("/ab*ba$", "/aba")).toBe(false); // pieces may not overlap
    expect(matches("/ab*ba$", "/abba")).toBe(true);
    expect(matches("/**x*", "/x")).toBe(true);
    expect(matches("/*$", "/anything")).toBe(true);
    expect(matches("*", "/")).toBe(true);
  });
});

describe("fetchRobots", () => {
  const fetchReturning = (result: GuardedFetchResult) => async () => result;

  it("allows everything when robots.txt is absent or the fetch fails", async () => {
    const absent = await fetchRobots("https://example.com", fetchReturning({ kind: "absent", status: 404 }));
    const failed = await fetchRobots("https://example.com", fetchReturning({ kind: "error", reason: "timeout", message: "t" }));

    const none = { tooLong: 0, overLimit: 0 };
    expect(absent).toEqual({ rules: [], sitemaps: [], skippedRules: none, source: "absent" });
    expect(failed).toEqual({ rules: [], sitemaps: [], skippedRules: none, source: "error" });
    expect(isAllowed(absent, "/admin")).toBe(true);
  });

  it("fetches /robots.txt on the origin and parses it", async () => {
    const urls: string[] = [];
    const rules = await fetchRobots("https://www.peakdesign.com", async (url) => {
      urls.push(url);
      return { kind: "ok", status: 200, body: fixture("peak.txt"), bytes: new Uint8Array(), finalUrl: url };
    });

    expect(urls).toEqual(["https://www.peakdesign.com/robots.txt"]);
    expect(rules.source).toBe("fetched");
    expect(isAllowed(rules, "/admin")).toBe(false);
  });
});
