// The service worker's side of the side panel (pure; `chrome` injected).
//
// The worker owns the native port (only a native-messaging port keeps an MV3 worker alive), so
// the panel page talks to the core through it: the panel connects a runtime.Port named
// PANEL_PORT_NAME, the worker relays each `panel` frame from the core to every open panel and
// answers the panel's requests (window commands, pause, the current site, status).
//
// Cache: the core repaints grant, capabilities, audit, state and results only when a new native
// connection opens, never when a panel opens, so the worker keeps the last frame of each of
// those five types in memory and repaints a panel from them the moment it connects. Nothing
// else from the frames is kept (no ack, no preview text), nothing goes to chrome.storage, and
// the cache empties when the native port is lost: a replaced connection is repainted by the
// core, and until then the panel shows the link down, never a stale result. A `state` frame
// drops the cached results, exactly as it resets them in the panel's model (the core sends a
// visit's `state` before its `results`).
//
// Badge: a `results ok` frame while no side panel is open (runtime.getContexts SIDE_PANEL, or
// no connected panel port where getContexts is missing) sets the link count on the toolbar icon
// (blue); a panel connecting (or Chrome's sidePanel.onOpened, where present) and every `state`
// frame clear it. Files to review (offers for the core's current visit, from the cached
// `capabilities` and `state`) set their count in amber the same way, unless links are showing
// (links win) or the panel was open, or the icon clicked, since those offers arrived. A paused
// core (its `state` frame) swaps in the grey paused icon; any other state, or the native port's
// loss, puts the mark back. The panel never opens itself: Chrome allows that only from a user
// gesture.
//
// Toolbar click: the icon toggles the click's window's panel, handled in action.onClicked
// rather than through setPanelBehavior({openPanelOnActionClick: true}). Checked in Chrome for
// Testing 154: with openPanelOnActionClick the click opens the panel but grants no activeTab,
// so the panel could never learn an ungranted tab's site; through onClicked the same click
// also grants activeTab for that tab, and the worker tells open panels to look at their site
// again. Each panel port reports its window (a `window` message on connect); the click closes
// the panel (sidePanel.close) when a port has reported the click's window, and opens it
// (sidePanel.open) otherwise, including for a port that has not reported yet. sidePanel.close
// exists from Chrome 141; without it every click opens, as before. Either call is the
// handler's first synchronous statement, inside the gesture. A close reaches the worker as the
// port's onDisconnect, exactly like the panel's own close button.

import type { PanelState } from "@scout/contracts";
import { type LinkState, PANEL_PORT_NAME, type PanelPortRequest, type PanelToWorker, type StatusSnapshot, type WorkerToPanel } from "./messages.js";
import { hostOf } from "./panel/capabilities.js";
import { iconClickAction } from "./panel/toggle.js";

export const PANEL_PAGE = "panel.html";
/** Links found: the count on the accent blue. */
/** The badge is a plain dot (a one-space badge): it says Scout has something, not how much. */
export const BADGE_DOT = " ";
export const LINKS_BADGE_COLOR = "#1F5FCC";
/** Files for the user's agent to review: the count on the attention amber. */
export const FILES_BADGE_COLOR = "#A35D00";
export const ICON_PATHS = { 16: "icons/icon-16.png", 32: "icons/icon-32.png" } as const;
export const PAUSED_ICON_PATHS = { 16: "icons/paused-16.png", 32: "icons/paused-32.png" } as const;

type Cached = Extract<PanelState, { type: "grant" | "capabilities" | "audit" | "state" | "results" }>;
/** Repaint order: the core's own (grant, capabilities, audit, state), then the visit's results. */
const CACHE_ORDER = ["grant", "capabilities", "audit", "state", "results"] as const;

export interface PanelBridgeDeps {
  ch: typeof chrome;
  status(): StatusSnapshot;
  linkState(): LinkState;
  /** Answers one panel request (background-core's panelRequest). */
  handle(request: PanelPortRequest): Promise<unknown>;
}

export interface PanelBridge {
  /** Registers runtime.onConnect (and sidePanel.onOpened where present) synchronously. */
  install(): void;
  /** The toolbar click is handled by the worker (onClicked), not by Chrome's panel behaviour. */
  configureAction(): Promise<void>;
  /** One window frame from the core (port.ts onPanel). */
  onFrame(state: PanelState): void;
  /** The native port is gone: forget every cached frame (open panels hear it via pushStatus). */
  onLinkLost(): void;
  /** Send the current status to every open panel. */
  pushStatus(): void;
  /** The cached frames in repaint order (tests). */
  cached(): PanelState[];
  readonly openPanels: number;
}

const isObj = (m: unknown): m is Record<string, unknown> => typeof m === "object" && m !== null;

export function createPanelBridge(deps: PanelBridgeDeps): PanelBridge {
  const { ch } = deps;
  const cache = new Map<Cached["type"], Cached>();
  const ports = new Set<chrome.runtime.Port>();
  /** The window each side-panel port reported as its own (a port without an entry counts as no window). */
  const portWindow = new Map<chrome.runtime.Port, number>();
  let lastLink: LinkState | null = null;

  const post = (p: chrome.runtime.Port, m: WorkerToPanel): void => {
    try {
      p.postMessage(m);
    } catch {
      ports.delete(p);
      portWindow.delete(p);
    }
  };

  function panelOpenIn(windowId: number): boolean {
    for (const p of ports) if (portWindow.get(p) === windowId) return true;
    return false;
  }
  const broadcast = (m: WorkerToPanel): void => {
    for (const p of [...ports]) post(p, m);
  };

  function pushStatus(): void {
    const status = deps.status();
    lastLink = status.link;
    broadcast({ type: "status", status });
  }

  /** Items of the `results ok` frame the badge counts; 0 once a panel showed them or a state frame cleared them. */
  let links = 0;
  /** Offers (`resourceId@version`) a panel was open for, or the icon clicked over: they set no badge again. */
  const seenOffers = new Set<string>();
  let badgeSeq = 0;
  let pausedIcon = false;

  function setBadge(text: string, color?: string): void {
    const a = ch.action;
    if (!a?.setBadgeText) return;
    Promise.resolve()
      .then(async () => {
        if (text !== "" && color) await a.setBadgeBackgroundColor?.({ color });
        await a.setBadgeText({ text });
      })
      .catch(() => {});
  }

  function setPausedIcon(paused: boolean): void {
    if (paused === pausedIcon) return;
    pausedIcon = paused;
    const a = ch.action;
    if (!a?.setIcon) return;
    Promise.resolve(a.setIcon({ path: { ...(paused ? PAUSED_ICON_PATHS : ICON_PATHS) } })).catch(() => {});
  }

  /** Offers for the core's current visit: an idle state naming a host Chrome permits. */
  function currentOffers(): string[] {
    const st = cache.get("state");
    const caps = cache.get("capabilities");
    if (st?.type !== "state" || caps?.type !== "capabilities" || st.status !== "idle" || st.permitted === false || !st.detail) return [];
    return caps.offers.filter((o) => hostOf(o.siteOrigin) === st.detail).map((o) => `${o.resourceId}@${o.version}`);
  }

  /** The panel is (or was just) open, or the icon clicked: what it shows needs no badge. */
  function seen(): void {
    links = 0;
    for (const o of currentOffers()) seenOffers.add(o);
    badgeSeq++;
    setBadge("");
  }

  /** A dot, not a count: Scout has something new. Links win over files; nothing while a panel is open (asked of Chrome; a panel connecting meanwhile wins). */
  function refreshBadge(): void {
    const seq = ++badgeSeq;
    const offers = currentOffers();
    const want = links > 0 ? { text: BADGE_DOT, color: LINKS_BADGE_COLOR } : offers.some((o) => !seenOffers.has(o)) ? { text: BADGE_DOT, color: FILES_BADGE_COLOR } : null;
    if (ports.size > 0) {
      seen();
      return;
    }
    if (want === null) {
      setBadge("");
      return;
    }
    void panelOpen().then((open) => {
      if (seq !== badgeSeq) return;
      if (open || ports.size > 0) seen();
      else setBadge(want.text, want.color);
    });
  }

  async function panelOpen(): Promise<boolean> {
    if (ports.size > 0) return true;
    const getContexts = ch.runtime.getContexts;
    if (typeof getContexts !== "function") return false;
    try {
      const contexts = await getContexts({ contextTypes: ["SIDE_PANEL" as chrome.runtime.ContextType] });
      return contexts.length > 0;
    } catch {
      return false;
    }
  }

  function onFrame(state: PanelState): void {
    if (deps.linkState() !== lastLink) pushStatus(); // the panel learns the link is up before its frames
    switch (state.type) {
      case "state":
        cache.set("state", state);
        cache.delete("results");
        links = 0;
        setPausedIcon(state.status === "paused");
        refreshBadge();
        break;
      case "results":
        cache.set("results", state);
        // A newer state frame or results frame replaces the count; a panel that connected while
        // Chrome was asked shows it (refreshBadge's sequence check).
        if (state.status === "ok") {
          links = state.items.length;
          refreshBadge();
        }
        break;
      case "capabilities":
        cache.set(state.type, state);
        refreshBadge();
        break;
      case "grant":
      case "audit":
        cache.set(state.type, state);
        break;
      default:
        break; // acks and preview chunks are answers, never cached
    }
    broadcast({ type: "frame", state });
  }

  /** The status push follows from port.ts's onLinkChange, once the reconnect plan is known. */
  function onLinkLost(): void {
    cache.clear();
    links = 0;
    badgeSeq++;
    setBadge("");
    setPausedIcon(false);
  }

  function cached(): PanelState[] {
    return CACHE_ORDER.flatMap((t) => (cache.has(t) ? [cache.get(t)!] : []));
  }

  /** Our own panel page, and nothing else (a content script's port names its web page). */
  function fromPanel(p: chrome.runtime.Port): boolean {
    const s = p.sender;
    if (p.name !== PANEL_PORT_NAME || !s || s.id !== ch.runtime.id || typeof s.url !== "string") return false;
    return s.url.split(/[?#]/)[0] === ch.runtime.getURL(PANEL_PAGE);
  }

  function onConnect(p: chrome.runtime.Port): void {
    if (p.name !== PANEL_PORT_NAME) return;
    if (!fromPanel(p)) {
      try {
        p.disconnect();
      } catch {
        // already gone
      }
      return;
    }
    ports.add(p);
    seen();
    p.onDisconnect.addListener(() => {
      void ch.runtime.lastError;
      ports.delete(p); // the panel was closed (or its page reloaded)
      portWindow.delete(p);
    });
    p.onMessage.addListener((m: unknown) => {
      if (!isObj(m)) return;
      const msg = m as unknown as PanelToWorker;
      if (msg.type === "hb") return; // a message on the port is all a heartbeat needs to be
      if (msg.type === "window") {
        // panel.html opened in a tab is not the window's side panel: the click must still open that.
        if (Number.isInteger(msg.windowId) && p.sender?.tab === undefined && ports.has(p)) portWindow.set(p, msg.windowId);
        return;
      }
      if (msg.type !== "request" || typeof msg.id !== "number" || !isObj(msg.request)) return;
      deps.handle(msg.request).then(
        (result) => ports.has(p) && post(p, { type: "reply", id: msg.id, result }),
        () => ports.has(p) && post(p, { type: "reply", id: msg.id, result: null }),
      );
    });
    const status = deps.status();
    post(p, { type: "status", status });
    for (const state of cached()) post(p, { type: "frame", state });
  }

  /** The toolbar click: toggle the panel in the click's window (first, within the gesture), then recheck sites. */
  function onActionClicked(tab: chrome.tabs.Tab | undefined): void {
    if (typeof tab?.windowId === "number") {
      const windowId = tab.windowId;
      try {
        const sp = ch.sidePanel;
        const close = typeof sp?.close === "function" ? sp.close.bind(sp) : null;
        const action = iconClickAction({ panelOpenInWindow: panelOpenIn(windowId), canClose: close !== null });
        void Promise.resolve(action === "close" ? close!({ windowId }) : sp?.open?.({ windowId })).catch(() => {});
      } catch {
        // no side panel API: nothing to open
      }
    }
    seen();
    broadcast({ type: "site-check" }); // the click granted activeTab for this tab
  }

  function install(): void {
    ch.runtime.onConnect?.addListener(onConnect);
    ch.action?.onClicked?.addListener(onActionClicked);
    ch.sidePanel?.onOpened?.addListener(() => seen());
  }

  async function configureAction(): Promise<void> {
    await Promise.resolve(ch.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false })).catch(() => {});
  }

  return {
    install,
    configureAction,
    onFrame,
    onLinkLost,
    pushStatus,
    cached,
    get openPanels() {
      return ports.size;
    },
  };
}
