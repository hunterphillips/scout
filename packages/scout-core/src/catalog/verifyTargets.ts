import type { Candidate } from "@scout/contracts";
import { type Clock, systemClock } from "../clock.js";
import { type GuardedFetchResult, guardedFetch } from "../fetch/guardedFetch.js";
import { sameOriginAbsoluteHttpsUrl } from "./sameOrigin.js";
import { CANDIDATE_TITLE_MAX, sanitizeLabel } from "./sanitizeLabel.js";

/** Most candidates one verification pass fetches. */
export const VERIFY_MAX_CANDIDATES = 3;

/** One shared wall-clock budget for the whole pass. */
export const VERIFY_BUDGET_MS = 4_000;

/** Size cap for each verification fetch. */
export const VERIFY_MAX_BYTES = 1024 * 1024;

/** Only this much of an HTML body is searched for `<title>` and `og:title`. */
export const TITLE_SCAN_CHARS = 64 * 1024;

const VERIFY_ACCEPT = "text/html, application/xhtml+xml;q=0.9, */*;q=0.1";

/** The fetch verification uses. Only these named options reach `guardedFetch`. */
export type VerifyFetch = (
  url: string,
  options: { maxBytes: number; accept: string; timeoutMs: number },
) => Promise<GuardedFetchResult>;

export type VerifyDropReason = "not_found" | "off_host" | "invalid_url";

export type VerifiedCandidate = Candidate & { humanHref: string; displayTitle?: string };

export interface VerifyOptions {
  /** Defaults to the real `guardedFetch`. */
  fetch?: VerifyFetch;
  clock?: Clock;
  budgetMs?: number;
  maxCandidates?: number;
}

export interface VerifyResult {
  /** Survivors, in input order. */
  verified: VerifiedCandidate[];
  dropped: { candidateId: string; reason: VerifyDropReason }[];
  ms: number;
}

const defaultFetch: VerifyFetch = (url, { maxBytes, accept, timeoutMs }) => guardedFetch(url, { maxBytes, accept, timeoutMs });

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ENTITIES[entity] ?? entity);
}

function isHtml(contentType: string | undefined): boolean {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml";
}

/**
 * A display title from an HTML body: `og:title` if present and non-empty after
 * sanitizing, else `<title>`. Only the first `TITLE_SCAN_CHARS` characters are searched,
 * and every pattern is length-bounded, so the work is linear in that prefix.
 */
export function extractDisplayTitle(body: string): string | undefined {
  const head = body.slice(0, TITLE_SCAN_CHARS);
  const clean = (raw: string | undefined): string | undefined => {
    if (raw === undefined) return undefined;
    const label = sanitizeLabel(decodeEntities(raw), CANDIDATE_TITLE_MAX);
    return label || undefined;
  };
  for (const [tag] of head.matchAll(/<meta\b[^>]{0,2048}>/gi)) {
    if (!/\bproperty\s*=\s*["']og:title["']/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const og = clean(content?.[1] ?? content?.[2]);
    if (og) return og;
  }
  return clean(/<title\b[^>]{0,256}>([^<]{0,2048})<\/title>/i.exec(head)?.[1]);
}

type Outcome = { keep: true; humanHref: string; displayTitle?: string } | { keep: false; reason: VerifyDropReason };

/**
 * Check the ranked candidates' links before they are shown.
 *
 * Policy: only the first `maxCandidates` (default 3) are checked, in parallel under one
 * shared budget (default 4 s); their order is kept and nothing is re-ranked. Every fetch
 * goes through `guardedFetch` (1 MiB cap) to a URL on the candidate's own origin.
 *
 * - A `.md` source URL: the same URL without `.md` is proposed as the human page. It
 *   becomes `humanHref` only on a 200 `text/html` response from the same host (the final
 *   URL after any same-host redirect). Any other answer, including a 404 on the twin,
 *   keeps the candidate with `humanHref = sourceUrl`: the `.md` page was published, only
 *   its HTML twin is missing.
 * - Any other URL is fetched itself. A 200 keeps it with `humanHref = sourceUrl` and a
 *   `displayTitle` from `og:title` or `<title>` when the page is HTML.
 * - Dropped: a 404/410 on a non-`.md` source (`not_found`); a policy refusal on either
 *   kind (`off_host`), which is how `guardedFetch` reports a redirect off the host (it
 *   also covers the redirect limit and a disallowed address); a source URL that is not a
 *   valid credential-free `https:` URL (`invalid_url`).
 * - A timeout, network error, too-large body or unexpected status keeps the candidate with
 *   `humanHref = sourceUrl` and no display title: verification failed, not the page.
 */
export async function verifyTargets(candidates: readonly Candidate[], options: VerifyOptions = {}): Promise<VerifyResult> {
  const fetch = options.fetch ?? defaultFetch;
  const clock = options.clock ?? systemClock;
  const budgetMs = options.budgetMs ?? VERIFY_BUDGET_MS;
  const maxCandidates = options.maxCandidates ?? VERIFY_MAX_CANDIDATES;
  const started = clock.now();

  const fetchWithinBudget = async (url: string): Promise<GuardedFetchResult> => {
    const remaining = Math.max(1, budgetMs - (clock.now() - started));
    let timer: ReturnType<typeof setTimeout> | undefined;
    // guardedFetch enforces `timeoutMs` itself; the race also bounds an injected fetch that does not.
    const deadline = new Promise<GuardedFetchResult>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "error", reason: "timeout", message: "verification budget spent" }), remaining);
    });
    try {
      return await Promise.race([fetch(url, { maxBytes: VERIFY_MAX_BYTES, accept: VERIFY_ACCEPT, timeoutMs: remaining }), deadline]);
    } catch {
      return { kind: "error", reason: "network", message: "verification fetch threw" };
    } finally {
      clearTimeout(timer);
    }
  };

  const verifyOne = async (candidate: Candidate): Promise<Outcome> => {
    const source = sameOriginAbsoluteHttpsUrl(candidate.sourceUrl, safeOrigin(candidate.sourceUrl));
    if (!source) return { keep: false, reason: "invalid_url" };
    const keepSource: Outcome = { keep: true, humanHref: candidate.sourceUrl };
    const isMarkdown = /\.md$/i.test(source.pathname);
    const target = new URL(source.href);
    if (isMarkdown) target.pathname = target.pathname.replace(/\.md$/i, "");
    if (target.origin !== source.origin) return { keep: false, reason: "invalid_url" };

    const result = await fetchWithinBudget(target.href);
    if (result.kind === "error") return result.reason === "policy" ? { keep: false, reason: "off_host" } : keepSource;
    if (result.kind === "absent") return isMarkdown ? keepSource : { keep: false, reason: "not_found" };
    if (result.kind !== "ok") return keepSource;
    const final = sameOriginAbsoluteHttpsUrl(result.finalUrl, source.origin);
    if (!final) return { keep: false, reason: "off_host" };
    if (result.status !== 200) return keepSource;
    if (isMarkdown) return isHtml(result.contentType) ? { keep: true, humanHref: final.href } : keepSource;
    const displayTitle = isHtml(result.contentType) ? extractDisplayTitle(result.body) : undefined;
    return displayTitle ? { keep: true, humanHref: candidate.sourceUrl, displayTitle } : keepSource;
  };

  const selected = candidates.slice(0, Math.max(0, maxCandidates));
  const outcomes = await Promise.all(selected.map(verifyOne));
  const verified: VerifiedCandidate[] = [];
  const dropped: VerifyResult["dropped"] = [];
  outcomes.forEach((outcome, i) => {
    const candidate = selected[i] as Candidate;
    if (!outcome.keep) {
      dropped.push({ candidateId: candidate.id, reason: outcome.reason });
      return;
    }
    const kept: VerifiedCandidate = { ...candidate, humanHref: outcome.humanHref };
    if (outcome.displayTitle !== undefined) kept.displayTitle = outcome.displayTitle;
    verified.push(kept);
  });
  return { verified, dropped, ms: clock.now() - started };
}

/** The URL's own origin, or an empty string (which no URL matches) when it does not parse. */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
