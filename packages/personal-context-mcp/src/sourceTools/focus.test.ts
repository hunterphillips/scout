import { describe, expect, it, vi } from "vitest";
import { fetchFocus, parseFocusBody, type FetchLike } from "./focus.js";

const URL_ = "http://127.0.0.1:4242/api/focus";
const doc = {
  updated: "2026-09-30T00:00:00Z",
  items: [
    { id: "a", title: "Ship billing migration", source: "manual", tier: "today", now: true, status: "open", note: "before Friday" },
    { id: "b", title: "Done thing", source: "manual", tier: "today", now: false, status: "done" },
    { id: "c", title: "Later thing", source: "git", tier: "later", now: false, status: "open", note: null },
  ],
};

function fakeFetch(respond: () => Promise<Response> | Response): FetchLike & { mock: { calls: unknown[][] } } {
  return vi.fn(async () => respond()) as unknown as FetchLike & { mock: { calls: unknown[][] } };
}

describe("fetchFocus", () => {
  it("returns open items from a Focus document with one GET to the configured URL", async () => {
    const f = fakeFetch(() => new Response(JSON.stringify(doc), { status: 200 }));
    const r = await fetchFocus(URL_, f);
    expect(r).toEqual({
      ok: true,
      items: [
        { id: "a", title: "Ship billing migration", tier: "today", now: true, note: "before Friday" },
        { id: "c", title: "Later thing", tier: "later", now: false },
      ],
    });
    expect(f.mock.calls).toHaveLength(1);
    expect(f.mock.calls[0]?.[0]).toBe(URL_);
    expect(f.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error" });
  });

  it.each([
    ["a 500", () => new Response("boom", { status: 500 }), "http-status"],
    ["a 302", () => new Response("", { status: 302, headers: { location: "http://example.com/" } }), "http-status"],
    ["bad JSON", () => new Response("{not json", { status: 200 }), "bad-response"],
    ["the wrong shape", () => new Response(JSON.stringify({ items: [{ nope: 1 }] }), { status: 200 }), "bad-response"],
    ["a body over 256 KiB", () => new Response("x".repeat(300 * 1024), { status: 200 }), "too-large"],
    [
      "a network error",
      () => {
        throw new TypeError("fetch failed");
      },
      "network-error",
    ],
  ] as const)("is unavailable on %s, with exactly one fetch", async (_l, respond, reason) => {
    const f = fakeFetch(respond as () => Response);
    expect(await fetchFocus(URL_, f)).toEqual({ ok: false, reason });
    expect(f.mock.calls).toHaveLength(1);
  });

  it("times out even when fetch ignores the abort signal", async () => {
    const f = fakeFetch(() => new Promise<Response>(() => {}));
    const t0 = Date.now();
    expect(await fetchFocus(URL_, f, 50)).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(f.mock.calls).toHaveLength(1);
  });

  it("times out a body that never finishes", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("{"));
      },
    });
    const f = fakeFetch(() => new Response(body, { status: 200 }));
    expect(await fetchFocus(URL_, f, 50)).toEqual({ ok: false, reason: "timeout" });
  });
});

describe("parseFocusBody", () => {
  it("accepts a bare array, cuts long fields, drops odd ids and caps the list", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ id: i === 0 ? "has space" : `i${i}`, title: "t".repeat(300), note: "n".repeat(600) }));
    const out = parseFocusBody(JSON.stringify(items))!;
    expect(out).toHaveLength(50);
    expect(out[0]!.id).toBeUndefined();
    expect(out[0]!.title).toHaveLength(200);
    expect(out[0]!.note).toHaveLength(500);
  });
});
