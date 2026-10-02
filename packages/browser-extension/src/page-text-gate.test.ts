import { BrowserObservationSchema } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import { GITHUB_PATTERN } from "./hosts.js";
import { APPROVAL_TTL_MS, createPageTextGate } from "./page-text-gate.js";
import { createSharedState, newCounters } from "./shared-state.js";
import { activate, EXT_ID, fakeClock, popupSender } from "./test-fakes.js";
import { approve, ISSUE1, ISSUE2, observations, pageText, setup } from "./test-harness.js";

describe("page_text gate (through the background)", () => {
  it("forwards when the sender tab is the active tab of the focused window and its URL equals the message URL; attaches documentId", async () => {
    const { f, bg } = await setup();
    // sender.url is stale (the document's first URL); the tab URL is current.
    expect(await approve(bg, f, { url: "https://github.com/acme/widgets" })).toEqual({ approved: true });
    expect(await pageText(bg, f, { url: "https://github.com/acme/widgets", documentId: "doc-1" })).toEqual({ ok: true });
    const obs = observations(f, "page_text");
    expect(obs).toEqual([
      { kind: "page_text", seq: expect.any(Number), at: expect.any(Number), tabId: 10, documentId: "doc-1", url: ISSUE1, source: "github_issue", title: "One", text: "body", truncated: false, policyRevision: 2 },
    ]);
    expect(BrowserObservationSchema.safeParse(obs[0]).success).toBe(true);
  });

  it("stamps page text with the latest capture_policy revision the port received", async () => {
    const { f, bg } = await setup();
    f._.ports.at(-1)!.onMessage.emit({ type: "capture_policy", revision: 7, paused: false, captureEnabled: true });
    expect((await approve(bg, f)).approved).toBe(true);
    expect(await pageText(bg, f)).toEqual({ ok: true });
    const obs = observations(f, "page_text");
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ policyRevision: 7 });
    expect(BrowserObservationSchema.safeParse(obs[0]).success).toBe(true);
  });

  it("denies a subframe, an incognito sender, and a non-GitHub sender.url", async () => {
    const { f, bg } = await setup();
    expect(await approve(bg, f, { frameId: 1 })).toEqual({ approved: false, reason: "sender" });
    expect(await approve(bg, f, { url: "https://evil.example/acme/widgets/issues/1" })).toEqual({ approved: false, reason: "sender" });
    f._.tabs.get(10)!.incognito = true;
    expect(await approve(bg, f)).toEqual({ approved: false, reason: "sender" });
    expect(bg.approvals.size).toBe(0);
  });

  it("drops text from a background tab (issues loading in background tabs are never forwarded)", async () => {
    const { f, bg } = await setup();
    expect(await approve(bg, f, { tabId: 11 }, 3, ISSUE2)).toEqual({ approved: false, reason: "not-foreground" });
    expect(await pageText(bg, f, { tabId: 11 }, 3, ISSUE2)).toMatchObject({ ok: false });
    expect(observations(f, "page_text")).toEqual([]);
  });

  it("drops text when the tab switched away between approval and send", async () => {
    const { f, bg } = await setup();
    expect((await approve(bg, f)).approved).toBe(true);
    activate(f, 11);
    expect(await pageText(bg, f)).toMatchObject({ ok: false });
    expect(observations(f, "page_text")).toEqual([]);
  });

  it("drops text when the browser window is not focused", async () => {
    const { f, bg } = await setup();
    expect((await approve(bg, f)).approved).toBe(true);
    f._.windows.get(1)!.focused = false;
    expect(await pageText(bg, f)).toEqual({ ok: false, reason: "not-foreground" });
  });

  it("drops text when the browser loses focus (onFocusChanged -1) between approval and send", async () => {
    const { f, bg } = await setup();
    expect((await approve(bg, f)).approved).toBe(true);
    await Promise.all(f.windows.onFocusChanged.emit(-1 as never));
    expect(bg.approvals.size).toBe(0);
    expect(await pageText(bg, f)).toEqual({ ok: false, reason: "no-approval" });
    expect(observations(f, "page_text")).toEqual([]);
  });

  it("tabs.onRemoved clears the tab's approval", async () => {
    const { f, bg } = await setup();
    expect((await approve(bg, f)).approved).toBe(true);
    expect(bg.approvals.has(10)).toBe(true);
    f.tabs.onRemoved.emit(10 as never, {} as never);
    expect(bg.approvals.has(10)).toBe(false);
  });

  it("drops text when the tab's current URL no longer equals the message URL", async () => {
    const { f, bg } = await setup();
    expect((await approve(bg, f)).approved).toBe(true);
    f._.tabs.get(10)!.url = ISSUE2; // SPA-navigated on
    expect(await pageText(bg, f)).toMatchObject({ ok: false, reason: "url-changed" });
    expect(observations(f, "page_text")).toEqual([]);
  });

  it("drops text from another document or a different navCounter than approved", async () => {
    const { f, bg } = await setup();
    await approve(bg, f, { documentId: "doc-1" });
    expect(await pageText(bg, f, { documentId: "doc-2" })).toEqual({ ok: false, reason: "document-changed" });
    await approve(bg, f, {}, 3);
    expect(await pageText(bg, f, {}, 4)).toEqual({ ok: false, reason: "stale" });
    expect(await pageText(bg, f)).toEqual({ ok: false, reason: "no-approval" });
  });

  it("drops text sent without an approval", async () => {
    const { f, bg } = await setup();
    expect(await pageText(bg, f)).toEqual({ ok: false, reason: "no-approval" });
  });

  it("a pause landing during the approval's awaits cancels it (cancel epoch)", async () => {
    const { f, bg } = await setup();
    const orig = f.windows.get;
    f.windows.get = async (id) => {
      await bg.handleMessage({ type: "popup-pause", paused: true }, popupSender());
      return orig(id);
    };
    expect((await approve(bg, f)).approved).toBe(false);
    expect(bg.approvals.size).toBe(0);
  });

  it("a revoke landing between approval and send drops the text", async () => {
    const { f, bg } = await setup();
    expect((await approve(bg, f)).approved).toBe(true);
    f._.state.granted = [];
    const p = pageText(bg, f);
    f.permissions.onRemoved.emit({ origins: [GITHUB_PATTERN] } as never);
    expect(await p).toMatchObject({ ok: false });
    expect(observations(f, "page_text")).toEqual([]);
  });
});

describe("page_text gate: capture toggle and core policy", () => {
  it("denies with 'permission' when GitHub is granted but the capture toggle is off", async () => {
    const { f, bg } = await setup({ granted: [GITHUB_PATTERN] });
    expect(bg.snapshot().githubCapture).toBe(false);
    expect(await approve(bg, f)).toEqual({ approved: false, reason: "permission" });
  });

  it("drops text approved before the toggle went off", async () => {
    const { f, bg } = await setup();
    expect((await approve(bg, f)).approved).toBe(true);
    await bg.handleMessage({ type: "popup-github-capture", enabled: false }, popupSender());
    expect(await pageText(bg, f)).toMatchObject({ ok: false });
    expect(observations(f, "page_text")).toEqual([]);
  });

  it("drops text when the core's policy stops capture between approval and send", async () => {
    const { f, bg } = await setup();
    expect((await approve(bg, f)).approved).toBe(true);
    f._.ports.at(-1)!.onMessage.emit({ type: "capture_policy", revision: 9, paused: false, captureEnabled: false });
    expect(await pageText(bg, f)).toMatchObject({ ok: false });
    expect(observations(f, "page_text")).toEqual([]);
  });
});

describe("page_text gate (standalone, shared state only)", () => {
  /** Just enough chrome for the gate: tab 10 is the active issue tab of focused window 1. */
  function gateHarness() {
    const clock = fakeClock();
    const state = createSharedState(clock);
    const posted: unknown[] = [];
    state.port = { postMessage: (m: unknown) => void posted.push(m) } as unknown as chrome.runtime.Port;
    state.policy = { revision: 2, captureEnabled: true, paused: false };
    state.githubCapture = true;
    state.granted = [GITHUB_PATTERN];
    const tab = { id: 10, windowId: 1, active: true, incognito: false, url: ISSUE1 };
    const ch = {
      runtime: { id: EXT_ID },
      tabs: { query: async () => [tab], sendMessage: async () => {} },
      windows: { get: async () => ({ id: 1, focused: true, incognito: false }) },
    } as unknown as typeof chrome;
    const gate = createPageTextGate({ ch, clock, state, counters: newCounters(), trigger: () => {} });
    const s = { id: EXT_ID, frameId: 0, documentId: "doc-1", url: ISSUE1, origin: "https://github.com", tab } as chrome.runtime.MessageSender;
    const text = { type: "page_text", navCounter: 3, url: ISSUE1, title: "One", text: "body", truncated: false } as const;
    return { clock, state, posted, gate, s, text };
  }

  it("an approval expires after the longest settle plus 5 s", async () => {
    const { clock, posted, gate, s, text } = gateHarness();
    expect(await gate.onApprove({ type: "approve", navCounter: 3, url: ISSUE1 }, s)).toEqual({ approved: true });
    await clock.advance(APPROVAL_TTL_MS + 1);
    expect(await gate.onPageText(text, s)).toEqual({ ok: false, reason: "expired" });
    expect(await gate.onApprove({ type: "approve", navCounter: 3, url: ISSUE1 }, s)).toEqual({ approved: true });
    await clock.advance(APPROVAL_TTL_MS);
    expect(await gate.onPageText(text, s)).toEqual({ ok: true });
    expect(posted).toHaveLength(1);
  });

  it("reads browserFocused from the shared state", async () => {
    const { state, gate, s } = gateHarness();
    state.browserFocused = false;
    expect(await gate.onApprove({ type: "approve", navCounter: 3, url: ISSUE1 }, s)).toEqual({ approved: false, reason: "not-foreground" });
  });
});
