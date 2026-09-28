import type { FocusObservation } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import { createVisitTracker, type VisitChange, WINDOW_ID_NONE } from "./visitTracker.js";

const STRIPE = "https://docs.stripe.com/payments/checkout";

function setup() {
  const clock = { t: 1_000, now: () => clock.t };
  const changes: Array<VisitChange & { at: number }> = [];
  let contextRevision = 7;
  const tracker = createVisitTracker({
    destinations: ["docs.stripe.com", "www.peakdesign.com"],
    clock,
    getContextRevision: () => contextRevision,
    onChange: (c) => changes.push({ ...c, at: clock.t }),
  });
  let seq = 0;
  const focus = (overrides: Partial<FocusObservation> = {}): FocusObservation => ({
    kind: "focus",
    seq: seq++,
    at: clock.t,
    browserFocused: true,
    windowId: 1,
    tabId: 10,
    url: STRIPE,
    title: "Checkout",
    documentId: "doc-a",
    ...overrides,
  });
  const chrome = () => tracker.observeFrontmost({ type: "frontmost", bundleId: "com.google.Chrome", at: clock.t });
  /** Put the tracker on an active Stripe visit and clear the change log. */
  const activate = () => {
    chrome();
    tracker.observeFocus(focus());
    expect(tracker.current()).not.toBeNull();
    changes.length = 0;
  };
  return {
    clock,
    changes,
    tracker,
    focus,
    chrome,
    activate,
    setRevision: (r: number) => (contextRevision = r),
  };
}

describe("visitTracker", () => {
  it("starts a visit when Chrome is frontmost and an approved https page is focused", () => {
    const { tracker, changes, focus, chrome, clock } = setup();
    chrome();
    clock.t = 2_000;
    tracker.observeFocus(focus());
    expect(tracker.current()).toEqual({
      epoch: 2,
      tabId: 10,
      documentId: "doc-a",
      origin: "https://docs.stripe.com",
      url: STRIPE,
      startedAt: 2_000,
      contextRevision: 7,
    });
    expect(changes.at(-1)?.visit).toBe(tracker.current());
  });

  it("omits documentId from the visit when the observation has none", () => {
    const { tracker, focus, chrome } = setup();
    chrome();
    const { documentId: _drop, ...noDoc } = focus();
    tracker.observeFocus(noDoc);
    expect(tracker.current()).not.toHaveProperty("documentId");
  });

  const clearing: Array<[string, (s: ReturnType<typeof setup>) => void]> = [
    ["tab switch to an unapproved tab", (s) => s.tracker.observeFocus(s.focus({ tabId: 11, url: "https://example.com/" }))],
    ["window blur", (s) => s.tracker.observeFocus(s.focus({ browserFocused: false }))],
    [
      "WINDOW_ID_NONE",
      (s) => {
        const { tabId: _t, url: _u, documentId: _d, ...rest } = s.focus({ windowId: WINDOW_ID_NONE });
        s.tracker.observeFocus(rest);
      },
    ],
    ["WINDOW_ID_NONE even if browserFocused is true", (s) => s.tracker.observeFocus(s.focus({ windowId: WINDOW_ID_NONE }))],
    [
      "non-Chrome frontmost",
      (s) => s.tracker.observeFrontmost({ type: "frontmost", bundleId: "com.apple.Terminal", at: s.clock.t }),
    ],
    ["unapproved origin", (s) => s.tracker.observeFocus(s.focus({ url: "https://stripe.com/pricing" }))],
    ["http instead of https", (s) => s.tracker.observeFocus(s.focus({ url: "http://docs.stripe.com/payments" }))],
    [
      "missing URL",
      (s) => {
        const { url: _u, ...rest } = s.focus();
        s.tracker.observeFocus(rest);
      },
    ],
    ["incognito", (s) => s.tracker.observeFocus(s.focus({ tabId: 12, incognito: true }))],
  ];

  it.each(clearing)("%s clears the visit, bumps the epoch, and emits idle within 250 ms", (_name, act) => {
    const s = setup();
    s.activate();
    const before = s.tracker.epoch;
    const startedAt = s.clock.t;
    act(s);
    expect(s.tracker.current()).toBeNull();
    expect(s.tracker.epoch).toBe(before + 1);
    expect(s.changes).toHaveLength(1);
    expect(s.changes[0]).toMatchObject({ epoch: before + 1, visit: null });
    expect(s.changes[0]!.at - startedAt).toBeLessThan(250);
  });

  it("switching between two approved tabs is a new epoch with the new visit", () => {
    const s = setup();
    s.activate();
    s.tracker.observeFocus(s.focus({ tabId: 20, url: "https://www.peakdesign.com/products/everyday-backpack", documentId: "doc-b" }));
    expect(s.changes).toHaveLength(1);
    expect(s.changes[0]!.visit).toMatchObject({ epoch: s.tracker.epoch, tabId: 20, origin: "https://www.peakdesign.com" });
  });

  it("a repeated identical focus observation does not bump the epoch", () => {
    const s = setup();
    s.activate();
    const epoch = s.tracker.epoch;
    const visit = s.tracker.current();
    s.clock.t += 5_000;
    s.tracker.observeFocus(s.focus());
    s.tracker.observeFocus(s.focus({ title: "A new title" }));
    s.chrome();
    expect(s.tracker.epoch).toBe(epoch);
    expect(s.tracker.current()).toBe(visit);
    expect(s.changes).toHaveLength(0);
  });

  it("a same-tab navigation (new documentId or URL) is a real change", () => {
    const s = setup();
    s.activate();
    s.tracker.observeFocus(s.focus({ documentId: "doc-a2" }));
    s.tracker.observeFocus(s.focus({ documentId: "doc-a2", url: "https://docs.stripe.com/billing" }));
    expect(s.changes.map((c) => c.visit?.documentId)).toEqual(["doc-a2", "doc-a2"]);
    expect(s.changes.map((c) => c.epoch)).toEqual([3, 4]);
  });

  it("leaving and coming back is two changes, so the return is a new epoch", () => {
    const s = setup();
    s.activate();
    const first = s.tracker.epoch;
    s.tracker.observeFrontmost({ type: "frontmost", bundleId: "com.apple.Terminal", at: s.clock.t });
    s.setRevision(8);
    s.clock.t += 1_000;
    s.chrome();
    expect(s.changes.map((c) => c.epoch)).toEqual([first + 1, first + 2]);
    expect(s.tracker.current()).toMatchObject({ epoch: first + 2, startedAt: s.clock.t, contextRevision: 8 });
  });

  it("stays idle until a frontmost command says Chrome is in front", () => {
    const { tracker, focus } = setup();
    tracker.observeFocus(focus());
    expect(tracker.current()).toBeNull();
  });
});
