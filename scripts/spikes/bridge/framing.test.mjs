import { endianness } from "node:os";
import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, frameHeader, INCOMING_MAX_BYTES, OUTGOING_MAX_BYTES } from "./framing.mjs";
import { createBackoff, RECONNECT_DELAYS_MS } from "./reconnect-policy.mjs";

const frame = (obj) => {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  return Buffer.concat([frameHeader(body.length), body]);
};

describe("native-messaging framing", () => {
  it("writes the length in native byte order", () => {
    const h = frameHeader(0x01020304);
    const expected = endianness() === "LE" ? [4, 3, 2, 1] : [1, 2, 3, 4];
    expect([...h]).toEqual(expected);
  });

  it("round-trips objects fed one byte at a time", () => {
    const d = new FrameDecoder();
    const bytes = Buffer.concat([frame({ type: "a", s: "héllo ✓ 😀" }), frame({ type: "b" })]);
    const out = [];
    for (const b of bytes) out.push(...d.push(Buffer.from([b])));
    expect(out.map((r) => r.value)).toEqual([{ type: "a", s: "héllo ✓ 😀" }, { type: "b" }]);
    expect(d.end()).toEqual([]);
  });

  it("accepts exactly 64 KiB and rejects one byte more without buffering it", () => {
    const d = new FrameDecoder();
    const pad = "x".repeat(INCOMING_MAX_BYTES - Buffer.byteLength('{"p":""}'));
    const ok = d.push(frame({ p: pad }));
    expect(ok).toHaveLength(1);
    expect(ok[0].ok).toBe(true);
    expect(ok[0].bytes).toBe(INCOMING_MAX_BYTES);

    const big = frame({ p: pad + "y" });
    const res = [];
    for (let i = 0; i < big.length; i += 1000) {
      res.push(...d.push(big.subarray(i, i + 1000)));
      expect(d.bufferedBytes).toBeLessThanOrEqual(4);
    }
    expect(res).toEqual([{ ok: false, code: "oversized", bytes: INCOMING_MAX_BYTES + 1 }]);
    // Stream stays in sync after the skipped frame.
    expect(d.push(frame({ after: 1 }))[0].value).toEqual({ after: 1 });
  });

  it("does not allocate for a huge declared length", () => {
    const d = new FrameDecoder();
    const r = d.push(Buffer.concat([frameHeader(0xffffffff), Buffer.alloc(100)]));
    expect(r).toEqual([{ ok: false, code: "oversized", bytes: 0xffffffff }]);
    expect(d.bufferedBytes).toBe(0);
    expect(d.end()).toEqual([{ ok: false, code: "truncated" }]);
  });

  it("rejects invalid UTF-8, invalid JSON, empty and non-object bodies", () => {
    const d = new FrameDecoder();
    const raw = (buf) => Buffer.concat([frameHeader(buf.length), buf]);
    const codes = [
      raw(Buffer.from([0x22, 0xc3, 0x28, 0x22])),
      raw(Buffer.from("{nope")),
      frameHeader(0),
      frame([1]),
      frame("s"),
      frame(null),
      frame(3),
    ].flatMap((b) => d.push(b).map((r) => r.code));
    expect(codes).toEqual(["invalid-utf8", "invalid-json", "invalid-json", "not-object", "not-object", "not-object", "not-object"]);
  });

  it("reports a partial header or body at end of stream as truncated", () => {
    const a = new FrameDecoder();
    a.push(Buffer.from([1, 0]));
    expect(a.end()).toEqual([{ ok: false, code: "truncated" }]);
    const b = new FrameDecoder();
    b.push(frame({ a: 1 }).subarray(0, 7));
    expect(b.end()).toEqual([{ ok: false, code: "truncated" }]);
  });

  it("refuses to encode outgoing frames over 16 KiB", () => {
    expect(() => encodeFrame({ p: "x".repeat(OUTGOING_MAX_BYTES) })).toThrow("outgoing-oversized");
    expect(encodeFrame({ p: "x".repeat(OUTGOING_MAX_BYTES - 20) }).length).toBeLessThanOrEqual(OUTGOING_MAX_BYTES + 4);
  });
});

describe("reconnect schedule", () => {
  it("runs 1,2,4,8,16,30 s then stops until reset", () => {
    const b = createBackoff();
    const seen = [];
    for (let d = b.next(); d !== null; d = b.next()) seen.push(d);
    expect(seen).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(seen).toEqual([...RECONNECT_DELAYS_MS]);
    expect(b.exhausted).toBe(true);
    expect(b.next()).toBeNull();
    b.reset();
    expect(b.next()).toBe(1000);
  });
});
