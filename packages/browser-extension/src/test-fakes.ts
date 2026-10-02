// Test-only fakes (never bundled): a synthetic GitHub issue DOM mirroring the
// live structure (data-testid layout verified 2026-09-24), a read-counting
// jsdom with a synthetic History/Navigation driver, a fake clock, and a fake
// `chrome` for the background. Ported from the Phase 0 spike's test-fakes.mjs.

import { JSDOM } from "jsdom";

export const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";

/** Strings that must never reach a message. */
export const SENTINEL = {
  comment: "SENTINEL-COMMENT-TEXT-1c1c",
  sidebar: "SENTINEL-SIDEBAR-2d2d",
  nav: "SENTINEL-NAV-3e3e",
  draft: "SENTINEL-DRAFT-4f4f",
  sticky: "SENTINEL-STICKY-7c7c",
};

export function issueMain({ owner = "acme", repo = "widgets", number = 1, title = "Issue title", body = "<p>Issue body</p>" } = {}): string {
  return `<div data-testid="issue-viewer-container">
  <div data-testid="issue-header"><h1><bdi data-testid="issue-title" class="markdown-title">${title}</bdi><span> #${number}</span></h1></div>
  <div data-testid="issue-metadata-sticky"><span data-testid="issue-title-sticky">${SENTINEL.sticky}</span></div>
  <div data-testid="issue-body">
    <a data-testid="issue-body-header-link" href="https://github.com/${owner}/${repo}/issues/${number}#issue-9${number}">opened</a>
    <div data-testid="issue-body-viewer"><div data-testid="markdown-body" class="markdown-body">${body}</div></div>
  </div>
  <div data-testid="issue-viewer-comments-container"><div data-testid="markdown-body">${SENTINEL.comment}</div></div>
  <form data-testid="comment-composer"><textarea>${SENTINEL.draft}</textarea></form>
  <div data-testid="issue-viewer-metadata-pane">${SENTINEL.sidebar}</div>
</div>`;
}

export const listMain = (): string =>
  `<div data-testid="issues-list-surface"><a data-testid="issue-listitem-title-link" href="https://github.com/acme/widgets/issues/1">One</a></div>`;
export const repoHomeMain = (): string => `<div id="repo-home"><a href="/acme/widgets/issues">Issues</a> README text</div>`;

const page = (main: string) =>
  `<!doctype html><html><head><title>t</title></head><body><header><nav>${SENTINEL.nav}</nav></header><main id="main">${main}</main></body></html>`;

/**
 * A jsdom window at `url` with counters on every text-reading accessor:
 * reads.nodeValue counts text-node reads (the extractor's only text path);
 * reads.other counts textContent/innerText/innerHTML/outerHTML/value reads,
 * which the extractor must never use. `navigate` is the synthetic
 * History/Navigation driver: pushState, then the Navigation API's
 * `currententrychange` event (jsdom has no Navigation API).
 */
export function makeDom(url: string, mainHtml: string) {
  const dom = new JSDOM(page(mainHtml), { url, pretendToBeVisual: true });
  const win = dom.window as unknown as Window & typeof globalThis;
  const reads = { nodeValue: 0, other: 0, counting: true };
  const wrap = (proto: object, prop: string, key: "nodeValue" | "other") => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d?.get) return;
    const get = d.get;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: d.enumerable ?? false,
      get() {
        if (reads.counting) reads[key]++;
        return get.call(this);
      },
      ...(d.set ? { set: d.set } : {}),
    });
  };
  wrap(win.Node.prototype, "nodeValue", "nodeValue");
  wrap(win.Node.prototype, "textContent", "other");
  wrap(win.HTMLElement.prototype, "innerText", "other");
  wrap(win.Element.prototype, "innerHTML", "other");
  wrap(win.Element.prototype, "outerHTML", "other");
  wrap(win.HTMLTextAreaElement.prototype, "value", "other");
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(win.document, "visibilityState", { configurable: true, get: () => visibility });
  const navigation = new win.EventTarget();
  const uncounted = <T>(fn: () => T): T => {
    const was = reads.counting;
    reads.counting = false;
    try {
      return fn();
    } finally {
      reads.counting = was;
    }
  };
  return {
    win,
    doc: win.document,
    reads,
    navigation,
    setMain(html: string) {
      uncounted(() => {
        win.document.getElementById("main")!.innerHTML = html;
      });
    },
    /** SPA navigation: URL changes without a document load, with the Navigation API event. */
    navigate(u: string) {
      win.history.pushState({}, "", u);
      navigation.dispatchEvent(new win.Event("currententrychange"));
    },
    /** URL changes with no event at all (only the 1 s check can see it). */
    pushSilently(u: string) {
      win.history.pushState({}, "", u);
    },
    setVisible(v: boolean) {
      visibility = v ? "visible" : "hidden";
      win.document.dispatchEvent(new win.Event("visibilitychange"));
    },
    close() {
      win.close();
    },
  };
}

/** Let pending promise callbacks and jsdom mutation records run. */
export const flush = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

/** A deterministic clock with setTimeout and setInterval. */
export function fakeClock(start = 1_000_000) {
  let t = start;
  let nextId = 1;
  const q = new Map<number, { at: number; fn: () => void; every: number | null }>();
  const clock = {
    now: () => t,
    setTimeout(fn: () => void, ms: number): unknown {
      const id = nextId++;
      q.set(id, { at: t + ms, fn, every: null });
      return id;
    },
    clearTimeout(h: unknown) {
      q.delete(h as number);
    },
    setInterval(fn: () => void, ms: number): unknown {
      const id = nextId++;
      q.set(id, { at: t + ms, fn, every: ms });
      return id;
    },
    clearInterval(h: unknown) {
      q.delete(h as number);
    },
    get pending() {
      return q.size;
    },
    /** Run every timer due within `ms`, in order, flushing promises between them. */
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        await flush(2);
        let nid = -1;
        let n: { at: number; fn: () => void; every: number | null } | undefined;
        for (const [id, e] of q) if (e.at <= end && (!n || e.at < n.at)) [nid, n] = [id, e];
        if (!n) break;
        t = n.at;
        if (n.every !== null) n.at = t + n.every;
        else q.delete(nid);
        n.fn();
      }
      t = end;
      await flush(2);
    },
  };
  return clock;
}

function ev<F extends (...a: never[]) => unknown>() {
  const ls: F[] = [];
  return {
    ls,
    addListener: (f: F) => void ls.push(f),
    removeListener: (f: F) => void ls.splice(ls.indexOf(f), 1),
    emit: (...a: Parameters<F>) => ls.map((f) => f(...a)),
  };
}

export interface FakePort {
  name: string;
  posted: Array<Record<string, unknown>>;
  onMessage: ReturnType<typeof ev<(m: unknown) => void>>;
  onDisconnect: ReturnType<typeof ev<(p: unknown) => void>>;
  postMessage(m: unknown): void;
  disconnect(): void;
  disconnected: boolean;
}

function makePort(name: string, onPost: (port: FakePort, m: Record<string, unknown>) => void): FakePort {
  const port: FakePort = {
    name,
    posted: [],
    onMessage: ev(),
    onDisconnect: ev(),
    disconnected: false,
    postMessage(m) {
      if (port.disconnected) throw new Error("Attempting to use a disconnected port object");
      const copy = JSON.parse(JSON.stringify(m)) as Record<string, unknown>;
      port.posted.push(copy);
      onPost(port, copy);
    },
    disconnect() {
      port.disconnected = true;
    },
  };
  return port;
}

export interface FakeTab {
  id: number;
  windowId: number;
  active: boolean;
  url: string;
  title: string;
  incognito: boolean;
  index?: number;
}

/** One end of a runtime.Port between two extension contexts (the side panel and the worker). */
export interface LinkedPort {
  name: string;
  sender?: chrome.runtime.MessageSender;
  /** Messages this end posted. */
  posted: unknown[];
  onMessage: ReturnType<typeof ev<(m: unknown) => void>>;
  onDisconnect: ReturnType<typeof ev<(p: unknown) => void>>;
  postMessage(m: unknown): void;
  disconnect(): void;
  disconnected: boolean;
  peer: LinkedPort | null;
}

function linkedPort(name: string): LinkedPort {
  const port: LinkedPort = {
    name,
    posted: [],
    onMessage: ev(),
    onDisconnect: ev(),
    disconnected: false,
    peer: null,
    postMessage(m) {
      if (port.disconnected) throw new Error("Attempting to use a disconnected port object");
      const copy = JSON.parse(JSON.stringify(m)) as unknown;
      port.posted.push(copy);
      const peer = port.peer;
      queueMicrotask(() => {
        if (peer && !peer.disconnected) peer.onMessage.emit(copy);
      });
    },
    disconnect() {
      if (port.disconnected) return;
      port.disconnected = true;
      const peer = port.peer;
      if (peer && !peer.disconnected) {
        peer.disconnected = true;
        queueMicrotask(() => peer.onDisconnect.emit(peer));
      }
    },
  };
  return port;
}

/**
 * Whether Chrome match pattern `pattern` covers `target` (a URL or another
 * pattern), the way permissions.contains treats a broad grant: "<all_urls>",
 * a "*" scheme (http/https), a "*" or "*.host" host, and "*" path globs.
 */
export function patternCovers(pattern: string, target: string): boolean {
  if (pattern === "<all_urls>") return /^(https?|wss?|ftp|file):/.test(target);
  const pm = /^(\*|[a-z]+):\/\/([^/]*)(\/.*)$/.exec(pattern);
  const tm = /^([a-z]+):\/\/([^/]*)(\/.*)?$/.exec(target);
  if (!pm || !tm) return false;
  const [, ps, ph, pp] = pm as unknown as [string, string, string, string];
  const [, ts, th, tp = "/"] = tm as unknown as [string, string, string, string | undefined];
  if (ps === "*" ? ts !== "http" && ts !== "https" : ps !== ts) return false;
  if (ph !== "*" && ph !== th && !(ph.startsWith("*.") && (th === ph.slice(2) || th.endsWith(ph.slice(1))))) return false;
  const glob = new RegExp(`^${pp.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return glob.test(tp);
}

/** The core's answer to hello: capture disabled until it has the extension's snapshot. */
export const DISABLED_POLICY = { type: "capture_policy", revision: 1, paused: false, captureEnabled: false } as const;

/**
 * Fake chrome. `host` decides how a new native port behaves: "ok" (stays
 * open; like the native host with a protocol-2 core, it sends the core's
 * capture-disabled policy, then ready), "silent" (stays open, says nothing)
 * or "missing" (disconnects at once with the host-not-found error). With
 * `autoEnable` (default on), the fake core answers the first permissions
 * snapshot on a port with an enabling policy. Tab url/title are visible only
 * for hosts in `granted`, and for the tab holding the temporary activeTab
 * grant (`state.activeTabGrant`). `local` seeds chrome.storage.local. Pass the
 * same `session` object to two fakes to model a service-worker restart
 * (chrome.storage.session survives it; everything in memory does not).
 */
export function makeChrome({
  granted = [] as string[],
  host = "ok" as "ok" | "silent" | "missing",
  session = {} as Record<string, unknown>,
  local = {} as Record<string, unknown>,
  autoEnable = true,
  getContexts = true,
} = {}) {
  const tabs = new Map<number, FakeTab>();
  const windows = new Map<number, { id: number; focused: boolean }>();
  const registered: chrome.scripting.RegisteredContentScript[] = [];
  const executeCalls: unknown[] = [];
  const tabMessages: Array<{ tabId: number; msg: unknown }> = [];
  const store: Record<string, unknown> = { ...local };
  const ports: FakePort[] = [];
  const state = {
    granted: [...granted],
    host,
    storageFails: false,
    storageSetFails: false,
    lastFocusedWindow: 1,
    autoEnable,
    activeTabGrant: null as number | null,
    /** Open side-panel contexts runtime.getContexts reports. */
    sidePanels: 0,
    badge: "",
    badgeColor: null as string | null,
    panelBehavior: null as unknown,
    /** What permissions.request answers (Chrome's prompt); a yes adds the pattern. */
    grantOnRequest: true,
    createFails: false,
  };
  const panelPorts: LinkedPort[] = [];
  const created: chrome.tabs.CreateProperties[] = [];
  const requested: string[][] = [];
  const removedPerms: string[][] = [];
  const visible = (u: string) => state.granted.some((p) => patternCovers(p, u));
  const enabledOn = new Set<FakePort>();
  /** The fake core: answer the first permissions snapshot on a port with an enabling policy. */
  const onPost = (port: FakePort, m: Record<string, unknown>) => {
    if (!state.autoEnable || m["kind"] !== "permissions" || enabledOn.has(port)) return;
    enabledOn.add(port);
    queueMicrotask(() => {
      if (!port.disconnected) port.onMessage.emit({ type: "capture_policy", revision: 2, paused: false, captureEnabled: true });
    });
  };
  const view = (t: FakeTab) => {
    const o: Record<string, unknown> = { id: t.id, windowId: t.windowId, active: t.active, incognito: t.incognito, index: t.index ?? t.id - 10 };
    if (visible(t.url) || state.activeTabGrant === t.id) {
      o["url"] = t.url;
      o["title"] = t.title;
    }
    return o as unknown as chrome.tabs.Tab;
  };
  const fake = {
    _: { tabs, windows, registered, executeCalls, tabMessages, store, session, ports, state, panelPorts, created, requested, removedPerms },
    runtime: {
      id: EXT_ID,
      lastError: undefined as { message: string } | undefined,
      onMessage: ev(),
      onConnect: ev<(p: chrome.runtime.Port) => void>(),
      getURL: (p: string) => `chrome-extension://${EXT_ID}/${p}`,
      /** The panel page's runtime.connect: the worker gets the other end through onConnect. */
      connect({ name = "" }: { name?: string } = {}, sender: chrome.runtime.MessageSender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/panel.html` }) {
        const panelSide = linkedPort(name);
        const workerSide = linkedPort(name);
        panelSide.peer = workerSide;
        workerSide.peer = panelSide;
        workerSide.sender = sender;
        panelPorts.push(workerSide);
        queueMicrotask(() => fake.runtime.onConnect.emit(workerSide as unknown as chrome.runtime.Port));
        return panelSide as unknown as chrome.runtime.Port;
      },
      getContexts: getContexts
        ? async ({ contextTypes }: { contextTypes?: string[] }) =>
            contextTypes?.includes("SIDE_PANEL") ? Array.from({ length: state.sidePanels }, () => ({ contextType: "SIDE_PANEL" })) : []
        : undefined,
      connectNative(name: string) {
        const port = makePort(name, onPost);
        ports.push(port);
        if (state.host === "missing") {
          queueMicrotask(() => {
            fake.runtime.lastError = { message: "Specified native messaging host not found." };
            port.disconnected = true;
            port.onDisconnect.emit(port);
            fake.runtime.lastError = undefined;
          });
        } else if (state.host === "ok") {
          queueMicrotask(() => {
            if (port.disconnected) return;
            port.onMessage.emit({ ...DISABLED_POLICY });
            port.onMessage.emit({ type: "ready" });
          });
        }
        return port;
      },
      onInstalled: ev<(d: unknown) => void>(),
    },
    permissions: {
      contains: async ({ origins }: { origins: string[] }) => origins.every((o) => state.granted.some((p) => patternCovers(p, o))),
      getAll: async () => ({ origins: [...state.granted], permissions: [] }),
      async request({ origins }: { origins: string[] }) {
        requested.push(origins);
        if (!state.grantOnRequest) return false;
        for (const o of origins) if (!state.granted.includes(o)) state.granted.push(o);
        await Promise.all(fake.permissions.onAdded.emit({ origins } as never));
        return true;
      },
      async remove({ origins }: { origins: string[] }) {
        removedPerms.push(origins);
        state.granted = state.granted.filter((g) => !origins.includes(g));
        await Promise.all(fake.permissions.onRemoved.emit({ origins } as never));
        return true;
      },
      onAdded: ev(),
      onRemoved: ev(),
    },
    action: {
      async setBadgeText({ text }: { text: string }) {
        state.badge = text;
      },
      async setBadgeBackgroundColor({ color }: { color: string }) {
        state.badgeColor = color;
      },
    },
    sidePanel: {
      async setPanelBehavior(b: unknown) {
        state.panelBehavior = b;
      },
      onOpened: ev(),
    },
    scripting: {
      async registerContentScripts(arr: chrome.scripting.RegisteredContentScript[]) {
        for (const s of arr) {
          if (registered.some((r) => r.id === s.id)) throw new Error("Duplicate script ID");
          registered.push(s);
        }
      },
      async getRegisteredContentScripts({ ids }: { ids: string[] }) {
        return registered.filter((r) => ids.includes(r.id));
      },
      async unregisterContentScripts({ ids }: { ids: string[] }) {
        for (const id of ids) {
          const i = registered.findIndex((r) => r.id === id);
          if (i < 0) throw new Error("Nonexistent script ID");
          registered.splice(i, 1);
        }
      },
      async executeScript(x: unknown) {
        executeCalls.push(x);
        return [];
      },
    },
    tabs: {
      async query(q: { active?: boolean; lastFocusedWindow?: boolean; url?: string; windowId?: number }) {
        return [...tabs.values()]
          .filter((t) => (!q.active || t.active) && (!q.lastFocusedWindow || t.windowId === state.lastFocusedWindow))
          .filter((t) => q.windowId === undefined || t.windowId === q.windowId)
          .filter((t) => q.url === undefined || (visible(t.url) && patternCovers(q.url, t.url)))
          .map(view);
      },
      async sendMessage(tabId: number, msg: unknown) {
        tabMessages.push({ tabId, msg });
      },
      async create(props: chrome.tabs.CreateProperties) {
        if (state.createFails) throw new Error("No tab with id");
        created.push(props);
        const id = 100 + created.length;
        tabs.set(id, { id, windowId: props.windowId ?? 1, active: props.active !== false, url: props.url ?? "", title: "", incognito: false });
        return { id, windowId: props.windowId ?? 1 } as chrome.tabs.Tab;
      },
      onActivated: ev(),
      onUpdated: ev(),
      onRemoved: ev(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      async get(id: number) {
        const w = windows.get(id);
        return w ? { id: w.id, focused: w.focused, incognito: false } : undefined;
      },
      async getCurrent() {
        return { id: state.lastFocusedWindow, focused: true };
      },
      async getLastFocused() {
        const w = windows.get(state.lastFocusedWindow);
        return { id: w?.id, focused: w?.focused === true };
      },
      onFocusChanged: ev(),
    },
    storage: {
      local: {
        async get(defaults: Record<string, unknown>) {
          if (state.storageFails) throw new Error("storage unavailable");
          return { ...defaults, ...store };
        },
        async set(o: Record<string, unknown>) {
          if (state.storageSetFails) throw new Error("storage unavailable");
          Object.assign(store, o);
        },
      },
      session: {
        async get(key: string) {
          return key in session ? { [key]: structuredClone(session[key]) } : {};
        },
        async set(o: Record<string, unknown>) {
          Object.assign(session, structuredClone(o));
        },
      },
    },
  };
  windows.set(1, { id: 1, focused: true });
  tabs.set(10, { id: 10, windowId: 1, active: true, url: "https://github.com/acme/widgets/issues/1", title: "Issue 1", incognito: false });
  tabs.set(11, { id: 11, windowId: 1, active: false, url: "https://github.com/acme/widgets/issues/2", title: "Issue 2", incognito: false });
  tabs.set(12, { id: 12, windowId: 1, active: false, url: "https://example.com/", title: "Example", incognito: false });
  return fake;
}

export type FakeChrome = ReturnType<typeof makeChrome>;
export const asChrome = (f: FakeChrome): typeof chrome => f as unknown as typeof chrome;

/** Make `tabId` the active tab of its window (and focus that window). */
export function activate(f: FakeChrome, tabId: number): void {
  const t = f._.tabs.get(tabId)!;
  for (const o of f._.tabs.values()) if (o.windowId === t.windowId) o.active = o.id === tabId;
}

/**
 * A content-script MessageSender. `url` is sender.url, which real Chrome
 * appears to keep at the document's first URL across SPA navigation, so tests
 * may pass a stale one. sender.tab.url is the browser-owned current tab URL
 * (present only with host access), taken from the fake tab.
 */
export function sender(f: FakeChrome, { tabId = 10, url, documentId = "doc-1", frameId = 0 }: { tabId?: number; url?: string; documentId?: string; frameId?: number } = {}): chrome.runtime.MessageSender {
  const t = f._.tabs.get(tabId)!;
  return {
    id: EXT_ID,
    frameId,
    documentId,
    documentLifecycle: "active",
    url: url ?? t.url,
    origin: "https://github.com",
    tab: fakeView(f, t),
  } as chrome.runtime.MessageSender;
}

function fakeView(f: FakeChrome, t: FakeTab): chrome.tabs.Tab {
  const o: Record<string, unknown> = { id: t.id, windowId: t.windowId, active: t.active, incognito: t.incognito };
  if (f._.state.granted.some((p) => patternCovers(p, t.url))) o["url"] = t.url;
  return o as unknown as chrome.tabs.Tab;
}

