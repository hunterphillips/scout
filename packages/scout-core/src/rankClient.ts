import type { ActiveVisit, PageTextObservation, SiteCatalog } from "@scout/contracts";
import type { ActivityObservation, ContextStatus, RankResponse } from "personal-context-mcp/api";
import type { ActivitySend } from "./activityForwarder.js";
import type { Clock } from "./clock.js";
import type { Diagnostics } from "./diagnostics.js";
import type { ResumeCache } from "./resumeCache.js";
import { type AckTracker, createAckTracker, type Sleep } from "./rankClient/ackTracker.js";
import { createRankJob, type RankJob, type Timers } from "./rankClient/rankJob.js";
import type { ServiceTransport } from "./rankClient/transport.js";

/** The sensor name Scout reports to `observe_activity`. */
export const SCOUT_SENSOR = "scout-chrome";
/** Extra time past the rank's own budget before the SDK gives up on the call. */
const CALL_GRACE_MS = 2_000;

export interface RankClientResult {
  epoch: number;
  /** Always carries the three ContextStatus fields. */
  response: RankResponse;
  /** `service` when the service sent it; `local` when Scout wrote it (skip, timeout, transport failure). */
  source: "service" | "local";
  /** Scout's contextRevision this response was ranked against. */
  contextRevision: number;
}

export interface RankClientOptions {
  transport: ServiceTransport;
  clock: Clock;
  /** Scout's current contextRevision (the activity forwarder's). */
  getContextRevision: () => number;
  /** Receives every service-sent `ok` or `empty` result with its ContextStatus. */
  resumeCache?: ResumeCache<RankResponse>;
  diagnostics?: Diagnostics;
  /** Defaults to "the epoch of the latest `rankForVisit` or `setCurrentEpoch`". */
  isCurrentEpoch?: (epoch: number) => boolean;
  visitDeadlineMs?: number;
  /** Injected for tests. */
  sleep?: Sleep;
  timers?: Timers;
  newRequestId?: () => string;
}

export interface RankClient {
  /**
   * Rank a visit's catalog. Epochs are monotonic: call once per epoch, never for an epoch
   * older than the current one. One job per epoch: a second call for the same epoch returns
   * the first call's promise, and a call for a newer epoch cancels every other epoch's job.
   * A call for an older epoch resolves null at once (`rank_skipped`, reason `stale`) and
   * leaves the current job alone. Resolves with the final result, or null when the job was
   * cancelled or its epoch is no longer current. It always settles, so the caller never
   * stays `working`. Phase 4 must call `close()` at core shutdown.
   */
  rankForVisit(visit: ActiveVisit, catalog: SiteCatalog): Promise<RankClientResult | null>;
  /** The visit changed; cancels jobs for any other epoch. */
  setCurrentEpoch(epoch: number): void;
  /** Scout's contextRevision rose; a running rank for the current epoch becomes dirty. */
  notifyContextChanged(): void;
  /**
   * The `ActivitySend` for the activity forwarder: maps a `page_text` observation to
   * `observe_activity`, marks a running rank dirty, and resolves only on `accepted: true`.
   */
  sendObservation: ActivitySend;
  /** `context_status` for `resumeCache.restore`; rejects when the service cannot answer. */
  fetchContextStatus(): Promise<ContextStatus>;
  /** Cancels every job and closes the service session. */
  close(): Promise<void>;
}

/**
 * Scout's side of `rank_site_links` and `observe_activity`.
 *
 * Policy: the visit budget, ack wait, dirty re-rank, and timeout rules live in the rank
 * job (`rankClient/rankJob.ts`). This layer owns one job per epoch, drops any response
 * whose epoch is no longer current, stores service-sent `ok`/`empty` results in the resume
 * cache with the response's three ContextStatus fields, and tracks in-flight observation
 * sends so a rank can wait for their acks. Missing service or bad token arrive from the
 * transport as `unavailable`. Diagnostics are scalar: epochs, revisions, statuses, timings.
 */
export function createRankClient(options: RankClientOptions): RankClient {
  const { transport, clock, diagnostics } = options;
  const acks: AckTracker = createAckTracker(options.sleep ? { sleep: options.sleep } : {});
  const jobs = new Map<number, { job: RankJob; result: Promise<RankClientResult | null> }>();
  let currentEpoch: number | null = null;
  const isCurrent = options.isCurrentEpoch ?? ((epoch: number) => epoch === currentEpoch);

  const setCurrentEpoch = (epoch: number): void => {
    currentEpoch = epoch;
    for (const [e, entry] of jobs) {
      if (e === epoch) continue;
      entry.job.cancel();
      jobs.delete(e);
    }
  };

  const observe = async (obs: PageTextObservation): Promise<void> => {
    const at = new Date(obs.at);
    if (Number.isNaN(at.getTime())) throw new Error("scout: observation has no valid time");
    const observation: ActivityObservation = {
      sensor: SCOUT_SENSOR,
      kind: "viewed_page",
      observedAt: at.toISOString(),
      url: obs.url,
      title: obs.title,
      text: obs.text,
      truncated: obs.truncated,
    };
    const result = await transport.observeActivity(observation);
    if (!result.ok) throw new Error(`scout: observe_activity failed (${result.reason})`);
    if (!result.value.accepted) throw new Error("scout: observe_activity not accepted");
  };

  const notifyContextChanged = (): void => {
    if (currentEpoch !== null) jobs.get(currentEpoch)?.job.notifyContextChanged();
  };

  return {
    rankForVisit(visit, catalog) {
      const existing = jobs.get(visit.epoch);
      if (existing) return existing.result;
      if (currentEpoch !== null && visit.epoch < currentEpoch) {
        diagnostics?.event("rank_skipped", { epoch: visit.epoch, reason: "stale" });
        return Promise.resolve(null);
      }
      setCurrentEpoch(visit.epoch);
      const epoch = visit.epoch;
      const job = createRankJob({
        epoch,
        visitStartedAt: visit.startedAt,
        ...(options.visitDeadlineMs !== undefined ? { visitDeadlineMs: options.visitDeadlineMs } : {}),
        clock,
        rank: (req, signal) => transport.rankSiteLinks(req, { signal, timeoutMs: req.deadlineMs + CALL_GRACE_MS }),
        getContextRevision: options.getContextRevision,
        waitForAcks: (maxMs) => acks.waitForAcks(maxMs),
        lastContextStatus: () => transport.lastContextStatus(),
        ...(diagnostics ? { diagnostics } : {}),
        ...(options.timers ? { timers: options.timers } : {}),
        ...(options.newRequestId ? { newRequestId: options.newRequestId } : {}),
      });
      const startedAt = clock.now();
      const result = job.run({ origin: visit.origin }, catalog.candidates).then((outcome): RankClientResult | null => {
        if (jobs.get(epoch)?.job === job) jobs.delete(epoch);
        if (outcome.kind === "cancelled") return null;
        const { response, source, rev } = outcome;
        const dropped = !isCurrent(epoch);
        diagnostics?.event("rank_result", {
          epoch,
          status: response.status,
          ms: clock.now() - startedAt,
          dropped,
          local: source === "local",
          ...(source === "local" && "reason" in response ? { reason: response.reason } : {}),
        });
        if (dropped) return null;
        if (source === "service" && (response.status === "ok" || response.status === "empty")) {
          options.resumeCache?.store(
            {
              tabId: visit.tabId,
              ...(visit.documentId !== undefined ? { documentId: visit.documentId } : {}),
              url: visit.url,
              catalogVersion: catalog.version,
              contextRevision: rev,
            },
            response,
            {
              serviceInstanceId: response.serviceInstanceId,
              activityRevision: response.activityRevision,
              sourceGrantRevision: response.sourceGrantRevision,
            },
          );
        }
        return { epoch, response, source, contextRevision: rev };
      });
      jobs.set(epoch, { job, result });
      return result;
    },
    setCurrentEpoch,
    notifyContextChanged,
    sendObservation(obs) {
      const send = observe(obs);
      acks.track(send);
      notifyContextChanged();
      return send;
    },
    async fetchContextStatus() {
      const result = await transport.contextStatus();
      if (!result.ok) throw new Error(`scout: context_status failed (${result.reason})`);
      return result.value;
    },
    async close() {
      for (const { job } of jobs.values()) job.cancel();
      jobs.clear();
      await transport.close();
    },
  };
}
