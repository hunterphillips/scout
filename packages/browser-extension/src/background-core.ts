// Background service-worker wiring (pure; `chrome` and the clock injected).
//
// Builds the three parts around one shared-state object and registers the
// browser events:
// - port.ts: the native port to `dev.scout.bridge`, link health, reconnect;
// - focus-observer.ts: debounced focus observations;
// - page-text-gate.ts: the approval gate for GitHub issue text.
// It also owns the host-permission lifecycle (the GitHub content script's
// registration), the persisted paused flag, and the popup's requests.
//
// The paused flag is read from storage before any content message is
// answered, and storage failure means paused. Nothing is posted to the port
// while paused except the one focus-lost observation that ends the visit.

import { GITHUB_PATTERN, HOST_NAME, OPTIONAL_HOSTS } from "./hosts.js";
import { createFocusObserver, FOCUS_DEBOUNCE_MS } from "./focus-observer.js";
import type { ApproveRequest, PageTextMessage, PopupRequest, StatusSnapshot } from "./messages.js";
import { type Approval, createPageTextGate } from "./page-text-gate.js";
import { createPortLink } from "./port.js";
import type { Clock, ReconnectPolicy } from "./reconnect.js";
import { activeTab, createSharedState, defaultClock, newCounters, post } from "./shared-state.js";

export { FOCUS_DEBOUNCE_MS, GITHUB_PATTERN, HOST_NAME, OPTIONAL_HOSTS };

export const CONTENT_SCRIPT_ID = "scout-github-issue";
export const CONTENT_SCRIPT_FILE = "content/github-issue.js";
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

type Tab = chrome.tabs.Tab;
type Sender = chrome.runtime.MessageSender;

export interface BackgroundDeps {
  clock?: Clock;
}

export interface Background {
  /** Registers every listener synchronously, then loads state and connects. */
  start(): Promise<void>;
  handleMessage(msg: unknown, sender: Sender): Promise<unknown>;
  snapshot(): StatusSnapshot;
  readonly port: chrome.runtime.Port | null;
  readonly policy: ReconnectPolicy;
  readonly approvals: Map<number, Approval>;
}

const isObj = (m: unknown): m is Record<string, unknown> => typeof m === "object" && m !== null;

export function createBackground(ch: typeof chrome, deps: BackgroundDeps = {}): Background {
  const clock = deps.clock ?? defaultClock();
  const windowIdNone = ch.windows?.WINDOW_ID_NONE ?? WINDOW_ID_NONE;
  const state = createSharedState(clock);
  const counters = newCounters();
  let loaded: Promise<void> | null = null;
  let granted: string[] = [];
  let chain: Promise<boolean> = Promise.resolve(false);

  /** Load persisted state once; every content message waits for it. Fails closed (paused). */
  function loadState(): Promise<void> {
    loaded ??= Promise.resolve()
      .then(() => ch.storage.local.get({ paused: false }))
      .then(
        (stored) => {
          state.paused = stored?.["paused"] === true;
        },
        () => {
          state.paused = true;
        },
      );
    return loaded;
  }

  const gate = createPageTextGate({ ch, clock, state, counters, trigger: () => link.trigger() });
  const focus = createFocusObserver({ ch, clock, state, counters, windowIdNone, loaded: loadState });
  const link = createPortLink({
    ch,
    clock,
    state,
    counters,
    onOpen: () => {
      postPermissions();
      focus.schedule();
      void gate.refreshActive();
    },
    onLost: () => gate.cancelTabs(),
  });

  function postPermissions(): void {
    if (!state.paused) post(state, { kind: "permissions", granted: [...granted] });
  }

  // ---------- permissions ----------
  /** Refresh the granted list and (un)register the GitHub content script. Resolves to "GitHub granted". */
  function reconcile(): Promise<boolean> {
    chain = chain
      .then(async () => {
        const all = await ch.permissions.getAll();
        granted = (all.origins ?? []).filter((o) => OPTIONAL_HOSTS.includes(o));
        const gh = await gate.githubGranted();
        const regs = await ch.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
        if (gh && regs.length === 0) await ch.scripting.registerContentScripts([{ ...CONTENT_SCRIPT }]);
        if (!gh) {
          gate.cancelTabs({ stop: true });
          if (regs.length > 0) await ch.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
        }
        return gh;
      })
      .catch(() => false);
    return chain;
  }

  /**
   * After a grant (or an install/update), GitHub pages already open never got
   * the registered script, and SPA navigation will not load it. Inject into
   * their top frames once; a second injection is a no-op.
   */
  async function injectIntoOpenGithubTabs(): Promise<void> {
    const tabs = await ch.tabs.query({ url: GITHUB_PATTERN }).catch(() => [] as Tab[]);
    for (const t of tabs) {
      if (t.incognito || t.id === undefined || !Number.isInteger(t.id)) continue;
      await ch.scripting.executeScript({ target: { tabId: t.id, frameIds: [0] }, files: [CONTENT_SCRIPT_FILE] }).catch(() => {});
    }
  }

  // ---------- popup ----------
  function popupSender(sender: Sender | undefined): boolean {
    // Our own popup page (as the action popup, or opened in a tab). Content
    // scripts report the web page URL here, never a chrome-extension:// URL.
    if (!sender || sender.id !== ch.runtime.id || typeof sender.url !== "string") return false;
    return sender.url.split(/[?#]/)[0] === ch.runtime.getURL("popup.html");
  }

  function snapshot(): StatusSnapshot {
    return { link: link.linkState(), paused: state.paused, granted: [...granted], counters: { ...counters } };
  }

  async function setPaused(next: boolean): Promise<void> {
    state.paused = next;
    if (state.paused) {
      gate.cancelTabs();
      // Tell the core the visit is over. Nothing else is posted while paused.
      post(state, { kind: "focus", seq: ++state.seq, at: clock.now(), browserFocused: false, windowId: windowIdNone });
    }
    await ch.storage.local.set({ paused: state.paused });
    if (!state.paused) {
      postPermissions(); // any grant change while paused was held back
      focus.schedule();
      void gate.refreshActive();
    }
  }

  async function onPopup(msg: PopupRequest): Promise<StatusSnapshot> {
    if (msg.type === "popup-pause") await setPaused(msg.paused === true);
    else if (msg.type === "popup-reconnect") link.manualReconnect();
    return snapshot();
  }

  async function handleMessage(msg: unknown, sender: Sender): Promise<unknown> {
    if (!isObj(msg) || typeof msg["type"] !== "string") return { ok: false };
    await loadState();
    const type = msg["type"];
    if (type.startsWith("popup-")) return popupSender(sender) ? onPopup(msg as unknown as PopupRequest) : { ok: false };
    if (type === "approve" || type === "page_text") gate.noteContentTab(sender);
    if (type === "approve") return gate.onApprove(msg as unknown as ApproveRequest, sender);
    if (type === "page_text") return gate.onPageText(msg as unknown as PageTextMessage, sender);
    return { ok: false };
  }

  // ---------- browser events ----------
  function install(): void {
    ch.runtime.onMessage.addListener((msg: unknown, sender: Sender, sendResponse: (r: unknown) => void) => {
      handleMessage(msg, sender).then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    });
    ch.runtime.onInstalled?.addListener(async () => {
      if (await reconcile()) await injectIntoOpenGithubTabs();
    });
    ch.permissions.onAdded.addListener(async () => {
      const gh = await reconcile();
      postPermissions();
      focus.schedule();
      if (gh) {
        await injectIntoOpenGithubTabs();
        void gate.refreshActive();
      }
    });
    ch.permissions.onRemoved.addListener(async () => {
      state.cancelEpoch++; // fail closed now; reconcile confirms and cleans up
      await reconcile();
      postPermissions();
      focus.schedule();
    });
    ch.tabs.onActivated.addListener((info) => {
      gate.cancelTabs({ except: info?.tabId ?? null });
      link.trigger();
      void gate.refreshActive();
      focus.schedule();
    });
    ch.tabs.onUpdated.addListener((tabId, info) => {
      gate.onTabUpdated(tabId, info.url);
      if (info.url === undefined && info.status === undefined) return;
      link.trigger();
      focus.schedule();
    });
    ch.tabs.onRemoved.addListener((tabId) => gate.onTabRemoved(tabId));
    ch.windows.onFocusChanged.addListener(async (windowId) => {
      state.browserFocused = windowId !== windowIdNone;
      if (!state.browserFocused) {
        gate.cancelTabs();
      } else {
        const t = await activeTab(ch).catch(() => null);
        gate.cancelTabs({ except: t?.id ?? null });
        link.trigger();
        void gate.refreshActive();
      }
      focus.schedule();
    });
  }

  async function start(): Promise<void> {
    install();
    await loadState();
    try {
      const w = await ch.windows.getLastFocused();
      state.browserFocused = w?.focused === true;
    } catch {
      state.browserFocused = false;
    }
    await reconcile();
    await link.start();
  }

  return {
    start,
    handleMessage,
    snapshot,
    get port() {
      return state.port;
    },
    policy: link.policy,
    approvals: gate.approvals,
  };
}
