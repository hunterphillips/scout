import { describe, expect, it } from "vitest";
import type { GuardedFetchOptions, GuardedFetchResult } from "../fetch/guardedFetch.js";
import { createPacedCatalogFetch, isRefusal } from "./pacing.js";

const ORIGIN = "https://shop.example";

function harness(maxRequests?: number, runDeadlineMs?: number) {
  let now = 0;
  const clock = { now: () => now };
  const log: string[] = [];
  const seen: GuardedFetchOptions[] = [];
  const fetch = createPacedCatalogFetch({
    origin: ORIGIN,
    clock,
    ...(maxRequests !== undefined ? { maxRequests } : {}),
    ...(runDeadlineMs !== undefined ? { runDeadlineMs } : {}),
    sleep: async (ms) => {
      log.push(`sleep ${ms}`);
      now += ms;
    },
    guardedFetch: async (url, options) => {
      log.push(`fetch ${new URL(url).pathname}`);
      seen.push(options);
      now += 100; // each request takes 100 ms
      const result: GuardedFetchResult = { kind: "absent", status: 404 };
      return result;
    },
  });
  return { fetch, log, seen, advance: (ms: number) => void (now += ms) };
}

describe("createPacedCatalogFetch", () => {
  it("waits the crawl delay between requests, never before the first", async () => {
    const { fetch, log } = harness();
    await fetch(`${ORIGIN}/robots.txt`);
    fetch.setCrawlDelay(2000);
    await Promise.all([fetch(`${ORIGIN}/llms.txt`), fetch(`${ORIGIN}/sitemap.xml`)]);

    expect(log).toEqual(["fetch /robots.txt", "sleep 2000", "fetch /llms.txt", "sleep 2000", "fetch /sitemap.xml"]);
  });

  it("forwards only the named options, including conditional validators", async () => {
    const { fetch, seen } = harness();
    await fetch(`${ORIGIN}/sitemap.xml`, { maxBytes: 10, accept: "text/xml", ifNoneMatch: '"e"', ifModifiedSince: "Mon, 01 Sep 2026 00:00:00 GMT" });
    await fetch(`${ORIGIN}/llms.txt`);

    expect(seen[0]).toEqual({ timeoutMs: 8000, maxBytes: 10, accept: "text/xml", ifNoneMatch: '"e"', ifModifiedSince: "Mon, 01 Sep 2026 00:00:00 GMT" });
    expect(seen[1]).toEqual({ timeoutMs: 8000 });
  });

  it("refuses requests over budget or off the origin without a network call", async () => {
    const { fetch, log } = harness(2);
    expect((await fetch("https://other.example/robots.txt")).kind).toBe("error");
    await fetch(`${ORIGIN}/a`);
    await fetch(`${ORIGIN}/b`);
    const over = await fetch(`${ORIGIN}/c`);

    expect(over).toMatchObject({ kind: "error", reason: "policy" });
    expect(log).toEqual(["fetch /a", "fetch /b"]);
    expect(fetch.refused).toBe(2);
  });

  it("refuses requests once the run deadline has passed since the first request", async () => {
    const { fetch, log, advance } = harness(undefined, 1000);
    advance(5000); // time before the first request does not count
    await fetch(`${ORIGIN}/robots.txt`); // starts the clock; takes 100 ms
    advance(799);
    await fetch(`${ORIGIN}/llms.txt`); // at 899 ms: allowed, ends at 999 ms
    advance(1);
    const late = await fetch(`${ORIGIN}/sitemap.xml`); // at 1000 ms: refused

    expect(late).toMatchObject({ kind: "error", reason: "policy", message: "catalog run deadline passed" });
    expect(log).toEqual(["fetch /robots.txt", "fetch /llms.txt"]);
    expect(fetch.refused).toBe(1);
  });

  it("refuses a request whose crawl-delay wait runs past the deadline", async () => {
    const { fetch, log } = harness(undefined, 1000);
    await fetch(`${ORIGIN}/robots.txt`);
    fetch.setCrawlDelay(2000);
    const late = await fetch(`${ORIGIN}/llms.txt`);

    expect(late).toMatchObject({ kind: "error", reason: "policy" });
    expect(log).toEqual(["fetch /robots.txt", "sleep 2000"]);
    expect(fetch.refused).toBe(1);
  });

  it("marks its own refusals so callers can tell them from the site's answers", async () => {
    const { fetch } = harness(1);
    const answered = await fetch(`${ORIGIN}/a`);
    const refused = await fetch(`${ORIGIN}/b`);

    expect(isRefusal(answered)).toBe(false);
    expect(isRefusal(refused)).toBe(true);
    expect(isRefusal({ kind: "error", reason: "policy", message: "from guardedFetch" })).toBe(false);
  });

  it("startWindow restarts the deadline and budget but keeps the crawl delay", async () => {
    const { fetch, log } = harness(2, 1000);
    await fetch(`${ORIGIN}/robots.txt`);
    fetch.setCrawlDelay(300);
    await fetch(`${ORIGIN}/a`); // budget spent (2 of 2)
    expect(await fetch(`${ORIGIN}/b`)).toMatchObject({ kind: "error", reason: "policy" });

    fetch.startWindow();
    await fetch(`${ORIGIN}/c`); // the crawl delay still applies across the window boundary
    await fetch(`${ORIGIN}/d`);
    expect(await fetch(`${ORIGIN}/e`)).toMatchObject({ kind: "error", reason: "policy" }); // new budget of 2 spent

    fetch.startWindow();
    expect((await fetch(`${ORIGIN}/f`)).kind).toBe("absent");
    expect(log).toEqual(["fetch /robots.txt", "sleep 300", "fetch /a", "sleep 300", "fetch /c", "sleep 300", "fetch /d", "sleep 300", "fetch /f"]);
    expect(fetch.requests).toBe(5);
    expect(fetch.refused).toBe(2);
  });

  it("startWindow gives a fresh deadline counted from the next request", async () => {
    const { fetch, advance } = harness(undefined, 1000);
    await fetch(`${ORIGIN}/a`);
    advance(5000);
    expect(await fetch(`${ORIGIN}/b`)).toMatchObject({ message: "catalog run deadline passed" });

    fetch.startWindow();
    advance(5000); // idle time before the window's first request does not count
    expect((await fetch(`${ORIGIN}/c`)).kind).toBe("absent");
  });
});
