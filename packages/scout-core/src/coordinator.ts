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
// page_text is forwarded only when not paused, a snapshot has arrived on this connection,
// that snapshot enables GitHub capture and grants GitHub, Chrome is frontmost with a
// focused, non-incognito window, and the text comes from the focused tab's issue. The
// document check applies only when the focus carries a `documentId`; the extension's
// focus observations do not carry one today, so the same-document check is the
// extension's.
//
// A visit that stays unchanged for DWELL_MS settles (dwell.ts) and starts one discovery
// pass for its origin: one paced fetch session with one window, the catalog and resource
// discovery sharing it, then a store ingest only if the visit is still current and the
// origin still permitted. One pass runs at a time; settles meanwhile queue, latest wins.
// Pausing discards the running pass for good: resuming before it finishes does not let it
// ingest; the dwell re-armed on resume produces a fresh pass instead.
//
// The final check and the `store.ingest` call have no await between them, so the store
// is called with the permission state that check saw. A permission loss, pause, or
// navigation while the store's own ingest is in flight is not caught: that ingest commits
// with `chromePermitted: true`. The window is the store's write, and is accepted.

import type {
  ActiveVisit,
  BrowserObservation,
  FocusObservation,
  NativeCommand,
  PageTextObservation,
  PanelState,
} from "@scout/contracts";
import { createActivityForwarder, type ActivityForwarder, type ActivitySend } from "./activityForwarder.js";
import type { AgentView } from "./agentApi/handlers.js";
import type { DiscoveryResult } from "./capabilities/discovery.js";
import type { CapabilityStore } from "./capabilities/store.js";
import type { CatalogResolution } from "./catalog/resolveCatalog.js";
import type { Clock, Timers } from "./clock.js";
import type { Diagnostics } from "./diagnostics.js";
import { createDwellScheduler, type DwellScheduler } from "./dwell.js";
import type { OriginFetchSession } from "./fetch/originSession.js";
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
  /** Phase 3 passes the real observe_activity client. */
  sendActivity?: ActivitySend;
  /** How long a visit must stay unchanged before discovery; defaults to DWELL_MS. */
  dwellMs?: number;
  /** Called once when a `shutdown` command stops the coordinator. */
  onShutdownRequested?: () => void;
  /** Resource discovery on settled visits. Without it a settle is only logged. */
  capabilities?: CoordinatorCapabilities;
}

export interface CoordinatorCapabilities {
  store: Pick<CapabilityStore, "ingest">;
  /** One paced session per settled visit; the coordinator calls `startWindow()` once before discovery. */
  createFetchSession: (origin: string) => OriginFetchSession;
  /** The catalog resolve on the pass's session (it opens no window of its own). */
  resolveCatalog: (origin: string, session: OriginFetchSession) => Promise<CatalogResolution>;
  /** Resource discovery on the pass's session (it opens no window of its own). */
  discover: (origin: string, session: OriginFetchSession) => Promise<DiscoveryResult>;
}

export interface Coordinator {
  handleNativeCommand(cmd: NativeCommand): void;
  /** A native host completed a protocol-2 hello. The most recent one is the live sensor. */
  attachClient(client: SocketClient): void;
  /** Stop handling input and cancel pending dwell and discovery. Idempotent. */
  stop(): void;
  readonly stopped: boolean;
  readonly tracker: VisitTracker;
  readonly permissions: PermissionState;
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
  const permissions = createPermissionState({ diagnostics });
  const caps = options.capabilities;

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
    if (visit === null) return { type: "state", status: "idle", visitEpoch };
    return { type: "state", status: "idle", visitEpoch, detail: new URL(visit.origin).hostname };
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

  /** The running pass; `cancelled` is set when it must never ingest, whatever happens next. */
  let runningPass: { visit: ActiveVisit; cancelled: string | null } | null = null;
  let pendingSettle: ActiveVisit | null = null;

  /** Why a pass for `visit` must not run or ingest now, or null if it may. */
  const discoveryBlocker = (visit: ActiveVisit): string | null => {
    if (stopped) return "stopped";
    if (paused) return "paused";
    if (!permissions.isPermitted(visit.origin)) return "permission_lost";
    if (tracker.current()?.epoch !== visit.epoch) return "epoch_changed";
    return null;
  };

  const discarded = (visit: ActiveVisit, reason: string): void =>
    diagnostics.event("discovery_discarded", { origin: visit.origin, epoch: visit.epoch, reason });

  const runPass = async (visit: ActiveVisit, c: CoordinatorCapabilities): Promise<void> => {
    const pass: { visit: ActiveVisit; cancelled: string | null } = { visit, cancelled: null };
    runningPass = pass;
    const { origin, epoch } = visit;
    const started = clock.now();
    try {
      const session = c.createFetchSession(origin);
      session.startWindow();
      diagnostics.event("discovery_start", { origin, epoch });
      const [catalog, discovery] = await Promise.allSettled([c.resolveCatalog(origin, session), c.discover(origin, session)]);
      if (catalog.status === "rejected") diagnostics.event("discovery_catalog_failed", { origin, epoch, code: errorCode(catalog.reason) });
      if (discovery.status === "rejected") {
        diagnostics.event("discovery_failed", { origin, epoch, code: errorCode(discovery.reason) });
        return;
      }
      // No await from here to the ingest call: the store sees the state this check saw.
      const blocked = pass.cancelled ?? discoveryBlocker(visit);
      if (blocked !== null) {
        discarded(visit, blocked);
        return;
      }
      const chromePermitted = permissions.isPermitted(origin);
      const report = await c.store.ingest(discovery.value, { chromePermitted });
      void report.cleanup.catch(() => {});
      diagnostics.event("discovery_ingested", {
        origin,
        epoch,
        results: report.results.length,
        skipped: report.skipped,
        ms: clock.now() - started,
      });
    } catch (e) {
      diagnostics.event("discovery_failed", { origin, epoch, code: errorCode(e) });
    } finally {
      runningPass = null;
      const next = pendingSettle;
      pendingSettle = null;
      if (next !== null) startPass(next);
    }
  };

  const startPass = (visit: ActiveVisit): void => {
    const blocked = discoveryBlocker(visit);
    if (blocked !== null) {
      discarded(visit, blocked);
      return;
    }
    if (caps === undefined) {
      diagnostics.event("discovery_skipped", { origin: visit.origin, epoch: visit.epoch, reason: "not_wired" });
      return;
    }
    if (runningPass !== null) {
      if (pendingSettle !== null) discarded(pendingSettle, "superseded");
      pendingSettle = visit;
      diagnostics.event("discovery_queued", { origin: visit.origin, epoch: visit.epoch });
      return;
    }
    void runPass(visit, caps);
  };

  const dropPendingSettle = (reason: string): void => {
    if (pendingSettle === null) return;
    discarded(pendingSettle, reason);
    pendingSettle = null;
  };

  const dwell: DwellScheduler = createDwellScheduler({
    onSettled: startPass,
    diagnostics,
    ...(options.timers ? { timers: options.timers } : {}),
    ...(options.dwellMs !== undefined ? { dwellMs: options.dwellMs } : {}),
  });

  // --- Visits ---

  const onVisitChange = (change: VisitChange): void => {
    if (change.previous === null && change.visit === null) return;
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
    getContextRevision: () => forwarder.contextRevision,
  });

  /** Why a page_text is not forwarded, or null to forward it. */
  const gatePageText = (obs: PageTextObservation): string | null => {
    if (paused) return "paused";
    if (!permissions.received) return "no_permissions_snapshot";
    if (!permissions.githubCapture || !permissions.isPermitted(GITHUB_ORIGIN)) return "capture_disabled";
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
    if (before !== null && !permissions.isPermitted(before.origin)) {
      dwell.cancel("permission_lost");
      diagnostics.event("permission_lost", { origin: before.origin, epoch: before.epoch });
    }
    if (pendingSettle !== null && !permissions.isPermitted(pendingSettle.origin)) dropPendingSettle("permission_lost");
    tracker.recompute();
    syncPolicy();
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
        void forwarder.forward(obs);
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
    dwell.cancel("disconnected");
    dropPendingSettle("disconnected");
    permissions.clear();
    lastPolicy = null;
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
    forwarder,
    resumeCache,
    capabilities: caps,
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
          dwell.cancel("paused");
          dropPendingSettle("paused");
          if (runningPass !== null) runningPass.cancelled = "paused";
          diagnostics.event("paused", {});
          syncPolicy();
          emitCurrent();
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
      dwell.stop();
      dropPendingSettle("stopped");
      diagnostics.event("coordinator_stopped", { pending: forwarder.pendingCount });
    },
  };

  emitCurrent();
  return coordinator;
}

/** A scalar code for a thrown value; never its message, which may carry a URL. */
function errorCode(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return typeof code === "string" && /^[\w-]{1,64}$/.test(code) ? code : e.name;
  }
  return "unknown";
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
