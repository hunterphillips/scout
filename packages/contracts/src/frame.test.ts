import { Buffer } from "node:buffer";
import { endianness } from "node:os";
import { describe, expect, it } from "vitest";
import {
  encodeFrame,
  frameBytes,
  FrameDecoder,
  FrameError,
  frameHeader,
  type FrameResult,
  MAX_FRAME_FROM_CHROME,
  MAX_FRAME_TO_CHROME,
} from "./frame.js";

const frame = (obj: unknown) => {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  return Buffer.concat([frameHeader(body.length), body]);
};
const raw = (body: Buffer) => Buffer.concat([frameHeader(body.length), body]);
const values = (rs: FrameResult[]) => rs.map((r) => (r.ok ? r.value : r.code));

describe("frame codec", () => {
  it("writes the length in native byte order", () => {
    const expected = endianness() === "LE" ? [4, 3, 2, 1] : [1, 2, 3, 4];
    expect([...frameHeader(0x01020304)]).toEqual(expected);
  });

  it("round-trips objects fed one byte at a time", () => {
    const d = new FrameDecoder();
    const a = { type: "a", s: "héllo ✓ 😀" };
    const bytes = Buffer.concat([encodeFrame(a), encodeFrame({ type: "b" })]);
    const out: FrameResult[] = [];
    for (const b of bytes) out.push(...d.push(Buffer.from([b])));
    expect(values(out)).toEqual([a, { type: "b" }]);
    expect(d.end()).toEqual([]);
    expect(d.droppedTotal).toBe(0);
  });

  it("accepts exactly 64 KiB and drops one byte more without buffering it", () => {
    const d = new FrameDecoder();
    const pad = "x".repeat(MAX_FRAME_FROM_CHROME - Buffer.byteLength('{"p":""}'));
    const ok = d.push(frame({ p: pad }));
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ ok: true, bytes: MAX_FRAME_FROM_CHROME });

    const big = frame({ p: pad + "y" });
    const res: FrameResult[] = [];
    for (let i = 0; i < big.length; i += 1000) {
      res.push(...d.push(big.subarray(i, i + 1000)));
      expect(d.bufferedBytes).toBeLessThanOrEqual(4);
    }
    expect(res).toEqual([{ ok: false, code: "oversized", bytes: MAX_FRAME_FROM_CHROME + 1 }]);
    expect(d.dropped.oversized).toBe(1);
    // Stream stays in sync after the skipped frame.
    expect(values(d.push(frame({ after: 1 })))).toEqual([{ after: 1 }]);
  });

  it("does not allocate for a huge declared length", () => {
    const d = new FrameDecoder();
    const r = d.push(Buffer.concat([frameHeader(0xffffffff), Buffer.alloc(100)]));
    expect(r).toEqual([{ ok: false, code: "oversized", bytes: 0xffffffff }]);
    expect(d.bufferedBytes).toBe(0);
  });

  it("drops and counts invalid UTF-8, invalid JSON, empty and non-object bodies", () => {
    const d = new FrameDecoder();
    const inputs = [
      raw(Buffer.from([0x22, 0xc3, 0x28, 0x22])),
      raw(Buffer.from("{nope")),
      frameHeader(0),
      frame([1]),
      frame("s"),
      frame(null),
      frame(3),
      frame({ fine: true }),
    ];
    const out = inputs.flatMap((b) => d.push(b));
    expect(values(out)).toEqual([
      "invalid-utf8",
      "invalid-json",
      "invalid-json",
      "not-object",
      "not-object",
      "not-object",
      "not-object",
      { fine: true },
    ]);
    expect(d.dropped).toMatchObject({ "invalid-utf8": 1, "invalid-json": 2, "not-object": 4 });
    expect(d.droppedTotal).toBe(7);
  });

  it("reports a partial header, body, or skipped frame at end of stream as truncated", () => {
    const partials = [
      Buffer.from([1, 0]),
      frame({ a: 1 }).subarray(0, 7),
      Buffer.concat([frameHeader(MAX_FRAME_FROM_CHROME + 1), Buffer.alloc(10)]),
    ];
    for (const p of partials) {
      const d = new FrameDecoder();
      d.push(p);
      expect(d.end()).toEqual([{ ok: false, code: "truncated" }]);
      expect(d.dropped.truncated).toBe(1);
      expect(d.end()).toEqual([]);
    }
  });

  it("refuses to encode outgoing frames over 16 KiB", () => {
    expect(() => encodeFrame({ p: "x".repeat(MAX_FRAME_TO_CHROME) })).toThrow("outgoing-oversized");
    expect(encodeFrame({ p: "x".repeat(MAX_FRAME_TO_CHROME - 20) }).length).toBeLessThanOrEqual(
      MAX_FRAME_TO_CHROME + 4,
    );
  });

  it("frames a body of exactly 16 KiB and refuses one byte more", () => {
    const exact = frameBytes(Buffer.alloc(MAX_FRAME_TO_CHROME, 0x20));
    expect(exact.length).toBe(MAX_FRAME_TO_CHROME + 4);
    expect(exact.subarray(0, 4)).toEqual(frameHeader(MAX_FRAME_TO_CHROME));
    expect(() => frameBytes(Buffer.alloc(MAX_FRAME_TO_CHROME + 1, 0x20))).toThrow(FrameError);
  });
});
