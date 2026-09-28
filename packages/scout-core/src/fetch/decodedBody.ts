import { pipeline, Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createBrotliDecompress, createGunzip } from "node:zlib";

/** The content codings guarded fetch asks for and can decode. */
export const ACCEPT_ENCODING = "gzip, br";

export type DecodedBody =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "too_large" }
  | { kind: "unsupported"; coding: string };

/**
 * Read a response body, decoding `gzip` or `br` as it streams, and stop as soon as the
 * decoded size passes `maxBytes`. The cap is on decoded bytes, so a small compressed
 * body that inflates to gigabytes (a "zip bomb") is cut off at the cap; the decoder
 * only produces output as it is read, so at most one chunk past the cap is ever held.
 * Identity bodies are capped the same way. Any other coding is reported, not guessed at.
 * Aborting `signal` destroys the stream, so a stalled body cannot outlive the deadline.
 */
export async function readDecodedBody(
  body: ReadableStream<Uint8Array> | null,
  contentEncoding: string | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<DecodedBody> {
  if (!body) return { kind: "ok", bytes: new Uint8Array() };

  const coding = (contentEncoding ?? "").trim().toLowerCase();
  let decoder: NodeJS.ReadWriteStream | null;
  if (coding === "" || coding === "identity") decoder = null;
  else if (coding === "gzip" || coding === "x-gzip") decoder = createGunzip();
  else if (coding === "br") decoder = createBrotliDecompress();
  else {
    await body.cancel().catch(() => undefined);
    return { kind: "unsupported", coding };
  }

  const source = Readable.fromWeb(body as NodeReadableStream<Uint8Array>);
  // pipeline() destroys every stage when one fails or is destroyed; its own error is
  // surfaced through the iteration below, so the callback has nothing to do.
  const decoded: Readable = decoder ? (pipeline(source, decoder, () => undefined) as unknown as Readable) : source;
  const stop = () => decoded.destroy(new Error("deadline reached"));
  if (signal.aborted) stop();
  signal.addEventListener("abort", stop, { once: true });

  try {
    const chunks: Uint8Array[] = [];
    let received = 0;
    for await (const chunk of decoded as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        decoded.destroy();
        return { kind: "too_large" };
      }
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: "ok", bytes };
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
