import { describe, expect, it } from "vitest";
import { createReconnectPolicy, type SeriesState, type SeriesStore } from "./reconnect.js";
import { fakeClock } from "./test-fakes.js";

function memoryStore(): SeriesStore & { value: SeriesState | undefined } {
  const s = {
    value: undefined as SeriesState | undefined,
    load: async () => (s.value ? { ...s.value } : undefined),
    save: (v: SeriesState) => void (s.value = { ...v }),
  };
  return s;
}

function policy(opts: { delays?: number[]; store?: SeriesStore; start?: number } = {}) {
  const clock = fakeClock(opts.start);
  const attempts: number[] = [];
  const p = createReconnectPolicy({
    clock,
    attempt: () => void attempts.push(clock.now()),
    ...(opts.store ? { store: opts.store } : {}),
    ...(opts.delays ? { delays: opts.delays } : {}),
  });
  return { clock, attempts, p };
}

describe("reconnect policy", () => {
  it("an exhausted series inside 60 s ignores events; the first event after 60 s starts one", async () => {
    const { clock, attempts, p } = policy({ delays: [1000] });
    await p.start();
    p.disconnected(false);
    await clock.advance(1000);
    p.disconnected(false); // schedule spent at 1 s
    expect(p.exhausted).toBe(true);
    expect(p.pending).toBe(false);
    await clock.advance(1000);
    expect(p.trigger()).toBe(false);
    await clock.advance(57_999);
    expect(p.trigger()).toBe(false);
    expect(attempts).toHaveLength(2);
    await clock.advance(1);
    expect(p.trigger()).toBe(true);
    expect(attempts).toHaveLength(3);
    expect(p.seriesStarted).toBe(2);
  });

  it("a healthy drop more than 60 s after the series began starts a fresh 1 s series", async () => {
    const { clock, attempts, p } = policy();
    await p.start();
    p.disconnected(false);
    await clock.advance(1000); // attempt 2 connects and stays up
    await clock.advance(61_000);
    p.disconnected(true);
    expect(p.seriesStarted).toBe(2);
    await clock.advance(999);
    expect(attempts).toHaveLength(2);
    await clock.advance(1);
    expect(attempts).toHaveLength(3);
  });

  it("ignores events until start() has read the store", async () => {
    const { p } = policy({ store: memoryStore() });
    expect(p.trigger()).toBe(false);
  });

  it("a restarted worker resumes the pending retry at its step", async () => {
    const store = memoryStore();
    const a = policy({ store });
    await a.p.start();
    a.p.disconnected(false);
    await a.clock.advance(1000);
    a.p.disconnected(false); // step 2: the 2 s retry is pending
    expect(store.value).toMatchObject({ step: 2, exhausted: false, retryAt: a.clock.now() + 2000 });

    const b = policy({ store, start: a.clock.now() + 500 });
    await b.p.start();
    expect(b.attempts).toEqual([]);
    await b.clock.advance(1500);
    expect(b.attempts).toHaveLength(1);
    b.p.disconnected(false);
    expect(b.p.step).toBe(3); // 4 s next, not 1 s
    await b.clock.advance(3999);
    expect(b.attempts).toHaveLength(1);
    await b.clock.advance(1);
    expect(b.attempts).toHaveLength(2);
  });

  it("a restarted worker with nothing pending stays idle inside 60 s of the series start", async () => {
    const store = memoryStore();
    const a = policy({ store });
    await a.p.start(); // attempt in flight when the worker dies
    const b = policy({ store, start: a.clock.now() + 30_000 });
    await b.p.start();
    expect(b.attempts).toEqual([]);
    expect(b.p.trigger()).toBe(false);
    await b.clock.advance(30_000);
    expect(b.p.trigger()).toBe(true);
  });
});
