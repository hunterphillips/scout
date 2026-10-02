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
// no connected panel port where getContexts is missing) sets a dot on the toolbar icon; a panel
// connecting (or Chrome's sidePanel.onOpened, where present) and every `state` frame clear it.
// The panel never opens itself: Chrome allows that only from a user gesture.

import type { PanelState } from "@scout/contracts";
import { type LinkState, PANEL_PORT_NAME, type PanelPortRequest, type PanelToWorker, type StatusSnapshot, type WorkerToPanel } from "./messages.js";

export const PANEL_PAGE = "panel.html";
export const BADGE_TEXT = "•";
export const BADGE_COLOR = "#1a73e8";

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
  /** Sets the toolbar click to open the side panel. */
  configureAction(): Promise<void>;
  /** One window frame from the core (port.ts onPanel). */
  onFrame(state: PanelState): void;
  /** The native port is gone: forget every cached frame and tell open panels. */
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
  let lastLink: LinkState | null = null;

  const post = (p: chrome.runtime.Port, m: WorkerToPanel): void => {
    try {
      p.postMessage(m);
    } catch {
      ports.delete(p);
    }
  };
  const broadcast = (m: WorkerToPanel): void => {
    for (const p of [...ports]) post(p, m);
  };

  function pushStatus(): void {
    const status = deps.status();
    lastLink = status.link;
    broadcast({ type: "status", status });
  }

  function setBadge(text: string): void {
    const a = ch.action;
    if (!a?.setBadgeText) return;
    Promise.resolve()
      .then(async () => {
        if (text !== "") await a.setBadgeBackgroundColor?.({ color: BADGE_COLOR });
        await a.setBadgeText({ text });
      })
      .catch(() => {});
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
        setBadge("");
        break;
      case "results":
        cache.set("results", state);
        if (state.status === "ok") {
          void panelOpen().then((open) => {
            // Still the shown result (no state frame since), and no panel to show it.
            if (!open && cache.get("results") === state) setBadge(BADGE_TEXT);
          });
        }
        break;
      case "grant":
      case "capabilities":
      case "audit":
        cache.set(state.type, state);
        break;
      default:
        break; // acks and preview chunks are answers, never cached
    }
    broadcast({ type: "frame", state });
  }

  function onLinkLost(): void {
    cache.clear();
    setBadge("");
    pushStatus();
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
    setBadge("");
    p.onDisconnect.addListener(() => {
      void ch.runtime.lastError;
      ports.delete(p); // the panel was closed (or its page reloaded)
    });
    p.onMessage.addListener((m: unknown) => {
      if (!isObj(m)) return;
      const msg = m as unknown as PanelToWorker;
      if (msg.type === "hb") return; // a message on the port is all a heartbeat needs to be
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

  function install(): void {
    ch.runtime.onConnect?.addListener(onConnect);
    ch.sidePanel?.onOpened?.addListener(() => setBadge(""));
  }

  async function configureAction(): Promise<void> {
    await ch.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })?.catch?.(() => {});
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
