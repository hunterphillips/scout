import type { Candidate } from "@scout/contracts";
import { type Clock, systemClock } from "../clock.js";
import { type GuardedFetchResult, guardedFetch } from "../fetch/guardedFetch.js";
import { decodeEntities } from "./entities.js";
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

export type VerifyDropReason = "not_found" | "off_host" | "invalid_url" | "off_origin";

export type VerifiedCandidate = Candidate & { humanHref: string; displayTitle?: string };

export interface VerifyOptions {
  /** The site being verified. A candidate whose `sourceUrl` has another origin is dropped (`off_origin`) unfetched. */
  origin: string;
  /** Defaults to the real `guardedFetch`. */
  fetch?: VerifyFetch;
  clock?: Clock;
  budgetMs?: number;
  maxCandidates?: number;
  /** Aborting ends the pass at once: every fetch still waiting counts as a timeout. */
  signal?: AbortSignal;
}

export interface VerifyResult {
  /** Survivors, in input order. */
  verified: VerifiedCandidate[];
  dropped: { candidateId: string; reason: VerifyDropReason }[];
  ms: number;
}

const defaultFetch: VerifyFetch = (url, { maxBytes, accept, timeoutMs }) => guardedFetch(url, { maxBytes, accept, timeoutMs });

function isHtml(contentType: string | undefined): boolean {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml";
}

/**
 * A display title from an HTML body: `og:title` if present and non-empty after
 * sanitizing, else `<title>`. Only the first `TITLE_SCAN_CHARS` characters are searched,
 * and every pattern is length-bounded, so the work is linear in that prefix.
 *
 * Only `<meta property="og:title" content="...">` with quoted attribute values (either
 * order) is read. An unquoted `content`, or `name="og:title"`, is not supported and falls
 * back to `<title>`. Attribute names must stand alone, so `data-content=` does not match.
 */
export function extractDisplayTitle(body: string): string | undefined {
  const head = body.slice(0, TITLE_SCAN_CHARS);
  const clean = (raw: string | undefined): string | undefined => {
    if (raw === undefined) return undefined;
    const label = sanitizeLabel(decodeEntities(raw), CANDIDATE_TITLE_MAX);
    return label || undefined;
  };
  for (const [tag] of head.matchAll(/<meta\b[^>]{0,2048}>/gi)) {
    if (!/\sproperty\s*=\s*["']og:title["']/i.test(tag)) continue;
    const content = /(?:^|\s)content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
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
 * goes through `guardedFetch` (1 MiB cap) to a URL on `origin`.
 * "The source URL" below means its normalized form (`new URL(sourceUrl).href`), which is
 * what a kept candidate's `humanHref` holds.
 *
 * - A `.md` source URL: the same URL without `.md` is proposed as the human page. It
 *   becomes `humanHref` only on a 200 `text/html` response from the same host (the final
 *   URL after any same-host redirect). Any other answer, including a 404 on the twin or a
 *   twin that leaves the host, keeps the candidate with `humanHref` = the source URL: the `.md`
 *   page itself is never fetched, so the twin's answer says nothing against it.
 * - Any other URL is fetched itself. A 200 keeps it with `humanHref = sourceUrl` and a
 *   `displayTitle` from `og:title` or `<title>` when the page is HTML.
 * - Dropped: a 404/410 on a non-`.md` source (`not_found`); a non-`.md` source whose fetch
 *   is refused by policy or ends on another host (`off_host`) — a policy refusal is how
 *   `guardedFetch` reports a redirect off the host (it also covers the redirect limit and
 *   a disallowed address); a source URL that is not a valid credential-free `https:` URL
 *   (`invalid_url`); a valid source URL on another origin than `origin` (`off_origin`).
 * - A timeout, network error, too-large body or unexpected status keeps the candidate with
 *   `humanHref = sourceUrl` and no display title: verification failed, not the page.
 */
export async function verifyTargets(candidates: readonly Candidate[], options: VerifyOptions): Promise<VerifyResult> {
  const origin = new URL(options.origin).origin;
  const fetch = options.fetch ?? defaultFetch;
  const clock = options.clock ?? systemClock;
  const budgetMs = options.budgetMs ?? VERIFY_BUDGET_MS;
  const maxCandidates = options.maxCandidates ?? VERIFY_MAX_CANDIDATES;
  const started = clock.now();

  const fetchWithinBudget = async (url: string): Promise<GuardedFetchResult> => {
    const remaining = Math.max(1, budgetMs - (clock.now() - started));
    let timer: ReturnType<typeof setTimeout> | undefined;
    // guardedFetch enforces `timeoutMs` itself; the race also bounds an injected fetch that does not.
    let onAbort: (() => void) | undefined;
    const deadline = new Promise<GuardedFetchResult>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "error", reason: "timeout", message: "verification budget spent" }), remaining);
      onAbort = () => resolve({ kind: "error", reason: "timeout", message: "verification cancelled" });
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      if (options.signal?.aborted) return await deadline;
      return await Promise.race([fetch(url, { maxBytes: VERIFY_MAX_BYTES, accept: VERIFY_ACCEPT, timeoutMs: remaining }), deadline]);
    } catch {
      return { kind: "error", reason: "network", message: "verification fetch threw" };
    } finally {
      clearTimeout(timer);
      if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    }
  };

  const verifyOne = async (candidate: Candidate): Promise<Outcome> => {
    const source = sameOriginAbsoluteHttpsUrl(candidate.sourceUrl, safeOrigin(candidate.sourceUrl));
    if (!source) return { keep: false, reason: "invalid_url" };
    if (source.origin !== origin) return { keep: false, reason: "off_origin" };
    const keepSource: Outcome = { keep: true, humanHref: source.href };
    // A `.md` file needs a non-empty basename: `/.md` has no HTML twin to propose.
    const isMarkdown = /[^/]\.md$/i.test(source.pathname);
    const target = new URL(source.href);
    if (isMarkdown) target.pathname = target.pathname.replace(/\.md$/i, "");
    if (target.origin !== source.origin) return { keep: false, reason: "invalid_url" };

    const result = await fetchWithinBudget(target.href);
    const offHost: Outcome = isMarkdown ? keepSource : { keep: false, reason: "off_host" };
    if (result.kind === "error") return result.reason === "policy" ? offHost : keepSource;
    if (result.kind === "absent") return isMarkdown ? keepSource : { keep: false, reason: "not_found" };
    if (result.kind !== "ok") return keepSource;
    const final = sameOriginAbsoluteHttpsUrl(result.finalUrl, source.origin);
    if (!final) return offHost;
    if (result.status !== 200) return keepSource;
    if (isMarkdown) return isHtml(result.contentType) ? { keep: true, humanHref: final.href } : keepSource;
    const displayTitle = isHtml(result.contentType) ? extractDisplayTitle(result.body) : undefined;
    return displayTitle ? { keep: true, humanHref: source.href, displayTitle } : keepSource;
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
