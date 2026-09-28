import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bundleContentScript, extensionIdFromKey, prepare } from "./prepare.mjs";
import { APPROVAL_TTL_MS, CONTENT_SCRIPT, createBackground, DENIAL_CODES, HOST_NAME } from "./src/background-core.mjs";
import { createCaptureController } from "./src/content-core.mjs";
import { buildManifest } from "./src/manifest.mjs";
import { statusRows } from "./src/popup-view.mjs";
import { EXT_ID, flush, issueMain, listMain, makeChrome, makeDom, popupSender, repoHomeMain, sender, SENTINEL } from "./test-fakes.mjs";

const TITLE_SECRET = "SENTINEL-TITLE-9e9e";
const BODY_SECRET = "SENTINEL-BODY-0f0f";
const capture = (over = {}) => ({
  type: "capture",
  gen: 0,
  token: "tok-1",
  routeKey: "acme/widgets#1",
  title: `Title ${TITLE_SECRET}`,
  body: `Body ${BODY_SECRET}`,
  titleTruncated: false,
  bodyTruncated: false,
  selectorIds: ["identity:issue-body/issue-body-header-link", "title:issue-header/issue-title", "body:issue-body/issue-body-viewer/markdown-body"],
  settleMs: 512,
  ...over,
});

function timers() {
  const q = [];
  return {
    q,
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      q.push(t);
      return t;
    },
    clearTimeout: (t) => {
      const i = q.indexOf(t);
      if (i >= 0) q.splice(i, 1);
    },
    runNext() {
      const t = q.shift();
      t?.fn();
      return t?.ms;
    },
  };
}

async function boot({ granted = true, host = "ok", now } = {}) {
  const chrome = makeChrome({ granted, host });
  const tm = timers();
  let tok = 0;
  const bg = createBackground(chrome, { setTimeout: tm.setTimeout, clearTimeout: tm.clearTimeout, randomToken: () => (tok++, "tok-1"), now });
  await bg.start();
  await flush();
  return { chrome, bg, tm };
}

const approve = (bg, chrome, s = {}, m = {}) => bg.handleMessage({ type: "approve", gen: 0, routeKey: "acme/widgets#1", ...m }, sender(chrome, s));

describe("manifest", () => {
  it("asks for GitHub only as an optional permission and nothing broad", () => {
    const m = buildManifest({ key: "AAAA" });
    expect(m.permissions.sort()).toEqual(["nativeMessaging", "scripting", "storage"]);
    expect(m.optional_host_permissions).toEqual(["https://github.com/*"]);
    expect(m.incognito).toBe("not_allowed");
    expect(m.host_permissions).toBeUndefined();
    expect(m.content_scripts).toBeUndefined();
    expect(m.web_accessible_resources).toBeUndefined();
    const text = JSON.stringify(m);
    for (const bad of ["<all_urls>", '"tabs"', "history", "webNavigation", "cookies", "*://*/*"]) expect(text).not.toContain(bad);
  });

  it("registers the content script on all github.com pages, top frame only", () => {
    expect(CONTENT_SCRIPT).toMatchObject({ matches: ["https://github.com/*"], allFrames: false, world: "ISOLATED", js: ["content.js"] });
  });

  it("derives a stable a-p extension id from the public key", () => {
    const id = extensionIdFromKey("AAAA");
    expect(id).toMatch(/^[a-p]{32}$/);
    expect(extensionIdFromKey("AAAA")).toBe(id);
  });
});

describe("permission lifecycle", () => {
  it("registers only after a grant, idempotently, and unregisters on revoke", async () => {
    const { chrome, bg } = await boot({ granted: false });
    expect(chrome._.registered).toEqual([]);
    expect(bg.snapshot().permission).toBe("not-granted");
    chrome._.granted = true;
    await Promise.all(chrome.permissions.onAdded.emit({ origins: ["https://github.com/*"] }));
    await Promise.all(chrome.permissions.onAdded.emit({ origins: ["https://github.com/*"] }));
    await bg.reconcile();
    expect(chrome._.registered.map((r) => r.id)).toEqual(["scout-gh-capture"]);
    // Already-open GitHub tabs get the script, top frame only; other sites never do.
    expect(chrome._.executeCalls.slice(0, 2)).toEqual([
      { target: { tabId: 10, frameIds: [0] }, files: ["content.js"] },
      { target: { tabId: 11, frameIds: [0] }, files: ["content.js"] },
    ]);
    expect(chrome._.executeCalls.every((c) => c.target.tabId !== 12)).toBe(true);
    chrome._.granted = false;
    chrome.permissions.onRemoved.emit({ origins: ["https://github.com/*"] });
    await bg.reconcile();
    expect(chrome._.registered).toEqual([]);
    expect(bg.snapshot().permission).toBe("not-granted");
  });

  it("fails closed after revocation even with an outstanding approval", async () => {
    const { chrome, bg } = await boot();
    expect((await approve(bg, chrome)).approved).toBe(true);
    chrome._.granted = false;
    // Without host access Chrome gives no tab URL, so the route check fails first.
    const r = await bg.handleMessage(capture(), sender(chrome));
    expect(r).toEqual({ ok: false, reason: "url-changed" });
    expect(chrome._.ports[0].posted.filter((m) => m.type === "capture")).toEqual([]);
    expect((await approve(bg, chrome)).reason).toBe("route");
    // A request that still carries a tab URL (revoked in between) is refused by the live permission check.
    const s = sender(chrome, {});
    chrome._.granted = true;
    const withUrl = sender(chrome);
    chrome._.granted = false;
    expect(s.tab.url).toBeUndefined();
    expect((await bg.handleMessage({ type: "approve", gen: 0, routeKey: "acme/widgets#1" }, withUrl)).reason).toBe("permission");
  });
});

describe("approval gate", () => {
  it("approves only the top frame of the active tab in the focused window", async () => {
    const { chrome, bg } = await boot();
    expect(await approve(bg, chrome)).toEqual({ approved: true, token: "tok-1" });
    const cases = [
      [{ frameId: 3 }, {}, "sender"],
      [{ incognito: true }, {}, "sender"],
      [{ id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" }, {}, "sender"],
      [{ tabId: 11 }, { routeKey: "acme/widgets#2" }, "not-foreground"],
      [{ tabUrl: "https://github.com/acme/widgets/issues" }, {}, "route"],
      [{ tabUrl: "https://github.com/acme/widgets/issues/2" }, {}, "route"],
    ];
    for (const [s, m, reason] of cases) expect((await approve(bg, chrome, s, m)).reason, reason).toBe(reason);
    chrome._.windows.get(1).focused = false;
    expect((await approve(bg, chrome)).reason).toBe("not-foreground");
  });

  it("denies while paused, and persists only the paused flag", async () => {
    const { chrome, bg } = await boot();
    await bg.handleMessage({ type: "popup-pause", paused: true }, popupSender());
    expect((await approve(bg, chrome)).reason).toBe("paused");
    expect(chrome._.storageWrites).toEqual([{ paused: true }]);
    await bg.handleMessage({ type: "popup-pause", paused: false }, popupSender());
    expect((await approve(bg, chrome)).approved).toBe(true);
  });

  it("ignores popup commands from content scripts, accepts the popup page even when opened in a tab", async () => {
    const { chrome, bg } = await boot();
    expect(await bg.handleMessage({ type: "popup-pause", paused: true }, sender(chrome))).toEqual({ ok: false });
    expect(await bg.handleMessage({ type: "popup-pause", paused: true }, { id: EXT_ID, url: `chrome-extension://${EXT_ID}/background.js` })).toEqual({ ok: false });
    expect(bg.snapshot().paused).toBe(false);
    const inTab = { ...popupSender(), tab: { id: 99 } };
    expect((await bg.handleMessage({ type: "popup-status" }, inTab)).permission).toBe("granted");
  });
});

describe("capture forwarding", () => {
  it("forwards title/body once to the native port with a canonical URL; status holds metadata only", async () => {
    const { chrome, bg } = await boot();
    await approve(bg, chrome, { url: "https://github.com/acme/widgets/issues/1?q=private#frag" });
    const r = await bg.handleMessage(capture(), sender(chrome, { url: "https://github.com/acme/widgets/issues/1?q=private#frag" }));
    expect(r).toEqual({ ok: true });
    await flush();
    const sent = chrome._.ports[0].posted.filter((m) => m.type === "capture");
    expect(sent).toEqual([
      { type: "capture", id: 1, issueUrl: "https://github.com/acme/widgets/issues/1", title: `Title ${TITLE_SECRET}`, body: `Body ${BODY_SECRET}`, titleTruncated: false, bodyTruncated: false },
    ]);
    const snap = JSON.stringify(bg.snapshot());
    for (const s of [TITLE_SECRET, BODY_SECRET, "private", "frag", "https://"]) expect(snap).not.toContain(s);
    expect(bg.snapshot().lastCapture).toMatchObject({ state: "forwarded", acked: true, titleChars: `Title ${TITLE_SECRET}`.length, bodyBytes: `Body ${BODY_SECRET}`.length, settleMs: 512 });
    expect(JSON.stringify(chrome._.storageWrites)).not.toContain("SENTINEL");
    const rows = JSON.stringify(statusRows(bg.snapshot()));
    for (const s of [TITLE_SECRET, BODY_SECRET, "github.com"]) expect(rows).not.toContain(s);
  });

  it("uses each approval once", async () => {
    const { chrome, bg } = await boot();
    await approve(bg, chrome);
    await bg.handleMessage(capture(), sender(chrome));
    expect(await bg.handleMessage(capture(), sender(chrome))).toEqual({ ok: false, reason: "no-approval" });
  });

  it("discards a late capture from the previous document or generation", async () => {
    const { chrome, bg } = await boot();
    await approve(bg, chrome, { documentId: "doc-1" });
    expect(await bg.handleMessage(capture(), sender(chrome, { documentId: "doc-2" }))).toEqual({ ok: false, reason: "document-changed" });
    await approve(bg, chrome);
    expect(await bg.handleMessage(capture({ gen: 1 }), sender(chrome))).toEqual({ ok: false, reason: "stale-generation" });
    await approve(bg, chrome);
    expect(await bg.handleMessage(capture({ token: "forged" }), sender(chrome))).toEqual({ ok: false, reason: "stale-generation" });
    await approve(bg, chrome);
    expect(await bg.handleMessage(capture(), sender(chrome, { tabUrl: "https://github.com/acme/widgets/issues/2" }))).toEqual({ ok: false, reason: "url-changed" });
    expect(chrome._.ports[0].posted.filter((m) => m.type === "capture")).toEqual([]);
  });

  it("rejects after a tab switch, SPA navigation away, or expiry", async () => {
    let t = 1000;
    const { chrome, bg } = await boot({ now: () => t });
    await approve(bg, chrome);
    chrome.tabs.onActivated.emit({ tabId: 11 });
    expect((await bg.handleMessage(capture(), sender(chrome))).reason).toBe("no-approval");
    await approve(bg, chrome);
    chrome.tabs.onUpdated.emit(10, { url: "https://github.com/acme/widgets/issues" });
    expect((await bg.handleMessage(capture(), sender(chrome))).reason).toBe("no-approval");
    await approve(bg, chrome);
    t += APPROVAL_TTL_MS + 1;
    expect((await bg.handleMessage(capture(), sender(chrome))).reason).toBe("approval-expired");
  });

  it("rejects oversized or malformed payloads", async () => {
    const { chrome, bg } = await boot();
    for (const bad of [{ title: "t".repeat(301) }, { body: "é".repeat(4097) }, { selectorIds: ["made-up"] }, { title: "" }, { titleTruncated: "no" }]) {
      await approve(bg, chrome);
      expect((await bg.handleMessage(capture(bad), sender(chrome))).reason).toBe("payload");
    }
  });

  it("drops the payload (no queue) and shows disconnected when the server is down", async () => {
    const { chrome, bg } = await boot();
    chrome._.ports[0].reply({ type: "status", server: "disconnected", retryInMs: 1000 });
    expect((await approve(bg, chrome)).reason).toBe("bridge-disconnected");
    expect(bg.snapshot().lastCapture).toMatchObject({ state: "dropped", reason: "bridge-disconnected" });
    expect(chrome._.ports[0].posted.filter((m) => m.type === "capture")).toEqual([]);
    // Server back: the active issue tab is asked to refresh, no page reload.
    chrome._.ports[0].reply({ type: "status", server: "connected" });
    await flush();
    await flush();
    expect(chrome._.tabMessages.at(-1)).toEqual({ tabId: 10, msg: { type: "refresh" }, opts: { frameId: 0 } });
  });
});

describe("cancel messages to content scripts", () => {
  const cancels = (chrome) => chrome._.tabMessages.filter((m) => m.msg.type === "cancel");
  it("pause cancels every known tab; resume refreshes the active one", async () => {
    const { chrome, bg } = await boot();
    await approve(bg, chrome);
    await bg.handleMessage({ type: "route", issue: false, gen: 0 }, sender(chrome, { tabId: 11 }));
    await bg.handleMessage({ type: "popup-pause", paused: true }, popupSender());
    await flush();
    expect(cancels(chrome).map((m) => [m.tabId, m.msg.stop, m.opts.frameId]).sort()).toEqual([
      [10, false, 0],
      [11, false, 0],
    ]);
    expect(bg.approvals.size).toBe(0);
    await bg.handleMessage({ type: "popup-pause", paused: false }, popupSender());
    await flush();
    expect(chrome._.tabMessages.at(-1)).toMatchObject({ tabId: 10, msg: { type: "refresh" } });
  });

  it("permission revoke sends stop (disconnect) to every known tab", async () => {
    const { chrome, bg } = await boot();
    await approve(bg, chrome);
    chrome._.granted = false;
    chrome.permissions.onRemoved.emit({ origins: ["https://github.com/*"] });
    await bg.reconcile();
    await flush();
    expect(cancels(chrome)).toEqual([{ tabId: 10, msg: { type: "cancel", stop: true }, opts: { frameId: 0 } }]);
  });

  it("tab switch cancels the old tab, not the newly active one; losing window focus cancels all", async () => {
    const { chrome, bg } = await boot();
    await approve(bg, chrome);
    chrome._.tabs.get(10).active = false;
    chrome._.tabs.get(11).active = true;
    chrome.tabs.onActivated.emit({ tabId: 11, windowId: 1 });
    await flush();
    expect(cancels(chrome).map((m) => m.tabId)).toEqual([10]);
    chrome._.tabMessages.length = 0;
    await bg.handleMessage({ type: "route", issue: false, gen: 0 }, sender(chrome, { tabId: 11 }));
    chrome.windows.onFocusChanged.emit(chrome.windows.WINDOW_ID_NONE);
    await flush();
    expect(cancels(chrome).map((m) => m.tabId).sort()).toEqual([10, 11]);
    expect(bg.approvals.size).toBe(0);
  });
});

describe("cancellation while a check is awaiting (deferred promises)", () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  };
  /** Make the NEXT call of chrome.<api>.<fn> hang until released; later calls behave normally. */
  const holdNext = (obj, fn) => {
    const orig = obj[fn];
    const d = deferred();
    let entered;
    const started = new Promise((r) => (entered = r));
    obj[fn] = async (...a) => {
      obj[fn] = orig;
      entered();
      const real = await orig(...a);
      await d.promise;
      return real;
    };
    return { started, release: () => d.resolve() };
  };
  const pause = (bg) => bg.handleMessage({ type: "popup-pause", paused: true }, popupSender());
  const revoke = async (chrome, bg) => {
    chrome._.granted = false;
    chrome.permissions.onRemoved.emit({ origins: ["https://github.com/*"] });
    await bg.reconcile();
  };
  const captures = (chrome) => chrome._.ports[0].posted.filter((m) => m.type === "capture");
  const cases = [
    ["pause", "permission", (c) => c.permissions, "contains", pause],
    ["pause", "focus", (c) => c.windows, "get", pause],
    ["revoke", "permission", (c) => c.permissions, "contains", (bg, chrome) => revoke(chrome, bg)],
    ["revoke", "focus", (c) => c.windows, "get", (bg, chrome) => revoke(chrome, bg)],
  ];

  for (const [what, during, api, fn, cancel] of cases) {
    it(`${what} during the ${during} await: no fresh approval is created`, async () => {
      const { chrome, bg } = await boot();
      const h = holdNext(api(chrome), fn);
      const p = approve(bg, chrome);
      await h.started;
      await cancel(bg, chrome);
      // A permission answer that was already in flight still says "granted".
      chrome._.granted = true;
      h.release();
      const r = await p;
      expect(r.approved).toBe(false);
      expect(bg.approvals.size).toBe(0);
    });

    it(`${what} during the ${during} await: the capture is not forwarded`, async () => {
      const { chrome, bg } = await boot();
      expect((await approve(bg, chrome)).approved).toBe(true);
      const h = holdNext(api(chrome), fn);
      const p = bg.handleMessage(capture(), sender(chrome));
      await h.started;
      await cancel(bg, chrome);
      chrome._.granted = true;
      h.release();
      const r = await p;
      expect(r.ok).toBe(false);
      await flush();
      expect(captures(chrome)).toEqual([]);
      expect(bg.snapshot().counters.forwarded).toBe(0);
    });
  }
});

describe("SPA route authority: browser-owned tab URL, not sender.url", () => {
  const captures = (chrome) => chrome._.ports[0].posted.filter((m) => m.type === "capture");
  const setTab = (chrome, url) => (chrome._.tabs.get(10).url = url);

  it("repo -> issue in-page: stale repo-home sender.url, current tab on the issue: approved and forwarded", async () => {
    const { chrome, bg } = await boot();
    const s = sender(chrome, { url: "https://github.com/acme/widgets" });
    expect(await bg.handleMessage({ type: "approve", gen: 3, routeKey: "acme/widgets#1" }, s)).toEqual({ approved: true, token: "tok-1" });
    expect(await bg.handleMessage(capture({ gen: 3 }), s)).toEqual({ ok: true });
    expect(captures(chrome).map((c) => c.issueUrl)).toEqual(["https://github.com/acme/widgets/issues/1"]);
  });

  it("issue -> issue in the same document: stale sender.url of the first issue, tab on the second: approved and forwarded", async () => {
    const { chrome, bg } = await boot();
    setTab(chrome, "https://github.com/acme/widgets/issues/7?x=1#y");
    const s = sender(chrome, { url: "https://github.com/acme/widgets/issues/1", documentId: "doc-1" });
    expect((await bg.handleMessage({ type: "approve", gen: 1, routeKey: "acme/widgets#7" }, s)).approved).toBe(true);
    expect(await bg.handleMessage(capture({ gen: 1, routeKey: "acme/widgets#7" }), s)).toEqual({ ok: true });
    expect(captures(chrome).map((c) => c.issueUrl)).toEqual(["https://github.com/acme/widgets/issues/7"]);
  });

  it("a requester whose route disagrees with the actual tab route is denied", async () => {
    const { chrome, bg } = await boot();
    // Requester claims #1 (and even its sender.url says #1) but the tab is on #2.
    setTab(chrome, "https://github.com/acme/widgets/issues/2");
    expect((await approve(bg, chrome, { url: "https://github.com/acme/widgets/issues/1" })).reason).toBe("route");
    // Tab on a non-issue page.
    setTab(chrome, "https://github.com/acme/widgets/issues");
    expect((await approve(bg, chrome)).reason).toBe("route");
    // No browser-owned tab URL at all (no host access for it) fails closed.
    expect((await approve(bg, chrome, { tabUrl: "https://example.com/acme/widgets/issues/1" })).reason).toBe("route");
    expect(bg.approvals.size).toBe(0);
  });

  it("non-GitHub or cross-origin senders are denied", async () => {
    const { chrome, bg } = await boot();
    for (const s of [
      { url: "https://example.com/acme/widgets/issues/1" },
      { url: "https://github.com.evil.example/acme/widgets/issues/1" },
      { url: "http://github.com/acme/widgets/issues/1" },
      { url: "not a url" },
      { origin: "https://evil.example" },
    ]) {
      expect((await approve(bg, chrome, s)).reason, JSON.stringify(s)).toBe("sender");
    }
  });

  it("a non-active document (prerender, cached, pending deletion) gets no approval and no forward", async () => {
    const { chrome, bg } = await boot();
    for (const documentLifecycle of ["prerender", "cached", "pending_deletion"]) {
      expect((await approve(bg, chrome, { documentLifecycle })).reason).toBe("sender");
    }
    expect((await approve(bg, chrome)).approved).toBe(true);
    const r = await bg.handleMessage(capture(), sender(chrome, { documentLifecycle: "cached" }));
    expect(r).toEqual({ ok: false, reason: "sender" });
    expect(captures(chrome)).toEqual([]);
  });

  it("a capture from another document or a changed tab route is not forwarded", async () => {
    const { chrome, bg } = await boot();
    await approve(bg, chrome);
    expect((await bg.handleMessage(capture(), sender(chrome, { documentId: "doc-2" }))).reason).toBe("document-changed");
    await approve(bg, chrome);
    setTab(chrome, "https://github.com/acme/widgets/issues/2");
    expect((await bg.handleMessage(capture(), sender(chrome))).reason).toBe("url-changed");
    expect(captures(chrome)).toEqual([]);
  });

  describe("changes while the foreground check is awaiting", () => {
    const holdWindowsGet = (chrome) => {
      const orig = chrome.windows.get;
      let release;
      let entered;
      const started = new Promise((r) => (entered = r));
      const gate = new Promise((r) => (release = r));
      chrome.windows.get = async (...a) => {
        chrome.windows.get = orig;
        entered();
        const w = await orig(...a);
        await gate;
        return w;
      };
      return { started, release: () => release() };
    };
    const switchTab = (chrome) => {
      chrome._.tabs.get(10).active = false;
      chrome._.tabs.get(11).active = true;
      chrome.tabs.onActivated.emit({ tabId: 11, windowId: 1 });
    };

    it("tab route changes mid-approval: denied", async () => {
      const { chrome, bg } = await boot();
      // The request-time tab URL says #1; the tab moves to #2 while the
      // permission check is awaiting, before the fresh foreground query.
      const orig = chrome.permissions.contains;
      chrome.permissions.contains = async (...a) => {
        chrome.permissions.contains = orig;
        setTab(chrome, "https://github.com/acme/widgets/issues/2");
        return orig(...a);
      };
      expect((await approve(bg, chrome)).reason).toBe("route");
    });

    it("tab switch mid-approval: no approval", async () => {
      const { chrome, bg } = await boot();
      const h = holdWindowsGet(chrome);
      const p = approve(bg, chrome);
      await h.started;
      switchTab(chrome);
      h.release();
      expect((await p).approved).toBe(false);
      expect(bg.approvals.size).toBe(0);
    });

    it("tab switch mid-capture: not forwarded", async () => {
      const { chrome, bg } = await boot();
      await approve(bg, chrome);
      const h = holdWindowsGet(chrome);
      const p = bg.handleMessage(capture(), sender(chrome));
      await h.started;
      switchTab(chrome);
      h.release();
      expect((await p).ok).toBe(false);
      expect(captures(chrome)).toEqual([]);
    });

    it("tab route changes mid-capture: not forwarded", async () => {
      const { chrome, bg } = await boot();
      await approve(bg, chrome);
      const orig = chrome.permissions.contains;
      chrome.permissions.contains = async (...a) => {
        chrome.permissions.contains = orig;
        setTab(chrome, "https://github.com/acme/widgets/issues/2");
        return orig(...a);
      };
      expect(await bg.handleMessage(capture(), sender(chrome))).toEqual({ ok: false, reason: "url-changed" });
      expect(captures(chrome)).toEqual([]);
    });
  });
});

describe("startup state load", () => {
  it("does not answer content requests until the persisted paused flag is loaded", async () => {
    const chrome = makeChrome({ granted: true });
    chrome._.store.paused = true;
    let release;
    const gate = new Promise((r) => (release = r));
    const origGet = chrome.storage.local.get;
    chrome.storage.local.get = async (d) => {
      await gate;
      return origGet(d);
    };
    const bg = createBackground(chrome, { randomToken: () => "tok-1" });
    const started = bg.start();
    const p = approve(bg, chrome);
    await flush();
    release();
    await started;
    const r = await p;
    expect(r).toEqual({ approved: false, reason: "paused" });
    expect(bg.approvals.size).toBe(0);
  });

  it("fails closed (paused) when the stored state cannot be read", async () => {
    const chrome = makeChrome({ granted: true });
    chrome.storage.local.get = async () => {
      throw new Error("storage broken");
    };
    const bg = createBackground(chrome, { randomToken: () => "tok-1" });
    await bg.start();
    await flush();
    expect((await approve(bg, chrome)).reason).toBe("paused");
  });
});

describe("last denial (metadata only)", () => {
  it("records the latest denial as a fixed code and a numeric time; a later approval leaves it in place", async () => {
    let t = 1000;
    const { chrome, bg } = await boot({ now: () => t });
    expect(bg.snapshot().lastDenial).toBeNull();
    expect(statusRows(bg.snapshot(), t).some(([k]) => k === "Last denial")).toBe(false);
    const seen = [];
    const record = () => {
      const d = bg.snapshot().lastDenial;
      seen.push(d.reason);
      expect(Object.keys(d).sort()).toEqual(["at", "reason"]);
      expect(d.at).toBe(t);
      expect(DENIAL_CODES.has(d.reason)).toBe(true);
    };
    t = 2000;
    await approve(bg, chrome, { frameId: 3 });
    record();
    t = 3000;
    await approve(bg, chrome, { tabUrl: "https://github.com/acme/widgets/issues/2?q=SENTINEL-Q#SENTINEL-H" });
    record();
    t = 4000;
    await bg.handleMessage({ type: "popup-pause", paused: true }, popupSender());
    await approve(bg, chrome);
    record();
    await bg.handleMessage({ type: "popup-pause", paused: false }, popupSender());
    t = 5000;
    chrome._.windows.get(1).focused = false;
    await approve(bg, chrome);
    record();
    chrome._.windows.get(1).focused = true;
    t = 6000;
    const contains = chrome.permissions.contains;
    chrome.permissions.contains = async () => false; // revoked after the request left the tab
    await approve(bg, chrome);
    record();
    chrome.permissions.contains = contains;
    t = 7000;
    chrome._.ports[0].reply({ type: "status", server: "disconnected", retryInMs: 1000 });
    await approve(bg, chrome);
    record();
    expect(seen).toEqual(["sender", "route", "paused", "not-foreground", "permission", "bridge-disconnected"]);
    expect(bg.snapshot().counters.denied).toBe(6);
    // Replacement semantics: an approval does not clear it; the count and time tell old from new.
    chrome._.ports[0].reply({ type: "status", server: "connected" });
    t = 8000;
    expect((await approve(bg, chrome)).approved).toBe(true);
    expect(bg.snapshot().lastDenial).toEqual({ reason: "bridge-disconnected", at: 7000 });
    expect(statusRows(bg.snapshot(), 9000)).toContainEqual(["Last denial", "bridge-disconnected 2s ago"]);
    const pub = JSON.stringify([bg.snapshot(), statusRows(bg.snapshot(), 9000)]);
    for (const s of ["SENTINEL", "https://", "github.com", "issues/"]) expect(pub).not.toContain(s);
  });

  it("the popup row shows only an allowlisted code, never an arbitrary string", () => {
    const rowsFor = (lastDenial) => statusRows({ lastDenial, counters: {} }, 5000).filter(([k]) => k === "Last denial");
    expect(rowsFor({ reason: "https://github.com/x/y/issues/1 SENTINEL", at: 1000 })).toEqual([["Last denial", "other 4s ago"]]);
    expect(rowsFor({ reason: "route", at: "SENTINEL" })).toEqual([["Last denial", "route"]]);
    expect(rowsFor(null)).toEqual([]);
  });
});

describe("capture-failed metadata", () => {
  it("keeps settleMs only as a finite rounded number", async () => {
    const { chrome, bg } = await boot();
    const failed = (settleMs) => ({ type: "capture-failed", gen: 0, token: "tok-1", routeKey: "acme/widgets#1", reason: "timeout", settleMs });
    for (const [input, want] of [
      [512.6, 513],
      ["SENTINEL-SETTLE", null],
      [Infinity, null],
      [{ x: 1 }, null],
      [undefined, null],
    ]) {
      await approve(bg, chrome);
      expect(await bg.handleMessage(failed(input), sender(chrome))).toEqual({ ok: true });
      expect(bg.snapshot().lastCapture.settleMs).toBe(want);
    }
  });
});

describe("bridge reconnect", () => {
  it("uses the bounded 1,2,4,8,16,30 s schedule then waits for a tab/focus event", async () => {
    const { chrome, bg, tm } = await boot({ host: "missing" });
    await flush();
    expect(bg.snapshot().bridge.host).toBe("host-missing");
    const delays = [];
    for (let i = 0; i < 10 && tm.q.length; i++) {
      delays.push(tm.runNext());
      await flush();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(chrome._.ports).toHaveLength(7);
    expect(bg.snapshot().bridge.waitingForTrigger).toBe(true);
    expect(tm.q).toEqual([]);
    const rows = statusRows(bg.snapshot());
    expect(rows).toContainEqual(["Bridge", "disconnected (native host not installed)"]);
    chrome._.host = "ok";
    chrome.tabs.onActivated.emit({ tabId: 10 });
    await flush();
    await flush();
    expect(chrome._.ports).toHaveLength(8);
    expect(bg.snapshot().bridge).toMatchObject({ host: "connected", server: "connected" });
    expect(chrome._.ports.every((p) => p.name === HOST_NAME)).toBe(true);
  });

  it("asks the host to reconnect to the server only on a trigger after it went idle", async () => {
    const { chrome, bg } = await boot();
    const port = chrome._.ports[0];
    port.reply({ type: "status", server: "idle", attempts: 6 });
    expect(port.posted.filter((m) => m.type === "reconnect")).toEqual([]);
    chrome.windows.onFocusChanged.emit(1);
    await flush();
    expect(port.posted.filter((m) => m.type === "reconnect")).toHaveLength(1);
    await bg.handleMessage({ type: "popup-reconnect" }, popupSender());
    expect(port.posted.filter((m) => m.type === "reconnect")).toHaveLength(2);
  });
});

describe("content bundle", () => {
  const roots = [];
  afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

  it("is a classic script that runs in the page's isolated world without touching the DOM", async () => {
    const code = bundleContentScript();
    expect(code).not.toMatch(/^\s*(import|export)\b/m);
    expect(code).not.toMatch(/\b(fetch|XMLHttpRequest|localStorage|console)\b/);
    const d = makeDom("https://github.com/acme/widgets/issues", listMain());
    const sent = [];
    d.win.chrome = {
      runtime: {
        id: EXT_ID,
        sendMessage: async (m) => (sent.push(m), m.type === "approve" ? { approved: false } : { ok: true }),
        onMessage: { addListener() {} },
      },
    };
    const before = d.html();
    d.win.eval(code);
    d.win.eval(code); // double injection is a no-op
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([{ type: "route", issue: false, gen: 0 }]);
    expect(d.html()).toBe(before);
    expect(d.reads.nodeValue + d.reads.other).toBe(0);
  });

  it("prepare writes the extension and host files only under --out", () => {
    const out = mkdtempSync(join(tmpdir(), "scout prep ext "));
    roots.push(out);
    const r = prepare({ out });
    const m = JSON.parse(readFileSync(join(r.extensionDir, "manifest.json"), "utf8"));
    expect(m.key).toBeTruthy();
    expect(extensionIdFromKey(m.key)).toBe(r.extensionId);
    const host = JSON.parse(readFileSync(r.hostManifestPath, "utf8"));
    expect(host.allowed_origins).toEqual([`chrome-extension://${r.extensionId}/`]);
    expect(prepare({ out }).extensionId).toBe(r.extensionId); // stable across runs
    for (const p of Object.values(r)) if (typeof p === "string" && p.startsWith("/")) expect(p.startsWith(out)).toBe(true);
    expect(() => prepare({ out: join(process.env.HOME, "Library", "x") })).toThrow("~/Library");
  });
});

describe("end to end in memory: content controller + background + fake native port", () => {
  it("repo -> Issues -> issue -> issue -> list captures two issues and nothing on the list", async () => {
    const { chrome, bg } = await boot();
    const d = makeDom("https://github.com/acme/widgets", repoHomeMain());
    const tab = chrome._.tabs.get(10);
    const snd = () => sender(chrome, { url: d.win.location.href });
    const ctl = createCaptureController({
      win: d.win,
      doc: d.doc,
      limits: { settleMs: 40, maxWaitMs: 400, tickMs: 5, pollMs: 20 },
      requestApproval: (m) => bg.handleMessage({ type: "approve", ...m }, snd()),
      sendCapture: (p) => bg.handleMessage(p, snd()),
      sendRoute: (p) => void bg.handleMessage({ type: "route", ...p }, snd()),
    });
    const go = (url, main) => {
      d.pushUrl(url);
      tab.url = url;
      chrome.tabs.onUpdated.emit(10, { url });
      d.setMain(main);
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    ctl.start();
    await sleep(30);
    go("https://github.com/acme/widgets/issues", listMain());
    await sleep(40);
    go("https://github.com/acme/widgets/issues/1", issueMain({ number: 1, title: "One" }));
    await sleep(200);
    go("https://github.com/acme/widgets/issues/2", issueMain({ number: 2, title: "Two" }));
    await sleep(200);
    go("https://github.com/acme/widgets/issues", listMain());
    await sleep(150);
    ctl.stop();
    const caps = chrome._.ports[0].posted.filter((m) => m.type === "capture");
    expect(caps.map((c) => [c.issueUrl, c.title])).toEqual([
      ["https://github.com/acme/widgets/issues/1", "One"],
      ["https://github.com/acme/widgets/issues/2", "Two"],
    ]);
    expect(bg.snapshot().current.route).toBe("non-issue");
    for (const c of caps) for (const s of Object.values(SENTINEL)) expect(JSON.stringify(c)).not.toContain(s);
  });
});
