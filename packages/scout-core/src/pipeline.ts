// One recommendation job, from its immutable snapshot to the answer Scout's window may show:
// build the job request from a fixed template, run the user's agent through the adapter,
// validate its picks, verify at most three targets with the bounded checker, and map them to
// display items. The scheduler (jobScheduler.ts) owns when a job runs, its cancellation, the
// window's state frames, and the publish; this file owns what the answer is.
//
// The request carries only what the snapshot fixed: model-facing candidate fields (id, title,
// description, label quality; never the link `site_links` serves), the snapshot's id and
// revisions, and the remaining budget. Candidate, issue and site text are untrusted; the prompt
// template (agents/prompt.ts) keeps them in its untrusted block, and nothing in them reaches
// the tool grants, output schema, origin, or deadline.
//
// Verification gets the job's signal: a cancel during it ends the pass at once, and the job is
// discarded at the verify stage.
//
// Every stage re-checks `stillCurrent` (core instance, visit epoch, snapshot, permissions and
// browser-context grant revisions, profile fingerprint) and returns a discard instead of an
// answer once anything moved. The adapter may still report `ok` for a job cancelled while its
// output drained (a ~1.5 s window), so a discard never depends on the adapter's own status.
//
// Answers: `empty` only when the model said so. Picks are validated against the snapshot's
// candidates (an unknown or repeated id is `error/invalid_output`); picks that all fail
// verification are `error/agent_failed` with `verifyAllFailed` in the details, never "nothing
// relevant". Reasons go only into the answer for Scout's window; never into diagnostics.

import { JOB_MAX_PICKS, type Candidate, type HostJobResult, type JobRequest } from "@scout/contracts";
import type { JobSnapshot } from "./activity/snapshots.js";
import { MIN_LAUNCH_MS, type AgentJobAdapter, type JobDetails } from "./agents/adapter.js";
import type { PromptActivity } from "./agents/prompt.js";
import { VERIFY_BUDGET_MS, type VerifyResult } from "./catalog/verifyTargets.js";
import type { Clock } from "./clock.js";
import type { PublishedItem, PublishedResult } from "./results.js";

/** Time kept back from the agent for target verification. */
export const VERIFY_RESERVE_MS = VERIFY_BUDGET_MS;

/**
 * The one launch threshold: below this much visit budget a job is not started
 * (`unavailable: no_time_left`). It is the adapter's own launch floor plus the verification
 * reserve, so a job the scheduler starts always leaves the adapter at least MIN_LAUNCH_MS.
 */
export const MIN_JOB_MS = MIN_LAUNCH_MS + VERIFY_RESERVE_MS;

/** A job's answer before its identity is stamped on: what the registry will hold. */
export type JobAnswer = DistributiveOmit<PublishedResult, "coreInstanceId" | "visitEpoch" | "origin" | "jobId">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type DiscardStage = "agent" | "verify";

/** How many picks went to verification and how many survived it (counts only). */
export interface VerifyCounts {
  picked: number;
  verified: number;
}

export type JobRun =
  | { kind: "answer"; answer: JobAnswer; details: JobDetails | undefined; verifyAllFailed: boolean; verify?: VerifyCounts }
  | { kind: "discard"; stage: DiscardStage; why: string; details: JobDetails | undefined; verify?: VerifyCounts };

/** The part of the adapter a job calls. */
export type JobAgent = Pick<AgentJobAdapter, "run">;

/** The bounded target check. It must end promptly once `signal` aborts (the job was cancelled). */
export type VerifyFn = (candidates: readonly Candidate[], options: { origin: string; budgetMs: number; clock: Clock; signal: AbortSignal }) => Promise<VerifyResult>;

export interface RunJobInput {
  coreInstanceId: string;
  snapshot: JobSnapshot;
  /** The job token `take` issued with the snapshot. */
  token: string;
  /** The catalog's candidates (with their source URLs), for verification only. */
  candidates: readonly Candidate[];
  grantRevision: number;
  agent: JobAgent;
  /** agent.sock, for Scout's MCP server in the job. */
  socketPath: string;
  verify: VerifyFn;
  clock: Clock;
  signal: AbortSignal;
  /** The visit budget's end, on `clock`. */
  visitDeadline: number;
  /** Why the job's answer no longer counts, or null while it does. */
  stillCurrent: () => string | null;
}

/** The job request for a snapshot: explicit field mapping, nothing the model must not see. */
export function buildJobRequest(input: Pick<RunJobInput, "coreInstanceId" | "snapshot" | "grantRevision">, deadlineMs: number): JobRequest {
  const s = input.snapshot;
  return {
    requestId: s.jobId,
    coreInstanceId: input.coreInstanceId,
    visitEpoch: s.visitEpoch,
    origin: s.origin,
    catalogHash: s.catalogHash,
    browserSnapshot: { id: s.id, revision: s.revision },
    approvalRevision: s.approvalRevision,
    grantRevision: input.grantRevision,
    profileFingerprint: s.profileFingerprint,
    deadlineMs,
    candidates: s.candidates.map((c) => ({
      id: c.id,
      title: c.title,
      ...(c.description !== undefined ? { description: c.description } : {}),
      labelQuality: c.labelQuality,
    })),
    maxPicks: JOB_MAX_PICKS,
  };
}

/** A host result (anything but `ok`) as the window's answer. */
function nonOkAnswer(result: Exclude<HostJobResult, { status: "ok" }>): JobAnswer {
  switch (result.status) {
    case "empty":
      return { status: "empty" };
    case "cancelled":
      return { status: "cancelled", reason: result.reason };
    case "unavailable":
      return { status: "unavailable", reason: result.reason };
    case "error":
      return { status: "error", reason: result.reason };
  }
}

export async function runJob(input: RunJobInput): Promise<JobRun> {
  const { snapshot, clock } = input;
  const remaining = (): number => input.visitDeadline - clock.now();
  // The agent's share of the budget: what is left, less the verification reserve.
  const agentDeadline = input.visitDeadline - VERIFY_RESERVE_MS;
  const deadlineMs = Math.min(30_000, Math.floor(agentDeadline - clock.now()));
  let counts: VerifyCounts | undefined;
  const answer = (a: JobAnswer, details: JobDetails | undefined, verifyAllFailed = false): JobRun => ({
    kind: "answer",
    answer: a,
    details,
    verifyAllFailed,
    ...(counts ? { verify: counts } : {}),
  });
  if (deadlineMs < 1) return answer({ status: "unavailable", reason: "no_time_left" }, undefined);

  const request = buildJobRequest(input, deadlineMs);
  const activity: PromptActivity[] = snapshot.activity.map((a) => ({ title: a.title, ...(a.text !== undefined ? { text: a.text } : {}) }));
  let outcome;
  try {
    outcome = await input.agent.run(request, {
      toolSurface: { scout: { socketPath: input.socketPath, token: input.token } },
      signal: input.signal,
      deadline: agentDeadline,
      clock,
      activity,
    });
  } catch {
    return answer({ status: "error", reason: "agent_failed" }, undefined);
  }
  const { result, details } = outcome;
  const afterAgent = input.stillCurrent();
  if (afterAgent !== null) return { kind: "discard", stage: "agent", why: afterAgent, details };
  if (result.status !== "ok") return answer(nonOkAnswer(result), details);

  // The adapter validated the picks against the request; the pipeline checks again against the snapshot.
  const byId = new Map(snapshot.candidates.map((c) => [c.id, c]));
  const ids = result.items.map((i) => i.id);
  if (ids.length === 0 || ids.length > JOB_MAX_PICKS || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) {
    return answer({ status: "error", reason: "invalid_output" }, details);
  }
  const sources = new Map(input.candidates.map((c) => [c.id, c]));
  const picked = ids.map((id) => sources.get(id)).filter((c): c is Candidate => c !== undefined);
  const budgetMs = Math.min(VERIFY_BUDGET_MS, remaining());
  if (budgetMs <= 0) return answer({ status: "error", reason: "timeout" }, details);
  if (input.signal.aborted) return { kind: "discard", stage: "verify", why: input.stillCurrent() ?? "cancelled", details };
  const verified = await input.verify(picked, { origin: snapshot.origin, budgetMs, clock, signal: input.signal });
  counts = { picked: picked.length, verified: verified.verified.length };
  const afterVerify = input.stillCurrent() ?? (input.signal.aborted ? "cancelled" : null);
  if (afterVerify !== null) return { kind: "discard", stage: "verify", why: afterVerify, details, verify: counts };

  const reasons = new Map(result.items.map((i) => [i.id, i.reason]));
  const items: PublishedItem[] = [];
  for (const v of verified.verified) {
    const reason = reasons.get(v.id);
    if (reason === undefined) continue;
    let hostname: string;
    try {
      hostname = new URL(v.humanHref).hostname;
    } catch {
      continue;
    }
    items.push({ candidateId: v.id, title: v.displayTitle ?? byId.get(v.id)?.title ?? v.title, reason, href: v.humanHref, hostname });
  }
  if (items.length === 0) return answer({ status: "error", reason: "agent_failed" }, details, true);
  return answer({ status: "ok", items }, details);
}
