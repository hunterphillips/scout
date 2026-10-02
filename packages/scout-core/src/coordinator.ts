// The core pipeline: native commands and browser observations in; panel states, capture
// policies, and acks out; resource discovery on settled visits. All I/O is injected, so
// tests drive it with plain function calls.
//
// Panel status, in priority order: paused, then disconnected (no live sensor), then
// idle with the tracker's current epoch. While a visit is active, idle carries the
// permitted hostname as `detail` (origin only, never the path). Consecutive identical
// states are sent once, and idle-to-idle visit changes (unpermitted page to unpermitted
// page) send nothing.
//
// Bridge protocol 2, per connection: on attach the core first sends a capture-disabled
// `capture_policy` (revision 0), which the relay delivers before `ready`. Grants come only
// from the live connection's permissions snapshot (permissionState.ts). Each later policy
// has the next revision and is sent only when `paused` or `captureEnabled` changes;
// `captureEnabled` is the snapshot's GitHub-capture setting AND the GitHub grant AND not
// paused. A policy can only restrict: the extension still needs Chrome's grant and its
// own toggle.
//
// page_text is accepted into the activity store (activity/store.ts) only when not paused, a
// snapshot has arrived on this connection, that snapshot enables GitHub capture and grants
// GitHub, the text was captured under the policy revision last sent on this connection,
// Chrome is frontmost with a focused, non-incognito window, and the text comes from the
// focused tab's issue. The document check applies only when the focus carries a
// `documentId`; the extension's focus observations do not carry one today, so the
// same-document check is the extension's. The ack goes out only after the store returned:
// for text it took, and for a repeat it already holds (a re-send after a reconnect).
//
// A visit that stays unchanged for DWELL_MS settles (dwell.ts) and starts one discovery
// pass for its origin (discoveryRunner.ts). Pause, loss of the pass origin's grant,
// disconnect (or a new sensor replacing the live one), and stop cancel it.
//
// Scout's window commands (those with a `commandId`) go to the panel channel
// (panelChannel.ts), which answers them; without one each gets an `unavailable` ack. The
// coordinator tells the channel when the capability view may have changed: a permissions
// snapshot applied or cleared (offers follow Chrome's grants), the visit changed, or an ingest
// committed (and again when its export sync settles).
//
// Recommendation results (results.ts) live only as long as their visit: a visit change (which
// includes losing the origin's grant, which clears them first), pause, disconnect (or a
// replacing sensor), and stop clear them. These clears are silent: the state frame each sends
// next (the new visit's idle, paused, disconnected) is what makes the window drop them, and
// stop sends nothing. `resendState` is for P3.2's job clears within one visit.

import type {
  ActiveVisit,
  BrowserObservation,
  FocusObservation,
  NativeCommand,
  PageTextObservation,
  PanelState,
} from "@scout/contracts";
import { type ActivityStore, canonicalIssueUrl, createActivityStore } from "./activity/store.js";
import type { AgentView } from "./agentApi/handlers.js";
import type { PanelChannel } from "./panelChannel.js";
import type { ResultRegistry } from "./results.js";
import type { Clock, Timers } from "./clock.js";
import type { Diagnostics } from "./diagnostics.js";
import { createDiscoveryRunner, type DiscoveryCapabilities } from "./discoveryRunner.js";
import { createDwellScheduler, type DwellScheduler } from "./dwell.js";
import { createPermissionState, GITHUB_ORIGIN, type PermissionState } from "./permissionState.js";
import { createResumeCache, type ResumeCache } from "./resumeCache.js";
import type { SocketClient } from "./socketServer.js";
import { CHROME_BUNDLE_ID, createVisitTracker, type VisitChange, type VisitTracker, WINDOW_ID_NONE } from "./visitTracker.js";

export interface CoordinatorConfig {
  /** The bundle id treated as "Chrome frontmost". Defaults to CHROME_BUNDLE_ID. */
  chromeBundleId?: string;
}

export interface CoordinatorOptions {
  config: CoordinatorConfig;
  clock: Clock;
  /** The dwell timer's timers; defaults to the global ones. */
  timers?: Timers;
  diagnostics: Diagnostics;
  emitPanel: (state: PanelState) => void;
  /** Where accepted page text goes; defaults to a fresh store on `clock`. */
  activity?: ActivityStore;
  /** Called after a `pause` command took effect (main revokes job tokens there). */
  onPause?: () => void;
  /** How long a visit must stay unchanged before discovery; defaults to DWELL_MS. */
  dwellMs?: number;
  /** Called once when a `shutdown` command stops the coordinator. */
  onShutdownRequested?: () => void;
  /** Resource discovery on settled visits. Without it a settle is only logged. */
  capabilities?: CoordinatorCapabilities;
  /** Scout's window commands and capability view. Without it those commands are refused. */
  panel?: Pick<PanelChannel, "handle" | "capabilitiesChanged">;
  /** Recommendation results, cleared whenever their visit stops being current. */
  results?: Pick<ResultRegistry, "clear">;
}

export type CoordinatorCapabilities = DiscoveryCapabilities;

export interface Coordinator {
  handleNativeCommand(cmd: NativeCommand): void;
  /** A native host completed a protocol-2 hello. The most recent one is the live sensor. */
  attachClient(client: SocketClient): void;
  /** Stop handling input and cancel pending dwell and discovery. Idempotent. */
  stop(): void;
  readonly stopped: boolean;
  readonly tracker: VisitTracker;
  readonly permissions: PermissionState;
  readonly activity: ActivityStore;
  /** Constructed for Phase 2's ranking; not used in Phase 1. */
  readonly resumeCache: ResumeCache<unknown>;
  readonly capabilities: CoordinatorCapabilities | undefined;
  /** What agent.sock may see right now: the focused permitted visit and whether Scout is paused. A fresh copy. */
  agentView(): AgentView;
  /** Send the current panel state again, even if it is the last one sent. */
  resendState(): void;
}

const utf8 = new TextEncoder();

export function createCoordinator(options: CoordinatorOptions): Coordinator {
  const { clock, diagnostics } = options;
  const chromeBundleId = options.config.chromeBundleId ?? CHROME_BUNDLE_ID;
  const activity = options.activity ?? createActivityStore({ clock });
  const resumeCache = createResumeCache<unknown>({ clock, diagnostics });
  const permissions = createPermissionState({ diagnostics });
  const caps = options.capabilities;
  const panelChanged = (): void => options.panel?.capabilitiesChanged();
  // Silent: every caller sends a state frame next (a new visit's idle, paused, disconnected),
  // or none at all (stop), so a `resendState` here would only add a stray frame (an idle for the
  // old epoch before `disconnected`). The non-silent clear is for P3.2's job clears within one
  // visit, where no other state frame follows.
  const clearResults = (reason: string): void => void options.results?.clear(reason, { silent: true });

  let paused = false;
  let stopped = false;
  let liveClient: SocketClient | null = null;
  let latestFocus: FocusObservation | null = null;
  let frontmostBundleId: string | null = null;
  let lastEmitted: string | null = null;
  /** The last capture policy sent to the live client, and its revision. */
  let lastPolicy: { revision: number; paused: boolean; captureEnabled: boolean } | null = null;

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
    if (visit === null) return { type: "state", status: "idle", visitEpoch, permitted: false };
    return { type: "state", status: "idle", visitEpoch, detail: new URL(visit.origin).hostname, permitted: true };
  };

  const emitCurrent = (): void => {
    if (paused) emit({ type: "state", status: "paused" });
    else if (liveClient === null) emit({ type: "state", status: "disconnected" });
    else emit(idleState(tracker.epoch, tracker.current()));
  };

  const captureEnabled = (): boolean => !paused && permissions.githubCapture && permissions.isPermitted(GITHUB_ORIGIN);

  /** Send the live client a new policy if pause or capture changed since the last one (always on a fresh connection). */
  const syncPolicy = (): void => {
    const client = liveClient;
    if (client === null || stopped) return;
    const next = { paused, captureEnabled: captureEnabled() };
    if (lastPolicy !== null && lastPolicy.paused === next.paused && lastPolicy.captureEnabled === next.captureEnabled) return;
    const revision = lastPolicy === null ? 0 : lastPolicy.revision + 1;
    lastPolicy = { revision, ...next };
    diagnostics.event("capture_policy", { conn: client.id, revision, ...next });
    client.send({ type: "capture_policy", revision, ...next });
  };

  // --- Discovery on settled visits ---

  const discovery = createDiscoveryRunner({
    clock,
    diagnostics,
    capabilities: caps,
    blocker: (visit) => {
      if (stopped) return "stopped";
      if (paused) return "paused";
      if (!permissions.isPermitted(visit.origin)) return "permission_lost";
      if (tracker.current()?.epoch !== visit.epoch) return "epoch_changed";
      return null;
    },
    isPermitted: (origin) => permissions.isPermitted(origin),
    onIngested: panelChanged,
  });

  const dwell: DwellScheduler = createDwellScheduler({
    onSettled: (visit) => discovery.settle(visit),
    diagnostics,
    ...(options.timers ? { timers: options.timers } : {}),
    ...(options.dwellMs !== undefined ? { dwellMs: options.dwellMs } : {}),
  });

  // --- Visits ---

  const onVisitChange = (change: VisitChange): void => {
    if (change.previous === null && change.visit === null) return;
    clearResults("visit_changed");
    panelChanged();
    if (change.visit === null) dwell.cancel("visit_ended");
    else if (!paused && liveClient !== null) dwell.arm(change.visit);
    if (paused || liveClient === null) return;
    emit(idleState(change.epoch, change.visit));
  };

  const tracker = createVisitTracker({
    isPermitted: (origin) => permissions.isPermitted(origin),
    chromeBundleId,
    clock,
    diagnostics,
    onChange: onVisitChange,
    getContextRevision: () => activity.revision,
  });

  /** Why a page_text is not forwarded, or null to forward it. */
  const gatePageText = (obs: PageTextObservation): string | null => {
    if (paused) return "paused";
    if (!permissions.received) return "no_permissions_snapshot";
    if (!permissions.githubCapture || !permissions.isPermitted(GITHUB_ORIGIN)) return "capture_disabled";
    // Captured under an older policy (or by an extension that does not say): never accepted.
    if (obs.policyRevision === undefined || obs.policyRevision !== lastPolicy?.revision) return "policy_revision";
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

  const applyPermissions = (obs: Extract<BrowserObservation, { kind: "permissions" }>): void => {
    const before = tracker.current();
    if (!permissions.applySnapshot(obs)) return;
    // No consent to capture: no captured issue text is kept, even if the consent went while
    // Chrome was disconnected (pause and disconnect alone keep it).
    if (!permissions.githubCapture || !permissions.isPermitted(GITHUB_ORIGIN)) {
      const revision = activity.revision;
      activity.clear();
      if (activity.revision !== revision) diagnostics.event("activity_cleared", { reason: permissions.githubCapture ? "grant_lost" : "capture_off" });
    }
    if (before !== null && !permissions.isPermitted(before.origin)) {
      clearResults("permission_lost");
      dwell.cancel("permission_lost");
      diagnostics.event("permission_lost", { origin: before.origin, epoch: before.epoch });
    }
    discovery.permissionsChanged();
    tracker.recompute();
    syncPolicy();
    panelChanged();
  };

  const handleObservation = (obs: BrowserObservation, client: SocketClient): void => {
    if (stopped) return;
    switch (obs.kind) {
      case "focus":
        if (!permissions.acceptsFocus(obs)) return;
        latestFocus = obs;
        tracker.observeFocus(obs);
        return;
      case "page_text": {
        const reason = gatePageText(obs);
        if (reason !== null) {
          diagnostics.event("page_text_dropped", { reason });
          return;
        }
        const result = activity.accept(obs, client.id);
        if (!result.accepted && !result.duplicate) {
          diagnostics.event("page_text_dropped", { reason: "not_an_issue" });
          return;
        }
        diagnostics.event("activity_accepted", {
          bytes: utf8.encode(obs.text).byteLength,
          truncated: obs.truncated,
          duplicate: result.duplicate,
        });
        client.send({ type: "ack", seq: obs.seq });
        return;
      }
      case "permissions":
        applyPermissions(obs);
        return;
    }
  };

  /** Forget the last focus and end any visit: a visit never outlives its sensor. */
  const resetFocus = (): void => {
    latestFocus = null;
    tracker.observeFocus({ kind: "focus", seq: 0, at: clock.now(), browserFocused: false, windowId: WINDOW_ID_NONE });
  };

  /** The live connection is gone or replaced: cancel its work and forget its grants. */
  const dropConnectionState = (): void => {
    clearResults("disconnected");
    dwell.cancel("disconnected");
    discovery.cancel("disconnected");
    permissions.clear();
    lastPolicy = null;
    panelChanged();
  };

  const sensorLost = (): void => {
    dropConnectionState();
    liveClient = null;
    // No idle is sent while disconnected, so ending the visit here only moves the epoch.
    resetFocus();
    emitCurrent();
  };

  const coordinator: Coordinator = {
    tracker,
    permissions,
    activity,
    resumeCache,
    capabilities: caps,
    agentView() {
      const visit = tracker.current();
      return { currentSite: visit === null ? null : { origin: visit.origin, url: visit.url, visitEpoch: visit.epoch }, paused };
    },
    get stopped() {
      return stopped;
    },
    resendState() {
      if (stopped) return;
      lastEmitted = null;
      emitCurrent();
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
          clearResults("paused");
          dwell.cancel("paused");
          discovery.cancel("paused");
          diagnostics.event("paused", {});
          syncPolicy();
          emitCurrent();
          options.onPause?.();
          return;
        case "resume": {
          paused = false;
          diagnostics.event("resumed", {});
          syncPolicy();
          // The visit tracked while paused starts a fresh dwell.
          const visit = tracker.current();
          if (visit !== null && liveClient !== null) dwell.arm(visit);
          emitCurrent();
          return;
        }
        case "shutdown":
          coordinator.stop();
          options.onShutdownRequested?.();
          return;
        default:
          if (options.panel) void options.panel.handle(cmd);
          else options.emitPanel({ type: "ack", commandId: cmd.commandId, ok: false, code: "unavailable" });
      }
    },
    attachClient(client) {
      if (stopped) {
        client.close();
        return;
      }
      dropConnectionState();
      liveClient = client;
      // The handshake ack: capture-disabled until this connection's snapshot is validated.
      syncPolicy();
      // A new host starts from scratch; its permissions snapshot and focus will follow.
      resetFocus();
      diagnostics.event("sensor_connected", { conn: client.id });
      client.onFrame((frame) => {
        if (liveClient !== client) {
          diagnostics.event("stale_sensor_frame", { conn: client.id });
          return;
        }
        handleObservation(frame.observation, client);
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
      clearResults("stopped");
      dwell.stop();
      discovery.cancel("stopped");
      diagnostics.event("coordinator_stopped", {});
    },
  };

  emitCurrent();
  return coordinator;
}

export { canonicalIssueUrl };
