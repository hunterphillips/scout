import type { LookupAddress, LookupOptions } from "node:dns";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { type ConnectLookup, createPinnedDispatcher, createPinnedLookup } from "./pinnedDispatcher.js";
import { rawFetch } from "./rawFetch.js";

function resolve(lookup: ConnectLookup, hostname: string, all: boolean, family?: LookupOptions["family"]) {
  return new Promise<{ error: Error | null; address: string | LookupAddress[] }>((done) => {
    lookup(hostname, family === undefined ? { all } : { all, family }, (error, address) => done({ error, address }));
  });
}

describe("createPinnedLookup", () => {
  // DNS rebinding: the first answer is public and passes screening; a second answer would
  // point at loopback. The pinned lookup answers every connection from the first answer
  // and has no resolver to ask again, so the second answer is never reached.
  it("answers every connection from the screened addresses, never from a later DNS answer", async () => {
    const answers = [[{ address: "93.184.216.34", family: 4 }], [{ address: "127.0.0.1", family: 4 }]];
    let dnsCalls = 0;
    const dns = async () => answers[dnsCalls++]!;

    const lookup = createPinnedLookup("rebind.example", await dns());

    expect(await resolve(lookup, "rebind.example", true)).toEqual({ error: null, address: [{ address: "93.184.216.34", family: 4 }] });
    expect(await resolve(lookup, "REBIND.example", false)).toEqual({ error: null, address: "93.184.216.34" });
    expect(dnsCalls).toBe(1);
  });

  it("fails the connection when nothing is pinned or the hostname is not the pinned one", async () => {
    expect((await resolve(createPinnedLookup("a.example", []), "a.example", true)).error).toBeInstanceOf(Error);
    const pinned = createPinnedLookup("a.example", [{ address: "93.184.216.34", family: 4 }]);
    expect((await resolve(pinned, "b.example", true)).error).toBeInstanceOf(Error);
  });

  it("offers only the requested address family and fails rather than fall back when none match", async () => {
    const dualStack = createPinnedLookup("a.example", [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ]);
    expect(await resolve(dualStack, "a.example", true, 6)).toEqual({ error: null, address: [{ address: "2606:2800:220:1::1", family: 6 }] });
    expect(await resolve(dualStack, "a.example", false, "IPv4")).toEqual({ error: null, address: "93.184.216.34" });
    expect(await resolve(dualStack, "a.example", true, 0)).toMatchObject({ error: null, address: [{ family: 4 }, { family: 6 }] });

    const v4Only = createPinnedLookup("a.example", [{ address: "93.184.216.34", family: 4 }]);
    expect((await resolve(v4Only, "a.example", true, 6)).error).toBeInstanceOf(Error);
    expect((await resolve(v4Only, "a.example", false, 6)).error).toBeInstanceOf(Error);
  });
});

describe("createPinnedDispatcher with rawFetch", () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise((done) => server?.close(done) ?? done(undefined));
    server = null;
  });

  // Loopback plain HTTP only so the test stays hermetic; guardedFetch itself never allows
  // either. The `.invalid` name cannot resolve through real DNS, so a successful request
  // proves the connection used the pinned address.
  it("connects through the pinned address and returns the body still content-encoded", async () => {
    const encoded = gzipSync(Buffer.from("hello"));
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" });
      res.end(encoded);
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    const dispatcher = createPinnedDispatcher("scout-pinned.invalid", [{ address: "127.0.0.1", family: 4 }]);

    try {
      const response = await rawFetch(`http://scout-pinned.invalid:${port}/`, {
        method: "GET",
        redirect: "manual",
        signal: new AbortController().signal,
        headers: {},
        dispatcher,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBe("gzip");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(encoded));
    } finally {
      await dispatcher.destroy();
    }
  });
});
