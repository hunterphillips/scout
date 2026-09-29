// Adapted from rookkeeper/rook server/src/infrastructure/http/guardedFetch.test.ts (Rook, by John
// Berryman / Arcturus Labs). Scout changes: FetchLike stubs; tests for address classes,
// DNS pinning across redirects, Accept-Encoding, and the decoded-size cap.

import { brotliCompressSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  createGuardedFetch,
  DEFAULT_ACCEPT,
  type FetchLike,
  type GuardedFetchHooks,
  type GuardedFetchOptions,
  type GuardedRequestInit,
  type HostLookup,
  guardedFetch as publicGuardedFetch,
} from "./guardedFetch.js";
import { UnexpectedStatusError } from "./rawFetch.js";

/** Split the test hooks from the request options and call through `createGuardedFetch`. */
function guardedFetch(url: string, { fetch, lookup, isDisallowed, dispatcherFactory, ...options }: GuardedFetchHooks & GuardedFetchOptions = {}) {
  const hooks: GuardedFetchHooks = {};
  if (fetch) hooks.fetch = fetch;
  if (lookup) hooks.lookup = lookup;
  if (isDisallowed) hooks.isDisallowed = isDisallowed;
  if (dispatcherFactory) hooks.dispatcherFactory = dispatcherFactory;
  return createGuardedFetch(hooks)(url, options);
}


const PUBLIC_LOOKUP: HostLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function stubFetch(handler: (url: string, init: GuardedRequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: GuardedRequestInit }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { impl, calls };
}

function headersOf(init: GuardedRequestInit): Record<string, string> {
  return init.headers;
}

describe("guardedFetch", () => {
  it("returns ok with the body, validators, and final URL for a 2xx response", async () => {
    const { impl } = stubFetch(() => new Response("# llms", {
      status: 200,
      headers: { etag: '"v1"', "last-modified": "Mon, 17 Aug 2026 12:00:00 GMT", "content-type": "text/markdown" },
    }));

    const result = await guardedFetch("https://example.com/llms.txt", { fetch: impl, lookup: PUBLIC_LOOKUP });

    expect(result).toEqual({
      kind: "ok",
      status: 200,
      body: "# llms",
      bytes: new TextEncoder().encode("# llms"),
      etag: '"v1"',
      lastModified: "Mon, 17 Aug 2026 12:00:00 GMT",
      contentType: "text/markdown",
      finalUrl: "https://example.com/llms.txt",
    });
  });

  it("keeps a leading byte-order mark in the decoded body", async () => {
    const served = "\uFEFF# llms";
    const { impl } = stubFetch(() => new Response(new TextEncoder().encode(served), { status: 200 }));

    const result = await guardedFetch("https://example.com/llms.txt", { fetch: impl, lookup: PUBLIC_LOOKUP });

    // Decoded content keeps its leading mark, while `bytes` retains the exact payload.
    expect(result).toMatchObject({ kind: "ok", body: served });
  });

  it("returns exact bytes when invalid UTF-8 decodes with replacement", async () => {
    const served = new Uint8Array([0x66, 0x6f, 0xff, 0x6f]);
    const { impl } = stubFetch(() => new Response(served, { status: 200 }));

    const result = await guardedFetch("https://example.com/llms.txt", { fetch: impl, lookup: PUBLIC_LOOKUP });

    expect(result).toMatchObject({ kind: "ok", body: "fo\uFFFDo" });
    if (result.kind === "ok") expect(result.bytes).toEqual(served);
  });

  it("maps 304, 404, 410, and 500 responses to not_modified, absent, and an http error", async () => {
    const call = async (status: number, headers: Record<string, string> = {}) => {
      const { impl } = stubFetch(() => new Response(status === 304 ? null : "body", { status, headers }));
      return guardedFetch("https://example.com/AGENTS.md", { fetch: impl, lookup: PUBLIC_LOOKUP });
    };

    expect(await call(304, { etag: '"v1"', "last-modified": "Mon, 17 Aug 2026 12:00:00 GMT" })).toEqual({
      kind: "not_modified",
      etag: '"v1"',
      lastModified: "Mon, 17 Aug 2026 12:00:00 GMT",
    });
    expect(await call(404)).toEqual({ kind: "absent", status: 404 });
    expect(await call(410)).toEqual({ kind: "absent", status: 410 });
    expect(await call(500)).toMatchObject({ kind: "error", reason: "http", status: 500 });
  });

  it("refuses non-https URLs without making a request", async () => {
    const { impl, calls } = stubFetch(() => new Response("nope"));

    const result = await guardedFetch("http://example.com/llms.txt", { fetch: impl, lookup: PUBLIC_LOOKUP });

    expect(result).toMatchObject({ kind: "error", reason: "policy" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a string that is not a URL", async () => {
    const { impl, calls } = stubFetch(() => new Response("nope"));

    const result = await guardedFetch("not a url", { fetch: impl, lookup: PUBLIC_LOOKUP });

    expect(result).toMatchObject({ kind: "error", reason: "policy" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a host that resolves to a private address without making a request", async () => {
    const { impl, calls } = stubFetch(() => new Response("nope"));

    const result = await guardedFetch("https://intranet.example.com/llms.txt", {
      fetch: impl,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }],
    });

    expect(result).toMatchObject({ kind: "error", reason: "policy" });
    expect(calls).toHaveLength(0);
  });

  it("refuses loopback literals through the default resolver", async () => {
    for (const url of ["https://127.0.0.1/llms.txt", "https://[::1]/llms.txt"]) {
      const { impl, calls } = stubFetch(() => new Response("nope"));

      const result = await guardedFetch(url, { fetch: impl });

      expect(result).toMatchObject({ kind: "error", reason: "policy" });
      expect(calls).toHaveLength(0);
    }
  });

  it("reports a failing DNS lookup as a network error", async () => {
    const { impl, calls } = stubFetch(() => new Response("nope"));

    const result = await guardedFetch("https://example.com/llms.txt", {
      fetch: impl,
      lookup: async () => { throw new Error("ENOTFOUND"); },
    });

    expect(result).toMatchObject({ kind: "error", reason: "network" });
    expect(calls).toHaveLength(0);
  });

  it("follows a same-host redirect", async () => {
    const { impl, calls } = stubFetch((url) => (url === "https://example.com/llms.txt"
      ? new Response(null, { status: 301, headers: { location: "https://example.com/docs/llms.txt" } })
      : new Response("moved body", { status: 200 })));

    const result = await guardedFetch("https://example.com/llms.txt", { fetch: impl, lookup: PUBLIC_LOOKUP });

    expect(calls.map((call) => call.url)).toEqual(["https://example.com/llms.txt", "https://example.com/docs/llms.txt"]);
    expect(result).toMatchObject({ kind: "ok", body: "moved body", finalUrl: "https://example.com/docs/llms.txt" });
  });

  it("refuses a redirect to a different host", async () => {
    const { impl } = stubFetch(() => new Response(null, { status: 302, headers: { location: "https://cdn.other.com/llms.txt" } }));

    const result = await guardedFetch("https://example.com/llms.txt", { fetch: impl, lookup: PUBLIC_LOOKUP });

    expect(result).toMatchObject({ kind: "error", reason: "policy" });
  });

  it("refuses a redirect to a different port on the same hostname", async () => {
    const { impl } = stubFetch(() => new Response(null, { status: 302, headers: { location: "https://example.com:8443/llms.txt" } }));

    const result = await guardedFetch("https://example.com/llms.txt", { fetch: impl, lookup: PUBLIC_LOOKUP });

    expect(result).toMatchObject({ kind: "error", reason: "policy" });
  });

  it("reports a redirect without a Location header as an http error", async () => {
    const { impl } = stubFetch(() => new Response(null, { status: 301 }));

    const result = await guardedFetch("https://example.com/llms.txt", { fetch: impl, lookup: PUBLIC_LOOKUP });

    expect(result).toMatchObject({ kind: "error", reason: "http", status: 301 });
  });

  it("refuses more redirects than the hop limit", async () => {
    let hop = 0;
    const { impl, calls } = stubFetch(() => {
      hop += 1;
      return new Response(null, { status: 307, headers: { location: `https://example.com/hop-${hop}` } });
    });

    const result = await guardedFetch("https://example.com/llms.txt", { fetch: impl, lookup: PUBLIC_LOOKUP, maxRedirects: 2 });

    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({ kind: "error", reason: "policy" });
  });

  it("refuses the first redirect when the hop limit is zero", async () => {
    const { impl, calls } = stubFetch(() => new Response(null, { status: 308, headers: { location: "https://example.com/docs/llms.txt" } }));

    const result = await guardedFetch("https://example.com/llms.txt", { fetch: impl, lookup: PUBLIC_LOOKUP, maxRedirects: 0 });

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ kind: "error", reason: "policy" });
  });

  it("reports a timeout when the request is aborted by the deadline", async () => {
    const { impl } = stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    }));

    const result = await guardedFetch("https://example.com/llms.txt", { fetch: impl, lookup: PUBLIC_LOOKUP, timeoutMs: 5 });

    expect(result).toMatchObject({ kind: "error", reason: "timeout" });
  });

  it("stops an endless redirect chain at the deadline even when the fetch ignores the signal", async () => {
    let hop = 0;
    const { impl } = stubFetch(async () => {
      hop += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return new Response(null, { status: 302, headers: { location: `https://example.com/hop-${hop}` } });
    });

    const result = await guardedFetch("https://example.com/llms.txt", {
      fetch: impl,
      lookup: PUBLIC_LOOKUP,
      timeoutMs: 5,
      maxRedirects: 1_000,
    });

    expect(result).toMatchObject({ kind: "error", reason: "timeout" });
    expect(hop).toBeLessThan(1_000);
  });

  it("applies the deadline to the DNS lookup too", async () => {
    const { impl, calls } = stubFetch(() => new Response("never reached"));

    const result = await guardedFetch("https://example.com/llms.txt", {
      fetch: impl,
      lookup: () => new Promise(() => {}),
      timeoutMs: 5,
    });

    expect(result).toMatchObject({ kind: "error", reason: "timeout" });
    expect(calls).toHaveLength(0);
  });

  it("stops reading once the response exceeds the size cap", async () => {
    const chunk = new TextEncoder().encode("x".repeat(64));
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1;
        if (emitted > 100) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const { impl } = stubFetch(() => new Response(body, { status: 200 }));

    const result = await guardedFetch("https://example.com/llms.txt", { fetch: impl, lookup: PUBLIC_LOOKUP, maxBytes: 128 });

    expect(result).toMatchObject({ kind: "error", reason: "too_large" });
    expect(emitted).toBeLessThan(50);
  });

  it("accepts a body of exactly the cap and refuses one byte more", async () => {
    const serve = () => stubFetch(() => new Response("x".repeat(128), { status: 200 })).impl;

    const atCap = await guardedFetch("https://example.com/llms.txt", { fetch: serve(), lookup: PUBLIC_LOOKUP, maxBytes: 128 });
    const overCap = await guardedFetch("https://example.com/llms.txt", { fetch: serve(), lookup: PUBLIC_LOOKUP, maxBytes: 127 });

    expect(atCap).toMatchObject({ kind: "ok", body: "x".repeat(128) });
    expect(overCap).toMatchObject({ kind: "error", reason: "too_large" });
  });

  it("reports an unsupported content-encoding as an http error", async () => {
    const { impl } = stubFetch(() => new Response("compressed?", { status: 200, headers: { "content-encoding": "zstd" } }));

    const result = await guardedFetch("https://example.com/llms.txt", { fetch: impl, lookup: PUBLIC_LOOKUP });

    expect(result).toMatchObject({ kind: "error", reason: "http", status: 200 });
  });

  it("reports a status the transport cannot represent as an http error", async () => {
    const { impl } = stubFetch(() => { throw new UnexpectedStatusError(600); });

    const result = await guardedFetch("https://example.com/llms.txt", { fetch: impl, lookup: PUBLIC_LOOKUP });

    expect(result).toMatchObject({ kind: "error", reason: "http", status: 600 });
  });

  it("sends the fixed user agent and the supplied conditional headers", async () => {
    const { impl, calls } = stubFetch(() => new Response(null, { status: 304 }));

    await guardedFetch("https://example.com/llms.txt", {
      fetch: impl,
      lookup: PUBLIC_LOOKUP,
      ifNoneMatch: '"v1"',
      ifModifiedSince: "Mon, 17 Aug 2026 12:00:00 GMT",
      accept: "text/plain",
    });

    expect(calls[0]!.init.redirect).toBe("manual");
    const { "user-agent": userAgent, ...rest } = headersOf(calls[0]!.init);
    expect(userAgent).toMatch(/^Scout\/\S+ \(\+local POC\)$/);
    expect(rest).toEqual({
      accept: "text/plain",
      "accept-encoding": "gzip, br",
      "if-none-match": '"v1"',
      "if-modified-since": "Mon, 17 Aug 2026 12:00:00 GMT",
    });
  });

  it("sends the default Accept header when none is supplied", async () => {
    const { impl, calls } = stubFetch(() => new Response("body", { status: 200 }));

    await guardedFetch("https://example.com/llms.txt", { fetch: impl, lookup: PUBLIC_LOOKUP });

    expect(headersOf(calls[0]!.init).accept).toBe(DEFAULT_ACCEPT);
  });

  it("refuses loopback, link-local, private, and IPv4-mapped IPv6 answers without making a request", async () => {
    for (const address of ["127.0.0.1", "169.254.169.254", "192.168.1.1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      const { impl, calls } = stubFetch(() => new Response("nope"));

      const result = await guardedFetch("https://example.com/llms.txt", {
        fetch: impl,
        lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
      });

      expect(result, address).toMatchObject({ kind: "error", reason: "policy" });
      expect(calls).toHaveLength(0);
    }
  });

  // DNS rebinding: the host answers public first, then loopback. Scout screens once and
  // pins that answer for every hop, so the loopback answer is never consulted. That the
  // pinned dispatcher connects only to its pinned addresses is shown in pinnedDispatcher.test.ts.
  it("resolves DNS once and routes every redirect hop through the same pinned dispatcher", async () => {
    const answers = [[{ address: "93.184.216.34", family: 4 }], [{ address: "127.0.0.1", family: 4 }]];
    let lookups = 0;
    const lookup: HostLookup = async () => answers[lookups++]!;
    const { impl, calls } = stubFetch((url) => (url.endsWith("/final")
      ? new Response("ok", { status: 200 })
      : new Response(null, { status: 302, headers: { location: url.endsWith("/a") ? "/final" : "/a" } })));

    const result = await guardedFetch("https://rebind.example/llms.txt", { fetch: impl, lookup });

    expect(result).toMatchObject({ kind: "ok", finalUrl: "https://rebind.example/final" });
    expect(lookups).toBe(1);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((call) => call.init.dispatcher)).size).toBe(1);
  });

  it("decodes a gzip body and reports the decoded bytes", async () => {
    const { impl } = stubFetch(() => new Response(gzipSync(Buffer.from("# llms")), { status: 200, headers: { "content-encoding": "gzip" } }));

    const result = await guardedFetch("https://example.com/llms.txt", { fetch: impl, lookup: PUBLIC_LOOKUP });

    expect(result).toMatchObject({ kind: "ok", body: "# llms" });
  });

  it("returns too_large for a gzip bomb that inflates past the cap", async () => {
    const bomb = gzipSync(Buffer.alloc(20 * 1024 * 1024));
    const { impl } = stubFetch(() => new Response(bomb, { status: 200, headers: { "content-encoding": "gzip" } }));

    const result = await guardedFetch("https://example.com/sitemap.xml", { fetch: impl, lookup: PUBLIC_LOOKUP });

    expect(bomb.byteLength).toBeLessThan(100_000);
    expect(result).toMatchObject({ kind: "error", reason: "too_large" });
  });

  it("returns too_large for a brotli bomb that inflates past the cap", async () => {
    const bomb = brotliCompressSync(Buffer.alloc(20 * 1024 * 1024));
    const { impl } = stubFetch(() => new Response(bomb, { status: 200, headers: { "content-encoding": "br" } }));

    const result = await guardedFetch("https://example.com/sitemap.xml", { fetch: impl, lookup: PUBLIC_LOOKUP });

    expect(bomb.byteLength).toBeLessThan(100_000);
    expect(result).toMatchObject({ kind: "error", reason: "too_large" });
  });

  it("keeps the test hooks off the public entry points", async () => {
    // Hook-shaped options passed to the public function are ignored: the real address policy still applies.
    const result = await publicGuardedFetch("https://127.0.0.1/llms.txt", { isDisallowed: () => false } as GuardedFetchOptions);
    expect(result).toMatchObject({ kind: "error", reason: "policy" });

    const core = await import("../index.js");
    expect("createGuardedFetch" in core).toBe(false);
    expect("guardedFetch" in core).toBe(true);
  });
});
