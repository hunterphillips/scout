// The recommendation result the side panel shows, and the only way a click becomes a URL.
//
// The pipeline publishes one result per job; the registry holds at most one, for the current
// visit. Each job is announced first (`beginJob`), which makes it the visit's current job; a
// newer `beginJob` replaces it, and a `clear` or a new visit forgets it. The registry refuses a
// result for another core instance, a visit that is no longer current (a late job, a paused or
// disconnected core), a job that is not the current one (a replaced job, or none begun), another
// origin than the visit's, or an origin Chrome no longer grants, so neither a late job nor a
// replaced one can overwrite a newer answer. A result of the current job replaces the one held.
//
// Ordering (the scheduler's contract with the side panel): the panel resets a visit's results
// on every `state` frame for that visit except `working` for the same job, so a job's state frames
// must all go out before its result. For a job the scheduler emits `working{jobId}`, then the
// visit's `idle` when the job ends, and only then calls `publish`. Any `idle` (or `resendState`)
// for the same visit after the publish wipes the panel's results while the registry still
// holds them, and a later click on one is answered from the registry only if it is still held.
//
// Each `ok` item carries the verified target (catalog/verifyTargets.ts `humanHref`, the HTML
// twin when one was verified). The registry keeps it; the panel's frame never carries it
// (toFrame). A click sends back the displayed identity (instance, visit, job, candidate) and
// `resolveLink` answers with the stored target only after re-checking it: https, no
// credentials, the default port, the result's origin, and Chrome's grant for that origin now.
// The registry never fetches. Each resolved target goes to `onLinkOpened` (the scheduler starts
// no job for the page Scout opens).
//
// The coordinator clears the result when its visit ends, on pause, on loss of the origin's
// grant, on disconnect, and on stop, silently: the state frame that follows each of those
// already resets the panel. Listeners hear every publish and every non-silent clear that
// dropped a result; the panel channel sends a publish as a `results` frame and answers a
// non-silent clear (a job clear within the same visit) with `resendState`.
//
// Diagnostics carry status, counts, epochs, and codes only: never titles, reasons, or hrefs.

import {
  JOB_CANCELLED_REASONS,
  JOB_ERROR_REASONS,
  JOB_UNAVAILABLE_REASONS,
  type PanelResults,
  PanelStateSchema,
} from "@scout/contracts";
import { exactSameOriginHttpsUrl } from "./catalog/sameOrigin.js";
import type { Diagnostics } from "./diagnostics.js";

export interface PublishedItem {
  candidateId: string;
  /** The verified display title (or the candidate's title). */
  title: string;
  /** The model's reason; shown only in the side panel, never logged. */
  reason: string;
  /** The verified target (`humanHref`); kept here, never sent in a frame. */
  href: string;
  /** The verified target's host, for display. */
  hostname: string;
}

interface Identity {
  coreInstanceId: string;
  visitEpoch: number;
  /** The visit's origin, `https://host[:port]`. */
  origin: string;
  jobId: string;
}

export type PublishedResult = Identity &
  (
    | { status: "ok"; items: PublishedItem[] }
    | { status: "empty" }
    | { status: "unavailable"; reason: (typeof JOB_UNAVAILABLE_REASONS)[number] }
    | { status: "error"; reason: (typeof JOB_ERROR_REASONS)[number] }
    | { status: "cancelled"; reason: (typeof JOB_CANCELLED_REASONS)[number] }
  );

/** Why `publish` refused a result. */
export type PublishRefusal =
  /** Another core start's result. */
  | "stale_instance"
  /** Not the current visit, or no visit is current (paused, disconnected, stopped). */
  | "stale_visit"
  /** Not the visit's current job: a newer `beginJob` replaced it, or none was begun since the last clear. */
  | "stale_job"
  /** Not the current visit's origin. */
  | "wrong_origin"
  /** Chrome no longer grants the origin. */
  | "not_permitted"
  /** Not a valid frame, or an item's target or hostname failed its check. */
  | "invalid";

export type LinkRequest = Pick<Identity, "coreInstanceId" | "visitEpoch" | "jobId"> & { candidateId: string };
export type LinkRefusal = "stale_revision" | "not_found" | "not_permitted" | "unavailable";
export type LinkResolution = { ok: true; href: string } | { ok: false; code: LinkRefusal };

export type ResultsEvent = { kind: "published"; frame: PanelResults } | { kind: "cleared"; visitEpoch: number; reason: string };

export interface ResultRegistryOptions {
  coreInstanceId: string;
  /** The visit a result may be published for now, or null while none may (no visit, paused, disconnected, stopped). */
  activeVisit: () => { visitEpoch: number; origin: string } | null;
  isPermitted: (origin: string) => boolean;
  /** Hears the target of every resolved link (the page Scout is about to open). */
  onLinkOpened?: (href: string) => void;
  diagnostics?: Diagnostics;
}

export interface ClearOptions {
  /**
   * Tell no listener: the caller sends a state frame anyway (the coordinator's clears on a visit
   * change, permission loss, pause, disconnect, and stop). Without it a clear that dropped a
   * result is heard, and the panel channel re-sends the current state so the panel drops it
   * (a job clear within the same visit).
   */
  silent?: boolean;
}

export interface ResultRegistry {
  /**
   * Make `jobId` the current visit's job, replacing any earlier one: from now on only its result
   * may be published, and only a held result of it resolves links. Refused (`stale_visit`) when
   * no visit is current. The job is forgotten on `clear` and when the visit changes.
   */
  beginJob(jobId: string): { ok: true } | { ok: false; code: "stale_visit" };
  /**
   * Hold `result` as the current one and tell listeners; returns why not when refused. Checks,
   * in order: `stale_instance`, `stale_visit`, `stale_job`, `wrong_origin`, `not_permitted`,
   * `invalid`. Call it only after the job's state frames (`working`, then the visit's `idle`):
   * a later `idle` or `resendState` for the visit wipes the panel's results (see the header).
   */
  publish(result: PublishedResult): { ok: true } | { ok: false; code: PublishRefusal };
  /** The result held, hrefs included (a copy). */
  current(): PublishedResult | null;
  /** Drop the result held and forget the current job; returns whether a result was held. */
  clear(reason: string, options?: ClearOptions): boolean;
  /** The re-checked target for a clicked candidate. */
  resolveLink(request: LinkRequest): LinkResolution;
  /** Hear publishes and clears; returns an unsubscribe. */
  subscribe(listener: (event: ResultsEvent) => void): () => void;
}

/** The panel's frame for `result`: everything but the hrefs. */
export function toFrame(result: PublishedResult): PanelResults {
  const identity = {
    type: "results" as const,
    coreInstanceId: result.coreInstanceId,
    visitEpoch: result.visitEpoch,
    origin: result.origin,
    jobId: result.jobId,
  };
  switch (result.status) {
    case "ok":
      return {
        ...identity,
        status: "ok",
        items: result.items.map(({ candidateId, title, reason, hostname }) => ({ candidateId, title, reason, hostname })),
      };
    case "empty":
      return { ...identity, status: "empty" };
    case "unavailable":
      return { ...identity, status: "unavailable", reason: result.reason };
    case "error":
      return { ...identity, status: "error", reason: result.reason };
    case "cancelled":
      return { ...identity, status: "cancelled", reason: result.reason };
  }
}

/**
 * `href` as a URL Scout may open for `origin`, or null. The rule is catalog/sameOrigin.ts's
 * `exactSameOriginHttpsUrl`: https, no credentials, the default port, the same origin, and the
 * string exactly as the parser writes it. Any path, query, or fragment on that origin passes, so
 * a verified HTML twin does.
 */
export function checkTarget(href: string, origin: string): URL | null {
  return exactSameOriginHttpsUrl(href, origin);
}

export function createResultRegistry(options: ResultRegistryOptions): ResultRegistry {
  const { diagnostics } = options;
  let held: PublishedResult | null = null;
  /** The current job and the visit it was begun for; it counts only while that visit is current. */
  let job: { jobId: string; visitEpoch: number } | null = null;
  const listeners = new Set<(event: ResultsEvent) => void>();

  const notify = (event: ResultsEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        diagnostics?.event("results_listener_failed", {});
      }
    }
  };

  const copy = (r: PublishedResult): PublishedResult =>
    r.status === "ok" ? { ...r, items: r.items.map((i) => ({ ...i })) } : { ...r };

  const refusal = (r: PublishedResult): PublishRefusal | null => {
    if (r.coreInstanceId !== options.coreInstanceId) return "stale_instance";
    const visit = options.activeVisit();
    if (visit === null || visit.visitEpoch !== r.visitEpoch) return "stale_visit";
    if (job === null || job.visitEpoch !== visit.visitEpoch || job.jobId !== r.jobId) return "stale_job";
    if (visit.origin !== r.origin) return "wrong_origin";
    if (!options.isPermitted(r.origin)) return "not_permitted";
    if (!PanelStateSchema.safeParse(toFrame(r)).success) return "invalid";
    if (r.status === "ok") {
      for (const item of r.items) {
        const url = checkTarget(item.href, r.origin);
        if (url === null || url.hostname !== item.hostname) return "invalid";
      }
    }
    return null;
  };

  const resolve = (request: LinkRequest): LinkResolution => {
    const r = held;
    if (request.coreInstanceId !== options.coreInstanceId || r === null) return { ok: false, code: "stale_revision" };
    if (r.visitEpoch !== request.visitEpoch || r.jobId !== request.jobId) return { ok: false, code: "stale_revision" };
    // The result should have been cleared with its visit; check anyway.
    if (options.activeVisit()?.visitEpoch !== r.visitEpoch) return { ok: false, code: "stale_revision" };
    // A newer job has begun for this visit: the held answer is no longer the visit's.
    if (job === null || job.visitEpoch !== r.visitEpoch || job.jobId !== r.jobId) return { ok: false, code: "stale_revision" };
    const item = r.status === "ok" ? r.items.find((i) => i.candidateId === request.candidateId) : undefined;
    if (item === undefined) return { ok: false, code: "not_found" };
    if (!options.isPermitted(r.origin)) return { ok: false, code: "not_permitted" };
    const url = checkTarget(item.href, r.origin);
    if (url === null) return { ok: false, code: "unavailable" };
    return { ok: true, href: url.href };
  };

  return {
    beginJob(jobId) {
      const visit = options.activeVisit();
      if (visit === null) {
        diagnostics?.event("results_job_refused", { code: "stale_visit" });
        return { ok: false, code: "stale_visit" };
      }
      job = { jobId, visitEpoch: visit.visitEpoch };
      return { ok: true };
    },
    publish(result) {
      const code = refusal(result);
      if (code !== null) {
        diagnostics?.event("results_refused", { status: result.status, epoch: result.visitEpoch, code });
        return { ok: false, code };
      }
      held = copy(result);
      diagnostics?.event("results_published", {
        status: result.status,
        items: result.status === "ok" ? result.items.length : 0,
        epoch: result.visitEpoch,
      });
      notify({ kind: "published", frame: toFrame(held) });
      return { ok: true };
    },
    current: () => (held === null ? null : copy(held)),
    clear(reason, clearOptions = {}) {
      job = null;
      if (held === null) return false;
      const { visitEpoch } = held;
      held = null;
      diagnostics?.event("results_cleared", { epoch: visitEpoch, reason });
      if (clearOptions.silent !== true) notify({ kind: "cleared", visitEpoch, reason });
      return true;
    },
    resolveLink(request) {
      const answer = resolve(request);
      diagnostics?.event("link_resolved", answer.ok ? { ok: true } : { ok: false, code: answer.code });
      if (answer.ok) options.onLinkOpened?.(answer.href);
      return answer;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
