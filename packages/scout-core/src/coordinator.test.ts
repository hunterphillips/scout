import type { BrowserObservation, FocusObservation, ObservationFrame, PageTextObservation, PanelState, ToChromeFrame } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import { type CoordinatorOptions, createCoordinator } from "./coordinator.js";
import type { DiagnosticFields, Diagnostics } from "./diagnostics.js";
import type { SocketClient } from "./socketServer.js";

const STRIPE = "https://docs.stripe.com/payments/checkout";
const ISSUE = "https://github.com/o/r/issues/1";

function fakeClient(id: number) {
  const frameHandlers: Array<(f: ObservationFrame) => void> = [];
  const closeHandlers: Array<() => void> = [];
  const sent: ToChromeFrame[] = [];
  let closed = false;
  const client: SocketClient = {
    id,
    send: (f) => void sent.push(f),
    onFrame: (h) => void frameHandlers.push(h),
    onClose: (h) => void closeHandlers.push(h),
    close: () => void (closed = true),
  };
  return {
    client,
    sent,
    get closed() {
      return closed;
    },
    observe: (observation: BrowserObservation) => {
      for (const h of frameHandlers) h({ type: "observation", observation });
    },
    disconnect: () => {
      for (const h of closeHandlers) h();
    },
  };
}

function setup(extra: Partial<CoordinatorOptions> = {}) {
  const clock = { t: 1_000, now: () => clock.t };
  const panel: PanelState[] = [];
  const events: Array<{ name: string; fields: DiagnosticFields }> = [];
  const diagnostics: Diagnostics = { failures: 0, event: (name, fields = {}) => void events.push({ name, fields }) };
  const coordinator = createCoordinator({
    config: { destinations: ["docs.stripe.com", "www.peakdesign.com"] },
    clock,
    diagnostics,
    emitPanel: (s) => void panel.push(s),
    ...extra,
  });
  let seq = 0;
  const focus = (overrides: Partial<FocusObservation> = {}): FocusObservation => ({
    kind: "focus",
    seq: ++seq,
    at: clock.t,
    browserFocused: true,
    windowId: 1,
    tabId: 10,
    url: STRIPE,
    documentId: "doc-a",
    ...overrides,
  });
  const pageText = (overrides: Partial<PageTextObservation> = {}): PageTextObservation => ({
    kind: "page_text",
    seq: ++seq,
    at: clock.t,
    tabId: 20,
    documentId: "doc-issue",
    url: ISSUE,
    source: "github_issue",
    title: "An issue",
    text: "Issue body",
    truncated: false,
    ...overrides,
  });
  const chrome = () => coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.google.Chrome", at: clock.t });
  const connect = (id = 1) => {
    const c = fakeClient(id);
    coordinator.attachClient(c.client);
    return c;
  };
  return { coordinator, panel, events, focus, pageText, chrome, connect };
}

describe("coordinator", () => {
  it("a configured chromeBundleId is the one that counts as Chrome frontmost", () => {
    const { coordinator, focus, connect } = setup({
      config: { destinations: ["docs.stripe.com"], chromeBundleId: "com.google.chrome.for.testing" },
    });
    const c = connect();
    coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.google.Chrome", at: 1 });
    c.observe(focus());
    expect(coordinator.tracker.current()).toBeNull();
    coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.google.chrome.for.testing", at: 2 });
    expect(coordinator.tracker.current()).not.toBeNull();
    expect(new URL(coordinator.tracker.current()!.origin).hostname).toBe("docs.stripe.com");
  });

  it("starts disconnected and goes idle when a sensor says hello", () => {
    const { panel, connect } = setup();
    expect(panel).toEqual([{ type: "state", status: "disconnected" }]);
    connect();
    expect(panel.at(-1)).toEqual({ type: "state", status: "idle", visitEpoch: 0 });
  });

  it("an active visit's idle state carries the approved hostname only; leaving drops it", () => {
    const { coordinator, panel, focus, chrome, connect } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ url: "https://docs.stripe.com/payments/checkout?q=secret#frag" }));
    const state = panel.at(-1);
    expect(state).toEqual({ type: "state", status: "idle", visitEpoch: coordinator.tracker.epoch, detail: "docs.stripe.com" });
    expect(JSON.stringify(state)).not.toContain("payments");
    coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.apple.Terminal", at: 1 });
    expect(panel.at(-1)).toEqual({ type: "state", status: "idle", visitEpoch: coordinator.tracker.epoch });
    expect(panel.at(-1)).not.toHaveProperty("detail");
  });

  it("agentView shows the focused permitted visit and the pause state, nothing else", () => {
    const { coordinator, focus, chrome, connect } = setup();
    expect(coordinator.agentView()).toEqual({ currentSite: null, paused: false });
    const c = connect();
    chrome();
    c.observe(focus());
    expect(coordinator.agentView()).toEqual({
      currentSite: { origin: "https://docs.stripe.com", url: STRIPE, visitEpoch: coordinator.tracker.epoch },
      paused: false,
    });
    coordinator.handleNativeCommand({ type: "pause" });
    expect(coordinator.agentView().paused).toBe(true);
    c.observe(focus({ url: ISSUE }));
    expect(coordinator.agentView().currentSite).toBeNull();
  });

  it("an approved focus while Chrome is frontmost emits idle with the new epoch; a repeat emits nothing", () => {
    const { coordinator, panel, focus, chrome, connect } = setup();
    const c = connect();
    chrome(); // idle -> idle: no emission
    const before = panel.length;
    c.observe(focus());
    expect(coordinator.tracker.current()).not.toBeNull();
    const epoch = coordinator.tracker.epoch;
    expect(panel.slice(before)).toEqual([{ type: "state", status: "idle", visitEpoch: epoch, detail: "docs.stripe.com" }]);

    c.observe(focus({ title: "retitled" }));
    chrome();
    expect(panel.length).toBe(before + 1);
    expect(coordinator.tracker.epoch).toBe(epoch);
  });

  it("idle-to-idle changes emit nothing", () => {
    const { coordinator, panel, focus, chrome, connect } = setup();
    const c = connect();
    chrome();
    const before = panel.length;
    const epoch = coordinator.tracker.epoch;
    c.observe(focus({ url: "https://example.com/a", tabId: 1 }));
    c.observe(focus({ url: "https://example.com/b", tabId: 2 }));
    coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.apple.Terminal", at: 1 });
    expect(coordinator.tracker.epoch).toBeGreaterThan(epoch);
    expect(panel.length).toBe(before);
  });

  it("leaving an approved page emits idle with the new epoch", () => {
    const { coordinator, panel, focus, chrome, connect } = setup();
    const c = connect();
    chrome();
    c.observe(focus());
    coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.apple.Terminal", at: 1 });
    expect(coordinator.tracker.current()).toBeNull();
    expect(panel.at(-1)).toEqual({ type: "state", status: "idle", visitEpoch: coordinator.tracker.epoch });
  });

  it("page_text from the focused tab bumps contextRevision and is acked to the host", () => {
    const { coordinator, events, focus, pageText, chrome, connect } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue" }));
    const obs = pageText();
    c.observe(obs);
    expect(coordinator.forwarder.contextRevision).toBe(1);
    expect(c.sent).toEqual([{ type: "ack", seq: obs.seq }]);
    expect(events.some((e) => e.name === "activity_forwarded")).toBe(true);
  });

  it("new visits carry the bumped contextRevision", () => {
    const { coordinator, focus, pageText, chrome, connect } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue" }));
    c.observe(pageText());
    c.observe(focus());
    expect(coordinator.tracker.current()?.contextRevision).toBe(1);
  });

  it("page_text from another tab, an unfocused browser, or with Chrome in back is dropped and not acked", () => {
    const { coordinator, events, focus, pageText, chrome, connect } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue" }));
    c.observe(pageText({ tabId: 21 }));
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue", browserFocused: false, windowId: -1 }));
    c.observe(pageText());
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue" }));
    coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.apple.Terminal", at: 1 });
    c.observe(pageText());
    expect(c.sent).toEqual([]);
    expect(coordinator.forwarder.contextRevision).toBe(0);
    expect(events.filter((e) => e.name === "page_text_dropped").map((e) => e.fields.reason)).toEqual([
      "not-focused-tab",
      "browser-not-focused",
      "chrome-not-frontmost",
    ]);
  });

  it("page_text is dropped while the focused tab is incognito", () => {
    const { coordinator, events, focus, pageText, chrome, connect } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue", incognito: true }));
    c.observe(pageText());
    expect(c.sent).toEqual([]);
    expect(coordinator.forwarder.contextRevision).toBe(0);
    expect(events.filter((e) => e.name === "page_text_dropped").map((e) => e.fields.reason)).toEqual(["incognito"]);
  });

  it("page_text from a document the focused tab has left is dropped; no focus documentId skips the check", () => {
    const { coordinator, events, focus, pageText, chrome, connect } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-next" }));
    c.observe(pageText());
    expect(c.sent).toEqual([]);
    expect(events.filter((e) => e.name === "page_text_dropped").map((e) => e.fields.reason)).toEqual([
      "not-focused-document",
    ]);
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: undefined }));
    const obs = pageText();
    c.observe(obs);
    expect(c.sent).toEqual([{ type: "ack", seq: obs.seq }]);
    expect(coordinator.forwarder.contextRevision).toBe(1);
  });

  it("page_text whose URL is not the focused tab's issue is dropped as url-mismatch", () => {
    const { coordinator, events, focus, pageText, chrome, connect } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: "https://github.com/o/r/issues/2", documentId: "doc-issue" }));
    c.observe(pageText());
    c.observe(focus({ tabId: 20, url: "https://github.com/o/r/pulls", documentId: "doc-issue" }));
    c.observe(pageText());
    expect(c.sent).toEqual([]);
    expect(coordinator.forwarder.contextRevision).toBe(0);
    expect(events.filter((e) => e.name === "page_text_dropped").map((e) => e.fields.reason)).toEqual([
      "url-mismatch",
      "url-mismatch",
    ]);
  });

  it("the URL gate ignores query, fragment, trailing slash, and owner/repo case", () => {
    const { coordinator, focus, pageText, chrome, connect } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: "https://github.com/O/R/issues/1/?tab=x#issuecomment-5", documentId: "doc-issue" }));
    const obs = pageText();
    c.observe(obs);
    expect(c.sent).toEqual([{ type: "ack", seq: obs.seq }]);
    expect(coordinator.forwarder.contextRevision).toBe(1);
  });

  it("pause emits paused and suppresses forwarding and visit states; resume emits idle", () => {
    const { coordinator, panel, focus, pageText, chrome, connect } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue" }));
    coordinator.handleNativeCommand({ type: "pause" });
    expect(panel.at(-1)).toEqual({ type: "state", status: "paused" });
    const before = panel.length;
    c.observe(pageText());
    c.observe(focus());
    expect(panel.length).toBe(before);
    expect(c.sent).toEqual([]);
    expect(coordinator.forwarder.contextRevision).toBe(0);
    coordinator.handleNativeCommand({ type: "resume" });
    // The visit to docs.stripe.com (tracked while paused) is still active.
    expect(panel.at(-1)).toEqual({
      type: "state",
      status: "idle",
      visitEpoch: coordinator.tracker.epoch,
      detail: "docs.stripe.com",
    });
  });

  it("permissions observations are logged as a count only", () => {
    const { events, connect } = setup();
    const c = connect();
    c.observe({ kind: "permissions", granted: ["https://github.com/*", "https://docs.stripe.com/*"] });
    expect(events.at(-1)).toEqual({ name: "permissions", fields: { granted: 2 } });
  });

  it("the most recent hello is the live sensor; an older connection's frames and close are ignored", () => {
    const { coordinator, panel, focus, chrome, connect, events } = setup();
    const old = connect(1);
    const live = connect(2);
    chrome();
    old.observe(focus());
    expect(coordinator.tracker.current()).toBeNull();
    expect(events.some((e) => e.name === "stale_sensor_frame")).toBe(true);
    old.disconnect();
    expect(panel.at(-1)?.status).toBe("idle");
    live.observe(focus());
    expect(coordinator.tracker.current()).not.toBeNull();
  });

  it("a new sensor ends the previous sensor's visit", () => {
    const { coordinator, panel, focus, chrome, connect } = setup();
    const first = connect(1);
    chrome();
    first.observe(focus());
    expect(coordinator.tracker.current()).not.toBeNull();
    connect(2);
    expect(coordinator.tracker.current()).toBeNull();
    expect(panel.at(-1)).toEqual({ type: "state", status: "idle", visitEpoch: coordinator.tracker.epoch });
  });

  it("losing the live sensor ends the visit and emits disconnected", () => {
    const { coordinator, panel, focus, chrome, connect } = setup();
    const c = connect();
    chrome();
    c.observe(focus());
    c.disconnect();
    expect(coordinator.tracker.current()).toBeNull();
    expect(panel.at(-1)).toEqual({ type: "state", status: "disconnected" });
    const again = connect(2);
    expect(panel.at(-1)).toEqual({ type: "state", status: "idle", visitEpoch: coordinator.tracker.epoch });
    expect(again.closed).toBe(false);
  });

  it("shutdown stops handling input and asks the owner to shut down once", () => {
    let requests = 0;
    const { coordinator, panel, focus, chrome, connect } = setup({ onShutdownRequested: () => void (requests += 1) });
    const c = connect();
    coordinator.handleNativeCommand({ type: "shutdown" });
    coordinator.handleNativeCommand({ type: "shutdown" });
    expect(coordinator.stopped).toBe(true);
    expect(requests).toBe(1);
    const before = panel.length;
    chrome();
    c.observe(focus());
    expect(panel.length).toBe(before);
    expect(coordinator.tracker.epoch).toBe(0);
    const late = connect(2);
    expect(late.closed).toBe(true);
  });
});
