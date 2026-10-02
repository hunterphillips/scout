// The core's recommendation-job wiring (pure construction, no policy of its own): the agent
// adapter for `agent-profile.json` (none without a usable profile: every job is then
// `unavailable`), its child-process billing preflight (agents/preflightWorker.ts), the
// one-thread catalog parse pool, and the job scheduler over the coordinator's live view.
//
// The preflight starts at once only when some host is recommendation-enabled
// (`config.destinations`); otherwise no `claude` runs at start, and the first job (after the
// first enabled settle) starts it and waits for it (claudeJob.ts).
//
// The browser-context grant reaches the scheduler through the `grant` frames the panel channel
// emits (the same signal the window gets): `observePanel` sees every frame, and each change
// after the first bumps the revision job requests carry, then calls `scheduler.onGrantChanged`.
//
// Shutdown: `killPreflight()` (synchronous, before anything is awaited) kills a running
// preflight child; `close()` stops the scheduler (its job is cancelled `shutdown`), kills the
// preflight, waits for the job's process tree (`adapter.abortAll()`), and closes the parse pool.

import { join } from "node:path";
import type { PanelState } from "@scout/contracts";
import type { SnapshotRegistry } from "../activity/snapshots.js";
import type { ActivityStore } from "../activity/store.js";
import { readBrowserContextGrant } from "../agentApi/grants.js";
import { createClaudeJobAdapter, type ClaudeJobAdapter } from "../agents/claudeJob.js";
import { createPreflightFacade } from "../agents/preflightWorker.js";
import { AgentProfileError, loadAgentProfile, type AgentProfile } from "../agents/profile.js";
import type { CapabilityStore } from "../capabilities/store.js";
import { createParsePool } from "../catalog/parseWorker.js";
import type { CatalogParsers } from "../catalog/resolver.js";
import { verifyTargets } from "../catalog/verifyTargets.js";
import type { Clock } from "../clock.js";
import type { Coordinator } from "../coordinator.js";
import type { Diagnostics } from "../diagnostics.js";
import { createOriginFetchSession, type OriginFetchSession } from "../fetch/originSession.js";
import { createJobScheduler, type JobScheduler } from "../jobScheduler.js";
import type { JobAnswer } from "../pipeline.js";
import type { ResultRegistry } from "../results.js";
import { createJobResumeCache } from "../resumeCache.js";

export interface JobWiringOptions {
  /** SCOUT_HOME. */
  home: string;
  /** The core's environment (the adapter's launch profile and preflight read it). */
  env: NodeJS.ProcessEnv;
  /** Recommendation-enabled hosts (`config.destinations`). */
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
}

export interface JobWiring {
  readonly scheduler: JobScheduler;
  /** Null without a usable agent profile. */
  readonly adapter: ClaudeJobAdapter | null;
  /** Catalog parsers that run in the parse worker. */
  readonly parsers: CatalogParsers;
  /** A discovery pass's fetch session; cancelling it also cancels the pass's parses. */
  createFetchSession(origin: string): OriginFetchSession;
  /** Every panel frame passes here: a browser-context grant change reaches the scheduler. */
  observePanel(state: PanelState): void;
  /** Rises on every browser-context grant change after the first frame. */
  readonly grantRevision: number;
  /** Kill a running preflight child now, and start none from now on. */
  killPreflight(): void;
  /** Stop the scheduler, kill the preflight, wait for the job's process tree, close the parse pool. */
  close(): Promise<void>;
}

export function createJobWiring(o: JobWiringOptions): JobWiring {
  const { home, clock, diagnostics } = o;
  const parsePool = createParsePool({ diagnostics });
  const preflight = createPreflightFacade();
  const profile = openAgentProfile(home, diagnostics);
  const adapter: ClaudeJobAdapter | null =
    profile === null ? null : createClaudeJobAdapter({ home, profile, parentEnv: o.env, preflightAsync: preflight, clock, diagnostics });
  // Off the event loop; the first job waits for it. With no enabled host, the first job starts it.
  if (o.destinations.length > 0) void adapter?.refreshPreflightAsync();

  // The grant as the window was last told it.
  let shownGrant: boolean | null = null;
  let grantRevision = 0;

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
    agent: adapter,
    profile: {
      fingerprint: adapter?.profileFingerprint ?? "none",
      toolsRevision: profile?.tools?.revision ?? 0,
      hasUserTools: (profile?.tools?.selections.length ?? 0) > 0,
    },
    socketPath: join(home, "run", "agent.sock"),
    verify: (candidates, v) => verifyTargets(candidates, { origin: v.origin, budgetMs: v.budgetMs, clock: v.clock, signal: v.signal }),
    resumeCache: createJobResumeCache<JobAnswer>({ clock, diagnostics }),
  });

  let closing: Promise<void> | null = null;
  return {
    scheduler,
    adapter,
    parsers: parsePool.parsers,
    createFetchSession(origin) {
      const session = createOriginFetchSession({ origin, clock });
      return {
        ...session,
        cancel: () => {
          session.cancel();
          parsePool.cancel();
        },
      };
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
    killPreflight: () => preflight.cancelAll(),
    close: () =>
      (closing ??= (async () => {
        scheduler.stop();
        preflight.cancelAll();
        await adapter?.abortAll();
        await parsePool.close();
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
