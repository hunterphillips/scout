// End-to-end through the real default transport: guardedFetch -> rawFetch -> pinned undici
// Agent -> TLS -> readDecodedBody, against a self-signed HTTPS server on 127.0.0.1. The
// test-only hooks `isDisallowed` (allow this one loopback address) and `dispatcherFactory`
// (trust the fixture certificate), bound through `createGuardedFetch`, are the only
// departures from production defaults.

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGuardedFetch, type GuardedFetchHooks, type GuardedFetchOptions, type HostLookup } from "./guardedFetch.js";
import { isDisallowedAddress } from "./ipAddressPolicy.js";
import { createPinnedDispatcher } from "./pinnedDispatcher.js";

/** Split the test hooks from the request options and call through `createGuardedFetch`. */
function guardedFetch(url: string, { fetch, lookup, isDisallowed, dispatcherFactory, ...options }: GuardedFetchHooks & GuardedFetchOptions = {}) {
  const hooks: GuardedFetchHooks = {};
  if (fetch) hooks.fetch = fetch;
  if (lookup) hooks.lookup = lookup;
  if (isDisallowed) hooks.isDisallowed = isDisallowed;
  if (dispatcherFactory) hooks.dispatcherFactory = dispatcherFactory;
  return createGuardedFetch(hooks)(url, options);
}


const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/tls/${name}`, import.meta.url));
const cert = fixture("cert.pem");
const key = fixture("key.pem");

// `.invalid` never resolves through real DNS, so any successful connection used the pin.
const HOST = "scout-pinned.invalid";
const SERVER_ADDRESS = "127.0.0.1";

type Handler = Parameters<typeof createServer>[1];

describe("guardedFetch end to end over TLS", () => {
  let server: Server;
  let port: number;
  let handler: NonNullable<Handler>;

  beforeEach(async () => {
    server = createServer({ cert, key }, (req, res) => handler(req, res));
    await new Promise<void>((done) => server.listen(0, SERVER_ADDRESS, done));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });

  function options(lookup: HostLookup, extra: GuardedFetchOptions = {}): GuardedFetchHooks & GuardedFetchOptions {
    return {
      lookup,
      // Only the test server's loopback address is let through; everything else keeps the real policy.
      isDisallowed: (address) => address !== SERVER_ADDRESS && isDisallowedAddress(address),
      dispatcherFactory: (hostname, addresses) => createPinnedDispatcher(hostname, addresses, { ca: cert }),
      ...extra,
    };
  }

  // DNS rebinding: the first answer is the (allowed) server address; a second answer would
  // point somewhere else. One lookup is screened and pinned, and both hops of the redirect
  // reach the server through that pin.
  it("pins the first DNS answer for every hop over a real socket", async () => {
    const paths: string[] = [];
    handler = (req, res) => {
      paths.push(req.url ?? "");
      if (req.url === "/start") {
        res.writeHead(302, { location: "/final" });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        res.end(gzipSync(Buffer.from("pinned hello")));
      }
    };
    const answers = [[{ address: SERVER_ADDRESS, family: 4 }], [{ address: "10.0.0.1", family: 4 }]];
    let lookups = 0;
    const lookup: HostLookup = async () => answers[lookups++]!;

    const result = await guardedFetch(`https://${HOST}:${port}/start`, options(lookup));

    expect(result).toMatchObject({ kind: "ok", body: "pinned hello", finalUrl: `https://${HOST}:${port}/final` });
    expect(paths).toEqual(["/start", "/final"]);
    expect(lookups).toBe(1);
  });

  it("stops a gzip bomb served over the socket at the decoded cap", async () => {
    const bomb = gzipSync(Buffer.alloc(20 * 1024 * 1024));
    handler = (_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(bomb);
    };

    const result = await guardedFetch(`https://${HOST}:${port}/sitemap.xml`, options(async () => [{ address: SERVER_ADDRESS, family: 4 }]));

    expect(result).toMatchObject({ kind: "error", reason: "too_large" });
  });

  it("times out a stalled body and closes the socket", async () => {
    let socketClosed!: Promise<void>;
    handler = (req, res) => {
      socketClosed = new Promise((done) => req.socket.once("close", () => done()));
      res.writeHead(200, { "content-type": "text/plain" });
      res.flushHeaders(); // headers go out, the body never does
    };

    const result = await guardedFetch(
      `https://${HOST}:${port}/llms.txt`,
      options(async () => [{ address: SERVER_ADDRESS, family: 4 }], { timeoutMs: 300 }),
    );

    expect(result).toMatchObject({ kind: "error", reason: "timeout" });
    await expect(Promise.race([
      socketClosed.then(() => "closed"),
      new Promise((done) => setTimeout(() => done("still open"), 2_000)),
    ])).resolves.toBe("closed");
  });
  // Regression: a non-2xx or redirect body that keeps arriving after guarded fetch has
  // cancelled it used to be pushed into a closed web-stream controller, which threw
  // ERR_INVALID_STATE from a stream event, outside any promise, and killed the process.
  describe("bodies that keep arriving after cancel", () => {
    const uncaught: unknown[] = [];
    const record = (error: unknown) => { uncaught.push(error); };

    beforeEach(() => {
      uncaught.length = 0;
      process.on("uncaughtException", record);
      process.on("unhandledRejection", record);
    });

    afterEach(() => {
      process.off("uncaughtException", record);
      process.off("unhandledRejection", record);
    });

    /** Write `total` bytes in `chunks` chunked-encoding writes, `delayMs` apart. */
    async function trickle(res: ServerResponse, total: number, chunks: number, delayMs: number): Promise<void> {
      const size = Math.ceil(total / chunks);
      for (let sent = 0; sent < total && !res.destroyed; sent += size) {
        res.write(Buffer.alloc(Math.min(size, total - sent), 0x61));
        await new Promise((done) => setTimeout(done, delayMs));
      }
      if (!res.destroyed) res.end();
    }

    /** Let any late chunks reach the client before checking nothing escaped. */
    const settle = () => new Promise((done) => setTimeout(done, 400));
    const lookup: HostLookup = async () => [{ address: SERVER_ADDRESS, family: 4 }];

    it("reports a 404 with a large trickled body as absent without an uncaught error", async () => {
      handler = (_req, res) => {
        res.writeHead(404, { "content-type": "text/html" });
        void trickle(res, 200 * 1024, 8, 10);
      };

      const result = await guardedFetch(`https://${HOST}:${port}/llms.txt`, options(lookup));
      await settle();

      expect(result).toEqual({ kind: "absent", status: 404 });
      expect(uncaught).toEqual([]);
    });

    it("reports a 404 whose body is sent in one write as absent without an uncaught error", async () => {
      handler = (_req, res) => {
        res.writeHead(404, { "content-type": "text/html" });
        res.end(Buffer.alloc(512 * 1024, 0x61));
      };

      const result = await guardedFetch(`https://${HOST}:${port}/llms.txt`, options(lookup));
      await settle();

      expect(result).toEqual({ kind: "absent", status: 404 });
      expect(uncaught).toEqual([]);
    });

    it("follows a redirect that carries a large trickled body without an uncaught error", async () => {
      handler = (req, res) => {
        if (req.url === "/start") {
          res.writeHead(301, { location: "/final", "content-type": "text/html" });
          void trickle(res, 200 * 1024, 8, 10);
        } else {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("arrived");
        }
      };

      const result = await guardedFetch(`https://${HOST}:${port}/start`, options(lookup));
      await settle();

      expect(result).toMatchObject({ kind: "ok", body: "arrived", finalUrl: `https://${HOST}:${port}/final` });
      expect(uncaught).toEqual([]);
    });

    it("stops a trickled body at the cap without an uncaught error", async () => {
      handler = (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        void trickle(res, 400 * 1024, 16, 10);
      };

      const result = await guardedFetch(`https://${HOST}:${port}/sitemap.xml`, options(lookup, { maxBytes: 64 * 1024 }));
      await settle();

      expect(result).toMatchObject({ kind: "error", reason: "too_large" });
      expect(uncaught).toEqual([]);
    });
  });
});
