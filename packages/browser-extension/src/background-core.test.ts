import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTENT_SCRIPT_FILE, CONTENT_SCRIPT_ID, createBackground, GITHUB_PATTERN, HOST_NAME, OPTIONAL_HOSTS } from "./background-core.js";
import { FOCUS_DEBOUNCE_MS } from "./focus-observer.js";
import type { StatusSnapshot } from "./messages.js";
import { asChrome, fakeClock, makeChrome, popupSender, sender } from "./test-fakes.js";
import { approve, lastPort, observations, setup } from "./test-harness.js";

const ALL = [...OPTIONAL_HOSTS];

describe("manifest-level wiring", () => {
  it("connects one native port to dev.scout.bridge and reports permissions on connect", async () => {
    const { f } = await setup();
    expect(f._.ports.map((p) => p.name)).toEqual([HOST_NAME]);
    expect(lastPort(f).posted[0]).toEqual({ kind: "permissions", granted: [GITHUB_PATTERN] });
  });

  it("OPTIONAL_HOSTS matches optional_host_permissions in manifest.json", () => {
    const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")) as { optional_host_permissions: string[] };
    expect([...OPTIONAL_HOSTS]).toEqual(manifest.optional_host_permissions);
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

  it("seq keeps rising across a worker restart", async () => {
    const { f, clock } = await setup();
    const before = Math.max(...observations(f).flatMap((o) => (typeof o["seq"] === "number" ? [o["seq"]] : [])));
    const again = await setup({ granted: [GITHUB_PATTERN] }, clock.now() + 30_000);
    const first = observations(again.f, "focus")[0]!;
    expect(first["seq"] as number).toBeGreaterThan(before);
  });
});

describe("pause", () => {
  it("is persisted, denies approval, stops focus observations, and tells the core the visit ended", async () => {
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

  it("holds permission changes while paused and reports them on resume", async () => {
    const { f, clock, bg } = await setup();
    await bg.handleMessage({ type: "popup-pause", paused: true }, popupSender());
    const n = observations(f).length;
    f._.state.granted = ALL;
    await Promise.all(f.permissions.onAdded.emit({ origins: ALL } as never));
    f._.state.granted = [GITHUB_PATTERN];
    await Promise.all(f.permissions.onRemoved.emit({ origins: ALL } as never));
    await clock.advance(1000);
    expect(observations(f)).toHaveLength(n);
    await bg.handleMessage({ type: "popup-pause", paused: false }, popupSender());
    expect(observations(f).at(n)).toEqual({ kind: "permissions", granted: [GITHUB_PATTERN] });
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
    expect(f._.store).toEqual({});
  });

  it("resuming schedules a fresh focus observation", async () => {
    const { f, clock, bg } = await setup();
    await bg.handleMessage({ type: "popup-pause", paused: true }, popupSender());
    await bg.handleMessage({ type: "popup-pause", paused: false }, popupSender());
    await clock.advance(FOCUS_DEBOUNCE_MS);
    expect(observations(f, "focus").at(-1)).toMatchObject({ browserFocused: true, tabId: 10 });
  });
});
