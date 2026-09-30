import { describe, expect, it } from "vitest";
import type { ActivityObservation } from "./api.js";
import { createObservationStore, OBSERVATION_TTL_MS, truncateUtf8 } from "./observationStore.js";

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms), set: (v: number) => void (t = v) };
}

function obs(n: number, extra: Partial<ActivityObservation> = {}): ActivityObservation {
  return {
    sensor: "scout",
    kind: "viewed_page",
    observedAt: "2026-09-30T12:00:00Z",
    url: `https://github.com/o/r/issues/${n}`,
    title: `issue ${n}`,
    truncated: false,
    ...extra,
  };
}

describe("observation store", () => {
  it("accepts with per-process ids and lists newest first", () => {
    const store = createObservationStore({ clock: fakeClock() });
    expect(store.add(obs(1))).toEqual({ accepted: true, observationId: "o1", truncated: false });
    expect(store.add(obs(2)).observationId).toBe("o2");
    expect(store.list().map((o) => o.title)).toEqual(["issue 2", "issue 1"]);
  });

  it("evicts the oldest when the 11th entry arrives", () => {
    const store = createObservationStore({ clock: fakeClock() });
    for (let i = 1; i <= 11; i++) store.add(obs(i));
    const titles = store.list().map((o) => o.title);
    expect(titles).toHaveLength(10);
    expect(titles).not.toContain("issue 1");
    expect(titles[0]).toBe("issue 11");
  });

  it("drops entries past the 15 min TTL on read and on add", () => {
    const clock = fakeClock();
    const store = createObservationStore({ clock });
    store.add(obs(1));
    clock.advance(10 * 60_000);
    store.add(obs(2));
    clock.advance(5 * 60_000); // obs 1 is exactly 15 min old
    expect(store.list().map((o) => o.title)).toEqual(["issue 2"]);
    clock.advance(10 * 60_000);
    store.add(obs(3));
    expect(store.list().map((o) => o.title)).toEqual(["issue 3"]);
  });

  it("expires by acceptance time, not by the sensor's observedAt", () => {
    const clock = fakeClock();
    const store = createObservationStore({ clock });
    store.add(obs(1, { observedAt: "1999-01-01T00:00:00Z" }));
    expect(store.size).toBe(1);
    clock.advance(OBSERVATION_TTL_MS - 1);
    expect(store.size).toBe(1);
  });

  it("treats a clock that went backwards as expired", () => {
    const clock = fakeClock();
    const store = createObservationStore({ clock });
    store.add(obs(1));
    clock.advance(-1);
    expect(store.list()).toEqual([]);
  });

  it("bumps activityRevision on each accepted add and on each sweep that removed something", () => {
    const clock = fakeClock();
    const store = createObservationStore({ clock });
    expect(store.activityRevision).toBe(0);
    store.add(obs(1));
    store.add(obs(2));
    expect(store.activityRevision).toBe(2);
    store.list();
    expect(store.activityRevision).toBe(2); // nothing expired
    clock.advance(OBSERVATION_TTL_MS);
    expect(store.activityRevision).toBe(3); // one sweep removed both
    expect(store.activityRevision).toBe(3);
  });

  it("truncates 9 KiB of text to 8 KiB on a character boundary and flags it", () => {
    const store = createObservationStore({ clock: fakeClock() });
    const text = "é".repeat(9 * 512); // 2 bytes each: 9 KiB
    const r = store.add(obs(1, { text }));
    expect(r.truncated).toBe(true);
    const stored = store.list()[0]!;
    expect(stored.truncated).toBe(true);
    expect(Buffer.byteLength(stored.text!, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(stored.text!.includes("�")).toBe(false);
    expect(text.startsWith(stored.text!)).toBe(true);
  });

  it("keeps short text as is and preserves the sensor's own truncated flag", () => {
    const store = createObservationStore({ clock: fakeClock() });
    expect(store.add(obs(1, { text: "short" })).truncated).toBe(false);
    expect(store.add(obs(2, { text: "short", truncated: true })).truncated).toBe(true);
    expect(store.add(obs(3, { truncated: true })).truncated).toBe(true);
    expect(store.list()[2]!.text).toBe("short");
    expect(store.list()[0]).not.toHaveProperty("text");
  });

  it("snapshots a deep-frozen copy that later adds and expiries do not change", () => {
    const clock = fakeClock();
    const store = createObservationStore({ clock });
    store.add(obs(1));
    const snap = store.snapshot();
    expect(snap.activityRevision).toBe(1);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.observations)).toBe(true);
    expect(Object.isFrozen(snap.observations[0])).toBe(true);
    store.add(obs(2));
    clock.advance(OBSERVATION_TTL_MS);
    store.list();
    expect(snap.observations.map((o) => o.title)).toEqual(["issue 1"]);
    expect(snap.activityRevision).toBe(1);
  });

  it("does not keep a reference to the caller's object", () => {
    const store = createObservationStore({ clock: fakeClock() });
    const input = obs(1);
    store.add(input);
    input.title = "changed";
    expect(store.list()[0]!.title).toBe("issue 1");
  });
});

describe("truncateUtf8", () => {
  it("never splits a multi-byte character", () => {
    expect(truncateUtf8("a😀", 3)).toEqual({ text: "a", cut: true });
    expect(truncateUtf8("a😀", 5)).toEqual({ text: "a😀", cut: false });
    expect(truncateUtf8("abc", 2)).toEqual({ text: "ab", cut: true });
  });
});
