import { BrowserObservationSchema } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import { CONTENT_SCRIPT_FILE, CONTENT_SCRIPT_ID, createBackground, GITHUB_PATTERN, HOST_NAME } from "./background-core.js";
import { FOCUS_DEBOUNCE_MS } from "./focus-observer.js";
import type { StatusSnapshot } from "./messages.js";
import { activate, asChrome, DISABLED_POLICY, fakeClock, makeChrome, popupSender, sender } from "./test-fakes.js";
import { approve, dropPort, lastPort, observations, pageText, setup } from "./test-harness.js";

const STRIPE = "https://docs.stripe.com/*";
const EXAMPLE = "https://example.com/*";
const ENABLED = (revision: number) => ({ type: "capture_policy", revision, paused: false, captureEnabled: true });
const kinds = (posted: Array<Record<string, unknown>>) => posted.map((m) => m["kind"]);

describe("manifest-level wiring", () => {
  it("connects one native port to dev.scout.bridge", async () => {
    const { f } = await setup();
    expect(f._.ports.map((p) => p.name)).toEqual([HOST_NAME]);
  });

  it("posts nothing until the core's policy, then a permissions snapshot, then a focus stamped with its revision", async () => {
    const { f, clock, bg } = await setup({ granted: [GITHUB_PATTERN, STRIPE], host: "silent", local: { githubCapture: true }, autoEnable: false });
    f.tabs.onActivated.emit({ tabId: 10, windowId: 1 } as never);
    await clock.advance(1000);
    expect(lastPort(f).posted).toEqual([]);
    expect(bg.snapshot().policy).toBeNull();

    lastPort(f).onMessage.emit({ ...DISABLED_POLICY });
    lastPort(f).onMessage.emit({ type: "ready" });
    await clock.advance(0);
    const [perm, focus] = lastPort(f).posted;
    expect(kinds(lastPort(f).posted)).toEqual(["permissions", "focus"]);
    expect(perm).toEqual({ kind: "permissions", revision: expect.any(Number), at: clock.now(), granted: [GITHUB_PATTERN, STRIPE], githubCapture: true });
    expect(BrowserObservationSchema.safeParse(perm).success).toBe(true);
    expect(focus).toMatchObject({ kind: "focus", tabId: 10, url: "https://github.com/acme/widgets/issues/1", permissionsRevision: perm!["revision"] });
    expect(bg.snapshot().policy).toEqual({ revision: 1, captureEnabled: false, paused: false });
  });

  it("the snapshot lists only exact https origins, dropping wildcard, all-sites and http grants", async () => {
    const { f } = await setup({ granted: [GITHUB_PATTERN, "https://*/*", "https://*.example.com/*", "http://plain.example/*", "<all_urls>", STRIPE] });
    expect(observations(f, "permissions")[0]).toMatchObject({ granted: [GITHUB_PATTERN, STRIPE], githubCapture: false });
  });

  it("a grant change sends a new snapshot with a higher revision, then a focus carrying it", async () => {
    const { f, clock } = await setup();
    const first = observations(f, "permissions")[0]!;
    f._.state.granted = [GITHUB_PATTERN, STRIPE];
    await Promise.all(f.permissions.onAdded.emit({ origins: [STRIPE] } as never));
    await clock.advance(0);
    const next = observations(f, "permissions").at(-1)!;
    expect(next["revision"] as number).toBeGreaterThan(first["revision"] as number);
    expect(next["granted"]).toEqual([GITHUB_PATTERN, STRIPE]);
    const posted = lastPort(f).posted;
    const at = posted.indexOf(next);
    expect(posted[at + 1]).toMatchObject({ kind: "focus", permissionsRevision: next["revision"] });
  });

  it("a tab whose origin is not granted is sent without url, title or documentId, even when activeTab exposes it", async () => {
    const { f, clock } = await setup();
    activate(f, 12);
    f._.state.activeTabGrant = 12; // the popup was opened on example.com
    f.tabs.onActivated.emit({ tabId: 12, windowId: 1 } as never);
    await clock.advance(FOCUS_DEBOUNCE_MS);
    const obs = observations(f, "focus").at(-1)!;
    expect(obs).toMatchObject({ browserFocused: true, tabId: 12, windowId: 1, incognito: false, permissionsRevision: expect.any(Number) });
    for (const k of ["url", "title", "documentId"]) expect(k in obs).toBe(false);

    f._.state.granted = [GITHUB_PATTERN, EXAMPLE]; // "Allow Scout on this site"
    await Promise.all(f.permissions.onAdded.emit({ origins: [EXAMPLE] } as never));
    await clock.advance(0);
    expect(observations(f, "focus").at(-1)).toMatchObject({ tabId: 12, url: "https://example.com/", title: "Example" });
  });

  it("registers the GitHub content script only with both the GitHub grant and the capture toggle", async () => {
    const { f, clock, bg } = await setup({ granted: [] });
    f._.state.granted = [GITHUB_PATTERN];
    await Promise.all(f.permissions.onAdded.emit({ origins: [GITHUB_PATTERN] } as never));
    expect(f._.registered).toEqual([]); // a grant alone does not turn capture on
    expect(observations(f, "permissions").at(-1)).toMatchObject({ granted: [GITHUB_PATTERN], githubCapture: false });

    const s = (await bg.handleMessage({ type: "popup-github-capture", enabled: true }, popupSender())) as StatusSnapshot;
    expect(s.githubCapture).toBe(true);
    expect(f._.store["githubCapture"]).toBe(true);
    expect(f._.registered).toEqual([
      expect.objectContaining({ id: CONTENT_SCRIPT_ID, matches: ["https://github.com/*"], js: ["content/github-issue.js"], runAt: "document_idle", allFrames: false }),
    ]);
    await clock.advance(0);
    expect(observations(f, "permissions").at(-1)).toMatchObject({ githubCapture: true });

    await bg.handleMessage({ type: "popup-github-capture", enabled: false }, popupSender());
    expect(f._.registered).toEqual([]);
    expect(observations(f, "permissions").at(-1)).toMatchObject({ githubCapture: false });
  });

  it("the toggle cannot turn on without the GitHub grant, or from a content script; losing the grant turns it off", async () => {
    const { bg } = await setup({ granted: [STRIPE] });
    expect(((await bg.handleMessage({ type: "popup-github-capture", enabled: true }, popupSender())) as StatusSnapshot).githubCapture).toBe(false);

    const g = await setup();
    expect(await g.bg.handleMessage({ type: "popup-github-capture", enabled: false }, sender(g.f))).toEqual({ ok: false });
    expect(g.bg.snapshot().githubCapture).toBe(true);
    g.f._.state.granted = [];
    await Promise.all(g.f.permissions.onRemoved.emit({ origins: [GITHUB_PATTERN] } as never));
    await g.clock.advance(0);
    expect(g.bg.snapshot().githubCapture).toBe(false);
    expect(g.f._.store["githubCapture"]).toBe(false);
    expect(g.f._.registered).toEqual([]);
    g.f._.state.granted = [GITHUB_PATTERN];
    await Promise.all(g.f.permissions.onAdded.emit({ origins: [GITHUB_PATTERN] } as never));
    expect(g.f._.registered).toEqual([]); // re-granting alone does not bring capture back
  });

  it("injects into open GitHub tabs on the grant and on install, never on a plain worker wake", async () => {
    const { f } = await setup(); // GitHub already granted: this is a wake, not a grant
    expect(f._.executeCalls).toEqual([]);
    await Promise.all(f.permissions.onAdded.emit({ origins: [GITHUB_PATTERN] } as never));
    const injected = [10, 11].map((tabId) => ({ target: { tabId, frameIds: [0] }, files: [CONTENT_SCRIPT_FILE] }));
    expect(f._.executeCalls).toEqual(injected);
    f._.executeCalls.length = 0;
    await Promise.all(f.runtime.onInstalled.emit({ reason: "update" }));
    expect(f._.executeCalls).toEqual(injected);
  });

  it("seq and the permissions revision keep rising across a worker restart", async () => {
    const { f, clock } = await setup();
    const before = Math.max(...observations(f).flatMap((o) => (typeof o["seq"] === "number" ? [o["seq"]] : [])));
    const rev = observations(f, "permissions").at(-1)!["revision"] as number;
    const again = await setup({ granted: [GITHUB_PATTERN] }, clock.now() + 30_000);
    expect(observations(again.f, "focus")[0]!["seq"] as number).toBeGreaterThan(before);
    expect(observations(again.f, "permissions")[0]!["revision"] as number).toBeGreaterThan(rev);
  });
});

describe("capture policy", () => {
  it("denies approval with 'policy' until the core enables capture", async () => {
    const { f, clock, bg } = await setup({ granted: [GITHUB_PATTERN], local: { githubCapture: true }, autoEnable: false });
    expect(bg.snapshot().policy).toEqual({ revision: 1, captureEnabled: false, paused: false });
    expect(await approve(bg, f)).toEqual({ approved: false, reason: "policy" });
    expect(f._.tabMessages.filter((m) => (m.msg as { type: string }).type === "refresh")).toEqual([]);
    lastPort(f).onMessage.emit(ENABLED(2));
    await clock.advance(0);
    // enablement asks the active issue tab for a fresh capture
    expect(f._.tabMessages.at(-1)).toEqual({ tabId: 10, msg: { type: "refresh" } });
    expect(await approve(bg, f)).toEqual({ approved: true });
  });

  it("resets to no policy on port loss; a new port captures nothing until its own policy enables it", async () => {
    const { f, clock, bg } = await setup();
    expect((await approve(bg, f)).approved).toBe(true);
    dropPort(f);
    expect(bg.snapshot().policy).toBeNull();
    expect(bg.approvals.size).toBe(0);
    expect(await pageText(bg, f)).toMatchObject({ ok: false });
    f._.state.host = "silent";
    f._.state.autoEnable = false;
    await clock.advance(1000); // reconnect
    expect(f._.ports).toHaveLength(2);
    expect(await approve(bg, f)).toEqual({ approved: false, reason: "policy" });
    expect(lastPort(f).posted).toEqual([]);
    lastPort(f).onMessage.emit({ ...DISABLED_POLICY });
    await clock.advance(0);
    expect(kinds(lastPort(f).posted)).toEqual(["permissions", "focus"]);
    expect(await approve(bg, f)).toEqual({ approved: false, reason: "policy" });
    lastPort(f).onMessage.emit(ENABLED(2));
    expect(await approve(bg, f)).toEqual({ approved: true });
  });

  it("a paused policy cancels in-flight approvals and tells content scripts to stop reading", async () => {
    const { f, clock, bg } = await setup();
    expect((await approve(bg, f)).approved).toBe(true);
    await clock.advance(0);
    f._.tabMessages.length = 0;
    lastPort(f).onMessage.emit({ type: "capture_policy", revision: 3, paused: true, captureEnabled: true });
    expect(bg.approvals.size).toBe(0);
    await clock.advance(0);
    expect(f._.tabMessages).toEqual([{ tabId: 10, msg: { type: "cancel", stop: false } }]);
    expect(await pageText(bg, f)).toMatchObject({ ok: false });
    expect(await approve(bg, f)).toEqual({ approved: false, reason: "policy" });
    expect(observations(f, "page_text")).toEqual([]);
    expect(bg.snapshot().policy).toEqual({ revision: 3, captureEnabled: true, paused: true });
    lastPort(f).onMessage.emit(ENABLED(4));
    await clock.advance(0);
    expect(await approve(bg, f)).toEqual({ approved: true });
  });

  it("a policy that lands during approval's awaits cancels it", async () => {
    const { f, bg } = await setup();
    const orig = f.permissions.contains;
    f.permissions.contains = async (a) => {
      lastPort(f).onMessage.emit({ type: "capture_policy", revision: 3, paused: true, captureEnabled: true });
      return orig(a);
    };
    expect(await approve(bg, f)).toEqual({ approved: false, reason: "cancelled" });
  });

  it("ignores a policy older than the current one", async () => {
    const { f, bg } = await setup();
    lastPort(f).onMessage.emit({ type: "capture_policy", revision: 1, paused: true, captureEnabled: false });
    expect(bg.snapshot().policy).toEqual({ revision: 2, captureEnabled: true, paused: false });
    expect((await approve(bg, f)).approved).toBe(true);
  });

  it("shows upgrade_required until a later port is ready", async () => {
    const { f, bg } = await setup({ granted: [GITHUB_PATTERN], host: "silent" });
    lastPort(f).onMessage.emit({ type: "core_unavailable", reason: "upgrade_required" });
    expect(bg.snapshot().link).toBe("upgrade_required");
    dropPort(f);
    expect(bg.snapshot().link).toBe("upgrade_required");
    await bg.handleMessage({ type: "popup-reconnect" }, popupSender());
    lastPort(f).onMessage.emit({ ...DISABLED_POLICY });
    lastPort(f).onMessage.emit({ type: "ready" });
    expect(bg.snapshot().link).toBe("connected");
  });
});

describe("pause", () => {
  it("is persisted, denies approval, stops focus observations, and tells the core the visit ended", async () => {
    const { f, clock, bg } = await setup();
    const s = (await bg.handleMessage({ type: "popup-pause", paused: true }, popupSender())) as StatusSnapshot;
    expect(s.paused).toBe(true);
    expect(f._.store["paused"]).toBe(true);
    expect(observations(f, "focus").at(-1)).toMatchObject({ browserFocused: false, windowId: -1 });
    const n = observations(f).length;
    expect(await approve(bg, f)).toEqual({ approved: false, reason: "paused" });
    f.tabs.onActivated.emit({ tabId: 10, windowId: 1 } as never);
    await clock.advance(1000);
    expect(observations(f)).toHaveLength(n);
  });

  it("holds permission changes while paused and reports them on resume", async () => {
    const { f, clock, bg } = await setup();
    await bg.handleMessage({ type: "popup-pause", paused: true }, popupSender());
    const n = observations(f).length;
    f._.state.granted = [GITHUB_PATTERN, STRIPE];
    await Promise.all(f.permissions.onAdded.emit({ origins: [STRIPE] } as never));
    f._.state.granted = [GITHUB_PATTERN];
    await Promise.all(f.permissions.onRemoved.emit({ origins: [STRIPE] } as never));
    await clock.advance(1000);
    expect(observations(f)).toHaveLength(n);
    await bg.handleMessage({ type: "popup-pause", paused: false }, popupSender());
    expect(observations(f).at(n)).toMatchObject({ kind: "permissions", granted: [GITHUB_PATTERN], githubCapture: true });
    await clock.advance(0);
    expect(observations(f).at(n + 1)).toMatchObject({ kind: "focus", permissionsRevision: observations(f).at(n)!["revision"] });
  });

  it("does not answer content requests until the stored paused flag is loaded", async () => {
    const f = makeChrome({ granted: [GITHUB_PATTERN] });
    f._.store["paused"] = true;
    const bg = createBackground(asChrome(f), { clock: fakeClock() });
    expect(await approve(bg, f)).toEqual({ approved: false, reason: "paused" });
  });

  it("fails closed (paused) when storage cannot be read", async () => {
    const f = makeChrome({ granted: [GITHUB_PATTERN] });
    f._.state.storageFails = true;
    const bg = createBackground(asChrome(f), { clock: fakeClock() });
    expect(await approve(bg, f)).toEqual({ approved: false, reason: "paused" });
  });

  it("ignores popup commands from content scripts", async () => {
    const { f, bg } = await setup();
    expect(await bg.handleMessage({ type: "popup-pause", paused: true }, sender(f))).toEqual({ ok: false });
    expect(f._.store["paused"]).toBeUndefined();
  });

  it("resuming schedules a fresh focus observation", async () => {
    const { f, clock, bg } = await setup();
    await bg.handleMessage({ type: "popup-pause", paused: true }, popupSender());
    await bg.handleMessage({ type: "popup-pause", paused: false }, popupSender());
    await clock.advance(FOCUS_DEBOUNCE_MS);
    expect(observations(f, "focus").at(-1)).toMatchObject({ browserFocused: true, tabId: 10 });
  });
});
