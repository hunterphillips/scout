// Discovery on settled visits: one pass per settled visit's origin, one at a time, latest
// settle wins. A pass is one paced fetch session with one window; the catalog and resource
// discovery share it, then the store ingests only if the visit is still current and the
// origin still permitted (the caller's `blocker`).
//
// Pause, loss of the pass origin's grant, a visit change (the coordinator cancels with
// `visit_changed`), disconnect (or a new sensor replacing the live one), and stop cancel the
// running pass: its fetch session refuses every further request (the one in flight finishes),
// and the pass is discarded for good. Resuming or re-granting before it finishes does not let
// it ingest; the next settle produces a fresh pass instead. A cancelled pass no longer holds
// the slot: a settle (or the queued one) starts at once while the cancelled pass unwinds its
// in-flight request, so a new visit never waits behind the old visit's resource probes.
//
// The final check and the `store.ingest` call have no await between them, so the store is
// called with the permission state that check saw. A permission loss, pause, or navigation
// while the store's own ingest is in flight is not caught: that ingest commits with
// `chromePermitted: true`. The window is the store's write, and is accepted.
//
// The pass's catalog is handed on (`onCatalogReady`) so a recommendation job reuses it
// instead of fetching again: as soon as the catalog resolve settles, whatever its source
// (fresh, refetched, not_modified, stale, miss, or a failure), without waiting for resource
// discovery; never for a cancelled or blocked pass.

import type { ActiveVisit } from "@scout/contracts";
import type { DiscoveryResult } from "./capabilities/discovery.js";
import type { CapabilityStore } from "./capabilities/store.js";
import type { CatalogResolution } from "./catalog/resolveCatalog.js";
import type { Clock } from "./clock.js";
import type { Diagnostics } from "./diagnostics.js";
import type { OriginFetchSession } from "./fetch/originSession.js";

export interface DiscoveryCapabilities {
  store: Pick<CapabilityStore, "ingest">;
  /** One paced session per settled visit; the runner calls `startWindow()` once before discovery. */
  createFetchSession: (origin: string) => OriginFetchSession;
  /** The catalog resolve on the pass's session (it opens no window of its own). */
  resolveCatalog: (origin: string, session: OriginFetchSession) => Promise<CatalogResolution>;
  /** Resource discovery on the pass's session (it opens no window of its own). */
  discover: (origin: string, session: OriginFetchSession) => Promise<DiscoveryResult>;
}

export interface DiscoveryRunnerOptions {
  clock: Clock;
  diagnostics: Diagnostics;
  /** Without it a settle is only logged. */
  capabilities: DiscoveryCapabilities | undefined;
  /** Why a pass for `visit` must not run or ingest now, or null if it may. */
  blocker: (visit: ActiveVisit) => string | null;
  isPermitted: (origin: string) => boolean;
  /** An ingest committed (and again when its export sync settles). */
  onIngested: () => void;
  /** The pass's catalog, for a job on the same visit (see the header). */
  onCatalogReady?: (visit: ActiveVisit, catalog: CatalogResolution) => void;
}

export interface DiscoveryRunner {
  /** A visit settled: run its pass now, or queue it behind the running one (latest wins). */
  settle(visit: ActiveVisit): void;
  /** Cancel the running pass and drop the queued settle. */
  cancel(reason: string): void;
  /** Cancel the running pass and drop the queued settle when their origin is no longer permitted. */
  permissionsChanged(): void;
}

/** A discovery pass in progress; `cancelled` is set when it must never ingest, whatever happens next. */
interface RunningPass {
  visit: ActiveVisit;
  cancelled: string | null;
  /** Null until the pass has created its fetch session. */
  session: OriginFetchSession | null;
}

export function createDiscoveryRunner(options: DiscoveryRunnerOptions): DiscoveryRunner {
  const { clock, diagnostics, capabilities: caps } = options;
  let runningPass: RunningPass | null = null;
  let pendingSettle: ActiveVisit | null = null;

  /** Stop the running pass's fetches and mark it never to ingest. The first reason wins. */
  const cancelRunningPass = (reason: string): void => {
    if (runningPass === null) return;
    runningPass.cancelled ??= reason;
    runningPass.session?.cancel();
  };

  const discarded = (visit: ActiveVisit, reason: string): void =>
    diagnostics.event("discovery_discarded", { origin: visit.origin, epoch: visit.epoch, reason });

  const dropPendingSettle = (reason: string): void => {
    if (pendingSettle === null) return;
    discarded(pendingSettle, reason);
    pendingSettle = null;
  };

  /** Hand the catalog on if the pass is still live and its visit current. */
  const catalogReady = (pass: RunningPass, catalog: CatalogResolution): void => {
    if (options.onCatalogReady === undefined || pass.cancelled !== null || options.blocker(pass.visit) !== null) return;
    try {
      options.onCatalogReady(pass.visit, catalog);
    } catch {
      diagnostics.event("discovery_catalog_handler_failed", { epoch: pass.visit.epoch });
    }
  };

  const runPass = async (visit: ActiveVisit, c: DiscoveryCapabilities): Promise<void> => {
    const pass: RunningPass = { visit, cancelled: null, session: null };
    runningPass = pass;
    const { origin, epoch } = visit;
    const started = clock.now();
    try {
      const session = c.createFetchSession(origin);
      pass.session = session;
      session.startWindow();
      diagnostics.event("discovery_start", { origin, epoch });
      // A job needs the catalog only, never the resource probes: hand it on the moment it is ready.
      const catalogPromise = c.resolveCatalog(origin, session).then((resolution) => {
        catalogReady(pass, resolution);
        return resolution;
      });
      const [catalogOutcome, discovery] = await Promise.allSettled([catalogPromise, c.discover(origin, session)]);
      if (catalogOutcome.status === "rejected") diagnostics.event("discovery_catalog_failed", { origin, epoch, code: errorCode(catalogOutcome.reason) });
      if (discovery.status === "rejected") {
        diagnostics.event("discovery_failed", { origin, epoch, code: errorCode(discovery.reason) });
        return;
      }
      // No await from here to the ingest call: the store sees the state this check saw.
      const blocked = pass.cancelled ?? options.blocker(visit);
      if (blocked !== null) {
        discarded(visit, blocked);
        return;
      }
      const chromePermitted = options.isPermitted(origin);
      const report = await c.store.ingest(discovery.value, { chromePermitted });
      options.onIngested();
      void report.cleanup.then(options.onIngested, () => {});
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
      // A cancelled pass may already have been succeeded by a fresh one: leave that one alone.
      if (runningPass === pass) {
        runningPass = null;
        startPending();
      }
    }
  };

  /** Start the queued settle, if any. */
  const startPending = (): void => {
    const next = pendingSettle;
    pendingSettle = null;
    if (next !== null) settle(next);
  };

  const settle = (visit: ActiveVisit): void => {
    const blocked = options.blocker(visit);
    if (blocked !== null) {
      discarded(visit, blocked);
      return;
    }
    if (caps === undefined) {
      diagnostics.event("discovery_skipped", { origin: visit.origin, epoch: visit.epoch, reason: "not_wired" });
      return;
    }
    // Only a live pass holds the slot; a cancelled one finishes its in-flight request on its own.
    if (runningPass !== null && runningPass.cancelled === null) {
      if (pendingSettle !== null) discarded(pendingSettle, "superseded");
      pendingSettle = visit;
      diagnostics.event("discovery_queued", { origin: visit.origin, epoch: visit.epoch });
      return;
    }
    void runPass(visit, caps);
  };

  return {
    settle,
    cancel(reason) {
      dropPendingSettle(reason);
      cancelRunningPass(reason);
    },
    permissionsChanged() {
      if (pendingSettle !== null && !options.isPermitted(pendingSettle.origin)) dropPendingSettle("permission_lost");
      if (runningPass !== null && !options.isPermitted(runningPass.visit.origin)) {
        cancelRunningPass("permission_lost");
        // The queued settle need not wait for the cancelled pass to unwind.
        startPending();
      }
    },
  };
}

/** A scalar code for a thrown value; never its message, which may carry a URL. */
export function errorCode(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return typeof code === "string" && /^[\w-]{1,64}$/.test(code) ? code : e.name;
  }
  return "unknown";
}
