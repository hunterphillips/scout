// Background service-worker logic (pure; `chrome` and the clock injected).
//
// Owns the one native port to `dev.scout.bridge`, the bounded reconnect
// policy, focus observations, the host-permission lifecycle (including the
// GitHub content script's registration), and the approval gate for GitHub
// issue text. Page text passes through memory once, straight to the native
// port; it is never stored, logged, or kept in the popup status.
//
// Kept from the live-verified Phase 0 spike:
// - sender.url is not a route authority: Chrome appears to keep it at the
//   document's first URL across GitHub's in-page navigation. It is checked for
//   origin only. The route comes from the browser-owned tab URL: sender.tab.url
//   at request time, then a fresh active-tab query.
// - a cancel epoch, bumped by pause, revoke, tab change and focus loss, that
//   approval and forwarding snapshot on entry and re-check after every await;
// - the paused flag is read from storage before any content message is
//   answered, and storage failure means paused.

import {
  type BrowserObservation,
  type FocusObservation,
  type PageTextObservation,
  PageTextObservationSchema,
  ToChromeFrameSchema,
} from "@scout/contracts";
import { GITHUB_PATTERN, HOST_NAME, OPTIONAL_HOSTS } from "./hosts.js";
import type {
  ApproveRequest,
  ApproveResponse,
  BackgroundToContent,
  DenialCode,
  LinkState,
  PageTextMessage,
  PopupRequest,
  StatusSnapshot,
} from "./messages.js";
import { type Clock, createReconnectPolicy, type ReconnectPolicy } from "./reconnect.js";
import { type IssueRoute, parseIssueRoute } from "./route.js";

export { GITHUB_PATTERN, HOST_NAME, OPTIONAL_HOSTS };

export const CONTENT_SCRIPT_ID = "scout-github-issue";
export const CONTENT_SCRIPT_FILE = "content/github-issue.js";
export const FOCUS_DEBOUNCE_MS = 150;
/** A port that stayed up this long without core_unavailable counts as healthy. */
export const HEALTHY_AFTER_MS = 5_000;
export const WINDOW_ID_NONE = -1;

export const CONTENT_SCRIPT: chrome.scripting.RegisteredContentScript = Object.freeze({
  id: CONTENT_SCRIPT_ID,
  matches: [GITHUB_PATTERN],
  js: [CONTENT_SCRIPT_FILE],
  runAt: "document_idle",
  allFrames: false,
  world: "ISOLATED",
  persistAcrossSessions: true,
}) as chrome.scripting.RegisteredContentScript;

type Port = chrome.runtime.Port;
type Tab = chrome.tabs.Tab;
type Sender = chrome.runtime.MessageSender;

interface Approval {
  documentId: string;
  navCounter: number;
  routeKey: string;
}

export interface BackgroundDeps {
  clock?: Clock;
}

export interface Background {
  start(): Promise<void>;
  install(): void;
  handleMessage(msg: unknown, sender: Sender): Promise<unknown>;
  snapshot(): StatusSnapshot;
  readonly port: Port | null;
  readonly policy: ReconnectPolicy;
  readonly approvals: Map<number, Approval>;
}

const defaultClock = (): Clock => ({
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
});

const githubOrigin = (u: string): boolean => {
  try {
    return new URL(u).origin === "https://github.com";
  } catch {
    return false;
  }
};

const tabRoute = (t: { url?: string | undefined } | undefined | null): IssueRoute | null =>
  typeof t?.url === "string" ? parseIssueRoute(t.url) : null;

const isObj = (m: unknown): m is Record<string, unknown> => typeof m === "object" && m !== null;

export function createBackground(ch: typeof chrome, deps: BackgroundDeps = {}): Background {
  const clock = deps.clock ?? defaultClock();
  const windowIdNone = ch.windows?.WINDOW_ID_NONE ?? WINDOW_ID_NONE;

  let port: Port | null = null;
  let portOpenedAt = 0;
  let portAcked = false;
  let coreUnavailable = false;
  let paused = false;
  let loaded: Promise<void> | null = null;
  let browserFocused = true;
  let seq = 0;
  let granted: string[] = [];
  let cancelEpoch = 0;
  let focusTimer: unknown = null;
  let chain: Promise<boolean> = Promise.resolve(false);
  const approvals = new Map<number, Approval>();
  const contentTabs = new Set<number>();
  const counters = { focus: 0, forwarded: 0, dropped: 0, acked: 0, denied: 0 };

  const policy = createReconnectPolicy({ clock, attempt: () => connect() });

  /** Load persisted state once; every content message waits for it. Fails closed (paused). */
  function loadState(): Promise<void> {
    loaded ??= Promise.resolve()
      .then(() => ch.storage.local.get({ paused: false }))
      .then(
        (stored) => {
          paused = stored?.["paused"] === true;
        },
        () => {
          paused = true;
        },
      );
    return loaded;
  }

  // ---------- native port ----------
  function post(obs: BrowserObservation): boolean {
    if (!port) return false;
    try {
      port.postMessage(obs);
      return true;
    } catch {
      return false;
    }
  }

  function connect(): void {
    if (port) return;
    let p: Port;
    try {
      p = ch.runtime.connectNative(HOST_NAME);
    } catch {
      policy.disconnected(false);
      return;
    }
    port = p;
    portOpenedAt = clock.now();
    portAcked = false;
    coreUnavailable = false;
    p.onMessage.addListener((m: unknown) => onHostMessage(p, m));
    p.onDisconnect.addListener(() => {
      void ch.runtime.lastError; // read it so Chrome does not log it as unchecked
      if (port !== p) return;
      port = null;
      const healthy = portAcked || (!coreUnavailable && clock.now() - portOpenedAt >= HEALTHY_AFTER_MS);
      cancelTabs();
      policy.disconnected(healthy);
    });
    post({ kind: "permissions", granted: [...granted] });
    scheduleFocus();
    void refreshActive();
  }

  function onHostMessage(p: Port, m: unknown): void {
    if (port !== p) return;
    const parsed = ToChromeFrameSchema.safeParse(m);
    if (!parsed.success) return;
    if (parsed.data.type === "core_unavailable") {
      coreUnavailable = true;
    } else {
      portAcked = true;
      coreUnavailable = false;
      counters.acked++;
    }
  }

  function linkState(): LinkState {
    if (port) return coreUnavailable ? "core_unavailable" : "connected";
    return policy.pending ? "connecting" : "disconnected";
  }

  /** Tab and focus events: may start one fresh series (policy enforces the 60 s limit). */
  function trigger(): void {
    if (!port) policy.trigger();
  }

  function manualReconnect(): void {
    if (port) {
      const p = port;
      port = null; // our own disconnect() does not fire onDisconnect
      try {
        p.disconnect();
      } catch {
        // already gone
      }
      cancelTabs();
    }
    policy.manual();
  }

  // ---------- focus observations ----------
  function scheduleFocus(): void {
    if (focusTimer !== null) clock.clearTimeout(focusTimer);
    focusTimer = clock.setTimeout(() => {
      focusTimer = null;
      void emitFocus();
    }, FOCUS_DEBOUNCE_MS);
  }

  async function activeTab(): Promise<Tab | null> {
    const [t] = await ch.tabs.query({ active: true, lastFocusedWindow: true });
    return t ?? null;
  }

  async function readFocus(): Promise<FocusObservation> {
    if (!browserFocused) return { kind: "focus", seq: ++seq, at: clock.now(), browserFocused: false, windowId: windowIdNone };
    const t = await activeTab().catch(() => null);
    const obs: FocusObservation = { kind: "focus", seq: ++seq, at: clock.now(), browserFocused: true, windowId: t?.windowId ?? windowIdNone };
    if (!t) return obs;
    if (Number.isInteger(t.id) && t.id !== undefined && t.id >= 0) obs.tabId = t.id;
    // Chrome only fills url/title for tabs whose host is granted. Absent means unapproved.
    if (typeof t.url === "string" && t.url !== "") obs.url = t.url;
    if (typeof t.title === "string" && obs.url !== undefined) obs.title = t.title;
    obs.incognito = t.incognito === true;
    return obs;
  }

  async function emitFocus(): Promise<void> {
    await loadState();
    if (paused) return;
    const obs = await readFocus();
    if (paused) return;
    if (post(obs)) counters.focus++;
  }

  // ---------- permissions ----------
  async function githubGranted(): Promise<boolean> {
    try {
      return (await ch.permissions.contains({ origins: [GITHUB_PATTERN] })) === true;
    } catch {
      return false;
    }
  }

  /** Refresh the granted list and (un)register the GitHub content script. Resolves to "GitHub granted". */
  function reconcile(): Promise<boolean> {
    chain = chain
      .then(async () => {
        const all = await ch.permissions.getAll();
        granted = (all.origins ?? []).filter((o) => OPTIONAL_HOSTS.includes(o));
        const gh = await githubGranted();
        const regs = await ch.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
        if (gh && regs.length === 0) await ch.scripting.registerContentScripts([{ ...CONTENT_SCRIPT }]);
        if (!gh) {
          cancelTabs({ stop: true });
          if (regs.length > 0) await ch.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
        }
        return gh;
      })
      .catch(() => false);
    return chain;
  }

  /**
   * After a grant, GitHub pages already open never got the registered script,
   * and SPA navigation will not load it. Inject into their top frames once; a
   * second injection is a no-op.
   */
  async function injectIntoOpenGithubTabs(): Promise<void> {
    const tabs = await ch.tabs.query({ url: GITHUB_PATTERN }).catch(() => [] as Tab[]);
    for (const t of tabs) {
      if (t.incognito || t.id === undefined || !Number.isInteger(t.id)) continue;
      await ch.scripting.executeScript({ target: { tabId: t.id, frameIds: [0] }, files: [CONTENT_SCRIPT_FILE] }).catch(() => {});
    }
  }

  // ---------- content scripts ----------
  function sendToTab(tabId: number, msg: BackgroundToContent): void {
    Promise.resolve()
      .then(() => ch.tabs.sendMessage(tabId, msg, { frameId: 0 }))
      .catch(() => {});
  }

  async function refreshActive(): Promise<void> {
    if (paused || !port) return;
    const t = await activeTab().catch(() => null);
    if (!t || t.incognito || t.id === undefined || !tabRoute(t)) return;
    sendToTab(t.id, { type: "refresh" });
  }

  /**
   * Stop reads now: drop every approval and send cancel to the top frame of
   * each known tab except `except` (a tab about to be asked to refresh).
   * `stop` also disconnects the script (permission revoked).
   */
  function cancelTabs({ stop = false, except = null }: { stop?: boolean; except?: number | null } = {}): void {
    const ids = new Set([...contentTabs, ...approvals.keys()]);
    cancelEpoch++;
    approvals.clear();
    if (stop) contentTabs.clear();
    for (const id of ids) if (id !== except) sendToTab(id, { type: "cancel", stop });
  }

  function senderOk(sender: Sender | undefined): sender is Sender & { tab: Tab & { id: number }; documentId: string; url: string } {
    return (
      !!sender &&
      sender.id === ch.runtime.id &&
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

  /** The browser's record of `tabId` if it is the active tab of the focused, non-incognito window. */
  async function foregroundTab(tabId: number): Promise<Tab | null> {
    if (!browserFocused) return null;
    const t = await activeTab();
    if (!t || t.id !== tabId || t.incognito) return null;
    const w = await ch.windows.get(t.windowId);
    return w?.focused === true && w.incognito !== true ? t : null;
  }

  const deny = (reason: DenialCode): ApproveResponse => {
    counters.denied++;
    return { approved: false, reason };
  };

  async function onApprove(msg: ApproveRequest, sender: Sender): Promise<ApproveResponse> {
    if (!senderOk(sender)) return deny("sender");
    const route = tabRoute(sender.tab);
    const asked = typeof msg.url === "string" ? parseIssueRoute(msg.url) : null;
    if (!route || !asked || route.key !== asked.key || !Number.isSafeInteger(msg.navCounter)) return deny("route");
    if (paused) return deny("paused");
    const epoch = cancelEpoch;
    if (!(await githubGranted())) return deny("permission");
    const fg = await foregroundTab(sender.tab.id).catch(() => null);
    if (!fg) return deny("not-foreground");
    if (tabRoute(fg)?.key !== route.key) return deny("route");
    if (epoch !== cancelEpoch || paused) return deny("cancelled");
    if (!port) {
      trigger();
      return deny("bridge-disconnected");
    }
    approvals.set(sender.tab.id, { documentId: sender.documentId, navCounter: msg.navCounter, routeKey: route.key });
    return { approved: true };
  }

  function validText(msg: PageTextMessage): boolean {
    return typeof msg.title === "string" && msg.title.length > 0 && typeof msg.text === "string" && typeof msg.truncated === "boolean";
  }

  /** Why a page_text message is dropped, or the route it may be forwarded under. */
  async function checkPageText(msg: PageTextMessage, sender: Sender): Promise<{ reason: string } | { route: IssueRoute }> {
    if (!senderOk(sender)) return { reason: "sender" };
    const a = approvals.get(sender.tab.id);
    if (!a) return { reason: "no-approval" };
    approvals.delete(sender.tab.id); // single use
    if (a.documentId !== sender.documentId) return { reason: "document-changed" };
    const msgRoute = typeof msg.url === "string" ? parseIssueRoute(msg.url) : null;
    if (!msgRoute || a.navCounter !== msg.navCounter || a.routeKey !== msgRoute.key) return { reason: "stale" };
    if (tabRoute(sender.tab)?.key !== msgRoute.key) return { reason: "url-changed" };
    if (paused) return { reason: "paused" };
    if (!(await githubGranted())) return { reason: "permission" };
    const fg = await foregroundTab(sender.tab.id).catch(() => null);
    if (!fg) return { reason: "not-foreground" };
    const current = tabRoute(fg);
    if (!current || current.key !== msgRoute.key) return { reason: "url-changed" };
    return { route: current };
  }

  async function onPageText(msg: PageTextMessage, sender: Sender): Promise<{ ok: boolean; reason?: string }> {
    const epoch = cancelEpoch;
    const drop = (reason: string) => {
      counters.dropped++;
      return { ok: false, reason };
    };
    if (!validText(msg)) return drop("payload");
    const c = await checkPageText(msg, sender);
    if ("reason" in c) return drop(c.reason);
    if (epoch !== cancelEpoch || paused) return drop("cancelled");
    if (!port) return drop("bridge-disconnected");
    const obs: PageTextObservation = {
      kind: "page_text",
      seq: seq + 1,
      at: clock.now(),
      tabId: sender.tab!.id!,
      documentId: sender.documentId!,
      url: c.route.canonicalUrl,
      source: "github_issue",
      title: msg.title,
      text: msg.text,
      truncated: msg.truncated,
    };
    if (!PageTextObservationSchema.safeParse(obs).success) return drop("payload");
    seq++;
    if (!post(obs)) return drop("bridge-disconnected");
    counters.forwarded++;
    return { ok: true };
  }

  // ---------- popup ----------
  function popupSender(sender: Sender | undefined): boolean {
    // Our own popup page (as the action popup, or opened in a tab). Content
    // scripts report the web page URL here, never a chrome-extension:// URL.
    if (!sender || sender.id !== ch.runtime.id || typeof sender.url !== "string") return false;
    return sender.url.split(/[?#]/)[0] === ch.runtime.getURL("popup.html");
  }

  function snapshot(): StatusSnapshot {
    return { link: linkState(), paused, granted: [...granted], counters: { ...counters } };
  }

  async function setPaused(next: boolean): Promise<void> {
    paused = next;
    if (paused) {
      cancelTabs();
      // Tell the core the visit is over; nothing else is sent while paused.
      post({ kind: "focus", seq: ++seq, at: clock.now(), browserFocused: false, windowId: windowIdNone });
    }
    await ch.storage.local.set({ paused });
    if (!paused) {
      scheduleFocus();
      void refreshActive();
    }
  }

  async function onPopup(msg: PopupRequest): Promise<StatusSnapshot> {
    if (msg.type === "popup-pause") await setPaused(msg.paused === true);
    else if (msg.type === "popup-reconnect") manualReconnect();
    return snapshot();
  }

  async function handleMessage(msg: unknown, sender: Sender): Promise<unknown> {
    if (!isObj(msg) || typeof msg["type"] !== "string") return { ok: false };
    await loadState();
    const type = msg["type"];
    if (type.startsWith("popup-")) return popupSender(sender) ? onPopup(msg as unknown as PopupRequest) : { ok: false };
    if (type === "approve" || type === "page_text") {
      if (senderOk(sender)) contentTabs.add(sender.tab.id);
    }
    if (type === "approve") return onApprove(msg as unknown as ApproveRequest, sender);
    if (type === "page_text") return onPageText(msg as unknown as PageTextMessage, sender);
    return { ok: false };
  }

  // ---------- browser events ----------
  function install(): void {
    ch.runtime.onMessage.addListener((msg: unknown, sender: Sender, sendResponse: (r: unknown) => void) => {
      handleMessage(msg, sender).then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    });
    ch.permissions.onAdded.addListener(async () => {
      const gh = await reconcile();
      post({ kind: "permissions", granted: [...granted] });
      scheduleFocus();
      if (gh) {
        await injectIntoOpenGithubTabs();
        void refreshActive();
      }
    });
    ch.permissions.onRemoved.addListener(async () => {
      cancelEpoch++; // fail closed now; reconcile confirms and cleans up
      await reconcile();
      post({ kind: "permissions", granted: [...granted] });
      scheduleFocus();
    });
    ch.tabs.onActivated.addListener((info) => {
      cancelTabs({ except: info?.tabId ?? null });
      trigger();
      void refreshActive();
      scheduleFocus();
    });
    ch.tabs.onUpdated.addListener((tabId, info) => {
      const a = approvals.get(tabId);
      if (a && info.url !== undefined && parseIssueRoute(info.url)?.key !== a.routeKey) approvals.delete(tabId);
      if (info.url === undefined && info.status === undefined) return;
      trigger();
      scheduleFocus();
    });
    ch.tabs.onRemoved.addListener((tabId) => {
      approvals.delete(tabId);
      contentTabs.delete(tabId);
    });
    ch.windows.onFocusChanged.addListener(async (windowId) => {
      browserFocused = windowId !== windowIdNone;
      if (!browserFocused) {
        cancelTabs();
      } else {
        const t = await activeTab().catch(() => null);
        cancelTabs({ except: t?.id ?? null });
        trigger();
        void refreshActive();
      }
      scheduleFocus();
    });
  }

  async function start(): Promise<void> {
    install();
    await loadState();
    try {
      const w = await ch.windows.getLastFocused();
      browserFocused = w?.focused === true;
    } catch {
      browserFocused = false;
    }
    if (await reconcile()) await injectIntoOpenGithubTabs();
    policy.start();
  }

  return {
    start,
    install,
    handleMessage,
    snapshot,
    get port() {
      return port;
    },
    policy,
    approvals,
  };
}
