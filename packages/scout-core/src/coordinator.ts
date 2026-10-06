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
// Bridge protocol 3, per connection: on attach the core first sends a capture-disabled
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
// pass for its origin (discoveryRunner.ts). Pause, loss of the pass origin's grant, a visit
// change, disconnect (or a new sensor replacing the live one), and stop cancel it.
//
// Another app in front keeps the visit (visitTracker.ts `away`): its results, discovery pass
// and job carry on, and nothing is sent when Chrome comes back to the same page. Only a dwell
// that has not settled yet stops while away; it starts again, in full, on the return.
// agent.sock's current site stays hidden while away, as when no visit is in front.
//
// Recommendation jobs (jobScheduler.ts, `jobs`): the pass's catalog goes to the scheduler with
// the settle time (its 30 s budget starts at the settle) as soon as it resolves, and the
// scheduler hears visit changes, pause, sensor loss (and a replacing sensor), applied
// permissions, accepted activity (new content only), and stop. It shows a job through
// `showWorking` / `showIdle`, which emit only for the current, shown visit. Whether a visit's
// host is recommendation-enabled is in `agentView()`, asked of the scheduler (its
// `config.destinations` are the one source); without a scheduler nothing is enabled.
//
// Side panel commands (those with a `commandId`) go to the panel channel
// (panelChannel.ts), which answers them; without one each gets an `unavailable` ack. The
// coordinator tells the channel when the capability view may have changed: a permissions
// snapshot applied or cleared (offers follow Chrome's grants), the visit changed, or an ingest
// committed (and again when its export sync settles).
//
// Frame sinks (panelSinks.ts, `sinks`): every command arrives with the sink that sent it
// (the app's stdio, or the live connection's relay sink); commandRouting.ts decides whether it
// runs (frontmost/shutdown never from the relay; no commandId owned by another surface) and
// routes its answer back to that sink only. `pause`/`resume` and the panel commands are
// accepted from both. Each connection that completes its hello becomes the relay sink (the one
// it replaces is removed; a closed one too) and is repainted at once (panelChannel.ts
// `repaint`, with the last state sent), and again when its socket drains after backpressure
// dropped panel frames. A replaced connection's frames are ignored (`stale_sensor_frame`),
// except that a command naming a commandId is answered on that connection with an
// `unavailable` ack, so its panel does not wait forever.
//
// Recommendation results (results.ts) live only as long as their visit, which another app in
// front does not end: a visit change (which includes losing the origin's grant, which clears
// them first), pause, disconnect (or a replacing sensor), and stop clear them. These clears
// are silent: the state frame each sends next (the new visit's idle, paused, disconnected) is
// what makes the side panel drop them, and stop sends nothing. `resendState` is for the job
// scheduler's clears within one visit.

import {
  type ActiveVisit,
  type BrowserObservation,
  type FocusObservation,
  type NativeCommand,
  type PageTextObservation,
  type PanelState,
} from "@scout/contracts";
import { type ActivityStore, canonicalIssueUrl, createActivityStore } from "./activity/store.js";
import type { AgentView } from "./agentApi/handlers.js";
import type { JobScheduler } from "./jobScheduler.js";
import type { PanelChannel } from "./panelChannel.js";
import { createCommandRouting } from "./commandRouting.js";
import type { PanelSink, PanelSinks } from "./panelSinks.js";
import type { ResultRegistry } from "./results.js";
import type { Clock, Timers } from "./clock.js";
import type { Diagnostics } from "./diagnostics.js";
import { createDiscoveryRunner, type DiscoveryCapabilities } from "./discoveryRunner.js";
import { createDwellScheduler, type DwellScheduler } from "./dwell.js";
import { createPermissionState, GITHUB_ORIGIN, type PermissionState } from "./permissionState.js";
import type { SocketClient } from "./socketServer.js";
import { CHROME_BUNDLE_ID, createVisitTracker, type VisitChange, type VisitPresence, type VisitTracker, WINDOW_ID_NONE } from "./visitTracker.js";

export interface CoordinatorConfig {
  /** The bundle id treated as "Chrome frontmost". Defaults to CHROME_BUNDLE_ID. */
  chromeBundleId?: string;
}

/** What the coordinator tells the job scheduler. */
export type CoordinatorJobs = Pick<
  JobScheduler,
  "onSettled" | "onVisitChanged" | "onPause" | "onSensorLost" | "onPermissionsChanged" | "onActivityAccepted" | "stop" | "isEnabled"
>;

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
  /** Side panel commands and capability view. Without it those commands are refused. */
  panel?: Pick<PanelChannel, "handle" | "capabilitiesChanged"> & Partial<Pick<PanelChannel, "repaint">>;
  /**
   * Where panel frames go (main.ts registers the app's stdio sink). The coordinator
   * registers each live connection as a relay sink, and records which sink sent each command
   * so its answer goes back there. Without it frames go only through `emitPanel`.
   */
  sinks?: Pick<PanelSinks, "add" | "remove" | "routeCommand" | "routeOf" | "deliver">;
  /** Recommendation results, cleared whenever their visit stops being current. */
  results?: Pick<ResultRegistry, "clear">;
  /** Recommendation jobs. Without it a settled visit only runs discovery. */
  jobs?: CoordinatorJobs;
}

export type CoordinatorCapabilities = DiscoveryCapabilities;

export interface Coordinator {
  /**
   * One command from the Mac app or the side panel. `from` is the sink that sent it (its
   * answer goes there); a `relay` sink may not send `frontmost` or `shutdown`.
   */
  handleNativeCommand(cmd: NativeCommand, from: PanelSink): void;
  /** A native host completed a protocol-3 hello. The most recent one is the live sensor and the relay sink. */
  attachClient(client: SocketClient): void;
  /** Stop handling input and cancel pending dwell and discovery. Idempotent. */
  stop(): void;
  readonly stopped: boolean;
  readonly tracker: VisitTracker;
  readonly permissions: PermissionState;
  readonly activity: ActivityStore;
  readonly capabilities: CoordinatorCapabilities | undefined;
  /**
   * What agent.sock may see right now: the focused permitted visit and whether Scout is paused,
   * plus whether the visit's host is recommendation-enabled. A fresh copy.
   */
  agentView(): AgentView & { recommendationsEnabled: boolean };
  /** Send the current panel state again, even if it is the last one sent. */
  resendState(): void;
  /** GitHub capture is allowed right now: not paused, capture on, GitHub granted. */
  captureAllowed(): boolean;
  /**
   * The visit results belong to: the tracker's current visit, also while another app is in
   * front; null when paused or stopped.
   */
  shownVisit(): ActiveVisit | null;
  /** Show job `jobId` working for `visitEpoch`, if that visit is current and shown. */
  showWorking(visitEpoch: number, jobId: string): void;
  /** Send `visitEpoch`'s idle state, if that visit is current and shown (a job ended). */
  showIdle(visitEpoch: number): void;
}

const utf8 = new TextEncoder();

export function createCoordinator(options: CoordinatorOptions): Coordinator {
  const { clock, diagnostics } = options;
  const chromeBundleId = options.config.chromeBundleId ?? CHROME_BUNDLE_ID;
  const activity = options.activity ?? createActivityStore({ clock });
  const permissions = createPermissionState({ diagnostics });
  const caps = options.capabilities;
  const jobs = options.jobs;
  const panelChanged = (): void => options.panel?.capabilitiesChanged();
  // Silent: every caller sends a state frame next (a new visit's idle, paused, disconnected),
  // or none at all (stop), so a `resendState` here would only add a stray frame (an idle for the
  // old epoch before `disconnected`). The non-silent clear is for the job scheduler's clears
  // within one visit, where no other state frame follows.
  const clearResults = (reason: string): void => void options.results?.clear(reason, { silent: true });

  let paused = false;
  let stopped = false;
  let liveClient: SocketClient | null = null;
  /** The live connection's panel sink, while `sinks` is given. */
  let liveSink: PanelSink | null = null;
  let latestFocus: FocusObservation | null = null;
  let frontmostBundleId: string | null = null;
  let lastEmitted: string | null = null;
  /** The last state frame sent (a sink is repainted with it); the first is sent at construction. */
  let lastState: PanelState = { type: "state", status: "disconnected" };
  /** The last capture policy sent to the live client, and its revision. */
  let lastPolicy: { revision: number; paused: boolean; captureEnabled: boolean } | null = null;

  const emit = (state: PanelState): void => {
    const key = JSON.stringify(state);
    if (key === lastEmitted) return;
    lastEmitted = key;
    lastState = state;
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

  const currentState = (): PanelState => {
    if (paused) return { type: "state", status: "paused" };
    if (liveClient === null) return { type: "state", status: "disconnected" };
    return idleState(tracker.epoch, tracker.current());
  };
  const emitCurrent = (): void => emit(currentState());

  const routing = createCommandRouting({ ...(options.sinks ? { sinks: options.sinks } : {}), emitPanel: options.emitPanel, diagnostics });

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
    onCatalogReady: (visit, catalog) => jobs?.onSettled(visit, catalog, lastSettle?.epoch === visit.epoch ? lastSettle.at : clock.now()),
  });
  /** The last dwell settle: a job's budget starts there, not when its (possibly queued) pass ran. */
  let lastSettle: { epoch: number; at: number } | null = null;
  /** The current visit's dwell was stopped by another app in front, or a resume came while away: arm it on the return. */
  let dwellOnReturn = false;

  const dwell: DwellScheduler = createDwellScheduler({
    onSettled: (visit) => {
      lastSettle = { epoch: visit.epoch, at: clock.now() };
      discovery.settle(visit);
    },
    diagnostics,
    ...(options.timers ? { timers: options.timers } : {}),
    ...(options.dwellMs !== undefined ? { dwellMs: options.dwellMs } : {}),
  });

  // --- Visits ---

  const onVisitChange = (change: VisitChange): void => {
    if (change.previous === null && change.visit === null) return;
    dwellOnReturn = false;
    clearResults("visit_changed");
    jobs?.onVisitChanged();
    // The old visit's pass may never ingest; stop its fetches so the new visit's settle runs at once.
    discovery.cancel("visit_changed");
    panelChanged();
    if (change.visit === null) dwell.cancel("visit_ended");
    else if (!paused && liveClient !== null) dwell.arm(change.visit);
    if (paused || liveClient === null) return;
    emit(idleState(change.epoch, change.visit));
  };

  /** Another app in front, or back: only an unsettled dwell is affected (see the header). */
  const onPresence = ({ epoch, away }: VisitPresence): void => {
    if (away) {
      if (dwell.armedEpoch !== epoch) return;
      dwell.cancel("visit_suspended");
      dwellOnReturn = true;
      return;
    }
    if (!dwellOnReturn) return;
    dwellOnReturn = false;
    const visit = tracker.current();
    if (visit !== null && !paused && liveClient !== null) dwell.arm(visit);
  };

  const tracker = createVisitTracker({
    isPermitted: (origin) => permissions.isPermitted(origin),
    chromeBundleId,
    clock,
    diagnostics,
    onChange: onVisitChange,
    onPresence,
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
    jobs?.onPermissionsChanged();
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
        if (result.accepted) jobs?.onActivityAccepted(result.revision);
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
    tracker.reset();
  };

  /** The live connection is gone or replaced: cancel its work and forget its grants. */
  const dropConnectionState = (): void => {
    clearResults("disconnected");
    jobs?.onSensorLost();
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
    capabilities: caps,
    agentView() {
      // While another app is in front the agent sees no current site.
      const visit = tracker.away ? null : tracker.current();
      return {
        currentSite: visit === null ? null : { origin: visit.origin, url: visit.url, visitEpoch: visit.epoch },
        paused,
        recommendationsEnabled: visit !== null && (jobs?.isEnabled(visit.origin) ?? false),
      };
    },
    captureAllowed: captureEnabled,
    shownVisit() {
      return stopped || paused ? null : tracker.current();
    },
    showWorking(visitEpoch, jobId) {
      const visit = tracker.current();
      if (stopped || paused || liveClient === null || visit?.epoch !== visitEpoch) return;
      emit({ type: "state", status: "working", visitEpoch, detail: new URL(visit.origin).hostname, jobId });
    },
    showIdle(visitEpoch) {
      const visit = tracker.current();
      if (stopped || paused || liveClient === null || visit?.epoch !== visitEpoch) return;
      emit(idleState(visitEpoch, visit));
    },
    get stopped() {
      return stopped;
    },
    resendState() {
      if (stopped) return;
      lastEmitted = null;
      emitCurrent();
    },
    handleNativeCommand(cmd, from) {
      if (stopped) return;
      if (!routing.admit(cmd, from)) return;
      switch (cmd.type) {
        case "frontmost":
          frontmostBundleId = cmd.bundleId;
          tracker.observeFrontmost(cmd);
          return;
        case "pause":
          paused = true;
          dwellOnReturn = false;
          clearResults("paused");
          jobs?.onPause();
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
          if (visit !== null && liveClient !== null) {
            if (tracker.away) dwellOnReturn = true;
            else dwell.arm(visit);
          }
          emitCurrent();
          return;
        }
        case "shutdown":
          coordinator.stop();
          options.onShutdownRequested?.();
          return;
        default:
          if (options.panel) void options.panel.handle(cmd, from.id);
          else options.emitPanel({ type: "ack", commandId: cmd.commandId, ok: false, code: "unavailable" });
      }
    },
    attachClient(client) {
      if (stopped) {
        client.close();
        return;
      }
      dropConnectionState();
      if (liveSink !== null) options.sinks?.remove(liveSink);
      liveSink = null;
      liveClient = client;
      // The handshake ack: capture-disabled until this connection's snapshot is validated.
      syncPolicy();
      // A new host starts from scratch; its permissions snapshot and focus will follow.
      resetFocus();
      diagnostics.event("sensor_connected", { conn: client.id });
      const sink: PanelSink = {
        id: `relay-${client.id}`,
        kind: "relay",
        send: (state) => client.send({ type: "panel", state }),
      };
      client.onFrame((frame) => {
        if (liveClient !== client) {
          diagnostics.event("stale_sensor_frame", { conn: client.id });
          // A replaced connection has no sink: a command that expects an answer gets one directly.
          if (frame.type === "command" && "commandId" in frame.command) {
            client.send({ type: "panel", state: { type: "ack", commandId: frame.command.commandId, ok: false, code: "unavailable" } });
          }
          return;
        }
        switch (frame.type) {
          case "observation":
            handleObservation(frame.observation, client);
            return;
          case "command":
            coordinator.handleNativeCommand(frame.command, sink);
            return;
          case "refused_command":
            if (!stopped) routing.refuse(frame.command, frame.commandId, sink);
            return;
        }
      });
      client.onClose(() => {
        options.sinks?.remove(sink);
        if (liveSink === sink) liveSink = null;
        if (liveClient !== client || stopped) return;
        diagnostics.event("sensor_disconnected", { conn: client.id });
        sensorLost();
      });
      // After backpressure dropped window frames on this connection (socketServer.ts).
      client.onDrained(() => {
        if (liveSink === sink && !stopped) options.panel?.repaint?.(sink, lastState);
      });
      emitCurrent();
      if (options.sinks) {
        options.sinks.add(sink);
        liveSink = sink;
        options.panel?.repaint?.(sink, lastState);
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearResults("stopped");
      jobs?.stop();
      dwell.stop();
      discovery.cancel("stopped");
      diagnostics.event("coordinator_stopped", {});
    },
  };

  emitCurrent();
  return coordinator;
}

export { canonicalIssueUrl };
