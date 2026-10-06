// The core's recommendation-job wiring (construction and ownership, no job policy of its own):
// the agent adapter for `agent-profile.json` (agents/registry.ts; none without a usable profile:
// every job is then `unavailable`), the adapters' shared readiness checks, the one-thread catalog
// parse pool, the job scheduler over the coordinator's live view, and the registry of every job
// process tree the core started (agents/processTree.ts ProcessTracker).
//
// The readiness check starts at once only when some host is recommendation-enabled
// (`config.destinations`), or (P4.6) as soon as the first host is enabled while the core runs;
// otherwise no agent runs, and the first job (after the first enabled settle) starts it and
// waits for it.
//
// The browser-context grant reaches the scheduler through the `grant` frames the panel channel
// emits (the same signal the window gets): `observePanel` sees every frame, and each change
// after the first bumps the revision job requests carry, then calls `scheduler.onGrantChanged`.
//
// Discovery passes: each pass's fetch session gets its own parse scope (catalog/parseWorker.ts):
// once the session is cancelled its parses are refused before they reach the worker, and its
// cancel fails only that pass's parses, so a cancelled pass never occupies the single worker.
// `parsersFor(session)` is what the pass's catalog resolve parses with.
//
// The agent profile (P3.4): the core holds `agent-profile.lock` (capabilities/storeLock.ts,
// named-lock option) for its lifetime, so the profile CLI's writes exit 2 meanwhile; a lock held
// elsewhere at start (a CLI write in progress) is retried every PROFILE_LOCK_RETRY_MS. The file
// stays user-editable, so wiring/profileWatcher.ts watches it; a change whose fingerprint differs
// (which any `tools.revision` change does) builds a new adapter for the next job, tells the
// scheduler (`onProfileChanged`: the running job is cancelled `superseded` and the visit's one
// replacement starts on the new adapter, budget permitting), and clears the
// resume cache (its key already carries the fingerprint and tools revision, so an old entry could
// not match; clearing just frees it). The replaced adapter is closed (`abortAll`) and awaited at
// close. An edit that leaves the profile unusable leaves no adapter: jobs are `unavailable`.
// The side panel's agent choice (`set_agent`) writes the profile through `switchAgent`
// (agents/profileSwitch.ts) only while the core holds the lock, and the watcher swaps the adapter
// as for any other edit; `onProfileChanged` tells the panel so Settings shows the new choice.
//
// Shutdown (main.ts calls each step in its order): `cancelReadinessChecks()` (synchronous) stops every
// running readiness check; `stopScheduler()` cancels the running job (`shutdown`); `abortJobs()` waits for
// every adapter's job process tree (SIGTERM → 2 s grace → SIGKILL → tracked descendants);
// `closeParsers()` terminates the parse worker; `releaseProfile()` stops the watcher and releases
// the lock; `reapDescendants(deadline)` SIGKILLs and waits for any tracked descendant a job's own
// reap left behind. `close(deadlineAt)` runs them all in that order (tests only; the core runs
// each step itself, bounded by its own deadline).
//
// The watcher's baseline is taken before the profile is first read, so an edit that lands between
// the read and the watch is still noticed (at worst once more than needed: the fingerprint decides).

import { join } from "node:path";
import type { PanelState } from "@scout/contracts";
import type { SnapshotRegistry } from "../activity/snapshots.js";
import type { ActivityStore } from "../activity/store.js";
import { readBrowserContextGrant } from "../agentApi/grants.js";
import type { AgentJobAdapter } from "../agents/adapter.js";
import { AGENT_PROFILE_LOCK_FILE, AgentProfileError, agentProfilePath, loadAgentProfile, profileFingerprint, type AgentProfile } from "../agents/profile.js";
import { ProcessTracker, type ProcessIdentity } from "../agents/processTree.js";
import { switchAgent, type SwitchAgentOutcome } from "../agents/profileSwitch.js";
import { createJobAdapter, createReadinessChecks } from "../agents/registry.js";
import type { CapabilityStore } from "../capabilities/store.js";
import { acquireStoreLock, StoreLockedError, type StoreLock } from "../capabilities/storeLock.js";
import { createParsePool } from "../catalog/parseWorker.js";
import type { CatalogParsers } from "../catalog/resolver.js";
import { verifyTargets } from "../catalog/verifyTargets.js";
import { systemTimers, type Clock, type Timers } from "../clock.js";
import type { Coordinator } from "../coordinator.js";
import type { Diagnostics } from "../diagnostics.js";
import { createOriginFetchSession, type OriginFetchSession } from "../fetch/originSession.js";
import { createJobScheduler, type JobScheduler, type SchedulerProfile } from "../jobScheduler.js";
import type { JobAnswer } from "../pipeline.js";
import type { ResultRegistry } from "../results.js";
import { createJobResumeCache } from "../resumeCache.js";
import { type ProfileWatcher, watchProfile, type WatchFn } from "./profileWatcher.js";

/** How often a profile lock held by someone else at start is tried again. */
export const PROFILE_LOCK_RETRY_MS = 5000;

export interface JobWiringOptions {
  /** SCOUT_HOME. */
  home: string;
  /** The core's environment (the adapter and its readiness check read it). */
  env: NodeJS.ProcessEnv;
  /** Recommendation-enabled hosts at start (`config.destinations`); later lists come through `destinationsChanged`. */
  destinations: readonly string[];
  coreInstanceId: string;
  clock: Clock;
  diagnostics: Diagnostics;
  results: ResultRegistry;
  /** Null until agent.sock is up. */
  snapshots: () => SnapshotRegistry | null;
  /** The coordinator; read only once a job needs it (it is built after this wiring). */
  coordinator: () => Coordinator;
  activity: Pick<ActivityStore, "entries">;
  store: Pick<CapabilityStore, "approvalRevision">;
  /** The profile changed (a new fingerprint, after the adapter swap). */
  onProfileChanged?: () => void;
  /** Test seams for the profile watcher and the lock retry. */
  timers?: Timers;
  watch?: WatchFn;
}

export interface JobWiring {
  readonly scheduler: JobScheduler;
  /** The adapter for the current profile; null without a usable one. */
  readonly adapter: AgentJobAdapter | null;
  /** Catalog parsers that run in the parse worker (no pass scope: the dev path and tests). */
  readonly parsers: CatalogParsers;
  /** A discovery pass's fetch session; cancelling it also cancels that pass's parses. */
  createFetchSession(origin: string): OriginFetchSession;
  /** The parsers for a session `createFetchSession` made: refused once it is cancelled. */
  parsersFor(session: OriginFetchSession): CatalogParsers;
  /**
   * The recommendation-enabled hosts changed (wiring/destinations.ts): the scheduler gets the new
   * list, and the first host enabled while none was starts the readiness check.
   */
  destinationsChanged(hosts: readonly string[]): void;
  /** Every panel frame passes here: a browser-context grant change reaches the scheduler. */
  observePanel(state: PanelState): void;
  /** Rises on every browser-context grant change after the first frame. */
  readonly grantRevision: number;
  /** Whether the core holds `agent-profile.lock`. */
  readonly holdsProfileLock: boolean;
  /**
   * `set_agent`: write the default profile for adapter `id` (agents/profileSwitch.ts); the watcher
   * swaps the adapter. `unavailable` unless the core holds the profile lock or after shutdown began.
   */
  switchAgent(id: string): SwitchAgentOutcome;
  /** The registry of job process trees. */
  readonly processes: ProcessTracker;
  /** Stop every running readiness check now, and start none from now on. Synchronous. */
  cancelReadinessChecks(): void;
  /** Cancel the running job (`shutdown`) and start none from now on. */
  stopScheduler(): void;
  /** Close every adapter (current and replaced) and wait for their jobs' process trees. */
  abortJobs(): Promise<void>;
  /** Refuse parses and terminate the parse worker. */
  closeParsers(): Promise<void>;
  /** Stop watching the profile and release its lock. */
  releaseProfile(): void;
  /** SIGKILL and wait (until `deadlineAt`, Date.now() time) for tracked descendants; resolves with survivors. */
  reapDescendants(deadlineAt: number): Promise<ProcessIdentity[]>;
  /** Tests only: every shutdown step above, in order; the descendant wait ends at `deadlineAt` (Date.now() time). */
  close(deadlineAt: number): Promise<void>;
}

export function createJobWiring(o: JobWiringOptions): JobWiring {
  const { home, clock, diagnostics } = o;
  const timers = o.timers ?? systemTimers;
  const parsePool = createParsePool({ diagnostics });
  const readinessChecks = createReadinessChecks();
  const processes = new ProcessTracker();

  // ---------- the profile lock ----------
  let lock: StoreLock | null = null;
  let lockRetry: unknown = null;
  let released = false;
  const takeLock = (): void => {
    lockRetry = null;
    if (released || lock !== null) return;
    try {
      lock = acquireStoreLock(home, { now: () => clock.now(), file: AGENT_PROFILE_LOCK_FILE });
      diagnostics.event("agent_profile_locked", {});
    } catch (e) {
      diagnostics.event("agent_profile_lock_busy", { code: e instanceof StoreLockedError ? "locked" : "lock_failed" });
      lockRetry = timers.setTimeout(takeLock, PROFILE_LOCK_RETRY_MS);
    }
  };
  takeLock();

  // ---------- the profile and its adapter ----------
  const buildAdapter = (p: AgentProfile | null): AgentJobAdapter | null =>
    p === null ? null : createJobAdapter(p, { home, parentEnv: o.env, readinessChecks, clock, diagnostics, processTracker: processes });
  const schedulerProfile = (p: AgentProfile | null, a: AgentJobAdapter | null): SchedulerProfile => ({
    fingerprint: a?.profileFingerprint ?? "none",
    toolsRevision: p?.tools?.revision ?? 0,
    hasUserTools: (p?.tools?.selections.length ?? 0) > 0,
  });
  // Watch first: its baseline predates the read below (see the header). It calls back only from a timer.
  const watcher: ProfileWatcher = watchProfile({
    path: agentProfilePath(home),
    onChange: () => reloadProfile(),
    timers,
    ...(o.watch ? { watch: o.watch } : {}),
    onFallback: () => diagnostics.event("agent_profile_watch_fallback", {}),
  });
  let profile = openAgentProfile(home, diagnostics);
  let adapter = buildAdapter(profile);
  /** Replaced adapters' abortAll(), awaited by abortJobs(). */
  const retired = new Set<Promise<void>>();
  // Off the event loop; the first job waits for it. With no enabled host, the first job starts it.
  let destinations = o.destinations;
  if (destinations.length > 0) void adapter?.refreshReadiness();

  // The grant as the window was last told it.
  let shownGrant: boolean | null = null;
  let grantRevision = 0;

  const resumeCache = createJobResumeCache<JobAnswer>({ clock, diagnostics });
  const scheduler = createJobScheduler({
    coreInstanceId: o.coreInstanceId,
    clock,
    diagnostics,
    destinations: o.destinations,
    results: o.results,
    snapshots: o.snapshots,
    view: {
      visit: () => {
        const c = o.coordinator();
        return c.stopped || c.agentView().paused ? null : c.tracker.current();
      },
      permissionsRevision: () => o.coordinator().permissions.revision,
      isPermitted: (origin) => o.coordinator().permissions.isPermitted(origin),
      captureAllowed: () => o.coordinator().captureAllowed(),
    },
    window: {
      working: (visitEpoch, jobId) => o.coordinator().showWorking(visitEpoch, jobId),
      idle: (visitEpoch) => o.coordinator().showIdle(visitEpoch),
    },
    activity: () => o.activity.entries(),
    browserContextGranted: () => readBrowserContextGrant(home),
    grantRevision: () => grantRevision,
    approvalRevision: () => o.store.approvalRevision,
    agent: () => adapter,
    profile: schedulerProfile(profile, adapter),
    socketPath: join(home, "run", "agent.sock"),
    verify: (candidates, v) => verifyTargets(candidates, { origin: v.origin, budgetMs: v.budgetMs, clock: v.clock, signal: v.signal }),
    resumeCache,
  });

  let stopped = false;
  /** Re-read the profile; a new fingerprint swaps the adapter for the next job. */
  const reloadProfile = (): void => {
    if (stopped) return;
    const next = openAgentProfile(home, diagnostics);
    const nextFingerprint = next === null ? "none" : profileFingerprint(next);
    if (nextFingerprint === (adapter?.profileFingerprint ?? "none")) return;
    const old = adapter;
    profile = next;
    adapter = buildAdapter(next);
    const view = schedulerProfile(profile, adapter);
    diagnostics.event("agent_profile_changed", { usable: adapter !== null, toolsRevision: view.toolsRevision });
    resumeCache.clear();
    scheduler.onProfileChanged(view);
    // The scheduler already cancelled the old adapter's job (`superseded`); closing it only waits for that run.
    if (old !== null) {
      const p = old.abortAll().catch(() => {});
      retired.add(p);
      void p.finally(() => retired.delete(p));
    }
    if (adapter !== null && destinations.length > 0) void adapter.refreshReadiness();
    o.onProfileChanged?.();
  };

  const sessions = new WeakMap<OriginFetchSession, CatalogParsers>();

  const releaseProfile = (): void => {
    if (released) return;
    released = true;
    watcher.close();
    if (lockRetry !== null) timers.clearTimeout(lockRetry);
    lock?.release();
    lock = null;
  };
  const stopScheduler = (): void => {
    stopped = true;
    scheduler.stop();
  };
  const abortJobs = async (): Promise<void> => {
    stopScheduler();
    readinessChecks.cancelAll();
    await Promise.all([adapter?.abortAll(), ...retired]);
  };

  let closing: Promise<void> | null = null;
  return {
    scheduler,
    get adapter() {
      return adapter;
    },
    parsers: parsePool.parsers,
    createFetchSession(origin) {
      const session = createOriginFetchSession({ origin, clock });
      const scope = parsePool.scope(() => session.isCancelled());
      const wrapped: OriginFetchSession = {
        ...session,
        cancel: () => {
          session.cancel();
          scope.cancel();
        },
      };
      sessions.set(wrapped, scope.parsers);
      return wrapped;
    },
    parsersFor(session) {
      return sessions.get(session) ?? parsePool.parsers;
    },
    destinationsChanged(hosts) {
      if (stopped) return;
      const wasNone = destinations.length === 0;
      destinations = hosts;
      // The readiness check first: a job the change starts at once shares this run instead of starting its own.
      if (wasNone && hosts.length > 0) void adapter?.refreshReadiness();
      scheduler.onDestinationsChanged(hosts);
    },
    observePanel(state) {
      if (state.type !== "grant" || state.agentBrowserContext === shownGrant) return;
      const first = shownGrant === null;
      shownGrant = state.agentBrowserContext;
      if (first) return;
      grantRevision += 1;
      scheduler.onGrantChanged(state.agentBrowserContext);
    },
    get grantRevision() {
      return grantRevision;
    },
    get holdsProfileLock() {
      return lock !== null;
    },
    switchAgent(id) {
      if (stopped || released || lock === null) return { ok: false, code: "unavailable" };
      const result = switchAgent(home, id, o.env);
      if (result.ok) {
        if (result.written) diagnostics.event("agent_profile_switched", { adapter: id });
      } else diagnostics.event("agent_profile_switch_failed", { code: result.code });
      return result;
    },
    processes,
    cancelReadinessChecks: () => readinessChecks.cancelAll(),
    stopScheduler,
    abortJobs,
    closeParsers: () => parsePool.close(),
    releaseProfile,
    reapDescendants: (deadlineAt) => processes.killAll(deadlineAt),
    close: (deadlineAt) =>
      (closing ??= (async () => {
        readinessChecks.cancelAll();
        stopScheduler();
        await abortJobs();
        await parsePool.close();
        releaseProfile();
        await processes.killAll(deadlineAt);
      })()),
  };
}

/** The agent profile, or null (reported to diagnostics) when it is missing or unusable: jobs are then `unavailable`. */
function openAgentProfile(home: string, diagnostics: Diagnostics): AgentProfile | null {
  try {
    return loadAgentProfile(home);
  } catch (e) {
    diagnostics.event("agent_profile_unavailable", { code: e instanceof AgentProfileError ? e.code : "profile: unreadable" });
    return null;
  }
}
