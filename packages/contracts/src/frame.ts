// Chrome native-messaging framing, also used on the host <-> core Unix socket.
//
// A frame is a 32-bit unsigned length in NATIVE byte order followed by that
// many bytes of UTF-8 JSON. The decoder never allocates more than `maxBytes`
// for a body: an oversized header switches it to skip mode, where the declared
// bytes are discarded as they arrive and one `oversized` drop is reported.
// Every decoded value must be a plain JSON object; anything else is dropped,
// counted, and never handed to the caller as a message.
//
// Core -> Chrome frames have a per-type cap (bridge protocol 3): a `panel` frame may
// reach MAX_PANEL_FRAME_BYTES, every other frame MAX_FRAME_TO_CHROME. A decoder for
// that direction is built with `toChromeDecoder()`: it refuses a length prefix over
// MAX_PANEL_FRAME_BYTES before reading the body, then refuses a decoded non-panel
// frame over MAX_FRAME_TO_CHROME, so a peer cannot pass off a 1 MiB observation or ack.

import { Buffer } from "node:buffer";
import { endianness } from "node:os";

export const MAX_FRAME_FROM_CHROME = 64 * 1024;
export const MAX_FRAME_TO_CHROME = 16 * 1024;
/** Cap for one core -> Chrome `panel` frame (Chrome's own host -> extension limit is 1 MiB). */
export const MAX_PANEL_FRAME_BYTES = 1024 * 1024;

/** The cap for one core -> Chrome frame of this shape: `panel` frames get MAX_PANEL_FRAME_BYTES. */
export function toChromeFrameLimit(frame: { readonly type?: unknown }): number {
  return frame.type === "panel" ? MAX_PANEL_FRAME_BYTES : MAX_FRAME_TO_CHROME;
}

/** Encode one core -> Chrome frame under its per-type cap. Throws `outgoing-oversized` over it. */
export function encodeToChromeFrame(frame: { readonly type: string }): Buffer {
  return encodeFrame(frame, toChromeFrameLimit(frame));
}

/** A decoder for core -> Chrome frames: 1 MiB for `panel`, MAX_FRAME_TO_CHROME for the rest. */
export function toChromeDecoder(): FrameDecoder {
  return new FrameDecoder({ maxBytes: MAX_PANEL_FRAME_BYTES, limitFor: toChromeFrameLimit });
}

const LITTLE = endianness() === "LE";

export type DropCode = "oversized" | "invalid-utf8" | "invalid-json" | "not-object" | "truncated";

export type FrameResult =
  | { ok: true; value: Record<string, unknown>; raw: Buffer; bytes: number }
  | { ok: false; code: Exclude<DropCode, "truncated">; bytes: number }
  | { ok: false; code: "truncated" };

export class FrameError extends Error {
  constructor(readonly code: "outgoing-oversized") {
    super(code);
    this.name = "FrameError";
  }
}

/** Header for a body of `n` bytes, native byte order. */
export function frameHeader(n: number): Buffer {
  const h = Buffer.alloc(4);
  if (LITTLE) h.writeUInt32LE(n, 0);
  else h.writeUInt32BE(n, 0);
  return h;
}

function readLength(h: Buffer): number {
  return LITTLE ? h.readUInt32LE(0) : h.readUInt32BE(0);
}

/** Frame raw body bytes (already-validated JSON). Throws `outgoing-oversized` over the cap. */
export function frameBytes(body: Uint8Array, maxBytes: number = MAX_FRAME_TO_CHROME): Buffer {
  if (body.length > maxBytes) throw new FrameError("outgoing-oversized");
  return Buffer.concat([frameHeader(body.length), body]);
}

/** Encode an object as one frame. Throws `outgoing-oversized` over the cap. */
export function encodeFrame(obj: object, maxBytes: number = MAX_FRAME_TO_CHROME): Buffer {
  return frameBytes(Buffer.from(JSON.stringify(obj), "utf8"), maxBytes);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Decode one complete frame body. */
export function decodeBody(body: Buffer): FrameResult {
  const bytes = body.length;
  let text: string;
  try {
    text = utf8.decode(body);
  } catch {
    return { ok: false, code: "invalid-utf8", bytes };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid-json", bytes };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "not-object", bytes };
  }
  return { ok: true, value: value as Record<string, unknown>, raw: body, bytes };
}

/**
 * Streaming decoder. Feed chunks with `push`; each returns the frames completed
 * by that chunk, in order. A bad frame is dropped and counted in `dropped`;
 * the stream stays in sync after it.
 */
export class FrameDecoder {
  /** No body over this is ever read: the length prefix alone refuses it. */
  readonly maxBytes: number;
  /** A decoded frame over its own limit (at most maxBytes) is dropped as `oversized`. */
  private readonly limitFor: ((value: Record<string, unknown>) => number) | undefined;
  readonly dropped: Record<DropCode, number> = {
    oversized: 0,
    "invalid-utf8": 0,
    "invalid-json": 0,
    "not-object": 0,
    truncated: 0,
  };

  private readonly header = Buffer.alloc(4);
  private headerFill = 0;
  private body: Buffer | null = null;
  private bodyFill = 0;
  private skipRemaining = 0;

  constructor({ maxBytes = MAX_FRAME_FROM_CHROME, limitFor }: { maxBytes?: number; limitFor?: (value: Record<string, unknown>) => number } = {}) {
    this.maxBytes = maxBytes;
    this.limitFor = limitFor;
  }

  /** Total frames dropped so far, all reasons. */
  get droppedTotal(): number {
    return Object.values(this.dropped).reduce((a, b) => a + b, 0);
  }

  /** Bytes currently held in memory (header + partial body). */
  get bufferedBytes(): number {
    return this.headerFill + (this.body ? this.bodyFill : 0);
  }

  push(chunk: Uint8Array): FrameResult[] {
    const out: FrameResult[] = [];
    const emit = (r: FrameResult) => {
      if (!r.ok) this.dropped[r.code] += 1;
      out.push(r);
    };
    let i = 0;
    while (i < chunk.length) {
      if (this.skipRemaining > 0) {
        const n = Math.min(this.skipRemaining, chunk.length - i);
        this.skipRemaining -= n;
        i += n;
        continue;
      }
      if (this.body === null) {
        const n = Math.min(4 - this.headerFill, chunk.length - i);
        this.header.set(chunk.subarray(i, i + n), this.headerFill);
        this.headerFill += n;
        i += n;
        if (this.headerFill < 4) break;
        this.headerFill = 0;
        const len = readLength(this.header);
        if (len > this.maxBytes) {
          this.skipRemaining = len;
          emit({ ok: false, code: "oversized", bytes: len });
        } else if (len === 0) {
          emit({ ok: false, code: "invalid-json", bytes: 0 });
        } else {
          this.body = Buffer.alloc(len);
          this.bodyFill = 0;
        }
        continue;
      }
      const n = Math.min(this.body.length - this.bodyFill, chunk.length - i);
      this.body.set(chunk.subarray(i, i + n), this.bodyFill);
      this.bodyFill += n;
      i += n;
      if (this.bodyFill === this.body.length) {
        const body = this.body;
        this.body = null;
        this.bodyFill = 0;
        const r = decodeBody(body);
        if (r.ok && this.limitFor !== undefined && r.bytes > this.limitFor(r.value)) emit({ ok: false, code: "oversized", bytes: r.bytes });
        else emit(r);
      }
    }
    return out;
  }

  /** Stream ended: report a partial frame, if any, as truncated. */
  end(): FrameResult[] {
    const partial = this.headerFill > 0 || this.body !== null || this.skipRemaining > 0;
    this.headerFill = 0;
    this.body = null;
    this.bodyFill = 0;
    this.skipRemaining = 0;
    if (!partial) return [];
    this.dropped.truncated += 1;
    return [{ ok: false, code: "truncated" }];
  }
}
