import { BrowserObservationSchema } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import { FOCUS_DEBOUNCE_MS } from "./focus-observer.js";
import { activate } from "./test-fakes.js";
import { ISSUE1, observations, setup } from "./test-harness.js";

describe("focus observations", () => {
  it("debounces bursts to one observation 150 ms after the last event", async () => {
    const { f, clock } = await setup();
    const before = observations(f, "focus").length;
    f.tabs.onActivated.emit({ tabId: 10, windowId: 1 } as never);
    await clock.advance(100);
    f.tabs.onUpdated.emit(10 as never, { status: "complete" } as never, {} as never);
    await clock.advance(100);
    f.tabs.onUpdated.emit(10 as never, { url: ISSUE1 } as never, {} as never);
    await clock.advance(FOCUS_DEBOUNCE_MS - 1);
    expect(observations(f, "focus")).toHaveLength(before);
    await clock.advance(1);
    expect(observations(f, "focus")).toHaveLength(before + 1);
    const obs = observations(f, "focus").at(-1)!;
    expect(obs).toMatchObject({ kind: "focus", browserFocused: true, windowId: 1, tabId: 10, url: ISSUE1, title: "Issue 1", incognito: false });
    expect(BrowserObservationSchema.safeParse(obs).success).toBe(true);
  });

  it("ignores tab updates that change neither url nor status", async () => {
    const { f, clock } = await setup();
    const before = observations(f, "focus").length;
    f.tabs.onUpdated.emit(10 as never, { title: "x" } as never, {} as never);
    await clock.advance(500);
    expect(observations(f, "focus")).toHaveLength(before);
  });

  it("WINDOW_ID_NONE sends browserFocused: false with no tab fields", async () => {
    const { f, clock } = await setup();
    await Promise.all(f.windows.onFocusChanged.emit(-1 as never));
    await clock.advance(FOCUS_DEBOUNCE_MS);
    const obs = observations(f, "focus").at(-1)!;
    expect(obs).toEqual({ kind: "focus", seq: expect.any(Number), at: expect.any(Number), browserFocused: false, windowId: -1 });
  });

  it("a tab on a host without a grant is sent with url (and title) absent", async () => {
    const { f, clock } = await setup();
    activate(f, 12);
    f.tabs.onActivated.emit({ tabId: 12, windowId: 1 } as never);
    await clock.advance(FOCUS_DEBOUNCE_MS);
    const obs = observations(f, "focus").at(-1)!;
    expect(obs).toMatchObject({ browserFocused: true, tabId: 12, windowId: 1 });
    expect("url" in obs).toBe(false);
    expect("title" in obs).toBe(false);
  });

  it("seq is monotonic across observations", async () => {
    const { f, clock } = await setup();
    for (const id of [11, 10, 12]) {
      activate(f, id);
      f.tabs.onActivated.emit({ tabId: id, windowId: 1 } as never);
      await clock.advance(FOCUS_DEBOUNCE_MS);
    }
    const seqs = observations(f, "focus").map((o) => o["seq"] as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
