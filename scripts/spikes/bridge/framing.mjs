// Scout Phase 0 bridge spike: Chrome native-messaging framing.
//
// A frame is a 32-bit unsigned length in NATIVE byte order followed by that
// many bytes of UTF-8 JSON. The same framing is reused on the private Unix
// socket between the native host and the stub server.
//
// The decoder never allocates more than `maxBytes` for a body. An oversized
// header switches it to skip mode: the declared bytes are discarded as they
// arrive, without buffering, and one `oversized` error is reported. Every
// decoded value must be a plain JSON object; anything else is an error and is
// never handed to the caller as a message.

import { endianness } from "node:os";

export const INCOMING_MAX_BYTES = 64 * 1024;
export const OUTGOING_MAX_BYTES = 16 * 1024;
const LITTLE = endianness() === "LE";

export class FrameError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function writeLength(buf, n) {
  if (LITTLE) buf.writeUInt32LE(n, 0);
  else buf.writeUInt32BE(n, 0);
}

function readLength(buf) {
  return LITTLE ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
}

/** Header for a body of `n` bytes, native byte order. */
export function frameHeader(n) {
  const h = Buffer.alloc(4);
  writeLength(h, n);
  return h;
}

/** Frame raw body bytes (already-validated JSON). */
export function frameBytes(body, maxBytes = OUTGOING_MAX_BYTES) {
  if (body.length > maxBytes) throw new FrameError("outgoing-oversized");
  return Buffer.concat([frameHeader(body.length), body]);
}

/** Encode an object as one frame. Throws `outgoing-oversized` over the cap. */
export function encodeFrame(obj, maxBytes = OUTGOING_MAX_BYTES) {
  return frameBytes(Buffer.from(JSON.stringify(obj), "utf8"), maxBytes);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Decode one complete body. Returns {ok, value, raw} or {ok:false, code}. */
export function decodeBody(body) {
  let text;
  try {
    text = utf8.decode(body);
  } catch {
    return { ok: false, code: "invalid-utf8", bytes: body.length };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid-json", bytes: body.length };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "not-object", bytes: body.length };
  }
  return { ok: true, value, raw: body, bytes: body.length };
}

export class FrameDecoder {
  constructor({ maxBytes = INCOMING_MAX_BYTES } = {}) {
    this.maxBytes = maxBytes;
    this.header = Buffer.alloc(4);
    this.headerFill = 0;
    this.body = null;
    this.bodyFill = 0;
    this.skipRemaining = 0;
  }

  /** Bytes currently held in memory (header + partial body). */
  get bufferedBytes() {
    return this.headerFill + (this.body ? this.bodyFill : 0);
  }

  /** Feed a chunk; returns decoded results in order. */
  push(chunk) {
    const out = [];
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
        chunk.copy(this.header, this.headerFill, i, i + n);
        this.headerFill += n;
        i += n;
        if (this.headerFill < 4) break;
        this.headerFill = 0;
        const len = readLength(this.header);
        if (len > this.maxBytes) {
          this.skipRemaining = len;
          out.push({ ok: false, code: "oversized", bytes: len });
          continue;
        }
        if (len === 0) {
          out.push({ ok: false, code: "invalid-json", bytes: 0 });
          continue;
        }
        this.body = Buffer.alloc(len);
        this.bodyFill = 0;
        continue;
      }
      const n = Math.min(this.body.length - this.bodyFill, chunk.length - i);
      chunk.copy(this.body, this.bodyFill, i, i + n);
      this.bodyFill += n;
      i += n;
      if (this.bodyFill === this.body.length) {
        const body = this.body;
        this.body = null;
        this.bodyFill = 0;
        out.push(decodeBody(body));
      }
    }
    return out;
  }

  /** Stream ended: report a partial frame, if any, as truncated. */
  end() {
    const partial = this.headerFill > 0 || this.body !== null || this.skipRemaining > 0;
    this.headerFill = 0;
    this.body = null;
    this.bodyFill = 0;
    this.skipRemaining = 0;
    return partial ? [{ ok: false, code: "truncated" }] : [];
  }
}
