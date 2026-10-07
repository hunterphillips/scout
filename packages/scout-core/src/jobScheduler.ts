// When recommendation jobs run. One job at a time per core, for the current visit only, and
// only for a recommendation-enabled host (`config.destinations`; the list is live:
// `onDestinationsChanged` replaces it, and the next settle reads the new one). The coordinator
// tells the scheduler about settles, visit changes, pause, sensor loss, permissions, accepted
// activity, the browser-context grant, revoked resources, profile changes and stop; the
// scheduler talks only to the result registry, the snapshot registry, the job pipeline
// (pipeline.ts), and the coordinator's panel hooks (`working`, `idle`).
//
// Budget: one JOB_MAX_DEADLINE_MS (30 s) budget per settled visit, from the dwell settle,
// covering discovery, inference and verification. A job gets what remains when it starts;
// under MIN_JOB_MS left it is `unavailable: no_time_left` without a launch. MIN_JOB_MS
// (pipeline.ts) is the adapter's launch floor plus the verification reserve, so the scheduler
// never starts a job the adapter would refuse for time; the same threshold gates a replacement.
//
// Per job, in order: `results.beginJob(jobId)` → the panel's `working{jobId}` → the resume
// cache, else `snapshots.take(...)` → the pipeline → the visit's `idle` → `results.publish`.
// Never an `idle` for the visit after its publish (the side panel would drop the answer). A job
// that ends without an answer (discarded) still gets its `idle`, so no spinner is left behind.
//
// The snapshot carries activity only when the browser-context grant is on and page capture
// is allowed right now; otherwise `activity: []`. The current page is never context: the
// job's activity is the store's entries except the one whose URL is canonicalPageUrl of the
// visit's URL (`visibleActivity`), and a page on the same origin that is not the current page
// is included.
//
// Changes while a job runs:
//   - fatal, nothing is published: visit change (navigation, a tab or window switch; another
//     app coming to the front is not one, the visit is kept) → `visit_changed`; the origin's
//     grant lost → `revoked` (the permissions change arrives before the visit change it
//     causes, and the first cancel reason stands); sensor loss → `visit_changed`; pause →
//     `paused`; stop → `shutdown`.
//   - relevant: an accepted activity entry the job may see that changes its visible activity
//     (→ `superseded`; a capture of the current page changes nothing it sees); capture
//     disallowed, the grant turned off, or an origin the snapshot's activity came from losing
//     its grant, while the snapshot carried activity (→ `revoked`); a
//     revoked resource the snapshot pinned (→ `revoked`). The job is cancelled and ONE
//     replacement per visit may start, with a fresh snapshot, within the same budget, once the
//     cancelled run has ended (the adapter runs one job at a time). With the replacement
//     used, a later activity accept is ignored (the job finishes on the snapshot it has) and a
//     later revocation publishes `cancelled: revoked`. Repeated changes never chain calls.
//   - irrelevant: any other permissions or grant change. The job's baselines move to the new
//     revisions, so its answer still counts.
//   - a host put on the destinations while the current visit there has settled (its catalog is
//     ready; it was skipped `not_enabled`, or its job was cancelled by turning the host off): that
//     visit's job starts at once, through `onSettled` with a fresh budget from now. A visit that
//     has not settled yet runs when it settles. Pause, a visit change, sensor loss and stop forget
//     the settle.
//   - the job's host taken off the destinations (the side panel's switch, or a hand edit of
//     config.json): the job is cancelled `revoked` and the cancel is published, with no
//     replacement (the visit's budget is dropped). Recommendations being turned off is a
//     withdrawn consent, the same code as a revoked grant.
//   - a profile change (a new profile needs a new adapter): the job is cancelled `superseded`
//     and, under the same one-replacement rule and budget, the visit's replacement starts on
//     the new profile once the cancelled run has ended. With the replacement used, or under
//     MIN_JOB_MS left, the cancel is published (`cancelled: superseded`) instead.
// Every cancel aborts the adapter's signal with the reason and releases the snapshot at once
// (its token is revoked, so the agent's next read is refused), with release reason
// `cancelled`. A job that ends on its own releases its snapshot with reason `released` once
// its last checks ran; the plan's "cancelled" wording for the release refers to the cancel
// paths only.
//
// The pipeline re-checks, after the agent and after verification, and the scheduler once
// more right before publishing: core instance, visit epoch, snapshot still live, the
// permissions and grant baselines, the profile fingerprint. A mismatch is a discard
// (`job_discarded {stage, why}`), never a publish. Answers (`ok`, `empty`) go into the resume
// cache, and a job whose key hits publishes the cached answer at once, through the same order.
// That includes a replacement: it starts only once the cancelled run has ended, so a hit
// publishes `working{replacement}` → `idle` → its results, and the cancelled run publishes
// nothing.
//
// Suggestions stick to their page (resumeCache.ts holds them while shown and 15 min after the
// page's visit ends): a new visit whose key matches a stored answer, whatever activity the
// user has read since, gets it republished through the same order, before the time and agent
// checks, with no snapshot and so no job token. A page Scout opened from its own links
// (`onLinkOpened`, from the result registry's resolved `open_link`) gets no job of its own for
// OPENED_BY_SCOUT_TTL_MS: its settle is `job_skipped {reason: "opened_by_scout"}` and publishes
// nothing, even when the page has a stored answer. Pause clears the stored answers; losing an
// origin's permission drops that origin's; page capture withdrawn drops those that saw activity.
//
// Diagnostics (scalars only, never reasons, titles, URLs or prompts): job_started, job_finished,
// job_cancelled, job_discarded, job_skipped, job_replaced, verify.

import { randomBytes } from "node:crypto";
import { JOB_MAX_DEADLINE_MS, type ActiveVisit, type ActivityEntry, type Candidate } from "@scout/contracts";
import { snapshotCandidates, type JobSnapshot, type SnapshotRegistry } from "./activity/snapshots.js";
import { canonicalPageUrl, type StoredActivity } from "./activity/store.js";
import type { JobCancelReason } from "./agents/adapter.js";
import type { CatalogResolution } from "./catalog/resolveCatalog.js";
import type { Clock } from "./clock.js";
import type { DiagnosticFields, Diagnostics } from "./diagnostics.js";
import { type JobAgent, type JobAnswer, type JobRun, MIN_JOB_MS, runJob, type VerifyFn } from "./pipeline.js";
import type { ResultRegistry } from "./results.js";
import { activityHash, type JobResumeCache, type JobResumeKey } from "./resumeCache.js";

export { MIN_JOB_MS } from "./pipeline.js";

/** How long a page Scout opened from its links gets no job of its own. */
export const OPENED_BY_SCOUT_TTL_MS = 15 * 60 * 1000;
/** Upper bound on remembered opened pages; past it the oldest is forgotten. */
export const OPENED_BY_SCOUT_MAX = 32;

function stripFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

/** What the scheduler reads from the coordinator, live, on every check. */
export interface SchedulerView {
  /** The visit results may be shown for now: null when none, paused, disconnected or stopped. */
  visit(): ActiveVisit | null;
  permissionsRevision(): number | null;
  isPermitted(origin: string): boolean;
  /** Page capture is allowed right now (not paused, at least one origin granted). */
  captureAllowed(): boolean;
}

/** The coordinator's window hooks; each emits only while `visitEpoch` is the current, shown visit. */
export interface SchedulerWindow {
  working(visitEpoch: number, jobId: string): void;
  idle(visitEpoch: number): void;
}

export interface SchedulerProfile {
  fingerprint: string;
  /** The tools' revision, 0 without selected tools. */
  toolsRevision: number;
  hasUserTools: boolean;
}

export interface JobSchedulerOptions {
  coreInstanceId: string;
  clock: Clock;
  diagnostics: Diagnostics;
  /** Hosts with recommendations enabled. */
  destinations: readonly string[];
  results: Pick<ResultRegistry, "beginJob" | "publish">;
  /** Null until agent.sock is up. */
  snapshots: () => Pick<SnapshotRegistry, "take" | "release" | "get"> | null;
  view: SchedulerView;
  window: SchedulerWindow;
  activity: () => readonly StoredActivity[];
  browserContextGranted: () => boolean;
  /** Rises on every browser-context grant write. */
  grantRevision: () => number;
  approvalRevision: () => number;
  /**
   * The user's agent; null when no usable profile is loaded (jobs are `unavailable`). A function
   * is read at each job start, so a reloaded profile's adapter runs the next job.
   */
  agent: JobAgent | null | (() => JobAgent | null);
  profile: SchedulerProfile;
  /** agent.sock. */
  socketPath: string;
  verify: VerifyFn;
  resumeCache?: JobResumeCache<JobAnswer>;
  /** Test seam. */
  newJobId?: () => string;
}

export interface RunningJobInfo {
  jobId: string;
  visitEpoch: number;
  snapshotId: string | null;
  startedAt: number;
  replacementUsed: boolean;
}

export interface JobScheduler {
  /** A settled visit's catalog is ready (`settledAt` starts its budget). */
  onSettled(visit: ActiveVisit, catalog: CatalogResolution, settledAt: number): void;
  onVisitChanged(): void;
  onPause(): void;
  onSensorLost(): void;
  /** A permissions snapshot was applied. */
  onPermissionsChanged(): void;
  /** The activity store accepted new content (not a duplicate). */
  onActivityAccepted(revision: number): void;
  /** The browser-context grant was written (call after `grantRevision` moved). */
  onGrantChanged(enabled: boolean): void;
  /** A resource was revoked (the snapshot registry already released the snapshots pinning it). */
  onResourceRevoked(resourceId: string): void;
  /**
   * The recommendation-enabled hosts changed. Later settles use the new list; a running job (and
   * the visit's budget) whose host is no longer on it is cancelled `revoked`, published.
   */
  onDestinationsChanged(hosts: readonly string[]): void;
  /**
   * The agent profile changed (a new fingerprint, or new tools): the running job is cancelled
   * `superseded` and the visit's one replacement starts on the new profile (or, with the
   * replacement used or no time left, the cancel is published); later jobs and resume-cache
   * keys use the new profile. A bare fingerprint keeps the tools fields as they were.
   */
  onProfileChanged(next: string | SchedulerProfile): void;
  /** Scout is opening `href` from its links: a visit there starts no job for OPENED_BY_SCOUT_TTL_MS. */
  onLinkOpened(href: string): void;
  /** Cancel the running job (`shutdown`) and start none from now on. Idempotent. */
  stop(): void;
  /** Whether a host is recommendation-enabled. */
  isEnabled(origin: string): boolean;
  /** The running job, if any. */
  readonly running: RunningJobInfo | null;
  /** Resolves once no job is running. */
  settled(): Promise<void>;
}

/** What a cancel leads to once the cancelled run has ended (a replacement is `drop` plus a pending start). */
type AfterCancel = "drop" | "publish";

interface Budget {
  visit: ActiveVisit;
  deadline: number;
  candidates: readonly Candidate[];
  catalogHash: string;
  replacementUsed: boolean;
  /** A job should start for this visit as soon as none is running (a settle, or a replacement). */
  pending: boolean;
}

interface Running {
  jobId: string;
  visit: ActiveVisit;
  snapshot: JobSnapshot | null;
  startedAt: number;
  controller: AbortController;
  baseline: { permissionsRevision: number | null; grantRevision: number };
  hadActivity: boolean;
  /** activityHash of the activity the job started with. */
  activityHash: string;
  cancelled: JobCancelReason | null;
  after: AfterCancel;
  done: Promise<void>;
}

const newJobId = (): string => `j${randomBytes(12).toString("base64url")}`;

/** The snapshot's view of stored activity: the contract's fields only. */
function toEntries(stored: readonly StoredActivity[]): ActivityEntry[] {
  return stored.map((e) => ({ origin: e.origin, url: e.url, observedAt: e.observedAt, title: e.title, text: e.text, textTruncated: e.textTruncated }));
}

export function createJobScheduler(options: JobSchedulerOptions): JobScheduler {
  const { clock, diagnostics, view } = options;
  const profile = { ...options.profile };
  let destinations = new Set(options.destinations);
  let budget: Budget | null = null;
  /** The current visit's last settle with candidates, kept so enabling its host starts its job. */
  let skipped: { visit: ActiveVisit; catalog: CatalogResolution } | null = null;
  let running: Running | null = null;
  let stopped = false;
  /** Pages Scout opened from its links (fragment-free URL → when). */
  const opened = new Map<string, number>();

  const event = (name: string, fields: DiagnosticFields): void => diagnostics.event(name, fields);
  const isEnabled = (origin: string): boolean => {
    try {
      return destinations.has(new URL(origin).host);
    } catch {
      return false;
    }
  };
  const shownEpoch = (): number | null => view.visit()?.epoch ?? null;

  /** Show `answer` for `jobId`: the visit's idle, then the publish. Only while the visit is current. */
  const publish = (visit: ActiveVisit, jobId: string, answer: JobAnswer): boolean => {
    if (shownEpoch() !== visit.epoch) return false;
    options.window.idle(visit.epoch);
    const out = options.results.publish({ ...answer, coreInstanceId: options.coreInstanceId, visitEpoch: visit.epoch, origin: visit.origin, jobId } as Parameters<ResultRegistry["publish"]>[0]);
    if (out.ok && (answer.status === "ok" || answer.status === "empty")) options.resumeCache?.show(visit.url);
    return out.ok;
  };

  const openedByScout = (url: string): boolean => {
    const at = opened.get(stripFragment(url));
    if (at === undefined) return false;
    const age = clock.now() - at;
    return age >= 0 && age < OPENED_BY_SCOUT_TTL_MS;
  };

  /** The shown visit ended: its page's stored answer keeps a full window from now. */
  const leavePage = (): void => options.resumeCache?.show(null);

  const releaseSnapshot = (job: Running, reason: "released" | "cancelled"): void => {
    if (job.snapshot !== null) options.snapshots()?.release(job.snapshot.id, reason);
  };

  /** Why `job`'s answer no longer counts, or null. */
  const staleReason = (job: Running): string | null => {
    if (stopped) return "stopped";
    if (job.cancelled !== null) return "cancelled";
    if (running !== job) return "superseded";
    const visit = view.visit();
    if (visit === null || visit.epoch !== job.visit.epoch || visit.origin !== job.visit.origin) return "visit";
    if (!view.isPermitted(job.visit.origin)) return "permissions";
    if (job.snapshot === null || options.snapshots()?.get(job.snapshot.id) === undefined) return "snapshot";
    if (view.permissionsRevision() !== job.baseline.permissionsRevision) return "permissions";
    if (options.grantRevision() !== job.baseline.grantRevision) return "grant";
    if (profile.fingerprint !== job.snapshot.profileFingerprint) return "profile";
    return null;
  };

  const finished = (answer: JobAnswer, f: DiagnosticFields): void => {
    const fields: DiagnosticFields = { status: answer.status, ...f };
    if ("reason" in answer) fields.reason = answer.reason;
    event("job_finished", fields);
  };

  /** End a job that never launched: its answer goes out at once, through the same order. */
  const answerNow = (visit: ActiveVisit, jobId: string, answer: JobAnswer, f: DiagnosticFields): void => {
    publish(visit, jobId, answer);
    finished(answer, { termination: "not_launched", durationMs: 0, ...f });
  };

  /** The stored activity a job for `visit` may see: everything but the current page. */
  const visibleActivity = (visit: ActiveVisit): ActivityEntry[] => {
    const current = canonicalPageUrl(visit.url);
    return toEntries(options.activity().filter((e) => e.url !== current));
  };

  const resumeKey = (b: Budget, activity: readonly ActivityEntry[]): JobResumeKey => ({
    coreInstanceId: options.coreInstanceId,
    origin: b.visit.origin,
    url: b.visit.url,
    catalogHash: b.catalogHash,
    activityHash: activityHash(activity),
    approvalRevision: options.approvalRevision(),
    grantRevision: options.grantRevision(),
    profileFingerprint: profile.fingerprint,
    toolsRevision: profile.toolsRevision,
  });

  const start = (): void => {
    const b = budget;
    if (stopped || b === null || !b.pending || running !== null) return;
    b.pending = false;
    const visit = view.visit();
    if (visit === null || visit.epoch !== b.visit.epoch) return;
    const jobId = (options.newJobId ?? newJobId)();
    if (!options.results.beginJob(jobId).ok) return;
    options.window.working(visit.epoch, jobId);
    const activity = options.browserContextGranted() && view.captureAllowed() ? visibleActivity(visit) : [];
    const key = resumeKey(b, activity);
    const cached = options.resumeCache?.restore(key, { hasUserTools: profile.hasUserTools });
    if (cached) return answerNow(visit, jobId, cached, { epoch: visit.epoch, cached: true });
    const remaining = b.deadline - clock.now();
    if (remaining < MIN_JOB_MS) return answerNow(visit, jobId, { status: "unavailable", reason: "no_time_left" }, { epoch: visit.epoch });
    const agent = typeof options.agent === "function" ? options.agent() : options.agent;
    const snapshots = options.snapshots();
    if (agent === null || snapshots === null) return answerNow(visit, jobId, { status: "unavailable", reason: "agent_unavailable" }, { epoch: visit.epoch });

    let taken: { snapshot: JobSnapshot; token: string };
    try {
      taken = snapshots.take({
        jobId,
        origin: visit.origin,
        visitEpoch: visit.epoch,
        activity,
        candidates: snapshotCandidates(b.candidates),
        catalogHash: b.catalogHash,
        permissionsRevision: view.permissionsRevision() ?? 0,
        profileFingerprint: profile.fingerprint,
        deadline: b.deadline,
      });
    } catch {
      return answerNow(visit, jobId, { status: "error", reason: "agent_failed" }, { epoch: visit.epoch, detail: "snapshot_refused" });
    }
    const job: Running = {
      jobId,
      visit,
      snapshot: taken.snapshot,
      startedAt: clock.now(),
      controller: new AbortController(),
      baseline: { permissionsRevision: view.permissionsRevision(), grantRevision: options.grantRevision() },
      hadActivity: activity.length > 0,
      activityHash: activityHash(activity),
      cancelled: null,
      after: "drop",
      done: Promise.resolve(),
    };
    running = job;
    event("job_started", { epoch: visit.epoch, candidates: b.candidates.length, activity: activity.length, deadlineMs: remaining, replacement: b.replacementUsed });
    job.done = runJob({
      coreInstanceId: options.coreInstanceId,
      snapshot: taken.snapshot,
      token: taken.token,
      candidates: b.candidates,
      grantRevision: options.grantRevision(),
      agent,
      socketPath: options.socketPath,
      verify: options.verify,
      clock,
      signal: job.controller.signal,
      visitDeadline: b.deadline,
      stillCurrent: () => staleReason(job),
    }).then(
      (run) => ended(job, run, key),
      () => ended(job, { kind: "answer", answer: { status: "error", reason: "agent_failed" }, details: undefined, verifyAllFailed: false }, key),
    );
  };

  const ended = (job: Running, run: JobRun, key: JobResumeKey): void => {
    const durationMs = clock.now() - job.startedAt;
    const d = run.details;
    const f: DiagnosticFields = { epoch: job.visit.epoch, durationMs, termination: d?.termination ?? "not_launched" };
    if (d?.timings.apiMs !== undefined) f.apiMs = d.timings.apiMs;
    if (d?.usage.turns !== undefined) f.turns = d.usage.turns;
    if (d?.permissionDenials !== undefined) f.permissionDenials = d.permissionDenials;
    const toolErrors = d ? Object.values(d.toolErrors).reduce((a, n) => a + n, 0) + (d.unattributedToolErrors ?? 0) : 0;
    if (toolErrors > 0) f.toolErrors = toolErrors;
    if (d?.optionalToolFailed) f.optionalToolFailed = true;
    // Count only: tells "every pick unknown" (N dropped) from malformed output (0) under invalid_output.
    if (d?.droppedPicks) f.droppedPicks = d.droppedPicks;
    if (d?.cliVersionChanged) f.cliVersionChanged = true;
    if (run.verify) event("verify", { epoch: job.visit.epoch, picked: run.verify.picked, verified: run.verify.verified });

    // The last checks run while the job is still the running one and its snapshot live; then
    // it is released, and a settle or replacement that waited for this run starts.
    try {
      conclude(job, run, key, f);
    } finally {
      releaseSnapshot(job, "released");
      if (running === job) running = null;
      start();
    }
  };

  const conclude = (job: Running, run: JobRun, key: JobResumeKey, f: DiagnosticFields): void => {
    const d = run.details;
    if (job.cancelled !== null) {
      if (job.after === "publish") {
        const answer: JobAnswer = { status: "cancelled", reason: job.cancelled };
        publish(job.visit, job.jobId, answer);
        finished(answer, f);
      } else {
        event("job_finished", { status: "cancelled", reason: job.cancelled, ...f });
      }
      return;
    }
    if (run.kind === "discard") {
      event("job_discarded", { stage: run.stage, why: run.why, epoch: job.visit.epoch });
      if (shownEpoch() === job.visit.epoch) options.window.idle(job.visit.epoch);
      return;
    }
    // The last check before the side panel sees it.
    const stale = staleReason(job);
    if (stale !== null) {
      event("job_discarded", { stage: "publish", why: stale, epoch: job.visit.epoch });
      if (shownEpoch() === job.visit.epoch) options.window.idle(job.visit.epoch);
      return;
    }
    if (run.verifyAllFailed) f.verifyAllFailed = true;
    const published = publish(job.visit, job.jobId, run.answer);
    finished(run.answer, f);
    if (published && (run.answer.status === "ok" || run.answer.status === "empty")) {
      options.resumeCache?.store(key, { result: run.answer, browserOnly: d?.optionalToolFailed === true });
    }
  };

  /** Cancel the running job; a later, stronger outcome (`drop`) overrides an earlier one. */
  const cancel = (reason: JobCancelReason, after: AfterCancel): void => {
    const job = running;
    if (job === null) return;
    if (job.cancelled !== null) {
      if (after === "drop") job.after = "drop";
      return;
    }
    job.cancelled = reason;
    job.after = after;
    job.controller.abort(reason);
    releaseSnapshot(job, "cancelled");
    event("job_cancelled", { reason, epoch: job.visit.epoch });
  };

  /**
   * A change that makes the running job's answer stale: cancel it and, once per visit and with
   * time left, start a replacement. Without one, an activity change is ignored (the job ends on
   * its snapshot) and a revocation publishes `cancelled`.
   */
  const relevantChange = (reason: JobCancelReason): void => {
    const job = running;
    if (job === null || job.cancelled !== null) return;
    if (replace(job, reason)) return;
    if (reason === "superseded") return;
    cancel(reason, "publish");
  };

  /** Cancel `job` for its visit's one replacement, if unused and there is time for it; false otherwise. */
  const replace = (job: Running, reason: JobCancelReason): boolean => {
    const b = budget;
    if (b === null || b.visit.epoch !== job.visit.epoch || b.replacementUsed || b.deadline - clock.now() < MIN_JOB_MS) return false;
    b.replacementUsed = true;
    b.pending = true;
    event("job_replaced", { reason, epoch: job.visit.epoch });
    cancel(reason, "drop");
    return true;
  };

  const api: JobScheduler = {
    onSettled(visit, catalog, settledAt) {
      if (stopped) return;
      skipped = catalog.result.ok && catalog.result.catalog.candidates.length > 0 ? { visit, catalog } : null;
      if (!isEnabled(visit.origin)) {
        event("job_skipped", { epoch: visit.epoch, reason: "not_enabled" });
        return;
      }
      if (openedByScout(visit.url)) {
        event("job_skipped", { epoch: visit.epoch, reason: "opened_by_scout" });
        return;
      }
      const result = catalog.result;
      if (!result.ok || result.catalog.candidates.length === 0) {
        event("job_skipped", { epoch: visit.epoch, reason: "no_candidates" });
        return;
      }
      if (running !== null && running.visit.epoch === visit.epoch && running.cancelled === null) {
        event("job_skipped", { epoch: visit.epoch, reason: "busy" });
        return;
      }
      // A job for another visit should already be cancelled; it is, now. This visit's job
      // starts once that run has ended.
      if (running !== null && running.visit.epoch !== visit.epoch) cancel("visit_changed", "drop");
      budget = {
        visit,
        deadline: settledAt + JOB_MAX_DEADLINE_MS,
        candidates: result.catalog.candidates,
        catalogHash: result.catalog.version,
        replacementUsed: false,
        pending: true,
      };
      start();
    },
    onVisitChanged() {
      budget = null;
      skipped = null;
      leavePage();
      cancel("visit_changed", "drop");
    },
    onPause() {
      budget = null;
      skipped = null;
      options.resumeCache?.clear();
      cancel("paused", "drop");
    },
    onSensorLost() {
      budget = null;
      skipped = null;
      leavePage();
      cancel("visit_changed", "drop");
    },
    onPermissionsChanged() {
      const captureAllowed = view.captureAllowed();
      options.resumeCache?.dropWhere((e) => !view.isPermitted(e.origin) || (e.hadActivity && !captureAllowed));
      const job = running;
      if (job === null || job.cancelled !== null) return;
      if (!view.isPermitted(job.visit.origin)) return cancel("revoked", "drop");
      if (job.hadActivity && !view.captureAllowed()) return relevantChange("revoked");
      if (job.snapshot?.activity.some((a) => !view.isPermitted(a.origin))) return relevantChange("revoked");
      job.baseline.permissionsRevision = view.permissionsRevision();
    },
    onActivityAccepted() {
      const job = running;
      if (job === null || job.cancelled !== null) return;
      // Only activity the job could see makes its answer stale.
      if (!options.browserContextGranted() || !view.captureAllowed()) return;
      // A capture of the destination page itself never supersedes the job it belongs to.
      if (activityHash(visibleActivity(job.visit)) === job.activityHash) return;
      relevantChange("superseded");
    },
    onGrantChanged(enabled) {
      const job = running;
      if (job === null || job.cancelled !== null) return;
      if (!enabled && job.hadActivity) return relevantChange("revoked");
      job.baseline.grantRevision = options.grantRevision();
    },
    onResourceRevoked(resourceId) {
      const job = running;
      if (job === null || job.cancelled !== null || job.snapshot === null) return;
      if (job.snapshot.approved.some((a) => a.resourceId === resourceId)) relevantChange("revoked");
    },
    onDestinationsChanged(hosts) {
      const wasEnabled = skipped !== null && isEnabled(skipped.visit.origin);
      destinations = new Set(hosts);
      if (budget !== null && !isEnabled(budget.visit.origin)) budget = null;
      const job = running;
      if (job !== null && job.cancelled === null && !isEnabled(job.visit.origin)) cancel("revoked", "publish");
      // The current, settled visit's host was just enabled: its job starts now, with a fresh budget.
      const s = skipped;
      if (stopped || s === null || wasEnabled || !isEnabled(s.visit.origin)) return;
      const current = view.visit();
      if (current === null || current.epoch !== s.visit.epoch || current.origin !== s.visit.origin) {
        skipped = null;
        return;
      }
      // Its job (or the one being cancelled) still owns the visit: the settle path waits for it.
      if (budget !== null && budget.visit.epoch === s.visit.epoch) return;
      event("job_enabled_mid_visit", { epoch: s.visit.epoch });
      api.onSettled(s.visit, s.catalog, clock.now());
    },
    onProfileChanged(next) {
      if (typeof next === "string") profile.fingerprint = next;
      else Object.assign(profile, next);
      const job = running;
      if (job === null || job.cancelled !== null) return;
      // Unlike new activity, a new profile always ends the job: its adapter is retired.
      if (!replace(job, "superseded")) cancel("superseded", "publish");
    },
    onLinkOpened(href) {
      const page = stripFragment(href);
      opened.delete(page);
      opened.set(page, clock.now());
      while (opened.size > OPENED_BY_SCOUT_MAX) opened.delete(opened.keys().next().value as string);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      budget = null;
      skipped = null;
      cancel("shutdown", "drop");
    },
    isEnabled,
    get running() {
      const job = running;
      if (job === null) return null;
      return {
        jobId: job.jobId,
        visitEpoch: job.visit.epoch,
        snapshotId: job.snapshot?.id ?? null,
        startedAt: job.startedAt,
        replacementUsed: budget?.replacementUsed ?? false,
      };
    },
    async settled() {
      while (running !== null) await running.done;
    },
  };
  return api;
}
