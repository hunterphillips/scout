// The Phase 1 pipeline: native commands and browser observations in, panel states and
// acks out. All I/O is injected, so tests drive it with plain function calls.
//
// Panel status, in priority order: paused, then disconnected (no live sensor), then
// idle with the tracker's current epoch. Consecutive identical states are sent once,
// and idle-to-idle visit changes (unapproved page to unapproved page) send nothing.

import type {
  BrowserObservation,
  FocusObservation,
  NativeCommand,
  PageTextObservation,
  PanelState,
  ToChromeFrame,
} from "@scout/contracts";
import { createActivityForwarder, type ActivityForwarder, type ActivitySend } from "./activityForwarder.js";
import type { Clock } from "./clock.js";
import type { Diagnostics } from "./diagnostics.js";
import { createResumeCache, type ResumeCache } from "./resumeCache.js";
import type { SocketClient } from "./socketServer.js";
import { CHROME_BUNDLE_ID, createVisitTracker, type VisitChange, type VisitTracker, WINDOW_ID_NONE } from "./visitTracker.js";

export interface CoordinatorConfig {
  /** Approved hostnames, e.g. "docs.stripe.com". */
  destinations: readonly string[];
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
}

export function createCoordinator(options: CoordinatorOptions): Coordinator {
  const { clock, diagnostics } = options;
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

  const emitCurrent = (): void => {
    if (paused) emit({ type: "state", status: "paused" });
    else if (liveClient === null) emit({ type: "state", status: "disconnected" });
    else emit({ type: "state", status: "idle", visitEpoch: tracker.epoch });
  };

  const onVisitChange = (change: VisitChange): void => {
    if (change.previous === null && change.visit === null) return;
    if (paused || liveClient === null) return;
    emit({ type: "state", status: "idle", visitEpoch: change.epoch });
  };

  const tracker = createVisitTracker({
    destinations: options.config.destinations,
    clock,
    diagnostics,
    onChange: onVisitChange,
    getContextRevision: () => forwarder.contextRevision,
  });

  /** Why a page_text is not forwarded, or null to forward it. */
  const gatePageText = (obs: PageTextObservation): string | null => {
    if (paused) return "paused";
    if (frontmostBundleId !== CHROME_BUNDLE_ID) return "chrome-not-frontmost";
    const f = latestFocus;
    if (f === null || !f.browserFocused || f.windowId === WINDOW_ID_NONE) return "browser-not-focused";
    if (f.incognito === true) return "incognito";
    if (f.tabId !== obs.tabId) return "not-focused-tab";
    // The focused tab has navigated to another document since this text was captured.
    if (f.documentId !== undefined && f.documentId !== obs.documentId) return "not-focused-document";
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
