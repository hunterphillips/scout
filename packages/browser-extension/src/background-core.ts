// Background service-worker wiring (pure; `chrome` and the clock injected).
//
// Builds the three parts around one shared-state object and registers the
// browser events:
// - port.ts: the native port to `dev.scout.bridge`, link health, reconnect;
// - focus-observer.ts: debounced focus observations;
// - page-text-gate.ts: the approval gate for GitHub issue text.
// It also owns the host-permission lifecycle (the GitHub content script's
// registration), the persisted paused flag and GitHub-capture toggle, the
// permissions snapshot, the core's capture policy, and the side panel
// (panel-bridge.ts: the panel's port, the window frames' cache, the badge; the
// toolbar click opens the panel, there is no popup).
//
// The paused flag is read from storage before any content message is
// answered, and storage failure means paused. Nothing is posted to the port
// while paused except the one focus-lost observation that ends the visit.
//
// Handshake: on each port nothing is posted until the core's first
// capture_policy arrives (the native host delivers it before `ready`). That
// policy is answered with a full permissions snapshot (every exact origin
// Chrome granted, the GitHub-capture toggle, a fresh revision) and then a
// focus observation. A grant change or toggle change sends a new snapshot and
// focus the same way. The GitHub content script is registered only while
// both the exact GitHub grant and the toggle are on.
//
// "Granted" means an exact https origin in the last successful
// permissions.getAll. A broad grant (https://*/* from Chrome's site-access
// settings) is ignored everywhere, and a failed getAll means no sites.

import { type CapturePolicy, isExactOriginPattern } from "@scout/contracts";
import { GITHUB_PATTERN, HOST_NAME } from "./hosts.js";
import { createFocusObserver, FOCUS_DEBOUNCE_MS } from "./focus-observer.js";
import type { ApproveRequest, CommandReply, PageTextMessage, PanelPortRequest, PauseReply, StatusSnapshot } from "./messages.js";
import { checkSite } from "./origin.js";
import { createPanelBridge } from "./panel-bridge.js";
import type { CurrentSite } from "./panel/sites.js";
import { type Approval, createPageTextGate } from "./page-text-gate.js";
import { createPortLink } from "./port.js";
import type { Clock, ReconnectPolicy } from "./reconnect.js";
import { activeTab, createSharedState, defaultClock, githubCaptureOn, githubGranted, newCounters, policyAllowsCapture, post } from "./shared-state.js";

export { FOCUS_DEBOUNCE_MS, GITHUB_PATTERN, HOST_NAME };

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
  const counters = newCounters();
  let loaded: Promise<void> | null = null;
  let chain: Promise<boolean> = Promise.resolve(false);

  /** Load persisted state once; every content message waits for it. Fails closed (paused, capture off). */
  function loadState(): Promise<void> {
    loaded ??= Promise.resolve()
      .then(() => ch.storage.local.get({ paused: false, githubCapture: false }))
      .then(
        (stored) => {
          state.paused = stored?.["paused"] === true;
          state.githubCapture = stored?.["githubCapture"] === true;
        },
        () => {
          state.paused = true;
          state.githubCapture = false;
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
    state.policy = { revision: p.revision, captureEnabled: p.captureEnabled, paused: p.paused };
    const allowed = policyAllowsCapture(state);
    if (!allowed || prev === null) gate.cancelTabs(); // stop in-flight reads; content waits for a fresh refresh
    if (prev === null) sendSnapshot(); // first policy on this port: the core needs our snapshot
    if (allowed && !wasAllowed) void gate.refreshActive(); // after the snapshot, so capture follows it
    panel.pushStatus();
  }

  /**
   * Post a full permissions snapshot with a new revision, then a fresh focus.
   * Held while paused or before the core's policy: resume and the next policy
   * send it.
   */
  function sendSnapshot(): void {
    if (state.paused || !state.policy || !state.port) return;
    const revision = state.permissionsRevision + 1;
    const ok = post(state, {
      kind: "permissions",
      revision,
      at: clock.now(),
      granted: [...state.granted],
      githubCapture: githubCaptureOn(state),
    });
    if (!ok) return;
    state.permissionsRevision = revision;
    state.sentGranted = new Set(state.granted);
    void focus.flush();
  }

  // ---------- permissions ----------
  /**
   * Refresh the granted list and (un)register the GitHub content script.
   * Losing the GitHub grant also turns the capture toggle off, so a later
   * grant alone never re-enables capture. Resolves to "GitHub capture allowed".
   * Any failure means no sites: the list is emptied (so capture is effectively
   * off) and the content script is unregistered.
   */
  function reconcile(): Promise<boolean> {
    chain = chain
      .then(async () => {
        await loadState();
        const all = (await ch.permissions.getAll()).origins ?? [];
        state.granted = all.filter(isExactOriginPattern);
        state.broadGrantIgnored = all.length > state.granted.length;
        if (!githubGranted(state) && state.githubCapture) await setGithubCapture(false);
        const capture = githubCaptureOn(state);
        const regs = await ch.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
        if (capture && regs.length === 0) await ch.scripting.registerContentScripts([{ ...CONTENT_SCRIPT }]);
        if (!capture) {
          gate.cancelTabs({ stop: true });
          if (regs.length > 0) await ch.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
        }
        return capture;
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
   * Turning on persists first and changes memory only once storage has it (a
   * failed write leaves capture off and throws). Turning off (by the user, or
   * by reconcile when the GitHub grant is lost) takes effect in memory at once
   * and never throws; the write is best effort. Limitation: if that write
   * fails, a later worker restart reloads `true` from storage. Acceptable:
   * storage is already failing, and a failed read starts paused.
   */
  async function setGithubCapture(next: boolean): Promise<void> {
    if (!next) {
      state.githubCapture = false;
      gate.cancelTabs({ stop: true });
      await Promise.resolve()
        .then(() => ch.storage.local.set({ githubCapture: false }))
        .catch(() => {});
      return;
    }
    await ch.storage.local.set({ githubCapture: true });
    state.githubCapture = true;
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

  // ---------- side panel ----------
  function snapshot(): StatusSnapshot {
    return {
      link: link.linkState(),
      paused: state.paused,
      granted: [...state.granted],
      githubCapture: githubCaptureOn(state),
      broadGrantIgnored: state.broadGrantIgnored,
      policy: state.policy ? { ...state.policy } : null,
      counters: { ...counters },
    };
  }

  async function setPaused(next: boolean): Promise<void> {
    state.paused = next;
    if (state.paused) {
      gate.cancelTabs();
      // Tell the core the visit is over. Nothing else is posted while paused.
      post(state, { kind: "focus", seq: ++state.seq, at: clock.now(), browserFocused: false, windowId: windowIdNone });
    }
    // A failed write still takes effect in memory (and resume still sends what it held back);
    // the error is rethrown afterwards for the caller to report.
    const saved = Promise.resolve()
      .then(() => ch.storage.local.set({ paused: state.paused }))
      .then(
        () => null,
        (e: unknown) => e,
      );
    const failure = await saved;
    if (!state.paused) {
      sendSnapshot(); // any grant change while paused was held back; follows with focus
      void gate.refreshActive();
    }
    if (failure !== null) throw failure;
  }

  /** The side panel's checkbox (a user gesture). Turning it on needs the GitHub grant. */
  async function onGithubToggle(enabled: boolean): Promise<void> {
    if (enabled && !githubGranted(state)) return;
    if (enabled === state.githubCapture) return;
    await setGithubCapture(enabled);
    const capture = await reconcile();
    sendSnapshot();
    if (capture) {
      await injectIntoOpenGithubTabs();
      void gate.refreshActive();
    }
  }

  /**
   * The panel's one Pause/Resume control: the extension's own pause (nothing posted but the
   * focus-lost that ends the visit) and the core's pause/resume, sent only on a ready port.
   * Pausing stops posting first; resuming tells the core first, so the snapshot and focus that
   * follow reach a resumed core.
   */
  async function onPause(paused: boolean): Promise<PauseReply> {
    // A failed storage write still pauses in memory (setPaused sets it first); the core is told
    // either way, and the panel always gets a reply.
    const persist = (p: Promise<void>) =>
      p.catch((e: unknown) => {
        console.warn("scout: the paused flag was not saved", e instanceof Error ? e.message : "");
      });
    let written: boolean;
    if (paused) {
      await persist(setPaused(true));
      written = link.sendCommand({ type: "pause" });
    } else {
      written = link.sendCommand({ type: "resume" });
      await persist(setPaused(false));
    }
    return { status: snapshot(), written };
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
      case "pause": {
        const r = await onPause(req.paused === true);
        panel.pushStatus();
        return r;
      }
      case "reconnect":
        link.manualReconnect();
        panel.pushStatus();
        return snapshot();
      case "github-capture":
        await onGithubToggle(req.enabled === true);
        panel.pushStatus();
        return snapshot();
      case "site":
        return currentSite(req.windowId);
      case "command":
        return { written: link.sendCommand(req.command) } satisfies CommandReply;
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
      if (await reconcile()) await injectIntoOpenGithubTabs();
    });
    ch.permissions.onAdded.addListener(async () => {
      const gh = await reconcile();
      sendSnapshot();
      panel.pushStatus();
      if (gh) {
        await injectIntoOpenGithubTabs();
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
      await reconcile();
      sendSnapshot();
      panel.pushStatus();
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
