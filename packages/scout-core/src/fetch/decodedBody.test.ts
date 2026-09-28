import { Readable } from "node:stream";
import { brotliCompressSync, createGzip, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readDecodedBody } from "./decodedBody.js";

const MiB = 1024 * 1024;
const never = new AbortController().signal;

/** A stream that serves `payload` in small chunks. */
function chunkedStream(payload: Uint8Array, chunkSize = 1024) {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= payload.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(payload.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  return stream;
}

describe("readDecodedBody", () => {
  it("decodes gzip and br bodies", async () => {
    const text = new TextEncoder().encode("# llms.txt\n");
    const gz = await readDecodedBody(new Response(gzipSync(text)).body, "gzip", MiB, never);
    const br = await readDecodedBody(new Response(brotliCompressSync(text)).body, "br", MiB, never);

    expect(gz).toEqual({ kind: "ok", bytes: text });
    expect(br).toEqual({ kind: "ok", bytes: text });
  });

  // The compressed side never ends: without a streaming cap on decoded bytes this read
  // would never finish, so returning at all proves the cap is enforced while decoding.
  it("stops an endless gzip bomb at the decoded cap", async () => {
    const zeros = new Readable({ read() { this.push(Buffer.alloc(64 * 1024)); } });
    const bomb = Readable.toWeb(zeros.pipe(createGzip())) as ReadableStream<Uint8Array>;

    expect(await readDecodedBody(bomb, "gzip", 2 * MiB, never)).toEqual({ kind: "too_large" });
    zeros.destroy();
  });

  it("caps identity bodies too", async () => {
    expect(await readDecodedBody(chunkedStream(new Uint8Array(4096)), null, 1000, never)).toEqual({ kind: "too_large" });
  });

  it("reports a coding it did not ask for", async () => {
    expect(await readDecodedBody(new Response("x").body, "zstd", MiB, never)).toEqual({ kind: "unsupported", coding: "zstd" });
  });

  it("treats a zero-byte body labelled gzip or br as an empty body", async () => {
    expect(await readDecodedBody(new Response(new Uint8Array()).body, "gzip", MiB, never)).toEqual({ kind: "ok", bytes: new Uint8Array() });
    expect(await readDecodedBody(new Response(new Uint8Array()).body, "br", MiB, never)).toEqual({ kind: "ok", bytes: new Uint8Array() });
  });

  it("still rejects a truncated gzip body", async () => {
    const truncated = gzipSync(Buffer.from("# llms.txt\n")).subarray(0, 8);
    await expect(readDecodedBody(new Response(truncated).body, "gzip", MiB, never)).rejects.toThrow();
  });

  it("accepts a body of exactly the cap and refuses one byte more", async () => {
    const text = new Uint8Array(1000).fill(0x78);
    expect(await readDecodedBody(new Response(gzipSync(text)).body, "gzip", 1000, never)).toEqual({ kind: "ok", bytes: text });
    expect(await readDecodedBody(new Response(gzipSync(text)).body, "gzip", 999, never)).toEqual({ kind: "too_large" });
    expect(await readDecodedBody(chunkedStream(text, 100), null, 1000, never)).toEqual({ kind: "ok", bytes: text });
    expect(await readDecodedBody(chunkedStream(text, 100), null, 999, never)).toEqual({ kind: "too_large" });
  });

  it("throws when the signal aborts a stalled body", async () => {
    const controller = new AbortController();
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    setTimeout(() => controller.abort(), 5);

    await expect(readDecodedBody(stalled, null, MiB, controller.signal)).rejects.toThrow();
  });
});
