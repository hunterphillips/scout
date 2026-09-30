import { randomUUID } from "node:crypto";
import type { Candidate } from "@scout/contracts";
import { type ContextStatus, MAX_DEADLINE_MS, type RankRequest, type RankResponse } from "personal-context-mcp/api";
import type { Clock } from "../clock.js";
import type { Diagnostics } from "../diagnostics.js";
import type { TransportResult } from "./transport.js";

/** One deadline per visit, from visit start, covering catalog, rank, and verification. */
export const VISIT_DEADLINE_MS = 30_000;
/** Held back from the rank for target verification (`VERIFY_BUDGET_MS`). */
export const VERIFY_RESERVE_MS = 4_000;
/** A rank (or re-rank) with less model time than this is not started. */
export const MIN_RANK_MS = 5_000;
/** Longest a rank start waits for in-flight `observe_activity` acks. */
export const ACK_WAIT_MS = 1_000;
export const RANK_MAX_RESULTS = 3;

/** Stand-in ContextStatus for a response Scout made up before the service ever answered. */
export const UNKNOWN_CONTEXT_STATUS: ContextStatus = Object.freeze({
  serviceInstanceId: "unknown",
  activityRevision: 0,
  sourceGrantRevision: "unknown",
});

export type RankJobState =
  | { kind: "idle" }
  | { kind: "ranking"; rev: number; requestId: string }
  /** A newer contextRevision arrived while ranking; the running rank's result will be discarded. */
  | { kind: "dirty"; rev: number; requestId: string };

export type RankJobOutcome =
  | {
      kind: "result";
      /** Always carries the three ContextStatus fields. */
      response: RankResponse;
      /** `service` when the service sent this response; `local` when Scout wrote it (skip, timeout, transport failure). */
      source: "service" | "local";
      /** Scout's contextRevision this response was ranked against. */
      rev: number;
      requestId: string | null;
    }
  | { kind: "cancelled" };

export type RankCall = (req: RankRequest, signal: AbortSignal) => Promise<TransportResult<RankResponse>>;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RankJobOptions {
  epoch: number;
  /** Clock time the visit started; the visit deadline counts from here. */
  visitStartedAt: number;
  visitDeadlineMs?: number;
  clock: Clock;
  rank: RankCall;
  /** Scout's current contextRevision (the activity forwarder's). */
  getContextRevision: () => number;
  waitForAcks: (maxMs: number) => Promise<void>;
  /** Last ContextStatus the service reported; stamped on responses Scout writes itself. */
  lastContextStatus?: () => ContextStatus | null;
  onState?: (state: RankJobState) => void;
  diagnostics?: Diagnostics;
  /** Injected for tests; defaults to the global timers. */
  timers?: Timers;
  /** Injected for tests; defaults to `randomUUID`. */
  newRequestId?: () => string;
}

export interface RankJob {
  /** Rank once for this epoch (re-ranking on invalidation). Resolves exactly once; call at most once. */
  run(site: { origin: string; name?: string }, candidates: readonly Candidate[]): Promise<RankJobOutcome>;
  /** A contextRevision bump (a `page_text` observation). During a rank it marks the job dirty. */
  notifyContextChanged(): void;
  /** Abort the in-flight call; `run` resolves `cancelled` and nothing else is emitted. */
  cancel(): void;
  readonly state: RankJobState;
  readonly finished: boolean;
}

interface RoundContext {
  /** The last discarded request, which the next round supersedes. */
  previousRequestId: string | null;
  /** The contextRevision the latest round ranked against. */
  rev: number;
}

const globalTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * One visit epoch's rank job.
 *
 * Policy: before each rank it waits up to 1 s for in-flight activity acks, then records
 * the contextRevision it ranks against, so a rank never claims observations acked after
 * it started. The model budget is `visitDeadline - now - 4000`, capped at 26 s; under 5 s
 * the rank is skipped (`no time left` for the first, `timed out` for a re-rank). A
 * contextRevision change while ranking makes the job dirty: when the call returns its
 * result is discarded and exactly one re-rank starts for the newest revision, with
 * `supersedes` naming the discarded request. Any number of changes during one rank
 * coalesce into that one re-rank. Re-ranks chain: a change during a re-rank discards it
 * too and starts one more, once per discard while at least 5 s of model time remain,
 * because the plan says further observations during the re-rank coalesce into it the same
 * way. In practice the chain is short: `page_text` observations are rare, and the 30 s
 * visit budget caps it. If the call runs past its budget it is aborted and the job ends
 * `unavailable: "timed out"`, never `empty`. A cancel or a local timeout always aborts
 * the call in flight, so the service never keeps running a model for a dead visit. A
 * throw from any injected dependency ends the job `unavailable: "service unreachable"`.
 * Every outcome is final and emitted once, so the caller never stays `working`.
 */
export function createRankJob(options: RankJobOptions): RankJob {
  const { clock, diagnostics, epoch } = options;
  const timers = options.timers ?? globalTimers;
  const newRequestId = options.newRequestId ?? randomUUID;
  const visitDeadline = options.visitStartedAt + (options.visitDeadlineMs ?? VISIT_DEADLINE_MS);

  let state: RankJobState = { kind: "idle" };
  let started = false;
  let finished = false;
  let cancelled = false;
  let controller: AbortController | null = null;
  let resolveCancel: (() => void) | null = null;
  const cancelSignal = new Promise<"cancelled">((resolve) => {
    resolveCancel = () => resolve("cancelled");
  });

  const setState = (next: RankJobState): void => {
    // idle -> idle is not a change; cancel() and the loop's finish would otherwise both emit it.
    if (next.kind === "idle" && state.kind === "idle") return;
    state = next;
    try {
      options.onState?.(next);
    } catch {
      // A throwing listener must not keep the job from settling.
    }
  };

  const statusFields = (): ContextStatus => {
    try {
      return { ...(options.lastContextStatus?.() ?? UNKNOWN_CONTEXT_STATUS) };
    } catch {
      return { ...UNKNOWN_CONTEXT_STATUS };
    }
  };

  const local = (
    status: "unavailable" | "error" | "cancelled",
    reason: string,
    rev: number,
    requestId: string | null,
  ): RankJobOutcome => ({ kind: "result", response: { status, reason, ...statusFields() }, source: "local", rev, requestId });

  const finish = (outcome: RankJobOutcome): RankJobOutcome => {
    finished = true;
    setState({ kind: "idle" });
    return outcome;
  };

  async function loop(site: { origin: string; name?: string }, candidates: readonly Candidate[]): Promise<RankJobOutcome> {
    const ctx: RoundContext = { previousRequestId: null, rev: 0 };
    for (;;) {
      let step: RankJobOutcome | "again";
      try {
        step = await round(site, candidates, ctx);
      } catch {
        // An injected dependency threw (e.g. a rejecting ack wait); the job still settles.
        step = cancelled ? { kind: "cancelled" } : local("unavailable", "service unreachable", ctx.rev, ctx.previousRequestId);
      }
      if (step !== "again") return finish(step);
    }
  }

  /** One rank round: returns the job's outcome, or `again` when its result was discarded for a re-rank. */
  async function round(
    site: { origin: string; name?: string },
    candidates: readonly Candidate[],
    ctx: RoundContext,
  ): Promise<RankJobOutcome | "again"> {
    if (cancelled) return { kind: "cancelled" };
    const acked = await Promise.race([options.waitForAcks(ACK_WAIT_MS).then(() => "acked" as const), cancelSignal]);
    // cancel() can run in the microtasks between the ack wait settling and this line; the
    // race above still reads "acked" then, so the flag is the check that counts.
    if (acked === "cancelled" || cancelled) return { kind: "cancelled" };
    const rev = options.getContextRevision();
    ctx.rev = rev;
    const deadlineMs = Math.min(visitDeadline - clock.now() - VERIFY_RESERVE_MS, MAX_DEADLINE_MS);
    if (deadlineMs < MIN_RANK_MS) {
      const reason = ctx.previousRequestId === null ? "no time left" : "timed out";
      diagnostics?.event("rank_skipped", { epoch, reason });
      return local("unavailable", reason, rev, ctx.previousRequestId);
    }

    const requestId = newRequestId();
    const request: RankRequest = {
      requestId,
      site: site.name === undefined ? { origin: site.origin } : { origin: site.origin, name: site.name },
      candidates: candidates.map(toRankCandidate),
      maxResults: RANK_MAX_RESULTS,
      deadlineMs: Math.floor(deadlineMs),
    };
    if (ctx.previousRequestId !== null) request.supersedes = ctx.previousRequestId;

    const roundController = new AbortController();
    controller = roundController;
    let timedOut = false;
    let fireTimeout: () => void = () => {};
    const deadlineHit = new Promise<"timed out">((resolve) => {
      fireTimeout = () => resolve("timed out");
    });
    const watchdog = timers.setTimeout(() => {
      timedOut = true;
      roundController.abort();
      fireTimeout();
    }, deadlineMs);

    let result: TransportResult<RankResponse> | "cancelled" | "timed out";
    try {
      setState({ kind: "ranking", rev, requestId });
      diagnostics?.event("rank_start", { epoch, rev, deadlineMs: request.deadlineMs });
      // The races keep cancel() and the deadline prompt even if `rank` ignores its signal.
      result = await Promise.race([options.rank(request, roundController.signal), cancelSignal, deadlineHit]);
    } catch {
      result = { ok: false, status: "unavailable", reason: "service unreachable" };
    } finally {
      timers.clearTimeout(watchdog);
      controller = null;
      // A call this job no longer waits for must not keep the service running a model.
      if (cancelled || timedOut) roundController.abort();
    }
    if (cancelled || result === "cancelled") return { kind: "cancelled" };

    const invalidated = state.kind === "dirty" || options.getContextRevision() !== rev;
    if (invalidated && !timedOut) {
      diagnostics?.event("rank_discarded", { epoch });
      ctx.previousRequestId = requestId;
      return "again";
    }
    if (timedOut || result === "timed out") return local("unavailable", "timed out", rev, requestId);
    if (!result.ok) return local(result.status === "cancelled" ? "unavailable" : result.status, result.reason, rev, requestId);
    // The service cancels a run at its deadline; to the panel that is a quiet timeout.
    if (result.value.status === "cancelled") {
      const { serviceInstanceId, activityRevision, sourceGrantRevision } = result.value;
      const response: RankResponse = { status: "unavailable", reason: "timed out", serviceInstanceId, activityRevision, sourceGrantRevision };
      return { kind: "result", response, source: "local", rev, requestId };
    }
    return { kind: "result", response: result.value, source: "service", rev, requestId };
  }

  return {
    get state() {
      return state;
    },
    get finished() {
      return finished;
    },
    run(site, candidates) {
      if (started) throw new Error("scout: rank job already started");
      started = true;
      return loop(site, candidates);
    },
    notifyContextChanged() {
      if (state.kind === "ranking") setState({ kind: "dirty", rev: state.rev, requestId: state.requestId });
    },
    cancel() {
      if (cancelled || finished) return;
      cancelled = true;
      controller?.abort();
      resolveCancel?.();
      setState({ kind: "idle" });
    },
  };
}

function toRankCandidate(c: Candidate): RankRequest["candidates"][number] {
  const out: RankRequest["candidates"][number] = { id: c.id, title: c.title, labelQuality: c.labelQuality };
  if (c.description !== undefined) out.description = c.description;
  return out;
}

