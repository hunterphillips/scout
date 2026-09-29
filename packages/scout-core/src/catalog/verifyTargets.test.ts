import type { Candidate } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import type { GuardedFetchResult } from "../fetch/guardedFetch.js";
import { CANDIDATE_TITLE_MAX } from "./sanitizeLabel.js";
import { extractDisplayTitle, TITLE_SCAN_CHARS, VERIFY_MAX_BYTES, type VerifyFetch, verifyTargets } from "./verifyTargets.js";

const ORIGIN = "https://docs.example";
const candidate = (id: string, path: string): Candidate => ({
  id,
  sourceUrl: `${ORIGIN}${path}`,
  title: path,
  labelQuality: "published",
  provenance: "llms.txt",
});

const ok = (url: string, body: string, contentType = "text/html; charset=utf-8", status = 200): GuardedFetchResult => ({
  kind: "ok",
  status,
  body,
  bytes: new TextEncoder().encode(body),
  contentType,
  finalUrl: url,
});

/** A fake verify fetch answering by path; records every call and its options. */
function fakeFetch(answers: Record<string, (url: string) => GuardedFetchResult | Promise<GuardedFetchResult>>) {
  const calls: { url: string; options: Parameters<VerifyFetch>[1] }[] = [];
  const fetch: VerifyFetch = async (url, options) => {
    calls.push({ url, options });
    const answer = answers[new URL(url).pathname];
    return answer ? answer(url) : { kind: "absent", status: 404 };
  };
  return { fetch, calls };
}

describe("verifyTargets", () => {
  it("uses the HTML twin of a .md source on a 200 text/html answer", async () => {
    const { fetch, calls } = fakeFetch({ "/payments/subscriptions": (url) => ok(url, "<html></html>") });

    const result = await verifyTargets([candidate("c0", "/payments/subscriptions.md")], { fetch });

    expect(calls.map((c) => c.url)).toEqual([`${ORIGIN}/payments/subscriptions`]);
    expect(calls[0]?.options.maxBytes).toBe(VERIFY_MAX_BYTES);
    expect(result.verified).toEqual([expect.objectContaining({ id: "c0", humanHref: `${ORIGIN}/payments/subscriptions` })]);
    expect(result.dropped).toEqual([]);
  });

  it("keeps the .md source when the twin answers 200 but is not HTML", async () => {
    const { fetch } = fakeFetch({ "/a": (url) => ok(url, "# A", "text/markdown") });

    const result = await verifyTargets([candidate("c0", "/a.md")], { fetch });

    expect(result.verified[0]?.humanHref).toBe(`${ORIGIN}/a.md`);
  });

  it("keeps the .md source when the twin answers 2xx other than 200", async () => {
    const { fetch } = fakeFetch({ "/a": (url) => ok(url, "", "text/html", 203) });

    expect((await verifyTargets([candidate("c0", "/a.md")], { fetch })).verified[0]?.humanHref).toBe(`${ORIGIN}/a.md`);
  });

  it("keeps the .md source when the twin is a 404", async () => {
    const { fetch } = fakeFetch({});

    const result = await verifyTargets([candidate("c0", "/a.md")], { fetch });

    expect(result.verified).toEqual([expect.objectContaining({ id: "c0", humanHref: `${ORIGIN}/a.md` })]);
    expect(result.dropped).toEqual([]);
  });

  it("drops a non-.md candidate refused for leaving the host, but keeps a .md whose twin is", async () => {
    const offHost = (): GuardedFetchResult => ({ kind: "error", reason: "policy", message: "redirect off host" });
    const { fetch } = fakeFetch({ "/a": offHost, "/b": offHost });

    const result = await verifyTargets([candidate("c0", "/a.md"), candidate("c1", "/b")], { fetch });

    expect(result.verified).toEqual([expect.objectContaining({ id: "c0", humanHref: `${ORIGIN}/a.md` })]);
    expect(result.verified[0]).not.toHaveProperty("displayTitle");
    expect(result.dropped).toEqual([{ candidateId: "c1", reason: "off_host" }]);
  });

  it("drops a non-.md candidate whose final URL is on another host, but keeps a .md whose twin's is", async () => {
    const { fetch } = fakeFetch({
      "/a": () => ok("https://elsewhere.example/a", "<title>x</title>"),
      "/b": () => ok("https://elsewhere.example/b", "<title>x</title>"),
    });

    const result = await verifyTargets([candidate("c0", "/a.md"), candidate("c1", "/b")], { fetch });

    expect(result.verified).toEqual([expect.objectContaining({ id: "c0", humanHref: `${ORIGIN}/a.md` })]);
    expect(result.verified[0]).not.toHaveProperty("displayTitle");
    expect(result.dropped).toEqual([{ candidateId: "c1", reason: "off_host" }]);
  });

  it("drops a non-.md candidate that is a 404", async () => {
    const { fetch } = fakeFetch({});

    const result = await verifyTargets([candidate("c0", "/gone")], { fetch });

    expect(result.verified).toEqual([]);
    expect(result.dropped).toEqual([{ candidateId: "c0", reason: "not_found" }]);
  });

  it("keeps a non-.md 200 with a display title, preferring og:title", async () => {
    const html = `<html><head><title>Plain &amp; simple</title>
      <meta content="Tom &amp; Jerry&apos;s &lt;b&gt;guide&lt;/b&gt;" property="og:title"></head></html>`;
    const { fetch } = fakeFetch({ "/guide": (url) => ok(url, html) });

    const result = await verifyTargets([candidate("c0", "/guide")], { fetch });

    expect(result.verified).toEqual([expect.objectContaining({ humanHref: `${ORIGIN}/guide`, displayTitle: "Tom & Jerry's guide" })]);
  });

  it("falls back to <title>, and sets no title for a non-HTML 200", async () => {
    const { fetch } = fakeFetch({
      "/t": (url) => ok(url, "<head><title>Only &quot;title&quot;</title></head>"),
      "/pdf": (url) => ok(url, "<title>not really</title>", "application/pdf"),
    });

    const { verified } = await verifyTargets([candidate("c0", "/t"), candidate("c1", "/pdf")], { fetch });

    expect(verified[0]?.displayTitle).toBe('Only "title"');
    expect(verified[1]).toEqual(expect.objectContaining({ humanHref: `${ORIGIN}/pdf` }));
    expect(verified[1]).not.toHaveProperty("displayTitle");
  });

  it("keeps the source URL with no title on a timeout or other error", async () => {
    const { fetch } = fakeFetch({
      "/slow": () => ({ kind: "error", reason: "timeout", message: "t" }),
      "/big.md": () => ({ kind: "error", reason: "too_large", message: "t" }),
      "/boom": () => ({ kind: "error", reason: "http", status: 500, message: "t" }),
    });

    const { verified, dropped } = await verifyTargets([candidate("c0", "/slow"), candidate("c1", "/big.md"), candidate("c2", "/boom")], { fetch });

    expect(dropped).toEqual([]);
    expect(verified.map((v) => v.humanHref)).toEqual([`${ORIGIN}/slow`, `${ORIGIN}/big.md`, `${ORIGIN}/boom`]);
    expect(verified.every((v) => v.displayTitle === undefined)).toBe(true);
  });

  it("keeps a candidate whose fetch never answers once the budget is spent", async () => {
    const fetch: VerifyFetch = () => new Promise(() => undefined);

    const result = await verifyTargets([candidate("c0", "/hang")], { fetch, budgetMs: 20 });

    expect(result.verified).toEqual([expect.objectContaining({ humanHref: `${ORIGIN}/hang` })]);
  });

  it("checks only the first 3 candidates, in order, all in parallel under one budget", async () => {
    const pending: { url: string; timeoutMs: number; resolve: (r: GuardedFetchResult) => void }[] = [];
    const fetch: VerifyFetch = (url, options) =>
      new Promise((resolve) => void pending.push({ url, timeoutMs: options.timeoutMs, resolve }));
    const candidates = ["/a", "/b", "/c", "/d", "/e"].map((p, i) => candidate(`c${i}`, p));

    const run = verifyTargets(candidates, { fetch, budgetMs: 4000, clock: { now: () => 0 } });
    await Promise.resolve();
    // All three started before any answered.
    expect(pending.map((p) => p.url)).toEqual([`${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/c`]);
    expect(pending.every((p) => p.timeoutMs === 4000)).toBe(true);
    // Answer out of order; output order still follows the input.
    for (const i of [2, 0, 1]) {
      const p = pending[i];
      p?.resolve(ok(p.url, `<title>${i}</title>`));
    }
    const result = await run;

    expect(result.verified.map((v) => v.id)).toEqual(["c0", "c1", "c2"]);
    expect(result.dropped).toEqual([]);
  });

  it("fetches only URLs on the candidate's own origin and rejects unusable source URLs", async () => {
    const { fetch, calls } = fakeFetch({ "/a": (url) => ok(url, "") });
    const bad: Candidate[] = [
      { ...candidate("c0", "/a"), sourceUrl: "http://docs.example/a" },
      { ...candidate("c1", "/a"), sourceUrl: "https://user:pw@docs.example/a" },
      { ...candidate("c2", "/a"), sourceUrl: "not a url" },
    ];

    const result = await verifyTargets([...bad, candidate("c3", "/a.md")], { fetch, maxCandidates: 4 });

    expect(calls.map((c) => new URL(c.url).origin)).toEqual([ORIGIN]);
    expect(result.dropped.map((d) => d.reason)).toEqual(["invalid_url", "invalid_url", "invalid_url"]);
  });
});

describe("extractDisplayTitle", () => {
  it("sanitizes and bounds the title", () => {
    const title = extractDisplayTitle(`<title>  A​\n[link](https://x.example) ${"x".repeat(500)}</title>`);
    expect(title?.startsWith("A link ")).toBe(true);
    expect(Array.from(title ?? "").length).toBeLessThanOrEqual(CANDIDATE_TITLE_MAX);
  });

  it("searches only the first 64 KiB", () => {
    expect(extractDisplayTitle(`${" ".repeat(TITLE_SCAN_CHARS)}<title>late</title>`)).toBeUndefined();
    expect(extractDisplayTitle(`${" ".repeat(TITLE_SCAN_CHARS - 40)}<title>early</title>`)).toBe("early");
  });

  it("ignores an empty og:title", () => {
    expect(extractDisplayTitle(`<meta property='og:title' content=''><title>T</title>`)).toBe("T");
  });

  it("stays fast on a large pathological body", () => {
    const started = performance.now();
    extractDisplayTitle(`<meta ${"a".repeat(1_000_000)}<title ${"b".repeat(1_000_000)}`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
