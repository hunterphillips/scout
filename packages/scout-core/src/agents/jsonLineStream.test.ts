import { describe, expect, it } from "vitest";
import { createJsonLineStream, type StreamRecord } from "./jsonLineStream.js";

function harness(maxBytes = 1024, onEvent?: (ev: StreamRecord) => void) {
  const events: StreamRecord[] = [];
  const calls = { tooLarge: 0, errors: 0 };
  const stream = createJsonLineStream({
    maxBytes,
    onEvent: onEvent ?? ((ev) => events.push(ev)),
    onTooLarge: () => calls.tooLarge++,
    onError: () => calls.errors++,
  });
  return { stream, events, calls };
}

describe("jsonLineStream", () => {
  it("joins lines split across chunks and parses each object", () => {
    const h = harness();
    h.stream.push('{"a":1}\n{"b"');
    h.stream.push(':2}\n');
    expect(h.events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("parses a final line without a trailing newline only at end()", () => {
    const h = harness();
    h.stream.push('{"a":1}\n{"type":"result"}');
    expect(h.events).toEqual([{ a: 1 }]);
    h.stream.end();
    expect(h.events).toEqual([{ a: 1 }, { type: "result" }]);
  });

  it("skips blank lines, non-JSON and JSON that is not an object", () => {
    const h = harness();
    h.stream.push('\n   \nnot json\n[1,2]\n"str"\n42\nnull\n{"ok":true}\n{broken\n');
    h.stream.end();
    expect(h.events).toEqual([{ ok: true }]);
    expect(h.calls).toEqual({ tooLarge: 0, errors: 0 });
  });

  it("counts UTF-8 bytes, reports too large once, and ignores everything after", () => {
    const h = harness(16);
    h.stream.push('{"a":"é"}\n'); // 11 bytes, 10 chars
    h.stream.push('{"b":"éé"}'); // 13 more: over 16
    h.stream.push('\n{"c":1}\n');
    h.stream.end();
    expect(h.events).toEqual([{ a: "é" }]);
    expect(h.calls.tooLarge).toBe(1);
  });

  it("turns an exception from the event handler into onError and stops", () => {
    let seen = 0;
    const h = harness(1024, () => {
      seen++;
      throw new Error("handler failed");
    });
    expect(() => h.stream.push('{"a":1}\n{"b":2}\n')).not.toThrow();
    expect(() => h.stream.push('{"c":3}')).not.toThrow();
    h.stream.end();
    expect(seen).toBe(1);
    expect(h.calls.errors).toBe(1);
  });

  it("an exception while parsing the final line also goes to onError", () => {
    const h = harness(1024, () => {
      throw new Error("handler failed");
    });
    h.stream.push('{"a":1}');
    expect(() => h.stream.end()).not.toThrow();
    expect(h.calls.errors).toBe(1);
  });
});
