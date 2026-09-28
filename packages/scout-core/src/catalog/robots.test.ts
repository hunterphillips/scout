import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GuardedFetchResult } from "../fetch/guardedFetch.js";
import { fetchRobots, isAllowed, MAX_CRAWL_DELAY_MS, parseRobots } from "./robots.js";

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
    expect(isAllowed(parseRobots("User-agent: *\nDisallow:"), "/anything")).toBe(true);
  });

  it("caps a hostile crawl delay", () => {
    expect(parseRobots("User-agent: *\nCrawl-delay: 86400").crawlDelayMs).toBe(MAX_CRAWL_DELAY_MS);
  });

  it("matches many-wildcard patterns without pathological backtracking", () => {
    const rules = parseRobots(`User-agent: *\nDisallow: /${"*a".repeat(40)}b`);
    const started = performance.now();
    expect(isAllowed(rules, `/${"a".repeat(5000)}`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("fetchRobots", () => {
  const fetchReturning = (result: GuardedFetchResult) => async () => result;

  it("allows everything when robots.txt is absent or the fetch fails", async () => {
    const absent = await fetchRobots("https://example.com", fetchReturning({ kind: "absent", status: 404 }));
    const failed = await fetchRobots("https://example.com", fetchReturning({ kind: "error", reason: "timeout", message: "t" }));

    expect(absent).toEqual({ rules: [], sitemaps: [], source: "absent" });
    expect(failed).toEqual({ rules: [], sitemaps: [], source: "error" });
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
