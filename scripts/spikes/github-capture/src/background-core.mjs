// Scout Phase 0 GitHub capture spike: background service-worker logic.
//
// Holds the permission lifecycle, the per-tab capture approvals, the native
// bridge connection, and a metadata-only status for the popup. Captured title
// and body pass through memory once, straight to the native port, and are
// never stored, logged or kept in status. `chrome` is injected so the whole
// thing runs against a fake in tests.

import { createBackoff } from "./reconnect-policy.mjs";
import { parseIssueRoute } from "./route.mjs";
import { LIMITS, SELECTOR_IDS } from "./selectors.mjs";

export const GITHUB_ORIGINS = Object.freeze(["https://github.com/*"]);
export const SCRIPT_ID = "scout-gh-capture";
export const HOST_NAME = "dev.scout.spike_bridge";
export const APPROVAL_TTL_MS = 10_000;
export const MAX_NATIVE_MESSAGE_BYTES = 64 * 1024;
/** The only values status.lastDenial.reason can hold. */
export const DENIAL_CODES = Object.freeze(new Set(["sender", "route", "paused", "permission", "not-foreground", "cancelled", "bridge-disconnected"]));
export const CONTENT_SCRIPT = Object.freeze({
  id: SCRIPT_ID,
  matches: ["https://github.com/*"],
  js: ["content.js"],
  runAt: "document_idle",
  allFrames: false,
  world: "ISOLATED",
  persistAcrossSessions: true,
});

const enc = new TextEncoder();
const utf8Length = (s) => enc.encode(s).length;

function defaultToken() {
  const a = new Uint8Array(16);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function classifyNativeError(msg) {
  if (!msg) return "exited";
  if (/not found/i.test(msg)) return "host-missing";
  if (/forbidden/i.test(msg)) return "host-forbidden";
  if (/exited/i.test(msg)) return "exited";
  return "error";
}

export function createBackground(chrome, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeout ?? ((t) => clearTimeout(t));
  const token = opts.randomToken ?? defaultToken;
  const backoff = createBackoff({ scale: opts.backoffScale ?? 1 });

  const status = {
    permission: "unknown",
    paused: false,
    bridge: { host: "disconnected", server: "unknown", retryInMs: null, waitingForTrigger: false, lastError: null },
    current: null, // {route: 'issue'|'non-issue', at}
    lastCapture: null, // metadata only
    lastDenial: null, // {reason: DENIAL_CODES member, at: ms}; replaced by each denial, never cleared
    counters: { approved: 0, denied: 0, forwarded: 0, dropped: 0, rejected: 0, acked: 0, failed: 0, cancels: 0 },
  };
  const approvals = new Map(); // tabId -> {documentId, gen, token, routeKey, at}
  const contentTabs = new Set(); // tabs whose content script has talked to us
  let port = null;
  let hostHello = false;
  let retryTimer = null;
  let seq = 0;
  let chain = Promise.resolve();
  // Bumped by pause and by permission revocation. Approve/capture snapshot it
  // on entry and give up if it moved while they were awaiting a check.
  let cancelEpoch = 0;
  let loaded = null;

  /** Load persisted state once; every message waits for it. Fails closed (paused). */
  function loadState() {
    loaded ??= Promise.resolve()
      .then(() => chrome.storage.local.get({ paused: false }))
      .then(
        (stored) => {
          status.paused = stored?.paused === true;
        },
        () => {
          status.paused = true;
        },
      );
    return loaded;
  }

  const snapshot = () => JSON.parse(JSON.stringify(status));
  const bridgeReady = () => port !== null && hostHello && status.bridge.server === "connected";

  // ---------- native bridge ----------
  function connectBridge() {
    if (port) return;
    if (retryTimer !== null) clearT(retryTimer);
    retryTimer = null;
    status.bridge.host = "connecting";
    status.bridge.waitingForTrigger = false;
    status.bridge.retryInMs = null;
    let p;
    try {
      p = chrome.runtime.connectNative(HOST_NAME);
    } catch {
      portGone("connect-threw");
      return;
    }
    port = p;
    hostHello = false;
    p.onMessage.addListener((m) => onHostMessage(p, m));
    p.onDisconnect.addListener(() => {
      if (port !== p) return;
      port = null;
      hostHello = false;
      portGone(classifyNativeError(chrome.runtime.lastError?.message));
    });
    p.postMessage({ type: "hello", protocol: 1 });
  }

  function portGone(reason) {
    status.bridge.host = reason === "host-missing" ? "host-missing" : "disconnected";
    status.bridge.server = "unknown";
    status.bridge.lastError = reason;
    const d = backoff.next();
    if (d === null) {
      status.bridge.retryInMs = null;
      status.bridge.waitingForTrigger = true;
      return;
    }
    status.bridge.retryInMs = d;
    retryTimer = setT(() => {
      retryTimer = null;
      connectBridge();
    }, d);
  }

  function onHostMessage(p, m) {
    if (port !== p || !m || typeof m !== "object") return;
    if (m.type === "hello-ack" && m.protocol === 1) {
      hostHello = true;
      backoff.reset();
      status.bridge.host = "connected";
      status.bridge.lastError = null;
      setServer(m.server);
    } else if (m.type === "status") {
      setServer(m.server, m.retryInMs);
    } else if (m.type === "ack") {
      status.counters.acked++;
      if (status.lastCapture && status.lastCapture.id === m.id) {
        status.lastCapture.acked = true;
        status.lastCapture.ackBytes = Number.isSafeInteger(m.bytes) ? m.bytes : null;
      }
    } else if (m.type === "dropped") {
      status.counters.dropped++;
      if (status.lastCapture && status.lastCapture.id === m.id) status.lastCapture.state = "dropped";
    } else if (m.type === "error") {
      status.bridge.lastError = typeof m.code === "string" ? m.code.slice(0, 32) : "error";
    }
  }

  function setServer(server, retryInMs) {
    const was = status.bridge.server;
    const s = ["connected", "connecting", "disconnected", "idle"].includes(server) ? server : "unknown";
    status.bridge.server = s;
    status.bridge.retryInMs = Number.isFinite(retryInMs) ? retryInMs : null;
    status.bridge.waitingForTrigger = s === "idle";
    if (s === "connected" && was !== "connected") void refreshActive("bridge-connected");
  }

  /** Tab/focus events and the popup button. Never loops on its own. */
  function reconnect({ manual = false } = {}) {
    if (!port) {
      if (manual || (retryTimer === null && status.bridge.waitingForTrigger)) {
        backoff.reset();
        connectBridge();
      }
      return;
    }
    if (hostHello && (status.bridge.server === "idle" || (manual && status.bridge.server !== "connected"))) {
      port.postMessage({ type: "reconnect" });
    }
  }

  // ---------- permission lifecycle ----------
  async function permissionGranted() {
    try {
      return (await chrome.permissions.contains({ origins: [...GITHUB_ORIGINS] })) === true;
    } catch {
      return false;
    }
  }

  function reconcile() {
    chain = chain.then(async () => {
      const granted = await permissionGranted();
      status.permission = granted ? "granted" : "not-granted";
      const regs = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
      if (granted && regs.length === 0) await chrome.scripting.registerContentScripts([{ ...CONTENT_SCRIPT }]);
      if (!granted) {
        cancelTabs({ stop: true });
        if (regs.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      }
      return granted;
    });
    chain = chain.catch(() => false);
    return chain;
  }

  async function activeTab() {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t ?? null;
  }

  /**
   * The browser's own record of `tabId` if it is the active tab of the
   * focused, non-incognito window, else null. Its `url` (present only with
   * GitHub host access) is the authority for the current route.
   */
  async function foregroundTab(tabId) {
    const t = await activeTab();
    if (!t || t.id !== tabId || t.incognito) return null;
    const w = await chrome.windows.get(t.windowId);
    return w?.focused === true && w.incognito !== true ? t : null;
  }

  /**
   * After a grant: GitHub pages that were already open never got the
   * registered script, and SPA navigation will not load it. Inject into their
   * top frames once. The script only watches the URL until the background
   * approves a read, and a second injection is a no-op.
   */
  async function injectIntoOpenGithubTabs() {
    const tabs = await chrome.tabs.query({ url: "https://github.com/*" }).catch(() => []);
    for (const t of tabs) {
      if (t.incognito || !Number.isInteger(t.id)) continue;
      await chrome.scripting.executeScript({ target: { tabId: t.id, frameIds: [0] }, files: ["content.js"] }).catch(() => {});
    }
  }

  async function refreshActive() {
    if (status.paused || status.permission !== "granted") return;
    const t = await activeTab().catch(() => null);
    if (!t || t.incognito || !parseIssueRoute(t.url ?? "")) return;
    await chrome.tabs.sendMessage(t.id, { type: "refresh" }, { frameId: 0 }).catch(() => {});
  }

  /**
   * Tell content scripts to stop reading now: drop every approval and send
   * {type:'cancel'} to the top frame of each known tab except `except` (a tab
   * that is about to be asked to refresh). `stop` also disconnects the
   * script (permission revoked). Delivery failures are ignored: the content
   * script has its own blur/visibility guards and the background rejects any
   * late capture anyway.
   */
  function cancelTabs({ stop = false, except = null } = {}) {
    const ids = new Set([...contentTabs, ...approvals.keys()]);
    cancelEpoch++; // in-flight approve/capture checks give up too
    approvals.clear();
    if (stop) contentTabs.clear(); // stopped scripts re-register when re-injected
    for (const id of ids) {
      if (id === except) continue;
      status.counters.cancels++;
      Promise.resolve()
        .then(() => chrome.tabs.sendMessage(id, { type: "cancel", stop }, { frameId: 0 }))
        .catch(() => {});
    }
  }

  // ---------- content messages ----------
  // sender.url is NOT a route authority. The 2026-09-28 live run strongly
  // suggests Chrome keeps it at the document's first URL across GitHub's
  // in-page navigation (every SPA-reached issue was denied "route" while the
  // tab was on the right path). sender.url itself was not logged, and Chrome
  // does not document either way. It is only checked for origin. The route comes from the browser-owned tab
  // URL: sender.tab.url at request time, then the fresh active-tab query.
  const githubOrigin = (u) => {
    try {
      return new URL(u).origin === "https://github.com";
    } catch {
      return false;
    }
  };
  const tabRoute = (t) => (typeof t?.url === "string" ? parseIssueRoute(t.url) : null);

  function senderOk(sender) {
    return (
      !!sender &&
      sender.id === chrome.runtime.id &&
      sender.frameId === 0 &&
      !!sender.tab &&
      Number.isInteger(sender.tab.id) &&
      sender.tab.incognito !== true &&
      typeof sender.documentId === "string" &&
      typeof sender.url === "string" &&
      githubOrigin(sender.url) &&
      (sender.origin === undefined || sender.origin === "https://github.com") &&
      (sender.documentLifecycle === undefined || sender.documentLifecycle === "active")
    );
  }

  const seen = (sender) => {
    if (senderOk(sender)) contentTabs.add(sender.tab.id);
  };

  const deny = (reason) => {
    status.counters.denied++;
    status.lastDenial = { reason: DENIAL_CODES.has(reason) ? reason : "other", at: now() };
    return { approved: false, reason };
  };

  async function onApprove(msg, sender) {
    if (!senderOk(sender)) return deny("sender");
    const route = tabRoute(sender.tab);
    if (!route || route.key !== msg.routeKey || !Number.isSafeInteger(msg.gen)) return deny("route");
    if (status.paused) return deny("paused");
    const epoch = cancelEpoch;
    if (!(await permissionGranted())) {
      status.permission = "not-granted";
      return deny("permission");
    }
    const fg = await foregroundTab(sender.tab.id);
    if (!fg) return deny("not-foreground");
    if (tabRoute(fg)?.key !== route.key) return deny("route");
    if (epoch !== cancelEpoch || status.paused) return deny("cancelled");
    status.current = { route: "issue", at: now() };
    if (!bridgeReady()) {
      status.lastCapture = { state: "dropped", reason: "bridge-disconnected", at: now() };
      reconnect();
      return deny("bridge-disconnected");
    }
    const t = token();
    approvals.set(sender.tab.id, { documentId: sender.documentId, gen: msg.gen, token: t, routeKey: route.key, at: now() });
    status.counters.approved++;
    return { approved: true, token: t };
  }

  function validPayload(m) {
    return (
      typeof m.title === "string" &&
      m.title.length > 0 &&
      Array.from(m.title).length <= LIMITS.titleChars &&
      typeof m.body === "string" &&
      utf8Length(m.body) <= LIMITS.bodyBytes &&
      typeof m.titleTruncated === "boolean" &&
      typeof m.bodyTruncated === "boolean" &&
      Array.isArray(m.selectorIds) &&
      m.selectorIds.length <= 8 &&
      m.selectorIds.every((s) => SELECTOR_IDS.has(s)) &&
      Number.isFinite(m.settleMs)
    );
  }

  async function checkCaptureSender(msg, sender) {
    if (!senderOk(sender)) return { reason: "sender" };
    const a = approvals.get(sender.tab.id);
    if (!a) return { reason: "no-approval" };
    approvals.delete(sender.tab.id); // single use
    if (a.documentId !== sender.documentId) return { reason: "document-changed" };
    if (a.gen !== msg.gen || a.token !== msg.token || a.routeKey !== msg.routeKey) return { reason: "stale-generation" };
    const route = tabRoute(sender.tab);
    if (!route || route.key !== a.routeKey) return { reason: "url-changed" };
    if (now() - a.at > APPROVAL_TTL_MS) return { reason: "approval-expired" };
    if (status.paused) return { reason: "paused" };
    if (!(await permissionGranted())) return { reason: "permission" };
    const fg = await foregroundTab(sender.tab.id);
    if (!fg) return { reason: "not-foreground" };
    const current = tabRoute(fg);
    if (!current || current.key !== a.routeKey) return { reason: "url-changed" };
    return { route: current };
  }

  async function onCapture(msg, sender) {
    const epoch = cancelEpoch;
    let c = await checkCaptureSender(msg, sender);
    if (!c.reason && (epoch !== cancelEpoch || status.paused)) c = { reason: "cancelled" };
    if (c.reason) {
      status.counters.rejected++;
      status.lastCapture = { state: "rejected", reason: c.reason, at: now() };
      return { ok: false, reason: c.reason };
    }
    if (msg.type === "capture-failed") {
      status.counters.failed++;
      status.lastCapture = { state: "failed", reason: String(msg.reason ?? "").slice(0, 32), settleMs: Number.isFinite(msg.settleMs) ? Math.round(msg.settleMs) : null, at: now() };
      return { ok: true };
    }
    if (!validPayload(msg)) {
      status.counters.rejected++;
      status.lastCapture = { state: "rejected", reason: "payload", at: now() };
      return { ok: false, reason: "payload" };
    }
    const meta = {
      titleChars: Array.from(msg.title).length,
      bodyBytes: utf8Length(msg.body),
      titleTruncated: msg.titleTruncated,
      bodyTruncated: msg.bodyTruncated,
      selectorIds: [...msg.selectorIds],
      settleMs: Math.round(msg.settleMs),
      at: now(),
    };
    if (!bridgeReady()) {
      status.counters.dropped++;
      status.lastCapture = { state: "dropped", reason: "bridge-disconnected", ...meta };
      return { ok: false, reason: "bridge-disconnected" };
    }
    const id = ++seq;
    const out = {
      type: "capture",
      id,
      issueUrl: c.route.canonicalUrl,
      title: msg.title,
      body: msg.body,
      titleTruncated: msg.titleTruncated,
      bodyTruncated: msg.bodyTruncated,
    };
    if (utf8Length(JSON.stringify(out)) > MAX_NATIVE_MESSAGE_BYTES) {
      status.counters.rejected++;
      status.lastCapture = { state: "rejected", reason: "too-large", ...meta };
      return { ok: false, reason: "too-large" };
    }
    port.postMessage(out);
    status.counters.forwarded++;
    status.lastCapture = { state: "forwarded", id, acked: false, ...meta };
    return { ok: true };
  }

  function onRoute(msg, sender) {
    if (!senderOk(sender)) return { ok: false };
    approvals.delete(sender.tab.id);
    if (msg.issue === false) status.current = { route: "non-issue", at: now() };
    return { ok: true };
  }

  // ---------- popup messages ----------
  function popupSender(sender) {
    // Our own popup page (as the action popup, or opened in a tab). Content
    // scripts report the web page URL here, never a chrome-extension:// URL.
    if (!sender || sender.id !== chrome.runtime.id || typeof sender.url !== "string") return false;
    const u = sender.url.split(/[?#]/)[0];
    return u === chrome.runtime.getURL("popup.html");
  }

  async function onPopup(msg) {
    if (msg.type === "popup-status") return snapshot();
    if (msg.type === "popup-pause") {
      status.paused = msg.paused === true;
      if (status.paused) cancelTabs();
      await chrome.storage.local.set({ paused: status.paused });
      if (!status.paused) void refreshActive();
      return snapshot();
    }
    if (msg.type === "popup-reconnect") {
      reconnect({ manual: true });
      return snapshot();
    }
    return { ok: false };
  }

  async function handleMessage(msg, sender) {
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return { ok: false };
    await loadState();
    if (msg.type.startsWith("popup-")) return popupSender(sender) ? onPopup(msg) : { ok: false };
    if (msg.type === "approve" || msg.type === "capture" || msg.type === "capture-failed" || msg.type === "route") seen(sender);
    if (msg.type === "approve") return onApprove(msg, sender);
    if (msg.type === "capture" || msg.type === "capture-failed") return onCapture(msg, sender);
    if (msg.type === "route") return onRoute(msg, sender);
    return { ok: false };
  }

  // ---------- browser events ----------
  function onFocusOrTab() {
    reconnect();
    void refreshActive();
  }

  function install() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      handleMessage(msg, sender).then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    });
    chrome.permissions.onAdded.addListener(async () => {
      if (await reconcile()) {
        await injectIntoOpenGithubTabs();
        void refreshActive();
      }
    });
    chrome.permissions.onRemoved.addListener(() => {
      cancelEpoch++; // fail closed now; reconcile confirms and cleans up
      void reconcile();
    });
    chrome.tabs.onActivated.addListener((info) => {
      cancelTabs({ except: info?.tabId ?? null });
      onFocusOrTab();
    });
    chrome.windows.onFocusChanged.addListener(async (windowId) => {
      if (windowId === chrome.windows.WINDOW_ID_NONE) {
        cancelTabs();
        return;
      }
      const t = await activeTab().catch(() => null);
      cancelTabs({ except: t?.id ?? null });
      onFocusOrTab();
    });
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      const a = approvals.get(tabId);
      if (!a) return;
      if (info.status === "loading" && info.url === undefined) return;
      if (info.url !== undefined && parseIssueRoute(info.url)?.key !== a.routeKey) approvals.delete(tabId);
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      approvals.delete(tabId);
      contentTabs.delete(tabId);
    });
  }

  async function start() {
    install();
    await loadState();
    if (await reconcile()) await injectIntoOpenGithubTabs();
    connectBridge();
  }

  return { start, install, reconcile, handleMessage, snapshot, reconnect, approvals, get port() {
    return port;
  } };
}
