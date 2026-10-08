// The worker's side of the side panel: the panel port, the frame cache, the badge, the
// toolbar behaviour, and the panel's requests (commands, pause, the current site).
import { describe, expect, it } from "vitest";
import { createBackground } from "./background-core.js";
import { PANEL_PORT_NAME, type StatusSnapshot, type WorkerToPanel } from "./messages.js";
import { FILES_BADGE_COLOR, ICON_PATHS, LINKS_BADGE_COLOR, PAUSED_ICON_PATHS } from "./panel-bridge.js";
import { F } from "./panel/test-frames.js";
import { activate, asChrome, EXT_ID, type FakeChrome, fakeClock, flush, makeChrome } from "./test-fakes.js";
import { approve, commandsPosted, corePolicy, dropPort, lastPort, pageText, setup } from "./test-harness.js";

const GRANT = F.frame("frame.grant.json");
const CAPS = F.frame("frame.capabilities.minimal.json");
const AUDIT = F.frame("frame.audit.json");
const STATE_IDLE = { type: "state", status: "idle", visitEpoch: 3, detail: "docs.example.com", permitted: true } as const;
const RESULTS = F.frame("frame.results.ok.json");
/** The fixture's two links, as the badge counts them. */
const LINKS = "2";
const ACK = F.frame("frame.ack.ok-target.json");
const PREVIEW = F.frame("frame.preview.first.json");

/** The core sends one window frame over the native port, as the host relays it. */
const frame = (f: FakeChrome, state: unknown) => lastPort(f).onMessage.emit({ type: "panel", state });

/** Opens the panel page's port; returns what it received and a request helper. */
async function openPanel(f: FakeChrome, sender?: chrome.runtime.MessageSender) {
  const port = f.runtime.connect({ name: PANEL_PORT_NAME }, sender) as unknown as { onMessage: { addListener(fn: (m: unknown) => void): void }; postMessage(m: unknown): void; disconnect(): void; disconnected: boolean };
  const got: WorkerToPanel[] = [];
  port.onMessage.addListener((m) => got.push(m as WorkerToPanel));
  await flush();
  let id = 0;
  const request = async (req: unknown) => {
    const n = ++id;
    port.postMessage({ type: "request", id: n, request: req });
    for (let i = 0; i < 20; i++) {
      await flush();
      const r = got.find((m) => m.type === "reply" && m.id === n);
      if (r && r.type === "reply") return r.result;
    }
    throw new Error("no reply");
  };
  return {
    port,
    got,
    request,
    frames: () => got.filter((m) => m.type === "frame").map((m) => (m as { state: { type: string } }).state),
    get statuses() {
      return got.filter((m) => m.type === "status").map((m) => (m as { status: StatusSnapshot }).status);
    },
  };
}

async function repainted() {
  const g = await setup();
  for (const s of [GRANT, CAPS, AUDIT, STATE_IDLE, RESULTS]) frame(g.f, s);
  await flush();
  return g;
}

describe("toolbar and panel port", () => {
  it("the toolbar click opens the side panel from onClicked (so activeTab is granted) and asks open panels to recheck their site", async () => {
    const { f } = await setup();
    expect(f._.state.panelBehavior).toEqual({ openPanelOnActionClick: false });
    await Promise.all(f.runtime.onInstalled.emit({}));
    expect(f._.state.panelBehavior).toEqual({ openPanelOnActionClick: false });
    const p = await openPanel(f);
    frame(f, RESULTS);
    await flush();
    f.action.onClicked.emit({ id: 12, windowId: 1 } as chrome.tabs.Tab);
    await flush();
    expect(f._.state.opened).toEqual([{ windowId: 1 }]);
    expect(p.got.at(-1)).toEqual({ type: "site-check" });
    expect(f._.state.badge).toBe("");
  });

  it("the click closes the panel in a window whose panel port reported it, and opens it again once that port is gone", async () => {
    const { f } = await setup();
    const p = await openPanel(f);
    p.port.postMessage({ type: "window", windowId: 1 });
    await flush();
    f.action.onClicked.emit({ id: 12, windowId: 1 } as chrome.tabs.Tab);
    await flush();
    expect(f._.state.closed).toEqual([{ windowId: 1 }]);
    expect(f._.state.opened).toEqual([]);
    p.port.disconnect(); // Chrome closed the panel: its port goes, as with the panel's own X
    await flush();
    f.action.onClicked.emit({ id: 12, windowId: 1 } as chrome.tabs.Tab);
    await flush();
    expect(f._.state.opened).toEqual([{ windowId: 1 }]);
    expect(f._.state.closed).toHaveLength(1);
  });

  it("the click opens where Chrome has no sidePanel.close (before 141), even over an open panel", async () => {
    const { f } = await setup();
    delete (f.sidePanel as { close?: unknown }).close;
    const p = await openPanel(f);
    p.port.postMessage({ type: "window", windowId: 1 });
    await flush();
    f.action.onClicked.emit({ id: 12, windowId: 1 } as chrome.tabs.Tab);
    await flush();
    expect(f._.state.opened).toEqual([{ windowId: 1 }]);
    expect(f._.state.closed).toEqual([]);
  });

  it("windows are independent: a panel open in one window never closes another's", async () => {
    const { f } = await setup();
    const one = await openPanel(f);
    one.port.postMessage({ type: "window", windowId: 1 });
    const two = await openPanel(f);
    two.port.postMessage({ type: "window", windowId: 2 });
    await flush();
    f.action.onClicked.emit({ id: 30, windowId: 3 } as chrome.tabs.Tab);
    await flush();
    expect(f._.state.opened).toEqual([{ windowId: 3 }]);
    f.action.onClicked.emit({ id: 20, windowId: 2 } as chrome.tabs.Tab);
    await flush();
    expect(f._.state.closed).toEqual([{ windowId: 2 }]);
    two.port.disconnect();
    await flush();
    f.action.onClicked.emit({ id: 20, windowId: 2 } as chrome.tabs.Tab);
    f.action.onClicked.emit({ id: 12, windowId: 1 } as chrome.tabs.Tab);
    await flush();
    expect(f._.state.opened).toEqual([{ windowId: 3 }, { windowId: 2 }]);
    expect(f._.state.closed).toEqual([{ windowId: 2 }, { windowId: 1 }]);
  });

  it("a panel port that never reported its window counts as closed: the click opens", async () => {
    const { f, bg } = await setup();
    await openPanel(f);
    expect(bg.panel.openPanels).toBe(1);
    f.action.onClicked.emit({ id: 12, windowId: 1 } as chrome.tabs.Tab);
    await flush();
    expect(f._.state.opened).toEqual([{ windowId: 1 }]);
    expect(f._.state.closed).toEqual([]);
  });

  it("panel.html in a tab, or a malformed window report, never makes the click close", async () => {
    const { f } = await setup();
    const inTab = await openPanel(f, { id: EXT_ID, url: `chrome-extension://${EXT_ID}/panel.html`, tab: { id: 40, windowId: 1 } as chrome.tabs.Tab });
    inTab.port.postMessage({ type: "window", windowId: 1 });
    const odd = await openPanel(f);
    odd.port.postMessage({ type: "window", windowId: "1" });
    odd.port.postMessage({ type: "window", windowId: 1.5 });
    await flush();
    f.action.onClicked.emit({ id: 12, windowId: 1 } as chrome.tabs.Tab);
    await flush();
    expect(f._.state.opened).toEqual([{ windowId: 1 }]);
    expect(f._.state.closed).toEqual([]);
  });

  it("a panel that connects gets the status, then the cached frames in repaint order, at once", async () => {
    const { f } = await repainted();
    frame(f, ACK);
    frame(f, PREVIEW);
    const p = await openPanel(f);
    expect(p.got[0]).toMatchObject({ type: "status", status: { link: "connected" } });
    expect(p.frames()).toEqual([GRANT, CAPS, AUDIT, STATE_IDLE, RESULTS]); // never an ack or a preview chunk
  });

  it("refuses a port that is not the panel page", async () => {
    const { f, bg } = await repainted();
    const content = await openPanel(f, { id: EXT_ID, url: "https://docs.example.com/page", tab: { id: 10 } as chrome.tabs.Tab });
    expect(content.got).toEqual([]);
    expect(content.port.disconnected).toBe(true);
    const other = await openPanel(f, { id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", url: `chrome-extension://${EXT_ID}/panel.html` });
    expect(other.got).toEqual([]);
    expect(bg.panel.openPanels).toBe(0);
  });

  it("relays every frame to the open panel, acks and preview chunks included, and forgets the panel when it closes", async () => {
    const { f, bg } = await setup();
    const p = await openPanel(f);
    frame(f, GRANT);
    frame(f, ACK);
    frame(f, PREVIEW);
    await flush();
    expect(p.frames()).toEqual([GRANT, ACK, PREVIEW]);
    expect(bg.panel.openPanels).toBe(1);
    p.port.disconnect();
    await flush();
    expect(bg.panel.openPanels).toBe(0);
  });

  it("an invalid panel frame never reaches the panel", async () => {
    const { f } = await setup();
    const p = await openPanel(f);
    frame(f, { type: "results", status: "ok", items: [], href: "https://evil.example/" });
    await flush();
    expect(p.frames()).toEqual([]);
  });

  it("a heartbeat gets no answer and changes nothing", async () => {
    const { f } = await setup();
    const p = await openPanel(f);
    const n = p.got.length;
    p.port.postMessage({ type: "hb" });
    await flush();
    expect(p.got).toHaveLength(n);
  });
});

describe("cache", () => {
  it("keeps the last of grant, capabilities, audit, state and results only; a state frame drops the results", async () => {
    const { bg, f } = await repainted();
    expect(bg.panel.cached()).toEqual([GRANT, CAPS, AUDIT, STATE_IDLE, RESULTS]);
    const working = { type: "state", status: "working", visitEpoch: 4, jobId: "job-4" };
    frame(f, working);
    expect(bg.panel.cached()).toEqual([GRANT, CAPS, AUDIT, working]);
  });

  it("is emptied when the native port is lost; the panel hears the link is down, never a stale result", async () => {
    const { f, bg } = await repainted();
    const p = await openPanel(f);
    dropPort(f);
    await flush();
    expect(bg.panel.cached()).toEqual([]);
    expect(p.got.at(-1)).toMatchObject({ type: "status", status: { link: expect.not.stringMatching(/^connected$/) } });
    const late = await openPanel(f);
    expect(late.frames()).toEqual([]);
  });

  it("never writes a frame to chrome.storage", async () => {
    const { f } = await repainted();
    const all = JSON.stringify({ local: f._.store, session: f._.session });
    expect(all).not.toContain("results");
    expect(all).not.toContain("Webhooks");
    expect(all).not.toContain("capabilities");
  });
});

describe("badge", () => {
  it("results ok with no panel open sets the link count in blue; a state frame clears it", async () => {
    const { f } = await setup();
    frame(f, STATE_IDLE);
    frame(f, RESULTS);
    await flush();
    expect(f._.state.badge).toBe(LINKS);
    expect(f._.state.badgeColor).toBe(LINKS_BADGE_COLOR);
    frame(f, { type: "state", status: "idle", visitEpoch: 4 });
    await flush();
    expect(f._.state.badge).toBe("");
  });

  it("no dot while Chrome reports a side panel context, or a panel port is connected", async () => {
    const { f } = await setup();
    f._.state.sidePanels = 1;
    frame(f, RESULTS);
    await flush();
    expect(f._.state.badge).toBe("");
    f._.state.sidePanels = 0;
    await openPanel(f);
    frame(f, RESULTS);
    await flush();
    expect(f._.state.badge).toBe("");
  });

  it("a panel that connects while Chrome is still being asked gets no dot", async () => {
    const { f } = await setup();
    let answer: (c: unknown[]) => void = () => {};
    f.runtime.getContexts = (() => new Promise((r) => (answer = r))) as never;
    frame(f, RESULTS);
    await flush();
    await openPanel(f); // connects before getContexts answers
    answer([]); // Chrome's answer predates the panel
    await flush();
    expect(f._.state.badge).toBe("");
  });

  it("other results never set it; a panel connecting clears it", async () => {
    const { f } = await setup();
    frame(f, F.frame("frame.results.empty.json"));
    frame(f, F.frame("frame.results.error.json"));
    await flush();
    expect(f._.state.badge).toBe("");
    frame(f, RESULTS);
    await flush();
    expect(f._.state.badge).toBe(LINKS);
    await openPanel(f);
    await flush();
    expect(f._.state.badge).toBe("");
  });

  it("without runtime.getContexts it falls back to the panel ports; the native port's loss clears it", async () => {
    const f = makeChrome({ getContexts: false });
    const clock = fakeClock();
    await createBackground(asChrome(f), { clock }).start();
    await clock.advance(0);
    frame(f, RESULTS);
    await flush();
    expect(f._.state.badge).toBe(LINKS);
    dropPort(f);
    await flush();
    expect(f._.state.badge).toBe("");
  });

  it("files to review for the current visit set their count in amber; links win; a panel or the icon marks them seen", async () => {
    const { f } = await setup();
    frame(f, CAPS); // one offer on docs.example.com
    await flush();
    expect(f._.state.badge).toBe(""); // no visit yet
    frame(f, STATE_IDLE);
    await flush();
    expect([f._.state.badge, f._.state.badgeColor]).toEqual(["1", FILES_BADGE_COLOR]);
    frame(f, RESULTS);
    await flush();
    expect([f._.state.badge, f._.state.badgeColor]).toEqual([LINKS, LINKS_BADGE_COLOR]);
    // The icon click shows the panel: the same offers set no badge again, on any later frame.
    f.action.onClicked.emit({ id: 12, windowId: 1 } as chrome.tabs.Tab);
    await flush();
    expect(f._.state.badge).toBe("");
    frame(f, { ...STATE_IDLE, visitEpoch: 4 });
    frame(f, CAPS);
    await flush();
    expect(f._.state.badge).toBe("");
    // A new version is a new file to review.
    const caps = CAPS as Extract<typeof CAPS, { type: "capabilities" }>;
    frame(f, { ...caps, revision: 2, offers: [{ ...caps.offers[0]!, version: F.v2 }] });
    await flush();
    expect([f._.state.badge, f._.state.badgeColor]).toEqual(["1", FILES_BADGE_COLOR]);
    // Offers on another site, or a visit Chrome does not permit, set nothing.
    frame(f, { type: "state", status: "idle", visitEpoch: 5, detail: "other.example", permitted: true });
    await flush();
    expect(f._.state.badge).toBe("");
    frame(f, { ...STATE_IDLE, visitEpoch: 6, permitted: false });
    await flush();
    expect(f._.state.badge).toBe("");
  });

  it("offers that arrive while a panel is open set no badge after it closes", async () => {
    const { f } = await setup();
    const p = await openPanel(f);
    frame(f, STATE_IDLE);
    frame(f, CAPS);
    await flush();
    expect(f._.state.badge).toBe("");
    p.port.disconnect();
    await flush();
    frame(f, CAPS);
    await flush();
    expect(f._.state.badge).toBe("");
  });

  it("a paused core swaps in the grey paused icon; any other state or the port's loss puts the mark back", async () => {
    const { f } = await setup();
    expect(f._.state.icon).toBeNull(); // the manifest's icon until something changes
    frame(f, { type: "state", status: "paused" });
    await flush();
    expect(f._.state.icon).toEqual(PAUSED_ICON_PATHS);
    expect(f._.state.badge).toBe("");
    frame(f, STATE_IDLE);
    await flush();
    expect(f._.state.icon).toEqual(ICON_PATHS);
    frame(f, { type: "state", status: "paused" });
    await flush();
    expect(f._.state.icon).toEqual(PAUSED_ICON_PATHS);
    dropPort(f);
    await flush();
    expect(f._.state.icon).toEqual(ICON_PATHS);
  });

  it("Chrome's sidePanel.onOpened (where present) clears it", async () => {
    const { f } = await setup();
    frame(f, RESULTS);
    await flush();
    f.sidePanel.onOpened.emit({} as never);
    await flush();
    expect(f._.state.badge).toBe("");
  });
});

describe("panel requests", () => {
  it("a command goes to the core on a ready port, never queued before one", async () => {
    const { f } = await setup({ host: "silent" });
    const p = await openPanel(f);
    const cmd = { type: "refresh_capabilities", commandId: "sp-AAAAAAAAAAAAAAAAAAAAAA" };
    expect(await p.request({ type: "command", command: cmd })).toEqual({ written: false });
    expect(commandsPosted(f)).toEqual([]);
    lastPort(f).onMessage.emit({ type: "capture_policy", revision: 1, paused: false, captureEnabled: false });
    lastPort(f).onMessage.emit({ type: "ready" });
    expect(await p.request({ type: "command", command: cmd })).toEqual({ written: true });
    expect(commandsPosted(f)).toEqual([cmd]);
    // frontmost and shutdown are not relay commands: refused before the port, as invalid.
    expect(await p.request({ type: "command", command: { type: "shutdown" } })).toEqual({ written: false, invalid: true });
    expect(commandsPosted(f)).toEqual([cmd]);
  });

  it("pause and resume send only the core's command; the status follows the core's policy", async () => {
    const { f } = await setup();
    const p = await openPanel(f);
    const r = (await p.request({ type: "pause", paused: true })) as { status: StatusSnapshot; written: boolean };
    expect(r).toMatchObject({ written: true, status: { paused: false } });
    expect(commandsPosted(f)).toEqual([{ type: "pause" }]);
    expect(lastPort(f).posted.at(-1)).toEqual({ type: "command", command: { type: "pause" } });
    corePolicy(f, true);
    await flush();
    expect(p.statuses.at(-1)).toMatchObject({ paused: true });
    const r2 = (await p.request({ type: "pause", paused: false })) as { status: StatusSnapshot; written: boolean };
    expect(r2).toMatchObject({ written: true, status: { paused: true } });
    expect(commandsPosted(f)).toEqual([{ type: "pause" }, { type: "resume" }]);
    corePolicy(f, false);
    await flush();
    expect(p.statuses.at(-1)).toMatchObject({ paused: false });
  });

  it("pause with no core to reach sends nothing", async () => {
    const { f } = await setup({ host: "missing" });
    const p = await openPanel(f);
    expect(await p.request({ type: "pause", paused: true })).toMatchObject({ written: false, status: { paused: false } });
  });

  it("the current site: only an origin, and only for a tab whose URL Chrome shows", async () => {
    const { f } = await setup({ granted: ["https://tracker.example/*"] });
    const p = await openPanel(f);
    // Tab 10 (tracker issue, granted): the origin only, never the path.
    const granted = await p.request({ type: "site", windowId: 1 });
    expect(granted).toEqual({ kind: "ok", origin: "https://tracker.example", pattern: "https://tracker.example/*", host: "tracker.example", tabId: 10, index: 0 });
    expect(JSON.stringify(granted)).not.toContain("/issues");
    // Tab 12 (example.com, not granted): unknown until the toolbar click's activeTab grant.
    activate(f, 12);
    expect(await p.request({ type: "site", windowId: 1 })).toEqual({ kind: "unknown", tabId: 12, index: 2 });
    f._.state.activeTabGrant = 12;
    expect(await p.request({ type: "site", windowId: 1 })).toMatchObject({ kind: "ok", origin: "https://example.com", pattern: "https://example.com/*" });
    // Another window, an incognito tab, a browser page.
    expect(await p.request({ type: "site", windowId: 2 })).toEqual({ kind: "none" });
    f._.tabs.get(12)!.incognito = true;
    expect(await p.request({ type: "site", windowId: 1 })).toMatchObject({ kind: "refused", reason: "incognito" });
    f._.tabs.get(12)!.incognito = false;
    f._.tabs.get(12)!.url = "chrome://extensions/";
    expect(await p.request({ type: "site", windowId: 1 })).toMatchObject({ kind: "refused", reason: "internal" });
  });

  it("Reconnect answers with the status", async () => {
    const { f } = await setup({ granted: ["https://tracker.example/*"] });
    const p = await openPanel(f);
    expect(await p.request({ type: "reconnect" })).toMatchObject({ link: expect.any(String) });
    expect(await p.request({ type: "status" })).toMatchObject({ granted: ["https://tracker.example/*"] });
  });

  it("a grant change pushes the status to open panels", async () => {
    const { f } = await setup({ granted: [] });
    const p = await openPanel(f);
    f._.state.granted = ["https://docs.stripe.com/*"];
    await Promise.all(f.permissions.onAdded.emit({ origins: ["https://docs.stripe.com/*"] } as never));
    await flush();
    expect(p.got.filter((m) => m.type === "status").at(-1)).toMatchObject({ status: { granted: ["https://docs.stripe.com/*"] } });
  });
});

describe("Settings counters reach open panels", () => {
  it("issue text forwarded to the core is pushed to an open panel without a request, once per change", async () => {
    const { f, bg } = await setup();
    const p = await openPanel(f);
    const n = p.statuses.length;
    expect((await approve(bg, f)).approved).toBe(true);
    expect(await pageText(bg, f)).toEqual({ ok: true });
    await flush();
    expect(p.statuses.at(-1)!.counters.forwarded).toBe(1);
    lastPort(f).onMessage.emit({ type: "ack", seq: 1 });
    lastPort(f).onMessage.emit({ type: "ack", seq: 2 });
    await flush();
    expect(p.statuses.at(-1)!.counters).toMatchObject({ forwarded: 1, acked: 2 });
    // Two acks in one tick: one push for both.
    expect(p.statuses.slice(n).map((s) => s.counters.acked)).toEqual([0, 2]);
  });
});

describe("link changes reach open panels at once", () => {
  /** Status messages the worker has posted to the open panel (synchronous: the worker's side). */
  const pushed = (f: FakeChrome) =>
    (f._.panelPorts.at(-1)!.posted as WorkerToPanel[]).filter((m) => m.type === "status").map((m) => (m as { status: StatusSnapshot }).status.link);

  it("core_unavailable from the host is pushed in the same tick, and the port coming back ready too", async () => {
    const { f } = await setup();
    await openPanel(f);
    const n = pushed(f).length;
    lastPort(f).onMessage.emit({ type: "core_unavailable" });
    expect(pushed(f).slice(n)).toEqual(["core_unavailable"]); // no await: synchronous
    lastPort(f).onMessage.emit({ type: "ready" });
    expect(pushed(f).slice(n)).toEqual(["core_unavailable", "connected"]);
    lastPort(f).onMessage.emit({ type: "ready" }); // no change, no push
    expect(pushed(f).slice(n)).toHaveLength(2);
  });

  it("a lost port, each retry, and the series giving up are pushed", async () => {
    const { f, clock } = await setup();
    await openPanel(f);
    const n = pushed(f).length;
    f._.state.host = "missing";
    dropPort(f);
    expect(pushed(f).slice(n)).toEqual(["connecting"]); // a retry is scheduled
    await clock.advance(120_000); // every retry fails until the series is exhausted
    expect(pushed(f).at(-1)).toBe("disconnected");
    f._.state.host = "ok";
    const p = await openPanel(f);
    await p.request({ type: "reconnect" });
    await clock.advance(0);
    expect(pushed(f).at(-1)).toBe("connected");
  });

  it("pause never touches storage: it answers when storage refuses writes", async () => {
    const { f } = await setup();
    const p = await openPanel(f);
    f._.state.storageSetFails = true;
    expect(await p.request({ type: "pause", paused: true })).toMatchObject({ written: true });
    expect(commandsPosted(f)).toEqual([{ type: "pause" }]);
  });

});
