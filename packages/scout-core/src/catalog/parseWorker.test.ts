import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseLlmsTxt } from "./llmsTxt.js";
import { createParsePool, ParseCancelledError, ParseTimeoutError, ParseWorkerUnavailableError, type ParsePool } from "./parseWorker.js";
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
  it("parses a 50,000-entry sitemap off the main thread: input frames are never held up 100 ms, and the result equals the inline parse", async () => {
    pool = createParsePool();
    const xml = bigSitemap(50_000);
    // Warm the worker so its start-up is not part of the measurement.
    await pool.parsers.sitemap(bigSitemap(1), ORIGIN);
    const { value, worstGap } = await worstGapDuring(() => pool!.parsers.sitemap(xml, ORIGIN));
    expect(value.kind).toBe("urlset");
    expect(value.kind === "urlset" && value.entries.length).toBe(50_000);
    expect(worstGap).toBeLessThan(100);
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

  it("after close every parse is refused", async () => {
    pool = createParsePool();
    await pool.close();
    await expect(pool.parsers.sitemap(bigSitemap(1), ORIGIN)).rejects.toBeInstanceOf(ParseCancelledError);
  });

  it("a parse over its bound fails alone with ParseTimeoutError; the queued parse runs in a fresh worker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spw-"));
    try {
      // The first worker never answers (a parse stuck past its bound); a fresh one (a second run of this file) does.
      const entry = join(dir, "stuck.mjs");
      const marker = join(dir, "stuck");
      writeFileSync(
        entry,
        `import { existsSync, writeFileSync } from "node:fs";\nimport { parentPort } from "node:worker_threads";\n` +
          `const first = !existsSync(${JSON.stringify(marker)});\nif (first) writeFileSync(${JSON.stringify(marker)}, "");\n` +
          `parentPort.on("message", (m) => { if (!first) parentPort.postMessage({ id: m.id, ok: true, result: { kind: "urlset", entries: [] } }); });\n`,
      );
      pool = createParsePool({ entrypoint: entry, maxMs: 300 });
      const stuck = pool.parsers.sitemap(bigSitemap(1), ORIGIN);
      const queued = pool.parsers.sitemap(bigSitemap(2), ORIGIN);
      await expect(stuck).rejects.toBeInstanceOf(ParseTimeoutError);
      await expect(stuck).rejects.toMatchObject({ code: "parse_timeout" });
      await expect(queued).resolves.toEqual({ kind: "urlset", entries: [] });
      expect(pool.pending).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  describe("an unavailable worker", () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const recorder = () => {
      const events: Array<{ name: string; fields: unknown }> = [];
      return { events, diagnostics: { event: (name: string, fields: unknown = {}) => void events.push({ name, fields }) } };
    };

    it("one that fails to start fails each parse (no inline fallback) and reports parse_worker_unavailable once", async () => {
      dir = mkdtempSync(join(tmpdir(), "spw-"));
      const r = recorder();
      pool = createParsePool({ entrypoint: join(dir, "missing.mjs"), diagnostics: r.diagnostics as never });
      const first = pool.parsers.sitemap(bigSitemap(1), ORIGIN);
      await expect(first).rejects.toBeInstanceOf(ParseWorkerUnavailableError);
      await expect(first).rejects.toMatchObject({ code: "parse_worker_unavailable", reason: "worker_error" });
      await expect(pool.parsers.llmsTxt("# Docs\n", ORIGIN, `${ORIGIN}/llms.txt`)).rejects.toBeInstanceOf(ParseWorkerUnavailableError);
      expect(r.events).toEqual([{ name: "parse_worker_unavailable", fields: { code: "worker_error" } }]);
      expect(pool.pending).toBe(0);
    });

    it("one that dies mid-parse fails that parse; the queued parse goes to a fresh worker", async () => {
      dir = mkdtempSync(join(tmpdir(), "spw-"));
      const entry = join(dir, "dies.mjs");
      // Exits on its first message; a fresh worker (a second run of this file) answers.
      const marker = join(dir, "died");
      writeFileSync(
        entry,
        `import { existsSync, writeFileSync } from "node:fs";\nimport { parentPort } from "node:worker_threads";\n` +
          `parentPort.on("message", (m) => { if (!existsSync(${JSON.stringify(marker)})) { writeFileSync(${JSON.stringify(marker)}, ""); process.exit(1); } parentPort.postMessage({ id: m.id, ok: true, result: { kind: "urlset", entries: [] } }); });\n`,
      );
      const r = recorder();
      pool = createParsePool({ entrypoint: entry, diagnostics: r.diagnostics as never });
      const dying = pool.parsers.sitemap(bigSitemap(1), ORIGIN);
      const queued = pool.parsers.sitemap(bigSitemap(1), ORIGIN);
      await expect(dying).rejects.toMatchObject({ code: "parse_worker_unavailable", reason: "worker_exit" });
      await expect(queued).resolves.toEqual({ kind: "urlset", entries: [] });
      expect(r.events).toEqual([{ name: "parse_worker_unavailable", fields: { code: "worker_exit" } }]);
    });
  });
});

describe("parse worker: per-pass scopes", () => {
  it("a scope whose session is cancelled refuses new parses before they reach the queue", async () => {
    pool = createParsePool();
    let cancelled = false;
    const scope = pool.scope(() => cancelled);
    expect((await scope.parsers.sitemap(bigSitemap(1), ORIGIN)).kind).toBe("urlset");
    cancelled = true;
    const refused = scope.parsers.sitemap(bigSitemap(1), ORIGIN);
    expect(pool.pending).toBe(0);
    await expect(refused).rejects.toBeInstanceOf(ParseCancelledError);
    await expect(scope.parsers.llmsTxt("# x\n", ORIGIN, `${ORIGIN}/llms.txt`)).rejects.toBeInstanceOf(ParseCancelledError);
  });

  it("cancelling one pass's scope fails only its parses: another pass's running parse finishes", async () => {
    pool = createParsePool();
    const a = pool.scope();
    const b = pool.scope();
    const bRunning = b.parsers.sitemap(bigSitemap(2_000), ORIGIN);
    const aQueued = a.parsers.sitemap(bigSitemap(1), ORIGIN);
    const bQueued = b.parsers.sitemap(bigSitemap(3), ORIGIN);
    a.cancel();
    await expect(aQueued).rejects.toBeInstanceOf(ParseCancelledError);
    const [r1, r2] = await Promise.all([bRunning, bQueued]);
    expect(r1.kind === "urlset" && r1.entries.length).toBe(2_000);
    expect(r2.kind === "urlset" && r2.entries.length).toBe(3);
    await expect(a.parsers.sitemap(bigSitemap(1), ORIGIN)).rejects.toBeInstanceOf(ParseCancelledError);
  }, 30_000);

  it("cancelling the scope whose parse is running frees the worker at once: the next pass's parse runs in a fresh one", async () => {
    pool = createParsePool();
    const a = pool.scope();
    const b = pool.scope();
    const aRunning = a.parsers.sitemap(bigSitemap(50_000), ORIGIN);
    const bQueued = b.parsers.sitemap(bigSitemap(2), ORIGIN);
    const t0 = performance.now();
    a.cancel();
    await expect(aRunning).rejects.toBeInstanceOf(ParseCancelledError);
    const r = await bQueued;
    expect(r.kind === "urlset" && r.entries.length).toBe(2);
    expect(performance.now() - t0).toBeLessThan(2_000);
  }, 30_000);

  it("close() refuses every scope and resolves once the worker has stopped", async () => {
    pool = createParsePool();
    const s = pool.scope();
    const running = expect(s.parsers.sitemap(bigSitemap(50_000), ORIGIN)).rejects.toBeInstanceOf(ParseCancelledError);
    await pool.close();
    await running;
    await expect(s.parsers.sitemap(bigSitemap(1), ORIGIN)).rejects.toBeInstanceOf(ParseCancelledError);
    expect(pool.pending).toBe(0);
  }, 30_000);
});
