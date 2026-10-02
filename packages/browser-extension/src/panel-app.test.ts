// The side panel page end to end over the fake chrome: the real worker (background-core with
// its panel bridge and native port) and the real panel page (panel-app + panel/*), rendered in
// jsdom. The core is the test, speaking `panel` frames on the fake native port.
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { createBackground } from "./background-core.js";
import { createPanelApp } from "./panel-app.js";
import { chunks, F } from "./panel/test-frames.js";
import { activate, asChrome, type FakeChrome, fakeClock, flush, makeChrome } from "./test-fakes.js";
import { commandsPosted, corePolicy, lastPort } from "./test-harness.js";

const DOCS = "https://docs.example.com/*";
const ITEMS = [
  { candidateId: "c1", title: "Webhooks", reason: "You read about retries.", hostname: "docs.example.com" },
  { candidateId: "c2", title: "Testing", reason: "Covers the CLI.", hostname: "docs.example.com" },
];
const INSTANCE = "core-7f3a9c";
const caps = (over: Record<string, unknown> = {}) => ({ ...(F.raw("frame.capabilities.minimal.json") as object), ...over });

async function harness({ granted = [DOCS], host = "ok" as "ok" | "silent" | "missing", tab = "https://docs.example.com/guide" } = {}) {
  const f = makeChrome({ granted, host });
  f._.tabs.set(13, { id: 13, windowId: 1, active: false, url: tab, title: "Guide", incognito: false, index: 3 });
  activate(f, 13);
  const clock = fakeClock();
  const bg = createBackground(asChrome(f), { clock });
  await bg.start();
  await clock.advance(0);
  const dom = new JSDOM(`<!doctype html><body><p id="header-line"></p><div id="root"></div></body>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const time = { now: 0 };
  const app = createPanelApp({
    now: () => time.now,
    ch: asChrome(f),
    doc,
    root: doc.getElementById("root")!,
    setInterval: (fn, ms) => intervals.push({ fn, ms }),
    setTimeout: () => 0,
  });
  await app.start();
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await flush(4);
      await app.idle();
    }
    app.render();
  };
  await settle();
  const core = async (state: unknown) => {
    lastPort(f).onMessage.emit({ type: "panel", state });
    await settle();
  };
  const $ = (sel: string) => doc.querySelector<HTMLElement>(sel);
  const byKey = (k: string) => $(`[data-key="${k}"]`) as HTMLButtonElement | null;
  const click = async (k: string) => {
    const b = byKey(k);
    if (!b) throw new Error(`no ${k} in: ${doc.getElementById("root")!.textContent}`);
    b.click();
    await settle();
  };
  const text = () => doc.body.textContent ?? "";
  /** Moves the panel's clock on and runs its resend tick (pending expiry, resends). */
  const tick = async (ms: number) => {
    time.now += ms;
    for (const i of intervals) if (i.ms === 1000) i.fn();
    await settle();
  };
  return { f, bg, app, doc, dom, core, settle, $, byKey, click, text, intervals, clock, tick };
}

async function withResults(h: Awaited<ReturnType<typeof harness>>) {
  await h.core(F.raw("frame.grant.json"));
  await h.core(caps());
  await h.core({ type: "audit", entries: [] });
  await h.core({ type: "state", status: "idle", visitEpoch: 3, detail: "docs.example.com", permitted: true });
  await h.core({ type: "results", coreInstanceId: INSTANCE, visitEpoch: 3, origin: "https://docs.example.com", jobId: "job-3a", status: "ok", items: ITEMS });
}

const lastCommand = (f: FakeChrome) => commandsPosted(f).at(-1) as Record<string, unknown>;

describe("side panel page", () => {
  it("renders the results with labels, and a click opens only the ack's target in a new tab next to the current one", async () => {
    const h = await harness();
    await withResults(h);
    expect(h.$("#header-line")!.textContent).toBe("Idle · docs.example.com · 1 offer · 2 links");
    const open = h.byKey("open-c2")!;
    expect(open.getAttribute("aria-label")).toBe("Open Testing on docs.example.com");
    expect(h.text()).toContain("Covers the CLI.");
    expect(h.doc.body.innerHTML).not.toContain("https://docs.example.com/"); // no href before an ack

    await h.click("open-c2");
    const cmd = lastCommand(h.f);
    expect(cmd).toEqual({ type: "open_link", commandId: expect.stringMatching(/^sp-/), coreInstanceId: INSTANCE, visitEpoch: 3, jobId: "job-3a", candidateId: "c2" });
    expect(h.f._.created).toEqual([]);
    expect(h.byKey("open-c2")!.disabled).toBe(true);

    await h.core({ type: "ack", commandId: cmd["commandId"], ok: true, revision: 0, approvalRevision: 0, target: { href: "https://docs.example.com/testing" } });
    expect(h.f._.created).toEqual([{ url: "https://docs.example.com/testing", active: true, windowId: 1, openerTabId: 13, index: 4 }]);
    // The same ack again opens nothing more.
    await h.core({ type: "ack", commandId: cmd["commandId"], ok: true, revision: 0, approvalRevision: 0, target: { href: "https://docs.example.com/testing" } });
    expect(h.f._.created).toHaveLength(1);
    // The new tab is a new visit: the core's state clears the results.
    await h.core({ type: "state", status: "idle", visitEpoch: 4, detail: "docs.example.com", permitted: true });
    expect(h.byKey("open-c1")).toBeNull();
  });

  it("a target the panel would not open, a refused click, or a failed tab open opens nothing and offers Dismiss only", async () => {
    const h = await harness();
    await withResults(h);
    await h.click("open-c1");
    const id = lastCommand(h.f)["commandId"] as string;
    await h.core({ type: "ack", commandId: id, ok: true, revision: 0, approvalRevision: 0, target: { href: "https://evil.example/x" } });
    expect(h.f._.created).toEqual([]);
    expect(h.text()).toContain("the link pointed at another site");
    await h.click(`dismiss-${id}`);
    expect(h.text()).not.toContain("the link pointed at another site");

    await h.click("open-c1");
    const id2 = lastCommand(h.f)["commandId"] as string;
    await h.core({ type: "ack", commandId: id2, ok: false, code: "stale_revision" });
    expect(h.f._.created).toEqual([]);
    expect(h.byKey(`problem-retry-${id2}`)).toBeNull();

    // The site's tab went away: the new tab opens once more, plainly, in the panel's window.
    h.f._.state.createFails = "placed";
    await h.click("open-c2");
    const id4 = lastCommand(h.f)["commandId"] as string;
    await h.core({ type: "ack", commandId: id4, ok: true, revision: 0, approvalRevision: 0, target: { href: "https://docs.example.com/testing" } });
    expect(h.f._.created).toEqual([{ url: "https://docs.example.com/testing", active: true, windowId: 1 }]);
    expect(h.text()).not.toContain("Chrome could not open it");

    h.f._.state.createFails = true;
    await h.click("open-c2");
    const id3 = lastCommand(h.f)["commandId"] as string;
    await h.core({ type: "ack", commandId: id3, ok: true, revision: 0, approvalRevision: 0, target: { href: "https://docs.example.com/x" } });
    await h.click("nav-problems");
    expect(h.text()).toContain("Chrome could not open it");
    expect(h.byKey(`problem-dismiss-${id3}`)).not.toBeNull();
  });

  it("the host reporting the core gone reaches the panel's Problems as 'Scout isn't running'", async () => {
    const h = await harness();
    await withResults(h);
    lastPort(h.f).onMessage.emit({ type: "core_unavailable", reason: "unreachable" });
    await h.settle();
    expect(h.$("#header-line")!.textContent).toContain("Scout isn't running");
    expect(h.byKey("open-c1")).toBeNull();
    await h.click("nav-problems");
    expect(h.text()).toContain("Scout isn't running. Start the Scout app; the panel reconnects on its own.");
  });

  it("repaints at once from the worker's cache when the panel opens after the frames", async () => {
    const f = makeChrome({ granted: [DOCS] });
    const clock = fakeClock();
    await createBackground(asChrome(f), { clock }).start();
    await clock.advance(0);
    for (const s of [F.raw("frame.grant.json"), caps(), { type: "audit", entries: [] }, { type: "state", status: "idle", visitEpoch: 3, detail: "docs.example.com", permitted: true }])
      lastPort(f).onMessage.emit({ type: "panel", state: s });
    lastPort(f).onMessage.emit({ type: "panel", state: { type: "results", coreInstanceId: INSTANCE, visitEpoch: 3, origin: "https://docs.example.com", jobId: "job-3a", status: "ok", items: ITEMS } });
    await flush();
    expect(f._.state.badge).toBe("•");
    const dom = new JSDOM(`<!doctype html><body><p id="header-line"></p><div id="root"></div></body>`);
    const app = createPanelApp({ ch: asChrome(f), doc: dom.window.document, root: dom.window.document.getElementById("root")!, setInterval: () => 0, setTimeout: () => 0 });
    await app.start();
    for (let i = 0; i < 3; i++) {
      await flush(4);
      await app.idle();
    }
    app.render();
    expect(dom.window.document.querySelector('[data-key="open-c1"]')).not.toBeNull();
    expect(f._.state.badge).toBe("");
  });

  it("the link going down clears the results and says so", async () => {
    const h = await harness();
    await withResults(h);
    const p = lastPort(h.f);
    p.disconnected = true;
    p.onDisconnect.emit(p);
    await h.settle();
    expect(h.byKey("open-c1")).toBeNull();
    expect(h.$("#header-line")!.textContent).not.toContain("links");
  });

  it("an ungranted site says to click the icon and shows no URL; with activeTab, Allow requests the exact pattern", async () => {
    const h = await harness({ granted: [] });
    await h.click("nav-site");
    expect(h.text()).toContain("Click the Scout icon to check this site.");
    expect(h.text()).not.toContain("docs.example.com");
    h.f._.state.activeTabGrant = 13; // Chrome's grant for the toolbar click
    h.f.action.onClicked.emit({ id: 13, windowId: 1 } as chrome.tabs.Tab);
    await h.settle();
    expect(h.text()).toContain("Scout is not allowed on this site.");
    await h.click("site-allow");
    expect(h.f._.requested).toEqual([["https://docs.example.com/*"]]);
    expect(h.text()).toContain("Scout is allowed on this site.");
    await h.click("site-remove");
    expect(h.f._.removedPerms).toEqual([["https://docs.example.com/*"]]);
  });

  it("tab events from another window are ignored", async () => {
    const h = await harness({ granted: [] });
    h.f._.state.activeTabGrant = 13;
    h.f.tabs.onActivated.emit({ tabId: 99, windowId: 2 } as never);
    await h.settle();
    expect(h.app.site).toMatchObject({ kind: "unknown" });
  });

  it("Sites lists granted and core origins with Allow/Remove, and allows a typed site", async () => {
    const h = await harness({ granted: ["https://github.com/*"] });
    await h.core(caps({ origins: [{ origin: "https://docs.example.com", autoAcquire: false, permitted: false }] }));
    await h.click("nav-sites");
    expect(h.byKey("remove-github.com")!.getAttribute("aria-label")).toBe("Remove github.com");
    expect(h.byKey("allow-docs.example.com")!.getAttribute("aria-label")).toBe("Allow Scout on docs.example.com");
    await h.click("allow-docs.example.com");
    expect(h.f._.requested.at(-1)).toEqual(["https://docs.example.com/*"]);
    const input = h.$("#site-input") as HTMLInputElement;
    input.value = "docs.stripe.com";
    input.dispatchEvent(new h.dom.window.Event("input"));
    h.$("form.add-site")!.dispatchEvent(new h.dom.window.Event("submit", { cancelable: true }));
    await h.settle();
    expect(h.f._.requested.at(-1)).toEqual(["https://docs.stripe.com/*"]);
    expect(h.byKey("remove-docs.stripe.com")).not.toBeNull();
    input.value = "http://plain.example";
    (h.$("#site-input") as HTMLInputElement).value = "http://plain.example";
    h.$("form.add-site")!.dispatchEvent(new h.dom.window.Event("submit", { cancelable: true }));
    await h.settle();
    expect(h.text()).toContain("Only https sites can use Scout.");
    await h.click("remove-github.com");
    expect(h.f._.removedPerms.at(-1)).toEqual(["https://github.com/*"]);
  });

  it("preview before approval: chunks are assembled and hashed before Approve enables; Approve carries the version and revision", async () => {
    const h = await harness();
    await withResults(h);
    await h.click("nav-site");
    const key = { resourceId: `res_${"a".repeat(64)}`, version: "1".repeat(64) };
    const k = `${key.resourceId.slice(4, 16)}-${key.version.slice(0, 12)}`;
    await h.click(`preview-${k}`);
    const first = lastCommand(h.f);
    expect(first).toEqual({ type: "preview", commandId: expect.stringMatching(/^sp-/), resourceId: key.resourceId, version: key.version });
    expect(h.byKey(`approve-${k}`)!.disabled).toBe(true);
    const [c1, c2] = [F.raw("frame.preview.first.json") as Record<string, unknown>, F.raw("frame.preview.last.json") as Record<string, unknown>];
    await h.core({ ...c1, commandId: first["commandId"] });
    const second = lastCommand(h.f);
    expect(second).toMatchObject({ type: "preview", cursor: "cur_A-1" });
    expect(h.byKey(`approve-${k}`)!.disabled).toBe(true);
    await h.core({ ...c2, commandId: second["commandId"] });
    expect(h.byKey(`approve-${k}`)!.disabled).toBe(false);
    expect(h.text()).toContain("Complete and verified.");
    expect(h.text()).toContain("docs.example.com/llms.txt");
    expect(h.text()).toContain("117 bytes");
    await h.click(`approve-${k}`);
    expect(lastCommand(h.f)).toEqual({ type: "approve", commandId: expect.stringMatching(/^sp-/), resourceId: key.resourceId, version: key.version, expectedRevision: 1 });
    // Escape returns to Results; the preview stays put for when the user comes back.
    h.doc.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape" }));
    await h.settle();
    expect(h.byKey("nav-results")!.getAttribute("aria-current")).toBe("page");
    await h.click("nav-site");
    expect(h.$("#preview-pane")).not.toBeNull();
  });

  it("a tampered preview never enables Approve", async () => {
    const h = await harness();
    await withResults(h);
    await h.click("nav-site");
    const key = { resourceId: `res_${"a".repeat(64)}`, version: "1".repeat(64) };
    const k = `${key.resourceId.slice(4, 16)}-${key.version.slice(0, 12)}`;
    await h.click(`preview-${k}`);
    const [c] = chunks("not the real text", key, 1000);
    await h.core({ ...c, commandId: lastCommand(h.f)["commandId"], sha256: "f5f87631e2c65588499362cb033b1032a148944812890e2495605dc8a36efedf" });
    expect(h.byKey(`approve-${k}`)!.disabled).toBe(true);
    expect(h.text()).toContain("did not match its fingerprint");
  });

  it("auto-acquire asks for the acknowledgement first and carries expectedEnabled", async () => {
    const h = await harness();
    await withResults(h);
    await h.click("nav-site");
    const box = h.$("#auto-acquire") as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new h.dom.window.Event("change"));
    await h.settle();
    expect(commandsPosted(h.f).some((c) => c["type"] === "set_auto_acquire")).toBe(false);
    expect(h.$("[role=dialog]")).not.toBeNull();
    await h.click("sheet-confirm");
    expect(lastCommand(h.f)).toMatchObject({ type: "set_auto_acquire", origin: "https://docs.example.com", enabled: true, acknowledgeRisk: true, expectedEnabled: false });
  });

  it("Settings: Pause sends only the core's pause; agent context carries expectedEnabled", async () => {
    const h = await harness();
    await withResults(h);
    await h.click("nav-settings");
    expect(h.byKey("pause")!.textContent).toBe("Pause");
    await h.click("pause");
    expect(lastCommand(h.f)).toEqual({ type: "pause" });
    expect(h.f._.store["paused"]).toBeUndefined();
    expect(h.byKey("pause")!.textContent).toBe("Pausing…");
    await h.core({ type: "state", status: "paused" });
    expect(h.byKey("pause")!.textContent).toBe("Resume");
    await h.click("pause");
    expect(lastCommand(h.f)).toEqual({ type: "resume" });
    const ctx = h.$("#agent-context") as HTMLInputElement;
    expect(ctx.checked).toBe(true); // the grant fixture says on
    ctx.checked = false;
    ctx.dispatchEvent(new h.dom.window.Event("change"));
    await h.settle();
    expect(lastCommand(h.f)).toMatchObject({ type: "set_agent_browser_context", enabled: false, expectedEnabled: true });
  });

  it("paused in the panel, resumed from the Mac menu: the panel shows Pause again", async () => {
    const h = await harness();
    await withResults(h);
    await h.click("nav-settings");
    await h.click("pause");
    await h.core({ type: "state", status: "paused" });
    corePolicy(h.f, true);
    await h.settle();
    expect(h.byKey("pause")!.textContent).toBe("Resume");
    // The Mac menu resumes the core: the panel sent nothing.
    const sent = commandsPosted(h.f).length;
    corePolicy(h.f, false);
    await h.core({ type: "state", status: "idle", visitEpoch: 4, detail: "docs.example.com", permitted: true });
    expect(commandsPosted(h.f)).toHaveLength(sent);
    expect(h.byKey("pause")!.textContent).toBe("Pause");
    expect(h.byKey("pause")!.disabled).toBe(false);
  });

  it("paused from the Mac menu: the panel shows Resume and Results says Scout is paused", async () => {
    const h = await harness();
    await withResults(h);
    corePolicy(h.f, true);
    await h.core({ type: "state", status: "paused" });
    expect(commandsPosted(h.f)).toEqual([]);
    expect(h.text()).toContain("Scout is paused. Resume it to get links.");
    expect(h.byKey("open-c1")).toBeNull();
    await h.click("nav-settings");
    expect(h.byKey("pause")!.textContent).toBe("Resume");
    await h.click("pause");
    expect(lastCommand(h.f)).toEqual({ type: "resume" });
  });

  it("a core that starts paused: the panel opens on Resume and a paused Results", async () => {
    const f = makeChrome({ granted: [DOCS], host: "silent" });
    const clock = fakeClock();
    await createBackground(asChrome(f), { clock }).start();
    lastPort(f).onMessage.emit({ type: "capture_policy", revision: 1, paused: true, captureEnabled: true });
    lastPort(f).onMessage.emit({ type: "ready" });
    for (const s of [F.raw("frame.grant.json"), caps(), { type: "audit", entries: [] }, { type: "state", status: "paused" }])
      lastPort(f).onMessage.emit({ type: "panel", state: s });
    await clock.advance(0);
    expect(lastPort(f).posted).toEqual([]);
    const dom = new JSDOM(`<!doctype html><body><p id="header-line"></p><div id="root"></div></body>`);
    const doc = dom.window.document;
    const app = createPanelApp({ ch: asChrome(f), doc, root: doc.getElementById("root")!, setInterval: () => 0, setTimeout: () => 0 });
    await app.start();
    await flush(6);
    await app.idle();
    app.render();
    expect(doc.body.textContent).toContain("Scout is paused. Resume it to get links.");
    expect(app.model.pauseState.control).toMatchObject({ title: "Resume", enabled: true });
  });

  it("a pause no frame confirms settles back to the core's state after 10 s", async () => {
    const h = await harness();
    await withResults(h);
    await h.click("nav-settings");
    await h.click("pause");
    expect(lastCommand(h.f)).toEqual({ type: "pause" });
    await h.tick(9_999);
    expect(h.byKey("pause")!.textContent).toBe("Pausing…");
    expect(h.byKey("pause")!.disabled).toBe(true);
    await h.tick(1);
    expect(h.byKey("pause")!.textContent).toBe("Pause");
    expect(h.byKey("pause")!.disabled).toBe(false);
    expect(commandsPosted(h.f).filter((c) => c["type"] === "pause")).toHaveLength(1); // never re-sent
  });


  it("a command refused for now is re-sent under the same ID; a click refused for now fails with Dismiss only", async () => {
    const h = await harness();
    await withResults(h);
    await h.click("nav-site");
    const native = lastPort(h.f);
    native.disconnected = true; // postMessage throws, as on a port Chrome just closed
    const key = { resourceId: `res_${"a".repeat(64)}`, version: "1".repeat(64) };
    await h.click(`decline-offer-${key.resourceId.slice(4, 16)}-${key.version.slice(0, 12)}`);
    expect(commandsPosted(h.f).filter((c) => c["type"] === "decline")).toEqual([]);
    const declined = h.app.model.commands.records.find((r) => r.request.type === "decline")!;
    expect(declined).toMatchObject({ state: "pending", sent: false });
    native.disconnected = false;
    h.intervals.find((i) => i.ms === 1000)!.fn();
    await h.settle();
    const sent = commandsPosted(h.f).filter((c) => c["type"] === "decline");
    expect(sent).toEqual([{ type: "decline", commandId: declined.id, resourceId: key.resourceId, version: key.version, expectedRevision: 1 }]);

    native.disconnected = true;
    await h.click("nav-results");
    await h.click("open-c1");
    native.disconnected = false;
    h.intervals.find((i) => i.ms === 1000)!.fn();
    await h.settle();
    expect(commandsPosted(h.f).filter((c) => c["type"] === "open_link")).toEqual([]);
    expect(h.text()).toContain("Couldn't open it");
  });

  it("posts a heartbeat on its port every 15 s", async () => {
    const h = await harness();
    const hb = h.intervals.find((i) => i.ms === 15_000)!;
    expect(hb).toBeDefined();
    const worker = h.f._.panelPorts.at(-1)!;
    const n = worker.peer!.posted.length;
    hb.fn();
    expect(worker.peer!.posted.slice(n)).toEqual([{ type: "hb" }]);
  });
});
