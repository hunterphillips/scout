import type { FocusObservation } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import type { DiagnosticFields, Diagnostics } from "./diagnostics.js";
import { createVisitTracker, type VisitChange, WINDOW_ID_NONE } from "./visitTracker.js";

const STRIPE = "https://docs.stripe.com/payments/checkout";

function spyDiagnostics() {
  const events: Array<{ name: string; fields: DiagnosticFields }> = [];
  const diagnostics: Diagnostics = { failures: 0, event: (name, fields = {}) => void events.push({ name, fields }) };
  return { events, diagnostics };
}

function setup(opts: { onChange?: (c: VisitChange) => void } = {}) {
  const clock = { t: 1_000, now: () => clock.t };
  const changes: Array<VisitChange & { at: number }> = [];
  let contextRevision = 7;
  const { events, diagnostics } = spyDiagnostics();
  const granted = new Set(["https://docs.stripe.com", "https://www.peakdesign.com"]);
  const tracker = createVisitTracker({
    isPermitted: (origin) => granted.has(origin),
    clock,
    getContextRevision: () => contextRevision,
    diagnostics,
    onChange: (c) => {
      changes.push({ ...c, at: clock.t });
      opts.onChange?.(c);
    },
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
    events,
    tracker,
    focus,
    chrome,
    activate,
    granted,
    setRevision: (r: number) => (contextRevision = r),
  };
}

describe("visitTracker", () => {
  it("starts a visit when Chrome is frontmost and a permitted https page is focused", () => {
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
    ["tab switch to an unpermitted tab", (s) => s.tracker.observeFocus(s.focus({ tabId: 11, url: "https://example.com/" }))],
    ["unpermitted origin", (s) => s.tracker.observeFocus(s.focus({ url: "https://stripe.com/pricing" }))],
    ["non-default port", (s) => s.tracker.observeFocus(s.focus({ url: "https://docs.stripe.com:8443/payments" }))],
    ["http instead of https", (s) => s.tracker.observeFocus(s.focus({ url: "http://docs.stripe.com/payments" }))],
    ["malformed URL", (s) => s.tracker.observeFocus(s.focus({ url: "not a url" }))],
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
    expect(s.changes[0]).toMatchObject({ epoch: before + 1, visit: null, previous: { epoch: before } });
    expect(s.changes[0]!.at - startedAt).toBeLessThan(250);
  });

  it("switching between two permitted tabs is a new epoch with the new visit", () => {
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
    const before = s.tracker.epoch;
    s.tracker.observeFocus(s.focus({ documentId: "doc-a2" }));
    s.tracker.observeFocus(s.focus({ documentId: "doc-a2", url: "https://docs.stripe.com/billing" }));
    expect(s.changes.map((c) => c.visit?.documentId)).toEqual(["doc-a2", "doc-a2"]);
    expect(s.changes.map((c) => c.epoch)).toEqual([before + 1, before + 2]);
    expect(s.changes[1]!.previous).toBe(s.changes[0]!.visit);
  });

  const terminal = (s: ReturnType<typeof setup>) => s.tracker.observeFrontmost({ type: "frontmost", bundleId: "com.apple.Terminal", at: s.clock.t });
  /** Chrome's report once none of its windows has focus: no tab, no URL. */
  const unfocused = (s: ReturnType<typeof setup>) => {
    const { tabId: _t, url: _u, documentId: _d, title: _ti, ...rest } = s.focus({ browserFocused: false, windowId: WINDOW_ID_NONE });
    s.tracker.observeFocus(rest);
  };

  const keeping: Array<[string, (s: ReturnType<typeof setup>) => void]> = [
    ["another app frontmost", terminal],
    ["window blur on the same page", (s) => s.tracker.observeFocus(s.focus({ browserFocused: false }))],
    ["WINDOW_ID_NONE", unfocused],
    ["WINDOW_ID_NONE even if browserFocused is true", (s) => s.tracker.observeFocus(s.focus({ windowId: WINDOW_ID_NONE }))],
    [
      "another app, then Chrome's unfocused report",
      (s) => {
        terminal(s);
        unfocused(s);
      },
    ],
  ];

  it.each(keeping)("%s keeps the visit and its epoch, marked away, with no change", (_name, act) => {
    const s = setup();
    s.activate();
    const visit = s.tracker.current();
    const epoch = s.tracker.epoch;
    s.events.length = 0;
    act(s);
    expect(s.tracker.current()).toBe(visit);
    expect(s.tracker.epoch).toBe(epoch);
    expect(s.tracker.away).toBe(true);
    expect(s.changes).toHaveLength(0);
    expect(s.events.filter((e) => e.name.startsWith("visit_"))).toEqual([{ name: "visit_suspended", fields: { epoch } }]);
  });

  it("coming back to the same page resumes the visit: same epoch, same visit, no change", () => {
    const presence: Array<{ epoch: number; away: boolean }> = [];
    const s = setup();
    const tracker = createVisitTracker({
      isPermitted: () => true,
      clock: s.clock,
      onChange: (c) => void s.changes.push({ ...c, at: s.clock.t }),
      onPresence: (p) => void presence.push(p),
    });
    tracker.observeFrontmost({ type: "frontmost", bundleId: "com.google.Chrome", at: 0 });
    tracker.observeFocus(s.focus());
    const visit = tracker.current();
    s.changes.length = 0;
    tracker.observeFrontmost({ type: "frontmost", bundleId: "com.apple.Terminal", at: 1 });
    const { tabId: _t, url: _u, documentId: _d, title: _ti, ...none } = s.focus({ browserFocused: false, windowId: WINDOW_ID_NONE });
    tracker.observeFocus(none);
    // Chrome in front again, but its window not yet focused: still away.
    tracker.observeFrontmost({ type: "frontmost", bundleId: "com.google.Chrome", at: 2 });
    expect(tracker.away).toBe(true);
    s.clock.t += 60_000;
    tracker.observeFocus(s.focus());
    expect(tracker.away).toBe(false);
    expect(tracker.current()).toBe(visit);
    expect(s.changes).toHaveLength(0);
    expect(presence).toEqual([
      { epoch: visit!.epoch, away: true },
      { epoch: visit!.epoch, away: false },
    ]);
  });

  it("logs visit_resumed on the return, and nothing for a repeat while away", () => {
    const s = setup();
    s.activate();
    const epoch = s.tracker.epoch;
    s.events.length = 0;
    terminal(s);
    terminal(s);
    unfocused(s);
    s.chrome();
    s.tracker.observeFocus(s.focus());
    expect(s.events.map((e) => e.name)).toEqual(["visit_suspended", "visit_resumed"]);
    expect(s.events.map((e) => e.fields)).toEqual([{ epoch }, { epoch }]);
  });

  const returning: Array<[string, Partial<FocusObservation>]> = [
    ["another document", { documentId: "doc-b" }],
    ["another URL", { url: "https://docs.stripe.com/billing" }],
    ["another tab", { tabId: 11, documentId: "doc-c" }],
    ["an unpermitted page", { url: "https://example.com/" }],
    ["incognito", { tabId: 12, incognito: true }],
  ];

  it.each(returning)("coming back to %s ends the kept visit as a real change", (_name, overrides) => {
    const s = setup();
    s.activate();
    const held = s.tracker.current();
    const before = s.tracker.epoch;
    terminal(s);
    unfocused(s);
    s.chrome();
    s.tracker.observeFocus(s.focus(overrides));
    expect(s.tracker.away).toBe(false);
    expect(s.changes).toHaveLength(1);
    expect(s.changes[0]).toMatchObject({ epoch: before + 1, previous: held });
    expect(s.tracker.current()?.epoch ?? before + 1).toBe(before + 1);
  });

  it("a focus showing another page while Chrome is not frontmost ends the kept visit", () => {
    const s = setup();
    s.activate();
    const before = s.tracker.epoch;
    terminal(s);
    s.tracker.observeFocus(s.focus({ url: "https://docs.stripe.com/billing" }));
    expect(s.tracker.current()).toBeNull();
    expect(s.tracker.away).toBe(false);
    expect(s.changes).toEqual([expect.objectContaining({ epoch: before + 1, visit: null, previous: expect.objectContaining({ epoch: before }) })]);
    // Back in Chrome on that page: a new visit.
    s.chrome();
    expect(s.tracker.current()).toMatchObject({ epoch: before + 2, url: "https://docs.stripe.com/billing" });
  });

  it("losing the origin's grant while away ends the kept visit", () => {
    const s = setup();
    s.activate();
    const before = s.tracker.epoch;
    terminal(s);
    unfocused(s);
    s.granted.delete("https://docs.stripe.com");
    s.tracker.recompute();
    expect(s.tracker.current()).toBeNull();
    expect(s.tracker.away).toBe(false);
    expect(s.changes).toEqual([expect.objectContaining({ epoch: before + 1, visit: null })]);
  });

  it("reset ends the visit, kept or not", () => {
    for (const leave of [false, true]) {
      const s = setup();
      s.activate();
      const before = s.tracker.epoch;
      if (leave) {
        terminal(s);
        unfocused(s);
      }
      s.tracker.reset();
      expect(s.tracker.current()).toBeNull();
      expect(s.tracker.epoch).toBe(before + 1);
      expect(s.changes).toEqual([expect.objectContaining({ visit: null, previous: expect.objectContaining({ epoch: before }) })]);
      // Chrome's same page after a reset is a new visit.
      s.chrome();
      s.tracker.observeFocus(s.focus());
      expect(s.tracker.current()?.epoch).toBeGreaterThan(before + 1);
    }
  });

  it("another app in front with no visit logs nothing and stays idle", () => {
    const s = setup();
    s.chrome();
    s.tracker.observeFocus(s.focus({ url: "https://example.com/" }));
    s.events.length = 0;
    terminal(s);
    unfocused(s);
    expect(s.tracker.away).toBe(false);
    expect(s.events).toEqual([]);
  });

  it("stays idle until a frontmost command says Chrome is in front", () => {
    const { tracker, focus } = setup();
    tracker.observeFocus(focus());
    expect(tracker.current()).toBeNull();
  });

  it("activates when focus arrives first and Chrome becomes frontmost later", () => {
    const s = setup();
    s.tracker.observeFocus(s.focus());
    expect(s.tracker.current()).toBeNull();
    s.clock.t += 500;
    s.chrome();
    expect(s.tracker.current()).toMatchObject({ tabId: 10, origin: "https://docs.stripe.com", startedAt: s.clock.t });
    expect(s.changes.at(-1)).toMatchObject({ visit: s.tracker.current(), previous: null });
  });

  it("idle to idle is a change with previous null but is not logged", () => {
    const s = setup();
    s.chrome();
    s.tracker.observeFocus(s.focus({ url: "https://example.com/" }));
    s.events.length = 0;
    s.changes.length = 0;
    s.tracker.observeFocus(s.focus({ tabId: 11, url: "https://example.org/" }));
    expect(s.changes).toHaveLength(1);
    expect(s.changes[0]).toMatchObject({ visit: null, previous: null });
    expect(s.events.filter((e) => e.name === "visit_change")).toHaveLength(0);
  });

  it("logs visit_change when a visit starts, changes, or ends", () => {
    const s = setup();
    s.activate();
    s.events.length = 0;
    s.tracker.observeFocus(s.focus({ documentId: "doc-a2" }));
    s.tracker.observeFocus(s.focus({ tabId: 11, url: "https://example.com/" }));
    expect(s.events.filter((e) => e.name === "visit_change").map((e) => e.fields.active)).toEqual([true, false]);
  });

  it("never logs the page URL or documentId", () => {
    const s = setup();
    s.activate();
    s.tracker.observeFocus(s.focus({ url: "https://docs.stripe.com/billing" }));
    s.tracker.observeFocus(s.focus({ browserFocused: false }));
    expect(s.events.length).toBeGreaterThan(0);
    for (const { fields } of s.events) {
      for (const value of Object.values(fields)) {
        expect(String(value)).not.toContain("docs.stripe.com");
        expect(String(value)).not.toContain("doc-a");
      }
    }
  });

  it("catches and logs a throwing onChange handler", () => {
    const s = setup({
      onChange: () => {
        throw new Error("boom");
      },
    });
    expect(() => s.activate()).not.toThrow();
    expect(s.tracker.current()).not.toBeNull();
    expect(s.events.some((e) => e.name === "visit_change_handler_error")).toBe(true);
  });

  it("asks isPermitted with the page's exact origin and forms no visit for an unpermitted one", () => {
    const s = setup();
    s.chrome();
    s.tracker.observeFocus(s.focus({ url: "https://example.com/a" }));
    expect(s.tracker.current()).toBeNull();
    s.granted.add("https://example.com");
    s.tracker.recompute();
    expect(s.tracker.current()).toMatchObject({ origin: "https://example.com", url: "https://example.com/a" });
  });

  it("recompute ends the visit when the current origin loses its grant", () => {
    const s = setup();
    s.activate();
    const before = s.tracker.epoch;
    s.granted.delete("https://docs.stripe.com");
    s.tracker.recompute();
    expect(s.tracker.current()).toBeNull();
    expect(s.changes).toHaveLength(1);
    expect(s.changes[0]).toMatchObject({ epoch: before + 1, visit: null, previous: { epoch: before } });
  });

  it("recompute with unchanged grants changes nothing", () => {
    const s = setup();
    s.activate();
    const visit = s.tracker.current();
    s.granted.add("https://example.com");
    s.tracker.recompute();
    expect(s.tracker.current()).toBe(visit);
    expect(s.changes).toHaveLength(0);
  });

  it("a focus without documentId still forms a visit, and a later one with a documentId is a change", () => {
    const s = setup();
    s.chrome();
    const { documentId: _drop, ...noDoc } = s.focus();
    s.tracker.observeFocus(noDoc);
    expect(s.tracker.current()).toMatchObject({ origin: "https://docs.stripe.com", tabId: 10 });
    const epoch = s.tracker.epoch;
    s.tracker.observeFocus(s.focus());
    expect(s.tracker.epoch).toBe(epoch + 1);
  });
});
