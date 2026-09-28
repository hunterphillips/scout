// Test fakes for the GitHub capture spike: a synthetic GitHub issue DOM that
// mirrors the live structure (data-testid layout verified 2026-09-24), a
// read-counting jsdom, and a fake `chrome` API for the background.

import { JSDOM } from "jsdom";

export const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";

// Strings that must never reach a capture payload, status, storage or log.
export const SENTINEL = {
  comment: "SENTINEL-COMMENT-TEXT-1c1c",
  sidebar: "SENTINEL-SIDEBAR-2d2d",
  nav: "SENTINEL-NAV-3e3e",
  draft: "SENTINEL-DRAFT-4f4f",
  typed: "SENTINEL-TYPED-5a5a",
  editable: "SENTINEL-EDITABLE-6b6b",
  sticky: "SENTINEL-STICKY-7c7c",
  button: "SENTINEL-BUTTON-8d8d",
};

export function issueMain({ owner = "acme", repo = "widgets", number = 1, title = "Issue title", body = "<p>Issue body</p>", comments = 2 } = {}) {
  const c = Array.from(
    { length: comments },
    (_, i) =>
      `<div data-testid="comment-viewer-outer-box-IC_${i}"><div data-testid="comment-header">hdr</div><div data-testid="markdown-body" class="markdown-body"><p>${SENTINEL.comment} ${i}</p></div></div>`,
  ).join("");
  return `<div data-testid="issue-viewer-container">
  <div data-testid="issue-header"><h1><bdi data-testid="issue-title" class="markdown-title">${title}</bdi><span><span class="issueNumberText"> #${number}</span></span></h1></div>
  <div data-testid="issue-metadata-sticky"><span data-testid="issue-title-sticky">${SENTINEL.sticky}</span></div>
  <div data-testid="issue-viewer-issue-container">
    <div data-testid="issue-body">
      <a data-testid="issue-body-header-author" href="/someone">someone</a>
      <a data-testid="issue-body-header-link" href="https://github.com/${owner}/${repo}/issues/${number}#issue-9${number}">opened</a>
      <div data-testid="issue-body-viewer"><div data-testid="markdown-body" class="markdown-body">${body}</div></div>
    </div>
  </div>
  <div data-testid="issue-viewer-comments-container">${c}</div>
  <form data-testid="comment-composer"><textarea name="c">${SENTINEL.draft}</textarea><input value="${SENTINEL.draft}"></form>
  <div data-testid="issue-viewer-metadata-pane">${SENTINEL.sidebar}</div>
</div>`;
}

export const listMain = () =>
  `<div data-testid="issues-list-surface"><a data-testid="issue-listitem-title-link" href="https://github.com/acme/widgets/issues/1">One</a></div>`;
export const repoHomeMain = () => `<div id="repo-home"><a href="/acme/widgets/issues">Issues</a> README text</div>`;

export function page(mainHtml) {
  return `<!doctype html><html><head><title>t</title></head><body><header><nav data-testid="top-nav-left">${SENTINEL.nav}</nav></header><main id="main">${mainHtml}</main></body></html>`;
}

/**
 * A jsdom window at `url`, with counters on every text-reading accessor.
 * reads.nodeValue counts text-node reads (the extractor's only text path);
 * reads.other counts textContent/innerText/innerHTML/outerHTML/value reads,
 * which the extractor must never use.
 */
export function makeDom(url, mainHtml) {
  const dom = new JSDOM(page(mainHtml), { url, pretendToBeVisual: true, runScripts: "outside-only" });
  const win = dom.window;
  const reads = { nodeValue: 0, other: 0, counting: true };
  const wrap = (proto, prop, key) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d?.get) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get() {
        if (reads.counting) reads[key]++;
        return d.get.call(this);
      },
      set: d.set,
    });
  };
  wrap(win.Node.prototype, "nodeValue", "nodeValue");
  wrap(win.Node.prototype, "textContent", "other");
  wrap(win.HTMLElement.prototype, "innerText", "other");
  wrap(win.Element.prototype, "innerHTML", "other");
  wrap(win.Element.prototype, "outerHTML", "other");
  wrap(win.HTMLTextAreaElement.prototype, "value", "other");
  wrap(win.HTMLInputElement.prototype, "value", "other");
  let visibility = "visible";
  Object.defineProperty(win.document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(win.document, "hidden", { configurable: true, get: () => visibility !== "visible" });
  const fetchCalls = [];
  win.fetch = (...a) => {
    fetchCalls.push(a);
    return Promise.reject(new Error("no network"));
  };
  return {
    dom,
    win,
    doc: win.document,
    reads,
    fetchCalls,
    /** Uncounted snapshot of the whole page, for "no page writes" checks. */
    html() {
      const was = reads.counting;
      reads.counting = false;
      const h = win.document.documentElement.outerHTML;
      reads.counting = was;
      return h;
    },
    setMain(html) {
      const was = reads.counting;
      reads.counting = false;
      win.document.getElementById("main").innerHTML = html;
      reads.counting = was;
    },
    /** SPA navigation: URL changes without a document load. */
    pushUrl(u) {
      win.history.pushState({}, "", u);
    },
    setVisible(v) {
      visibility = v ? "visible" : "hidden";
      win.document.dispatchEvent(new win.Event("visibilitychange"));
    },
  };
}

function ev() {
  const ls = [];
  return {
    ls,
    addListener: (f) => ls.push(f),
    removeListener: (f) => ls.splice(ls.indexOf(f), 1),
    emit: (...a) => ls.map((f) => f(...a)),
  };
}

export function makePort(name) {
  const port = {
    name,
    posted: [],
    onMessage: ev(),
    onDisconnect: ev(),
    postMessage(m) {
      port.posted.push(m);
      port.onPost?.(m);
    },
    disconnect() {},
    reply(m) {
      port.onMessage.emit(m);
    },
  };
  return port;
}

/**
 * Fake chrome for the background. `host` decides how a new native port
 * behaves: "ok" (hello-ack + server connected), "missing" (disconnects with
 * the host-not-found error), or a function(port).
 */
export function makeChrome({ granted = false, host = "ok" } = {}) {
  const tabs = new Map();
  const windows = new Map();
  const registered = [];
  const executeCalls = [];
  const tabMessages = [];
  const storageWrites = [];
  const store = {};
  const ports = [];
  const chrome = {
    _: { tabs, windows, registered, executeCalls, tabMessages, storageWrites, store, ports, granted, host },
    runtime: {
      id: EXT_ID,
      lastError: undefined,
      onMessage: ev(),
      getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
      connectNative(name) {
        const port = makePort(name);
        ports.push(port);
        const h = chrome._.host;
        if (h === "ok") {
          port.onPost = (m) => {
            if (m.type === "hello") queueMicrotask(() => port.reply({ type: "hello-ack", protocol: 1, server: "connected" }));
            if (m.type === "capture") queueMicrotask(() => port.reply({ type: "ack", id: m.id, msgType: "capture", bytes: 1, sha256: "0" }));
          };
        } else if (h === "missing") {
          queueMicrotask(() => {
            chrome.runtime.lastError = { message: "Specified native messaging host not found." };
            port.onDisconnect.emit(port);
            chrome.runtime.lastError = undefined;
          });
        } else if (typeof h === "function") h(port);
        return port;
      },
    },
    permissions: {
      contains: async ({ origins }) => chrome._.granted && origins.length === 1 && origins[0] === "https://github.com/*",
      onAdded: ev(),
      onRemoved: ev(),
    },
    scripting: {
      async registerContentScripts(arr) {
        for (const s of arr) {
          if (registered.some((r) => r.id === s.id)) throw new Error("Duplicate script ID");
          registered.push(s);
        }
      },
      async getRegisteredContentScripts({ ids }) {
        return registered.filter((r) => ids.includes(r.id));
      },
      async unregisterContentScripts({ ids }) {
        for (const id of ids) {
          const i = registered.findIndex((r) => r.id === id);
          if (i < 0) throw new Error("Nonexistent script ID");
          registered.splice(i, 1);
        }
      },
      async executeScript(x) {
        executeCalls.push(x);
        return [];
      },
    },
    tabs: {
      async query({ active, lastFocusedWindow, url }) {
        const lastWin = [...windows.values()].find((w) => w.lastFocused);
        if (url !== undefined && (url !== "https://github.com/*" || !chrome._.granted)) throw new Error("unsupported query");
        return [...tabs.values()]
          .filter((t) => (!active || t.active) && (!lastFocusedWindow || t.windowId === lastWin?.id))
          .filter((t) => url === undefined || /^https:\/\/github\.com\//.test(t.url))
          .map((t) => ({ ...t, url: chrome._.granted && /^https:\/\/github\.com\//.test(t.url) ? t.url : undefined }));
      },
      async sendMessage(tabId, msg, opts) {
        tabMessages.push({ tabId, msg, opts });
      },
      onActivated: ev(),
      onUpdated: ev(),
      onRemoved: ev(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      async get(id) {
        const w = windows.get(id);
        return w ? { id: w.id, focused: w.focused, incognito: false } : undefined;
      },
      onFocusChanged: ev(),
    },
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, ...store };
        },
        async set(o) {
          storageWrites.push(JSON.parse(JSON.stringify(o)));
          Object.assign(store, o);
        },
      },
    },
  };
  windows.set(1, { id: 1, focused: true, lastFocused: true });
  tabs.set(10, { id: 10, windowId: 1, active: true, url: "https://github.com/acme/widgets/issues/1", incognito: false });
  tabs.set(11, { id: 11, windowId: 1, active: false, url: "https://github.com/acme/widgets/issues/2", incognito: false });
  tabs.set(12, { id: 12, windowId: 1, active: false, url: "https://example.com/", incognito: false });
  return chrome;
}

/**
 * A content-script MessageSender. `url` is sender.url, which real Chrome
 * appears to leave at the document's first URL across SPA navigation
 * (strongly suggested by the 2026-09-28 live run, not directly logged), so
 * tests may pass a stale one. sender.tab.url is the
 * browser-owned current tab URL (present only with host access), taken from
 * the fake tab unless `tabUrl` overrides it.
 */
export function sender(chrome, { tabId = 10, url, tabUrl, documentId = "doc-1", frameId = 0, incognito = false, id = EXT_ID, origin = "https://github.com", documentLifecycle = "active" } = {}) {
  const t = chrome._.tabs.get(tabId);
  const current = tabUrl ?? t?.url;
  const tab = { id: tabId, windowId: t?.windowId ?? 1, incognito };
  if (chrome._.granted && /^https:\/\/github\.com\//.test(current ?? "")) tab.url = current;
  return { id, frameId, documentId, documentLifecycle, url: url ?? t?.url, origin, tab };
}

export const popupSender = () => ({ id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html` });

export const flush = () => new Promise((r) => setTimeout(r, 0));
