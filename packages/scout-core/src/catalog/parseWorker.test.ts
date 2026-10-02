import { afterEach, describe, expect, it } from "vitest";
import { parseLlmsTxt } from "./llmsTxt.js";
import { createParsePool, ParseCancelledError, type ParsePool } from "./parseWorker.js";
import { parseSitemap } from "./sitemap.js";

const ORIGIN = "https://docs.example.com";

/** A urlset of `n` same-origin entries, each with an image title (the parser's heaviest path). */
function bigSitemap(n: number): string {
  const urls: string[] = [];
  for (let i = 0; i < n; i++) {
    urls.push(`<url><loc>${ORIGIN}/guides/page-${i}?a=1&amp;b=2</loc><image:image><image:loc>${ORIGIN}/i/${i}.png</image:loc><image:title>Guide ${i}</image:title></image:image></url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${urls.join("")}</urlset>`;
}

/** Record the worst gap between 5 ms timer ticks while `work` runs: how long input would wait. */
async function worstGapDuring<T>(work: () => Promise<T>): Promise<{ value: T; worstGap: number }> {
  let last = performance.now();
  let worstGap = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    worstGap = Math.max(worstGap, now - last);
    last = now;
  }, 5);
  try {
    const value = await work();
    return { value, worstGap };
  } finally {
    clearInterval(tick);
  }
}

let pool: ParsePool | null = null;
afterEach(async () => {
  await pool?.close();
  pool = null;
});

describe("parse worker", () => {
  it("parses a 50,000-entry sitemap off the main thread: input frames are never held up 50 ms, and the result equals the inline parse", async () => {
    pool = createParsePool();
    const xml = bigSitemap(50_000);
    // Warm the worker so its start-up is not part of the measurement.
    await pool.parsers.sitemap(bigSitemap(1), ORIGIN);
    const { value, worstGap } = await worstGapDuring(() => pool!.parsers.sitemap(xml, ORIGIN));
    expect(value.kind).toBe("urlset");
    expect(value.kind === "urlset" && value.entries.length).toBe(50_000);
    expect(worstGap).toBeLessThan(50);
    expect(value).toEqual(parseSitemap(xml, ORIGIN));
  }, 60_000);

  it("parses llms.txt with the same result as inline", async () => {
    pool = createParsePool();
    const text = `# Docs\n\n- [Billing](/billing): invoices\n- [Nested](/team/llms.txt)\n`;
    expect(await pool.parsers.llmsTxt(text, ORIGIN, `${ORIGIN}/llms.txt`)).toEqual(parseLlmsTxt(text, ORIGIN, `${ORIGIN}/llms.txt`));
  });

  it("runs parses one at a time, in order", async () => {
    pool = createParsePool();
    const results = await Promise.all([1, 2, 3].map((n) => pool!.parsers.sitemap(bigSitemap(n), ORIGIN)));
    expect(results.map((r) => (r.kind === "urlset" ? r.entries.length : -1))).toEqual([1, 2, 3]);
  });

  it("cancel terminates the running parse and rejects the queued ones; the next parse gets a fresh worker", async () => {
    pool = createParsePool();
    const running = pool.parsers.sitemap(bigSitemap(50_000), ORIGIN);
    const queued = pool.parsers.sitemap(bigSitemap(1), ORIGIN);
    expect(pool.pending).toBe(2);
    pool.cancel();
    await expect(running).rejects.toBeInstanceOf(ParseCancelledError);
    await expect(queued).rejects.toBeInstanceOf(ParseCancelledError);
    expect(pool.pending).toBe(0);
    const after = await pool.parsers.sitemap(bigSitemap(2), ORIGIN);
    expect(after.kind === "urlset" && after.entries.length).toBe(2);
  }, 30_000);

  it("a parse over its bound is cancelled; after close every parse is refused", async () => {
    pool = createParsePool({ maxMs: 1 });
    await expect(pool.parsers.sitemap(bigSitemap(50_000), ORIGIN)).rejects.toBeInstanceOf(ParseCancelledError);
    await pool.close();
    await expect(pool.parsers.sitemap(bigSitemap(1), ORIGIN)).rejects.toBeInstanceOf(ParseCancelledError);
  }, 30_000);
});
