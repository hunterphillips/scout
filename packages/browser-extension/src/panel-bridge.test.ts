// The worker's side of the side panel: the panel port, the frame cache, the badge, the
// toolbar behaviour, and the panel's requests (commands, pause, the current site).
import { describe, expect, it } from "vitest";
import { createBackground } from "./background-core.js";
import { PANEL_PORT_NAME, type StatusSnapshot, type WorkerToPanel } from "./messages.js";
import { BADGE_TEXT } from "./panel-bridge.js";
import { F } from "./panel/test-frames.js";
import { activate, asChrome, EXT_ID, type FakeChrome, fakeClock, flush, makeChrome } from "./test-fakes.js";
import { commandsPosted, dropPort, lastPort, setup } from "./test-harness.js";

const GRANT = F.frame("frame.grant.json");
const CAPS = F.frame("frame.capabilities.minimal.json");
const AUDIT = F.frame("frame.audit.json");
const STATE_IDLE = { type: "state", status: "idle", visitEpoch: 3, detail: "docs.example.com", permitted: true } as const;
const RESULTS = F.frame("frame.results.ok.json");
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
  return { port, got, request, frames: () => got.filter((m) => m.type === "frame").map((m) => (m as { state: { type: string } }).state) };
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
  it("results ok with no panel open sets a dot; a state frame clears it", async () => {
    const { f } = await setup();
    frame(f, STATE_IDLE);
    frame(f, RESULTS);
    await flush();
    expect(f._.state.badge).toBe(BADGE_TEXT);
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

  it("other results never set it; a panel connecting clears it", async () => {
    const { f } = await setup();
    frame(f, F.frame("frame.results.empty.json"));
    frame(f, F.frame("frame.results.error.json"));
    await flush();
    expect(f._.state.badge).toBe("");
    frame(f, RESULTS);
    await flush();
    expect(f._.state.badge).toBe(BADGE_TEXT);
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
    expect(f._.state.badge).toBe(BADGE_TEXT);
    dropPort(f);
    await flush();
    expect(f._.state.badge).toBe("");
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
    // frontmost and shutdown are not relay commands: refused before the port.
    expect(await p.request({ type: "command", command: { type: "shutdown" } })).toEqual({ written: false });
    expect(commandsPosted(f)).toEqual([cmd]);
  });

  it("pause pauses the extension and the core; resume tells the core first", async () => {
    const { f } = await setup();
    const p = await openPanel(f);
    const r = (await p.request({ type: "pause", paused: true })) as { status: StatusSnapshot; written: boolean };
    expect(r.written).toBe(true);
    expect(r.status.paused).toBe(true);
    expect(f._.store["paused"]).toBe(true);
    const posted = lastPort(f).posted;
    const focusLost = posted.findIndex((m) => m["kind"] === "focus" && m["browserFocused"] === false);
    const pause = posted.findIndex((m) => m["type"] === "command");
    expect(focusLost).toBeGreaterThan(-1);
    expect(pause).toBeGreaterThan(focusLost);
    expect(commandsPosted(f)).toEqual([{ type: "pause" }]);
    const before = posted.length;
    const r2 = (await p.request({ type: "pause", paused: false })) as { status: StatusSnapshot; written: boolean };
    expect(r2).toMatchObject({ written: true, status: { paused: false } });
    expect(posted[before]).toEqual({ type: "command", command: { type: "resume" } });
    expect(posted[before + 1]).toMatchObject({ kind: "permissions" });
  });

  it("pause with no core to reach still pauses the extension", async () => {
    const { f } = await setup({ host: "missing" });
    const p = await openPanel(f);
    expect(await p.request({ type: "pause", paused: true })).toMatchObject({ written: false, status: { paused: true } });
  });

  it("the current site: only an origin, and only for a tab whose URL Chrome shows", async () => {
    const { f } = await setup({ granted: ["https://github.com/*"] });
    const p = await openPanel(f);
    // Tab 10 (github.com issue, granted): the origin only, never the path.
    const granted = await p.request({ type: "site", windowId: 1 });
    expect(granted).toEqual({ kind: "ok", origin: "https://github.com", pattern: "https://github.com/*", host: "github.com", tabId: 10, index: 0 });
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

  it("GitHub capture and Reconnect answer with the status", async () => {
    const { f } = await setup({ granted: ["https://github.com/*"] });
    const p = await openPanel(f);
    expect(await p.request({ type: "github-capture", enabled: true })).toMatchObject({ githubCapture: true });
    expect(await p.request({ type: "reconnect" })).toMatchObject({ link: expect.any(String) });
    expect(await p.request({ type: "status" })).toMatchObject({ granted: ["https://github.com/*"] });
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
