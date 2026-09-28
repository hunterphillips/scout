import { BrowserObservationSchema } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import { CONTENT_SCRIPT_ID, createBackground, FOCUS_DEBOUNCE_MS, GITHUB_PATTERN, HOST_NAME, OPTIONAL_HOSTS } from "./background-core.js";
import type { StatusSnapshot } from "./messages.js";
import { RECONNECT_DELAYS_MS } from "./reconnect.js";
import { activate, asChrome, type FakeChrome, fakeClock, flush, makeChrome, popupSender, sender } from "./test-fakes.js";

const ISSUE1 = "https://github.com/acme/widgets/issues/1";
const ISSUE2 = "https://github.com/acme/widgets/issues/2";
const ALL = [...OPTIONAL_HOSTS];

async function setup(opts: Parameters<typeof makeChrome>[0] = { granted: [GITHUB_PATTERN] }) {
  const f = makeChrome(opts);
  const clock = fakeClock();
  const bg = createBackground(asChrome(f), { clock });
  await bg.start();
  await clock.advance(FOCUS_DEBOUNCE_MS);
  return { f, clock, bg };
}

const port = (f: FakeChrome) => f._.ports.at(-1)!;
const observations = (f: FakeChrome, kind?: string) =>
  f._.ports.flatMap((p) => p.posted).filter((m) => kind === undefined || m["kind"] === kind);

const approve = (bg: Awaited<ReturnType<typeof setup>>["bg"], f: FakeChrome, s = {}, navCounter = 3, url = ISSUE1) =>
  bg.handleMessage({ type: "approve", navCounter, url }, sender(f, s)) as Promise<{ approved: boolean; reason?: string }>;
const pageText = (bg: Awaited<ReturnType<typeof setup>>["bg"], f: FakeChrome, s = {}, navCounter = 3, url = ISSUE1) =>
  bg.handleMessage({ type: "page_text", navCounter, url, title: "One", text: "body", truncated: false }, sender(f, s)) as Promise<{ ok: boolean; reason?: string }>;

describe("manifest-level wiring", () => {
  it("connects one native port to dev.scout.bridge and reports permissions on connect", async () => {
    const { f } = await setup();
    expect(f._.ports.map((p) => p.name)).toEqual([HOST_NAME]);
    expect(port(f).posted[0]).toEqual({ kind: "permissions", granted: [GITHUB_PATTERN] });
  });

  it("registers the GitHub content script on all of github.com only on the GitHub grant, and unregisters on revoke", async () => {
    const { f, clock } = await setup({ granted: [] });
    f._.state.granted = ["https://docs.stripe.com/*"];
    await Promise.all(f.permissions.onAdded.emit({ origins: ["https://docs.stripe.com/*"] } as never));
    expect(f._.registered).toEqual([]);
    f._.state.granted = ALL;
    await Promise.all(f.permissions.onAdded.emit({ origins: [GITHUB_PATTERN] } as never));
    expect(f._.registered).toEqual([
      expect.objectContaining({ id: CONTENT_SCRIPT_ID, matches: ["https://github.com/*"], js: ["content/github-issue.js"], runAt: "document_idle", allFrames: false }),
    ]);
    expect(observations(f, "permissions").at(-1)).toEqual({ kind: "permissions", granted: ALL });
    f._.state.granted = ["https://docs.stripe.com/*"];
    await Promise.all(f.permissions.onRemoved.emit({ origins: [GITHUB_PATTERN] } as never));
    await clock.advance(0);
    expect(f._.registered).toEqual([]);
    expect(observations(f, "permissions").at(-1)).toEqual({ kind: "permissions", granted: ["https://docs.stripe.com/*"] });
  });
});

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

describe("page_text gate", () => {
  it("forwards when the sender tab is the active tab of the focused window and its URL equals the message URL; attaches documentId", async () => {
    const { f, bg } = await setup();
    // sender.url is stale (the document's first URL); the tab URL is current.
    expect(await approve(bg, f, { url: "https://github.com/acme/widgets" })).toEqual({ approved: true });
    expect(await pageText(bg, f, { url: "https://github.com/acme/widgets", documentId: "doc-1" })).toEqual({ ok: true });
    const obs = observations(f, "page_text");
    expect(obs).toEqual([
      { kind: "page_text", seq: expect.any(Number), at: expect.any(Number), tabId: 10, documentId: "doc-1", url: ISSUE1, source: "github_issue", title: "One", text: "body", truncated: false },
    ]);
    expect(BrowserObservationSchema.safeParse(obs[0]).success).toBe(true);
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

  it("pause is persisted, denies approval, stops focus observations, and tells the core the visit ended", async () => {
    const { f, clock, bg } = await setup();
    const s = (await bg.handleMessage({ type: "popup-pause", paused: true }, popupSender())) as StatusSnapshot;
    expect(s.paused).toBe(true);
    expect(f._.store).toEqual({ paused: true });
    expect(observations(f, "focus").at(-1)).toMatchObject({ browserFocused: false, windowId: -1 });
    const n = observations(f).length;
    expect(await approve(bg, f)).toEqual({ approved: false, reason: "paused" });
    f.tabs.onActivated.emit({ tabId: 10, windowId: 1 } as never);
    await clock.advance(1000);
    expect(observations(f)).toHaveLength(n);
  });

  it("does not answer content requests until the stored paused flag is loaded", async () => {
    const f = makeChrome({ granted: [GITHUB_PATTERN] });
    f._.store["paused"] = true;
    const bg = createBackground(asChrome(f), { clock: fakeClock() });
    bg.install();
    expect(await approve(bg, f)).toEqual({ approved: false, reason: "paused" });
  });

  it("fails closed (paused) when storage cannot be read", async () => {
    const f = makeChrome({ granted: [GITHUB_PATTERN] });
    f._.state.storageFails = true;
    const bg = createBackground(asChrome(f), { clock: fakeClock() });
    bg.install();
    expect(await approve(bg, f)).toEqual({ approved: false, reason: "paused" });
  });

  it("a pause landing during the approval's awaits cancels it (cancel epoch)", async () => {
    const { f, bg } = await setup();
    const orig = f.permissions.contains;
    f.permissions.contains = async (a) => {
      await bg.handleMessage({ type: "popup-pause", paused: true }, popupSender());
      return orig(a);
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

  it("ignores popup commands from content scripts", async () => {
    const { f, bg } = await setup();
    expect(await bg.handleMessage({ type: "popup-pause", paused: true }, sender(f))).toEqual({ ok: false });
    expect(f._.store).toEqual({});
  });
});

describe("bounded reconnect (fake port and clock)", () => {
  const LONG = 10 * 60_000;

  it("runs 1, 2, 4, 8, 16, 30 s, then makes no attempt until a focus event", async () => {
    const f = makeChrome({ granted: [GITHUB_PATTERN], host: "missing" });
    const clock = fakeClock();
    const bg = createBackground(asChrome(f), { clock });
    await bg.start();
    expect(f._.ports).toHaveLength(1);
    for (const [i, d] of RECONNECT_DELAYS_MS.entries()) {
      await clock.advance(d - 1);
      expect(f._.ports).toHaveLength(i + 1);
      await clock.advance(1);
      expect(f._.ports).toHaveLength(i + 2);
    }
    await clock.advance(LONG);
    expect(f._.ports).toHaveLength(7);
    expect(bg.snapshot().link).toBe("disconnected");
    await Promise.all(f.windows.onFocusChanged.emit(1 as never));
    await clock.advance(0);
    expect(f._.ports).toHaveLength(8);
  });

  it("two events within 60 s start one series", async () => {
    const { f, clock } = await setup({ granted: [GITHUB_PATTERN], host: "missing" });
    await clock.advance(LONG); // first series spent
    const spent = f._.ports.length;
    f.tabs.onActivated.emit({ tabId: 10, windowId: 1 } as never);
    await clock.advance(0);
    expect(f._.ports).toHaveLength(spent + 1);
    await clock.advance(LONG); // second series spent (61 s of delays)
    const afterSecond = f._.ports.length;
    expect(afterSecond).toBe(spent + 7);
    // 61 s have passed since the series began, so a new event may start one; a
    // second event before that series is spent does nothing.
    f.tabs.onActivated.emit({ tabId: 10, windowId: 1 } as never);
    await clock.advance(10);
    f.tabs.onActivated.emit({ tabId: 10, windowId: 1 } as never);
    await clock.advance(10);
    expect(f._.ports).toHaveLength(afterSecond + 1);
  });

  it("a healthy port that drops twice within 60 s does not get a second fresh series", async () => {
    const f = makeChrome({ granted: [GITHUB_PATTERN] });
    const clock = fakeClock();
    const bg = createBackground(asChrome(f), { clock });
    await bg.start();
    await clock.advance(10_000); // healthy
    const drop = () => {
      const p = port(f);
      p.disconnected = true;
      p.onDisconnect.emit(p);
    };
    drop(); // fresh series is not allowed yet (started 10 s ago): continues at 1 s
    await clock.advance(1000);
    expect(f._.ports).toHaveLength(2);
    await clock.advance(10_000);
    drop(); // still within 60 s of the series start: next delay is 2 s, not 1 s
    await clock.advance(1000);
    expect(f._.ports).toHaveLength(2);
    await clock.advance(1000);
    expect(f._.ports).toHaveLength(3);
    expect(bg.policy.seriesStarted).toBe(1);
  });

  it("the popup's Reconnect starts a series at once, even within 60 s", async () => {
    const { f, clock, bg } = await setup({ granted: [GITHUB_PATTERN], host: "missing" });
    await clock.advance(LONG);
    f.tabs.onActivated.emit({ tabId: 10, windowId: 1 } as never);
    await clock.advance(0);
    const n = f._.ports.length;
    await bg.handleMessage({ type: "popup-reconnect" }, popupSender());
    expect(f._.ports).toHaveLength(n + 1);
  });

  it("shows core unavailable when the host reports it, connected again on an ack", async () => {
    const { f, bg } = await setup();
    expect(bg.snapshot().link).toBe("connected");
    port(f).onMessage.emit({ type: "core_unavailable" });
    expect(bg.snapshot().link).toBe("core_unavailable");
    port(f).onMessage.emit({ type: "ack", seq: 1 });
    expect(bg.snapshot().link).toBe("connected");
    port(f).onMessage.emit({ type: "bogus" });
    expect(bg.snapshot().counters.acked).toBe(1);
  });

  it("denies approval while no port is open", async () => {
    const { f, clock, bg } = await setup({ granted: [GITHUB_PATTERN], host: "missing" });
    await clock.advance(1);
    await flush();
    expect(await approve(bg, f)).toEqual({ approved: false, reason: "bridge-disconnected" });
  });
});
