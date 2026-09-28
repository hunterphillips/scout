import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createPinnedDispatcher } from "./pinnedDispatcher.js";
import { rawFetch, UnexpectedStatusError } from "./rawFetch.js";

describe("rawFetch", () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise((done) => server?.close(done) ?? done(undefined));
    server = null;
  });

  // `Response` cannot hold a status outside 200-599, so the transport reports it as an
  // UnexpectedStatusError (which guarded fetch maps to an http error) instead of a
  // RangeError that would read as a network failure. Plain HTTP on loopback keeps it hermetic.
  it("throws UnexpectedStatusError for a status outside 200-599", async () => {
    server = createServer((socket) => {
      socket.once("data", () => socket.end("HTTP/1.1 600 Odd\r\ncontent-length: 5\r\nconnection: close\r\n\r\nhello"));
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    const dispatcher = createPinnedDispatcher("scout-pinned.invalid", [{ address: "127.0.0.1", family: 4 }]);

    try {
      const attempt = rawFetch(`http://scout-pinned.invalid:${port}/`, {
        method: "GET",
        redirect: "manual",
        signal: new AbortController().signal,
        headers: {},
        dispatcher,
      });

      await expect(attempt).rejects.toBeInstanceOf(UnexpectedStatusError);
      await expect(attempt).rejects.toMatchObject({ status: 600 });
    } finally {
      await dispatcher.destroy();
    }
  });
});
