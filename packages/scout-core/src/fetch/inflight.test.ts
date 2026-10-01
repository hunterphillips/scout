import { describe, expect, it } from "vitest";
import type { GuardedFetchResult } from "./guardedFetch.js";
import { type CoalescedFetchOptions, createCoalescingFetch } from "./inflight.js";

const ok = (body: string, url: string): GuardedFetchResult => ({ kind: "ok", status: 200, body, bytes: new TextEncoder().encode(body), finalUrl: url });

/** An inner fetch whose responses resolve only when the test releases them. */
function gatedFetch(bodies: Record<string, string>) {
  const calls: { url: string; opts: CoalescedFetchOptions }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const inner = async (url: string, opts: CoalescedFetchOptions = {}): Promise<GuardedFetchResult> => {
    calls.push({ url, opts });
    await gate;
    const body = bodies[new URL(url).pathname] ?? "";
    if (opts.maxBytes !== undefined && body.length > opts.maxBytes) return { kind: "error", reason: "too_large", message: "too large" };
    return ok(body, url);
  };
  return { inner, calls, release };
}

describe("createCoalescingFetch", () => {
  it("shares one in-flight request and its body between identical callers", async () => {
    const { inner, calls, release } = gatedFetch({ "/sitemap.xml": "<urlset/>" });
    const fetch = createCoalescingFetch(inner);
    const a = fetch("https://s.example/sitemap.xml", { accept: "x" });
    const b = fetch("https://s.example/sitemap.xml", { accept: "x" });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls).toHaveLength(1);
    expect(ra).toBe(rb);
    // Not a retained root path: once settled, a later caller asks again.
    await fetch("https://s.example/sitemap.xml", { accept: "x" });
    expect(calls).toHaveLength(2);
  });

  it("keeps settled results for the fixed root paths", async () => {
    const { inner, calls, release } = gatedFetch({ "/llms.txt": "# Site" });
    release();
    const fetch = createCoalescingFetch(inner);
    await fetch("https://s.example/llms.txt", { accept: "x" });
    await fetch("https://s.example/llms.txt", { accept: "x" });
    expect(calls).toHaveLength(1);
  });

  it("does not share across different validators or Accept headers", async () => {
    const { inner, calls, release } = gatedFetch({ "/llms.txt": "# Site" });
    release();
    const fetch = createCoalescingFetch(inner);
    await fetch("https://s.example/llms.txt", { accept: "x" });
    await fetch("https://s.example/llms.txt", { accept: "y" });
    await fetch("https://s.example/llms.txt", { accept: "x", ifNoneMatch: '"1"' });
    expect(calls).toHaveLength(3);
  });

  it("applies each caller's own size cap to a shared body", async () => {
    const { inner, calls, release } = gatedFetch({ "/llms.txt": "x".repeat(200) });
    const fetch = createCoalescingFetch(inner);
    const big = fetch("https://s.example/llms.txt", { maxBytes: 500 });
    const small = fetch("https://s.example/llms.txt", { maxBytes: 100 });
    release();
    expect((await big).kind).toBe("ok");
    expect(await small).toMatchObject({ kind: "error", reason: "too_large" });
    expect(calls).toHaveLength(1);
  });

  it("asks again when only a smaller cap than the caller's was in flight and it overflowed", async () => {
    const { inner, calls, release } = gatedFetch({ "/llms.txt": "x".repeat(200) });
    const fetch = createCoalescingFetch(inner);
    const small = fetch("https://s.example/llms.txt", { maxBytes: 100 });
    const big = fetch("https://s.example/llms.txt", { maxBytes: 500 });
    release();
    expect(await small).toMatchObject({ kind: "error", reason: "too_large" });
    expect((await big).kind).toBe("ok");
    expect(calls.map((c) => c.opts.maxBytes)).toEqual([100, 500]);
  });

  it("does not retain an error for later callers", async () => {
    let calls = 0;
    const fetch = createCoalescingFetch(async () => {
      calls += 1;
      return { kind: "error", reason: "policy", message: "refused" };
    });
    await fetch("https://s.example/llms.txt");
    await fetch("https://s.example/llms.txt");
    expect(calls).toBe(2);
  });
});
