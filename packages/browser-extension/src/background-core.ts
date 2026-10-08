// Background service-worker wiring (pure; `chrome` and the clock injected).
//
// Builds the three parts around one shared-state object and registers the
// browser events:
// - port.ts: the native port to `dev.scout.bridge`, link health, reconnect;
// - focus-observer.ts: debounced focus observations;
// - page-text-gate.ts: the approval gate for page text from allowed sites.
// It also owns the host-permission lifecycle (the content script's
// registration), the permissions snapshot, the core's capture policy, and the side panel
// (panel-bridge.ts: the panel's port, the window frames' cache, the badge; the
// toolbar click opens the panel, there is no popup).
//
// Pause belongs to the core alone (its capture_policy `paused`): the side panel's
// Pause/Resume sends the core's pause/resume, and the Mac menu or window pausing
// the core stops the extension too. While the core is paused nothing is posted;
// when it resumes, the permissions snapshot (holding back any grant change made
// meanwhile) and a focus follow. The extension's old stored `paused` and
// `githubCapture` keys are removed on load and never read.
//
// Page text is read on exactly the sites the user allowed: Allow includes
// reading that site's pages, and there is no separate switch.
//
// Handshake: on each port nothing is posted until the core's first
// capture_policy arrives (the native host delivers it before `ready`). That
// policy is answered with a full permissions snapshot (every exact origin
// Chrome granted, a fresh revision) and then a focus observation. A grant
// change sends a new snapshot and focus the same way. The content script is
// registered for exactly the granted patterns, and not at all without one.
//
// "Granted" means an exact https origin in the last successful
// permissions.getAll. A broad grant (https://*/* from Chrome's site-access
// settings) is ignored everywhere, and a failed getAll means no sites.

import { type CapturePolicy, isExactOriginPattern } from "@scout/contracts";
import { HOST_NAME } from "./hosts.js";
import { createFocusObserver, FOCUS_DEBOUNCE_MS } from "./focus-observer.js";
import type { ApproveRequest, CommandReply, PageTextMessage, PanelPortRequest, PauseReply, StatusSnapshot } from "./messages.js";
import { checkSite } from "./origin.js";
import { createPanelBridge } from "./panel-bridge.js";
import type { CurrentSite } from "./panel/sites.js";
import { type Approval, createPageTextGate } from "./page-text-gate.js";
import { createPortLink } from "./port.js";
import type { Clock, ReconnectPolicy } from "./reconnect.js";
import { activeTab, anyGranted, corePaused, createSharedState, defaultClock, newCounters, policyAllowsCapture, post } from "./shared-state.js";

export { FOCUS_DEBOUNCE_MS, HOST_NAME };

export const CONTENT_SCRIPT_ID = "scout-page";
export const CONTENT_SCRIPT_FILE = "content/page.js";
export const WINDOW_ID_NONE = -1;

/** The registration, less `matches` (the granted patterns at the time). */
export const CONTENT_SCRIPT = Object.freeze({
  id: CONTENT_SCRIPT_ID,
  js: [CONTENT_SCRIPT_FILE],
  runAt: "document_idle",
  allFrames: false,
  world: "ISOLATED",
  persistAcrossSessions: true,
});

type Script = chrome.scripting.RegisteredContentScript;
const contentScript = (matches: string[]): Script => ({ ...CONTENT_SCRIPT, js: [...CONTENT_SCRIPT.js], matches }) as Script;

const sameSet = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
  !!a && a.length === b.length && b.every((x) => a.includes(x));

type Tab = chrome.tabs.Tab;
type Sender = chrome.runtime.MessageSender;

export interface BackgroundDeps {
  clock?: Clock;
}

export interface Background {
  /** Registers every listener synchronously, then loads state and connects. */
  start(): Promise<void>;
  /** Content-script messages (approve, page_text). */
  handleMessage(msg: unknown, sender: Sender): Promise<unknown>;
  /** One request from the side panel (over its port; tests call it directly). */
  panelRequest(req: PanelPortRequest): Promise<unknown>;
  snapshot(): StatusSnapshot;
  readonly panel: ReturnType<typeof createPanelBridge>;
  readonly port: chrome.runtime.Port | null;
  readonly policy: ReconnectPolicy;
  readonly approvals: Map<number, Approval>;
}

const isObj = (m: unknown): m is Record<string, unknown> => typeof m === "object" && m !== null;

export function createBackground(ch: typeof chrome, deps: BackgroundDeps = {}): Background {
  const clock = deps.clock ?? defaultClock();
  const windowIdNone = ch.windows?.WINDOW_ID_NONE ?? WINDOW_ID_NONE;
  const state = createSharedState(clock);
  // Settings' "Sent" row: a counter change pushes the status to open panels, once per tick.
  let countersPush = false;
  const counters = newCounters(() => {
    if (countersPush) return;
    countersPush = true;
    queueMicrotask(() => {
      countersPush = false;
      panel.pushStatus();
    });
  });
  let loaded: Promise<void> | null = null;
  let chain: Promise<boolean> = Promise.resolve(false);

  /**
   * Once per worker: drop the keys older extensions stored. `paused` (the core is the one
   * source of pause) and `githubCapture` (the github.com grant alone governs capture now).
   * Every content message waits for it.
   */
  function loadState(): Promise<void> {
    loaded ??= Promise.resolve()
      .then(() => ch.storage.local.remove?.(["paused", "githubCapture"]))
      .then(
        () => {},
        () => {},
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
    // Nothing is posted until the core's policy arrives (post() checks it).
    onOpen: () => {},
    onPolicy,
    onLost: () => {
      gate.cancelTabs();
      panel.onLinkLost();
    },
    onPanel: (frame) => panel.onFrame(frame),
    onLinkChange: () => panel.pushStatus(),
  });
  const panel = createPanelBridge({ ch, status: () => snapshot(), linkState: () => link.linkState(), handle: (r) => panelRequest(r) });

  // ---------- capture policy and permissions snapshot ----------
  function onPolicy(p: CapturePolicy): void {
    const prev = state.policy;
    if (prev !== null && p.revision < prev.revision) return; // a stale policy never overrides a newer one
    // The first policy after (re)connect is a transition from "no policy": treated
    // as disabling (any read still in flight stops) even if it already enables.
    const wasAllowed = prev !== null && policyAllowsCapture(state);
    const wasPaused = prev?.paused === true;
    state.policy = { revision: p.revision, captureEnabled: p.captureEnabled, paused: p.paused };
    const allowed = policyAllowsCapture(state);
    if (!allowed || prev === null) gate.cancelTabs(); // stop in-flight reads; content waits for a fresh refresh
    // First policy on this port: the core needs our snapshot. A resume: it gets what was held back.
    if (prev === null || (wasPaused && !p.paused)) sendSnapshot();
    if (allowed && !wasAllowed) void gate.refreshActive(); // after the snapshot, so capture follows it
    panel.pushStatus();
  }

  /**
   * Post a full permissions snapshot with a new revision, then a fresh focus.
   * Held while the core is paused or before its policy: resume and the next
   * policy send it.
   */
  function sendSnapshot(): void {
    if (corePaused(state) || !state.policy || !state.port) return;
    const revision = state.permissionsRevision + 1;
    const ok = post(state, {
      kind: "permissions",
      revision,
      at: clock.now(),
      granted: [...state.granted],
    });
    if (!ok) return;
    state.permissionsRevision = revision;
    state.sentGranted = new Set(state.granted);
    void focus.flush();
  }

  // ---------- permissions ----------
  /**
   * Refresh the granted list and match the content script's registration to it:
   * exactly the granted patterns, or no registration without one. Resolves to
   * "capture on" (at least one site granted). Any failure means no sites: the
   * list is emptied (so capture is off) and the content script is unregistered.
   */
  function reconcile(): Promise<boolean> {
    chain = chain
      .then(async () => {
        await loadState();
        const all = (await ch.permissions.getAll()).origins ?? [];
        state.granted = all.filter(isExactOriginPattern);
        state.broadGrantIgnored = all.length > state.granted.length;
        const matches = [...state.granted];
        const [reg] = await ch.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
        if (!anyGranted(state)) {
          gate.cancelTabs({ stop: true });
          if (reg) await ch.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
          return false;
        }
        if (!reg) await ch.scripting.registerContentScripts([contentScript(matches)]);
        else if (!sameSet(reg.matches, matches)) {
          if (typeof ch.scripting.updateContentScripts === "function") await ch.scripting.updateContentScripts([{ id: CONTENT_SCRIPT_ID, matches } as Script]);
          else {
            await ch.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
            await ch.scripting.registerContentScripts([contentScript(matches)]);
          }
        }
        return true;
      })
      .catch(async () => {
        state.granted = [];
        gate.cancelTabs({ stop: true });
        await ch.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }).catch(() => {});
        return false;
      });
    return chain;
  }

  /**
   * After a grant (or an install/update), pages already open on a granted site
   * never got the registered script, and SPA navigation will not load it.
   * Inject into their top frames once; a second injection is a no-op.
   */
  async function injectIntoOpenTabs(): Promise<void> {
    if (state.granted.length === 0) return;
    const tabs = await ch.tabs.query({ url: [...state.granted] }).catch(() => [] as Tab[]);
    for (const t of tabs) {
      if (t.incognito || t.id === undefined || !Number.isInteger(t.id)) continue;
      await ch.scripting.executeScript({ target: { tabId: t.id, frameIds: [0] }, files: [CONTENT_SCRIPT_FILE] }).catch(() => {});
    }
  }

  // ---------- side panel ----------
  function snapshot(): StatusSnapshot {
    return {
      link: link.linkState(),
      paused: corePaused(state),
      granted: [...state.granted],
      broadGrantIgnored: state.broadGrantIgnored,
      policy: state.policy ? { ...state.policy } : null,
      counters: { ...counters },
    };
  }

  /**
   * The panel's Pause/Resume: the core's pause or resume, sent only on a ready port. What the
   * extension posts follows the core's next capture_policy (paused or not), wherever the pause
   * came from.
   */
  function onPause(paused: boolean): PauseReply {
    const r = link.sendCommandResult({ type: paused ? "pause" : "resume" });
    return { status: snapshot(), written: r.written };
  }

  /**
   * The active tab of the panel's window. Without the `tabs` permission Chrome shows a tab's
   * URL only for a granted origin or the tab holding the toolbar click's activeTab grant; any
   * other tab is `unknown` ("Click the Scout icon to check this site"). Only the origin leaves.
   */
  async function currentSite(windowId: number): Promise<CurrentSite> {
    if (!Number.isInteger(windowId)) return { kind: "none" };
    const [t] = await ch.tabs.query({ active: true, windowId }).catch(() => [] as Tab[]);
    if (!t) return { kind: "none" };
    const ids = { tabId: t.id ?? null, index: t.index ?? null };
    if (t.incognito) return { kind: "refused", reason: "incognito", ...ids };
    if (typeof t.url !== "string" || t.url === "") return { kind: "unknown", ...ids };
    const v = checkSite(t.url, false);
    if (!v.ok) return { kind: "refused", reason: v.reason, ...ids };
    return { kind: "ok", origin: v.origin, pattern: v.pattern, host: new URL(v.origin).hostname, ...ids };
  }

  async function panelRequest(req: PanelPortRequest): Promise<unknown> {
    await loadState();
    switch (req.type) {
      case "status":
        return snapshot();
      case "pause":
        return onPause(req.paused === true);
      case "reconnect":
        link.manualReconnect();
        panel.pushStatus();
        return snapshot();
      case "site":
        return currentSite(req.windowId);
      case "command":
        return link.sendCommandResult(req.command) satisfies CommandReply;
      default:
        return null;
    }
  }

  async function handleMessage(msg: unknown, sender: Sender): Promise<unknown> {
    if (!isObj(msg) || typeof msg["type"] !== "string") return { ok: false };
    await loadState();
    const type = msg["type"];
    if (type === "approve" || type === "page_text") gate.noteContentTab(sender);
    if (type === "approve") return gate.onApprove(msg as unknown as ApproveRequest, sender);
    if (type === "page_text") return gate.onPageText(msg as unknown as PageTextMessage, sender);
    return { ok: false };
  }

  // ---------- browser events ----------
  function install(): void {
    panel.install();
    ch.runtime.onMessage.addListener((msg: unknown, sender: Sender, sendResponse: (r: unknown) => void) => {
      handleMessage(msg, sender).then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    });
    ch.runtime.onInstalled?.addListener(async () => {
      await panel.configureAction();
      if (await reconcile()) await injectIntoOpenTabs();
    });
    ch.permissions.onAdded.addListener(async () => {
      const capture = await reconcile();
      sendSnapshot();
      panel.pushStatus();
      if (capture) {
        await injectIntoOpenTabs();
        void gate.refreshActive();
      }
    });
    ch.permissions.onRemoved.addListener(async (removed?: chrome.permissions.Permissions) => {
      state.cancelEpoch++; // fail closed now; reconcile confirms and cleans up
      // A focus sent before the new snapshot must not carry a revoked origin's URL.
      // Nor may a snapshot sent before reconcile's getAll resolves list it.
      const gone = new Set(removed?.origins ?? []);
      state.granted = state.granted.filter((o) => !gone.has(o));
      state.sentGranted = new Set([...state.sentGranted].filter((o) => !gone.has(o)));
      // Reads in flight stop; the sites still granted capture again on refresh.
      gate.cancelTabs();
      const capture = await reconcile();
      sendSnapshot();
      panel.pushStatus();
      if (capture) void gate.refreshActive();
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
    void panel.configureAction();
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
    panelRequest,
    snapshot,
    panel,
    get port() {
      return state.port;
    },
    policy: link.policy,
    approvals: gate.approvals,
  };
}
