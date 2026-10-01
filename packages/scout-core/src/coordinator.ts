// The Phase 1 pipeline: native commands and browser observations in, panel states and
// acks out. All I/O is injected, so tests drive it with plain function calls.
//
// Panel status, in priority order: paused, then disconnected (no live sensor), then
// idle with the tracker's current epoch. While a visit is active, idle carries the
// approved hostname as `detail` (origin only, never the path). Consecutive identical
// states are sent once, and idle-to-idle visit changes (unapproved page to unapproved
// page) send nothing.

import type {
  ActiveVisit,
  BrowserObservation,
  FocusObservation,
  NativeCommand,
  PageTextObservation,
  PanelState,
  ToChromeFrame,
} from "@scout/contracts";
import { createActivityForwarder, type ActivityForwarder, type ActivitySend } from "./activityForwarder.js";
import type { AgentView } from "./agentApi/handlers.js";
import type { CapabilityStore } from "./capabilities/store.js";
import type { Clock } from "./clock.js";
import type { Diagnostics } from "./diagnostics.js";
import type { OriginFetchSession } from "./fetch/originSession.js";
import { createResumeCache, type ResumeCache } from "./resumeCache.js";
import type { SocketClient } from "./socketServer.js";
import { CHROME_BUNDLE_ID, createVisitTracker, type VisitChange, type VisitTracker, WINDOW_ID_NONE } from "./visitTracker.js";

export interface CoordinatorConfig {
  /** Approved hostnames, e.g. "docs.stripe.com". */
  destinations: readonly string[];
  /** The bundle id treated as "Chrome frontmost". Defaults to CHROME_BUNDLE_ID. */
  chromeBundleId?: string;
}

export interface CoordinatorOptions {
  config: CoordinatorConfig;
  clock: Clock;
  diagnostics: Diagnostics;
  emitPanel: (state: PanelState) => void;
  /** Phase 3 passes the real observe_activity client. */
  sendActivity?: ActivitySend;
  /** Called once when a `shutdown` command stops the coordinator. */
  onShutdownRequested?: () => void;
  /** For resource discovery on settled visits (P2.1 starts it); held, not used yet. */
  capabilities?: CoordinatorCapabilities;
}

export interface CoordinatorCapabilities {
  store: CapabilityStore;
  /** One paced session per settled visit; its owner calls `startWindow()` once before discovery. */
  createFetchSession: (origin: string) => OriginFetchSession;
}

export interface Coordinator {
  handleNativeCommand(cmd: NativeCommand): void;
  /** One observation from the live sensor; `reply` goes back to the same connection. */
  handleObservation(obs: BrowserObservation, reply: (frame: ToChromeFrame) => void): void;
  /** A native host completed hello. The most recent one is the live sensor. */
  attachClient(client: SocketClient): void;
  /** Stop handling input. Idempotent. */
  stop(): void;
  readonly stopped: boolean;
  readonly tracker: VisitTracker;
  readonly forwarder: ActivityForwarder;
  /** Constructed for Phase 2's ranking; not used in Phase 1. */
  readonly resumeCache: ResumeCache<unknown>;
  readonly capabilities: CoordinatorCapabilities | undefined;
  /** What agent.sock may see right now: the focused permitted visit and whether Scout is paused. A fresh copy. */
  agentView(): AgentView;
}

export function createCoordinator(options: CoordinatorOptions): Coordinator {
  const { clock, diagnostics } = options;
  const chromeBundleId = options.config.chromeBundleId ?? CHROME_BUNDLE_ID;
  const forwarder = createActivityForwarder(
    options.sendActivity === undefined ? { diagnostics } : { diagnostics, send: options.sendActivity },
  );
  const resumeCache = createResumeCache<unknown>({ clock, diagnostics });

  let paused = false;
  let stopped = false;
  let liveClient: SocketClient | null = null;
  let latestFocus: FocusObservation | null = null;
  let frontmostBundleId: string | null = null;
  let lastEmitted: string | null = null;

  const emit = (state: PanelState): void => {
    const key = JSON.stringify(state);
    if (key === lastEmitted) return;
    lastEmitted = key;
    try {
      options.emitPanel(state);
    } catch {
      diagnostics.event("panel_emit_failed", {});
    }
  };

  const idleState = (visitEpoch: number, visit: ActiveVisit | null): PanelState => {
    if (visit === null) return { type: "state", status: "idle", visitEpoch };
    return { type: "state", status: "idle", visitEpoch, detail: new URL(visit.origin).hostname };
  };

  const emitCurrent = (): void => {
    if (paused) emit({ type: "state", status: "paused" });
    else if (liveClient === null) emit({ type: "state", status: "disconnected" });
    else emit(idleState(tracker.epoch, tracker.current()));
  };

  const onVisitChange = (change: VisitChange): void => {
    if (change.previous === null && change.visit === null) return;
    if (paused || liveClient === null) return;
    emit(idleState(change.epoch, change.visit));
  };

  const tracker = createVisitTracker({
    destinations: options.config.destinations,
    chromeBundleId,
    clock,
    diagnostics,
    onChange: onVisitChange,
    getContextRevision: () => forwarder.contextRevision,
  });

  /** Why a page_text is not forwarded, or null to forward it. */
  const gatePageText = (obs: PageTextObservation): string | null => {
    if (paused) return "paused";
    if (frontmostBundleId !== chromeBundleId) return "chrome-not-frontmost";
    const f = latestFocus;
    if (f === null || !f.browserFocused || f.windowId === WINDOW_ID_NONE) return "browser-not-focused";
    if (f.incognito === true) return "incognito";
    if (f.tabId !== obs.tabId) return "not-focused-tab";
    // The focused tab has navigated to another document since this text was captured.
    if (f.documentId !== undefined && f.documentId !== obs.documentId) return "not-focused-document";
    // The focused tab is on another issue (e.g. a same-document navigation).
    if (f.url !== undefined) {
      const focused = canonicalIssueUrl(f.url);
      if (focused === null || focused !== canonicalIssueUrl(obs.url)) return "url-mismatch";
    }
    return null;
  };

  const handleObservation = (obs: BrowserObservation, reply: (frame: ToChromeFrame) => void): void => {
    if (stopped) return;
    switch (obs.kind) {
      case "focus":
        latestFocus = obs;
        tracker.observeFocus(obs);
        return;
      case "page_text": {
        const reason = gatePageText(obs);
        if (reason !== null) {
          diagnostics.event("page_text_dropped", { reason });
          return;
        }
        void forwarder.forward(obs);
        reply({ type: "ack", seq: obs.seq });
        return;
      }
      case "permissions":
        diagnostics.event("permissions", { granted: obs.granted.length });
        return;
    }
  };

  /** Forget the last focus and end any visit: a visit never outlives its sensor. */
  const resetFocus = (): void => {
    latestFocus = null;
    tracker.observeFocus({ kind: "focus", seq: 0, at: clock.now(), browserFocused: false, windowId: WINDOW_ID_NONE });
  };

  const sensorLost = (): void => {
    liveClient = null;
    // No idle is sent while disconnected, so ending the visit here only moves the epoch.
    resetFocus();
    emitCurrent();
  };

  const coordinator: Coordinator = {
    tracker,
    forwarder,
    resumeCache,
    capabilities: options.capabilities,
    agentView() {
      const visit = tracker.current();
      return { currentSite: visit === null ? null : { origin: visit.origin, url: visit.url, visitEpoch: visit.epoch }, paused };
    },
    get stopped() {
      return stopped;
    },
    handleNativeCommand(cmd) {
      if (stopped) return;
      switch (cmd.type) {
        case "frontmost":
          frontmostBundleId = cmd.bundleId;
          tracker.observeFrontmost(cmd);
          return;
        case "pause":
          paused = true;
          diagnostics.event("paused", {});
          emitCurrent();
          return;
        case "resume":
          paused = false;
          diagnostics.event("resumed", {});
          emitCurrent();
          return;
        case "shutdown":
          coordinator.stop();
          options.onShutdownRequested?.();
          return;
      }
    },
    handleObservation,
    attachClient(client) {
      if (stopped) {
        client.close();
        return;
      }
      liveClient = client;
      // A new host starts from scratch; its first focus observation will follow.
      resetFocus();
      diagnostics.event("sensor_connected", { conn: client.id });
      client.onFrame((frame) => {
        if (liveClient !== client) {
          diagnostics.event("stale_sensor_frame", { conn: client.id });
          return;
        }
        handleObservation(frame.observation, (f) => client.send(f));
      });
      client.onClose(() => {
        if (liveClient !== client || stopped) return;
        diagnostics.event("sensor_disconnected", { conn: client.id });
        sensorLost();
      });
      emitCurrent();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      diagnostics.event("coordinator_stopped", { pending: forwarder.pendingCount });
    },
  };

  emitCurrent();
  return coordinator;
}

// Same rule as the extension's route.ts (copied, not imported): a GitHub issue page,
// with query and fragment ignored.
const ISSUE_PATH_RE = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/;

/** `https://github.com/<owner>/<repo>/issues/<n>` with owner/repo lowercased, or null if not an issue page. */
export function canonicalIssueUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.port !== "" || u.username || u.password) return null;
  const m = ISSUE_PATH_RE.exec(u.pathname);
  if (m === null) return null;
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return `https://github.com/${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}/issues/${number}`;
}
