// The fixed root probes (`/llms.txt`, `/AGENTS.md`, `/.well-known/agent-skills/index.json`)
// and digest-verified `skill-md` fetching follow rookkeeper/rook
// server/src/environments/services/WebEnvironmentScout.ts (Rook, by John Berryman / Arcturus
// Labs), used as a read-only reference: nothing is imported from it. Scout changes: per-probe
// outcomes (found / absent / failed / unsupported / limited) instead of one bundle status;
// robots rules, pacing, and Scout's caps apply; a per-probe cache with backoff; two skill
// fetches at a time; cross-origin skills are references only.

import { join } from "node:path";
import type { ResourceKind } from "@scout/contracts";
import { type CatalogFetchOptions, LLMS_TXT_ACCEPT, nextValidators } from "../catalog/catalogFetch.js";
import { isRefusal, type PacedFetch } from "../catalog/pacing.js";
import { type CompiledRobots, compileRobots, fetchRobots, isAllowed, type RobotsSource } from "../catalog/robots.js";
import type { Clock } from "../clock.js";
import type { Diagnostics } from "../diagnostics.js";
import type { GuardedFetchOptions, GuardedFetchResult } from "../fetch/guardedFetch.js";
import { createOriginFetchSession, type OriginFetchSession } from "../fetch/originSession.js";
import {
  createDiscoveryCache,
  DISCOVERY_CACHE_SCHEMA_VERSION,
  type DiscoveryCache,
  type IndexRejectReason,
  isDue,
  nextCheckAt,
  type ProbeCode,
  type ProbeFailureCode,
  type ProbeKind,
  type ProbeRecord,
  type ProbeStatus,
  type SkillDescriptor,
  type StoredText,
  usableLastGood,
} from "./discoveryCache.js";
import { parseSkillsIndex, type SkillsIndexParse } from "./skillsIndex.js";
import { TEXT_MAX_BYTES, validateText } from "./textValidation.js";

export type { IndexRejectReason, ProbeCode, ProbeFailureCode, ProbeLimitCode } from "./discoveryCache.js";

export const LLMS_TXT_PATH = "/llms.txt";
export const AGENTS_MD_PATH = "/AGENTS.md";
export const SKILLS_INDEX_PATH = "/.well-known/agent-skills/index.json";

/**
 * Most skill fetches outstanding at once. Nominal today: every request goes through the
 * origin's serial paced queue, so two outstanding fetches still reach the site one at a time.
 */
export const SKILL_FETCH_CONCURRENCY = 2;

/**
 * Most accepted resource bytes (llms.txt, AGENTS.md, skills) in one pass. Today's caps sum
 * to ~1.5 MiB (128 KiB + 128 KiB + 20 skills x 64 KiB), so this cannot bind yet; it guards
 * against a future change to those caps or to the index entry limit.
 */
export const MAX_ACCEPTED_BYTES_PER_PASS = 2 * 1024 * 1024;

/** `AGENTS.md` and skills. `llms.txt` uses the catalog's `LLMS_TXT_ACCEPT` so a shared session can answer both from one request. */
const TEXT_ACCEPT = "text/markdown, text/plain";
const INDEX_ACCEPT = "application/json";

/** Where an item's answer came from this pass. */
export type ProbeSource = "network" | "not_modified" | "cache" | "none";

/** Public website text Scout accepted, with what the capability store needs to build a version. */
export interface AcquiredResource {
  kind: ResourceKind;
  siteOrigin: string;
  /** Always the site origin: only same-origin resources are fetched. */
  publisherOrigin: string;
  sourceUrl: string;
  /** The URL the text was finally served from (a same-host redirect may change the path). */
  finalUrl: string;
  text: string;
  sha256: string;
  byteLength: number;
  fetchedAt: number;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  skill?: SkillDescriptor;
}

export interface ProbeItem {
  kind: ProbeKind;
  /** Absent only for a skills-index entry whose URL did not resolve. */
  sourceUrl?: string;
  status: ProbeStatus;
  code?: ProbeCode;
  source: ProbeSource;
  /**
   * `found`: the accepted text. `failed` transiently (or on a digest mismatch), or `limited`
   * by the pass budget or a pacing refusal: the last good copy, if any, and only while the
   * site confirmed it less than `DISCOVERY_STALE_TEXT_MAX_MS` ago. Never for the skills index.
   */
  resource?: AcquiredResource;
  /** Skills only: the index entry. */
  entry?: { position: number; name?: string; description?: string };
}

/** A skill another origin publishes: shown, never fetched. */
export interface ExternalReference {
  position: number;
  name: string;
  description?: string;
  url: string;
  publisherOrigin: string;
}

export interface DiscoveryResult {
  origin: string;
  checkedAt: number;
  /** `not_fetched` when every probe was answered from the cache. */
  robots: RobotsSource | "not_fetched";
  /** `llms_txt`, `agents_md`, `skills_index`, then one item per examined index entry (except external references). */
  items: ProbeItem[];
  externalReferences: ExternalReference[];
  /** Index entries past the 20-entry cap: not examined, shown as a limit, never as absent. */
  skillsOverCap: number;
  acceptedBytes: number;
  stats: { requests: number; refused: number; ms: number };
}

export interface DiscoverSiteResourcesOptions {
  /** The origin's paced fetch, usually a shared `OriginFetchSession.fetch`. Discovery never opens a pacing window; the fetch's owner does. */
  fetch: PacedFetch;
  clock: Clock;
  cache?: DiscoveryCache;
  diagnostics?: Diagnostics;
  /** Ask every probe again now, skipping freshness and backoff (never caps, robots, or pacing). */
  refresh?: boolean;
  /** Test hook; defaults to `MAX_ACCEPTED_BYTES_PER_PASS`. */
  maxAcceptedBytes?: number;
}

function failureCode(result: Extract<GuardedFetchResult, { kind: "error" }>): ProbeFailureCode {
  switch (result.reason) {
    case "timeout":
      return "timeout";
    case "network":
      return "network";
    case "policy":
      return "policy";
    case "http":
      return result.status !== undefined && result.status >= 500 ? "http_5xx" : "http_status";
    default:
      return "network";
  }
}

async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface ProbeRequest {
  kind: ProbeKind;
  url: string;
  accept: string;
  /** Skills: the digest the index published. A cached copy with another hash is never reused. */
  skill?: SkillDescriptor;
  entry?: ProbeItem["entry"];
  /** False when the probe may only be answered from the cache (the index failed this pass). */
  network: boolean;
}

/**
 * Discover the agent-facing resources `origin` publishes at its fixed root paths, plus the
 * single-file skills its skills index lists. Never throws for anything the site does.
 *
 * Per probe: a cached answer is reused until it is due (24 h after a settled answer; 15 min,
 * 1 h, then 6 h after consecutive failures; `refresh` makes everything due). A due probe
 * checks robots (`*`/`scout` groups) first, then fetches through the paced fetch, sending
 * validators when it holds text, so a 304 keeps that text. Bodies must pass
 * `validateText`; skills must also match their published SHA-256.
 *
 * Partial failure: a transient failure (or a skill body that no longer matches its
 * unchanged published digest) keeps the last good text on the item (and in the cache) and
 * backs off, until the site last confirmed that text (a 200 or a 304) more than
 * `DISCOVERY_STALE_TEXT_MAX_MS` ago; then it is dropped. A pacing refusal (`limited`, code `refused`) or the pass budget leaves the
 * cached record as it was, so the next pass retries instead of freezing a partial result.
 *
 * Pacing windows: discovery never opens one. The fetch's owner (an `OriginFetchSession`)
 * does, once per pass.
 */
export async function discoverSiteResources(originInput: string, options: DiscoverSiteResourcesOptions): Promise<DiscoveryResult> {
  const origin = new URL(originInput).origin;
  if (!origin.startsWith("https://")) throw new TypeError("discovery origin must be https");
  const { clock, fetch, cache, diagnostics } = options;
  const refresh = options.refresh ?? false;
  const maxAccepted = options.maxAcceptedBytes ?? MAX_ACCEPTED_BYTES_PER_PASS;
  const started = clock.now();
  const requestsAtStart = fetch.requests;
  const refusedAtStart = fetch.refused;

  const cached = cache?.load(origin) ?? null;
  const previous = new Map((cached?.probes ?? []).map((record) => [record.url, record]));
  const next = new Map<string, ProbeRecord>();
  let dirty = false;
  let acceptedBytes = 0;
  let robotsSource: RobotsSource | "not_fetched" = "not_fetched";
  let robots: Promise<CompiledRobots> | null = null;

  const loadRobots = (): Promise<CompiledRobots> => {
    robots ??= fetchRobots(origin, fetch).then((fetched) => {
      robotsSource = fetched.source;
      if (fetched.source === "fetched") fetch.setCrawlDelay(fetched.crawlDelayMs);
      return compileRobots(fetched);
    });
    return robots;
  };

  const toResource = (request: ProbeRequest, stored: StoredText): AcquiredResource | undefined => {
    if (request.kind === "skills_index") return undefined;
    return {
      kind: request.kind,
      siteOrigin: origin,
      publisherOrigin: origin,
      sourceUrl: request.url,
      finalUrl: stored.finalUrl,
      text: stored.text,
      sha256: stored.sha256,
      byteLength: stored.byteLength,
      fetchedAt: stored.fetchedAt,
      ...(stored.contentType !== undefined ? { contentType: stored.contentType } : {}),
      ...(stored.etag !== undefined ? { etag: stored.etag } : {}),
      ...(stored.lastModified !== undefined ? { lastModified: stored.lastModified } : {}),
      ...(request.skill ? { skill: request.skill } : {}),
    };
  };

  const item = (request: ProbeRequest, status: ProbeStatus, source: ProbeSource, code?: ProbeCode, stored?: StoredText): ProbeItem => {
    const resource = stored ? toResource(request, stored) : undefined;
    return {
      kind: request.kind,
      sourceUrl: request.url,
      status,
      source,
      ...(code ? { code } : {}),
      ...(resource ? { resource } : {}),
      ...(request.entry ? { entry: request.entry } : {}),
    };
  };

  const record = (request: ProbeRequest, status: ProbeStatus, code: ProbeCode | undefined, failures: number, stored?: StoredText): void => {
    const checkedAt = clock.now();
    next.set(request.url, {
      kind: request.kind,
      url: request.url,
      status,
      ...(code ? { code } : {}),
      checkedAt,
      nextCheckAt: nextCheckAt(checkedAt, status, code, failures),
      failures,
      ...(stored ? { stored } : {}),
      ...(request.skill ? { skill: request.skill } : {}),
    });
    dirty = true;
  };

  /** Keep the previous record untouched (a refusal or limit of Scout's own says nothing new about the site). */
  const keep = (prev: ProbeRecord | undefined): void => {
    if (prev) next.set(prev.url, prev);
  };

  /** Count accepted text against the pass budget; false when it does not fit. */
  const admit = (request: ProbeRequest, bytes: number): boolean => {
    if (request.kind === "skills_index") return true;
    if (acceptedBytes + bytes > maxAccepted) return false;
    acceptedBytes += bytes;
    return true;
  };

  const fromRecord = (request: ProbeRequest, prev: ProbeRecord): ProbeItem => {
    if (prev.status === "found" && prev.stored && !admit(request, prev.stored.byteLength)) {
      keep(prev);
      return item(request, "limited", "none", "pass_budget");
    }
    if (prev.status !== "found" && prev.stored && !usableLastGood(prev.stored, clock.now())) {
      // The last good copy outlived the stale limit: forget it, keep the rest of the record.
      const { stored: _dropped, ...rest } = prev;
      next.set(prev.url, rest);
      dirty = true;
      return item(request, prev.status, "cache", prev.code);
    }
    keep(prev);
    return item(request, prev.status, "cache", prev.code, prev.stored);
  };

  const probe = async (request: ProbeRequest): Promise<ProbeItem> => {
    let prev = previous.get(request.url);
    if (prev && prev.kind !== request.kind) prev = undefined;
    // A skill whose published digest changed never reuses what was cached under the old one.
    if (prev && request.skill && prev.skill?.sha256 !== request.skill.sha256) prev = undefined;
    if (prev && (!request.network || !isDue(prev, clock.now(), refresh))) return fromRecord(request, prev);
    if (!request.network) return item(request, "failed", "none", "index_unavailable");
    // `lastGood` supplies validators; only `keptText` (younger than the stale limit) stands in for the site after a failure.
    const lastGood = prev?.stored;
    const keptText = usableLastGood(lastGood, clock.now());
    const priorFailures = prev?.status === "failed" ? prev.failures : 0;
    const fail = (code: ProbeFailureCode, keepText: boolean): ProbeItem => {
      record(request, "failed", code, priorFailures + 1, keepText ? keptText : undefined);
      return item(request, "failed", "network", code, keepText ? keptText : undefined);
    };

    if (request.kind !== "skills_index" && acceptedBytes >= maxAccepted) {
      keep(prev);
      return item(request, "limited", "none", "pass_budget", keptText);
    }
    const url = new URL(request.url);
    if (!isAllowed(await loadRobots(), url.pathname + url.search)) {
      record(request, "failed", "robots_disallowed", 0);
      return item(request, "failed", "none", "robots_disallowed");
    }

    const opts: CatalogFetchOptions = { accept: request.accept, maxBytes: TEXT_MAX_BYTES[request.kind] };
    if (lastGood?.etag) opts.ifNoneMatch = lastGood.etag;
    if (lastGood?.lastModified) opts.ifModifiedSince = lastGood.lastModified;
    const result = await fetch(request.url, opts);

    if (isRefusal(result)) {
      // Scout's own pacing said no: a limit, not news about the site.
      keep(prev);
      return item(request, "limited", "none", "refused", keptText);
    }
    switch (result.kind) {
      case "absent":
        record(request, "absent", undefined, 0);
        return item(request, "absent", "network");
      case "not_modified": {
        if (!lastGood) return fail("unexpected_not_modified", false);
        if (!admit(request, lastGood.byteLength)) {
          keep(prev);
          return item(request, "limited", "none", "pass_budget", keptText);
        }
        const { etag: _etag, lastModified: _lastModified, ...text } = lastGood;
        // A 304 confirms the stored text is current; `fetchedAt` stays the last full download.
        const stored: StoredText = { ...text, confirmedAt: clock.now(), ...nextValidators(lastGood, result) };
        record(request, "found", undefined, 0, stored);
        return item(request, "found", "not_modified", undefined, stored);
      }
      case "error":
        if (result.reason === "too_large") {
          record(request, "limited", "too_large", 0);
          return item(request, "limited", "network", "too_large");
        }
        return fail(failureCode(result), true);
      case "ok": {
        const checked = validateText(result.bytes, result.contentType, request.kind);
        if (!checked.ok) {
          const status: ProbeStatus = checked.reason === "too_large" ? "limited" : "unsupported";
          record(request, status, checked.reason, 0);
          return item(request, status, "network", checked.reason);
        }
        // The cached copy matched the published digest when it was fetched; a mismatch now is
        // the publisher's inconsistency, not evidence that copy is wrong, so it is kept.
        if (request.skill && checked.sha256 !== request.skill.sha256) return fail("digest_mismatch", true);
        if (!admit(request, checked.byteLength)) {
          keep(prev);
          return item(request, "limited", "none", "pass_budget", keptText);
        }
        const stored: StoredText = {
          text: checked.text,
          sha256: checked.sha256,
          byteLength: checked.byteLength,
          fetchedAt: clock.now(),
          confirmedAt: clock.now(),
          finalUrl: result.finalUrl,
          ...(result.contentType !== undefined ? { contentType: result.contentType } : {}),
          ...nextValidators({}, result),
        };
        record(request, "found", undefined, 0, stored);
        return item(request, "found", "network", undefined, stored);
      }
    }
  };

  const root = (kind: ProbeKind, path: string, accept: string): ProbeRequest => ({ kind, url: `${origin}${path}`, accept, network: true });
  const items: ProbeItem[] = [];
  items.push(await probe(root("llms_txt", LLMS_TXT_PATH, LLMS_TXT_ACCEPT)));
  items.push(await probe(root("agents_md", AGENTS_MD_PATH, TEXT_ACCEPT)));
  const indexRequest = root("skills_index", SKILLS_INDEX_PATH, INDEX_ACCEPT);
  let indexItem = await probe(indexRequest);

  // The index's text: current when found; the last good copy when the index failed this
  // pass, so its skills are still shown (from the cache only, with no new requests).
  const indexRecord = next.get(indexRequest.url);
  const indexText = indexItem.status === "found" || indexItem.status === "failed" ? indexRecord?.stored : undefined;
  let parsed: SkillsIndexParse | null = indexText ? parseSkillsIndex(indexText.text, indexText.finalUrl, origin) : null;
  if (parsed && !parsed.ok && indexItem.status === "found") {
    const code: IndexRejectReason = `index_${parsed.reason}`;
    record(indexRequest, "unsupported", code, 0);
    indexItem = item(indexRequest, "unsupported", indexItem.source, code);
    parsed = null;
  }
  items.push(indexItem);

  const externalReferences: ExternalReference[] = [];
  const skillRequests: ProbeRequest[] = [];
  const skillNetwork = indexItem.status === "found";
  if (parsed?.ok) {
    for (const entry of parsed.entries) {
      const shown: ProbeItem["entry"] = {
        position: entry.position,
        ...(entry.name !== undefined ? { name: entry.name } : {}),
        ...(entry.description !== undefined ? { description: entry.description } : {}),
      };
      if (entry.disposition === "external_reference") {
        externalReferences.push({ position: entry.position, name: entry.name, url: entry.url, publisherOrigin: entry.publisherOrigin, ...(entry.description !== undefined ? { description: entry.description } : {}) });
      } else if (entry.disposition === "unsupported") {
        items.push({ kind: "skill", ...(entry.url !== undefined ? { sourceUrl: entry.url } : {}), status: "unsupported", code: entry.reason, source: "none", entry: shown });
      } else {
        const skill: SkillDescriptor = { name: entry.name, sha256: entry.sha256, ...(entry.description !== undefined ? { description: entry.description } : {}) };
        skillRequests.push({ kind: "skill", url: entry.url, accept: TEXT_ACCEPT, skill, entry: shown, network: skillNetwork });
      }
    }
  }
  items.push(...(await mapWithLimit(skillRequests, SKILL_FETCH_CONCURRENCY, probe)));
  const skillsOverCap = parsed?.ok ? parsed.overCap : 0;

  // Records not carried into `next` (skills the index no longer lists) are dropped.
  if (cache && (dirty || next.size !== previous.size)) {
    cache.save({ schemaVersion: DISCOVERY_CACHE_SCHEMA_VERSION, origin, probes: [...next.values()] });
  }

  const ms = clock.now() - started;
  const requests = fetch.requests - requestsAtStart;
  const refused = fetch.refused - refusedAtStart;
  if (diagnostics) {
    const counts: Record<ProbeStatus, number> = { found: 0, absent: 0, failed: 0, unsupported: 0, limited: 0 };
    let fromCache = 0;
    let notModified = 0;
    let lastGoodKept = 0;
    let oldest = Number.POSITIVE_INFINITY;
    for (const it of items) {
      counts[it.status] += 1;
      if (it.source === "cache") {
        fromCache += 1;
        const at = it.sourceUrl ? previous.get(it.sourceUrl)?.checkedAt : undefined;
        if (at !== undefined) oldest = Math.min(oldest, at);
      }
      if (it.source === "not_modified") notModified += 1;
      if (it.status === "failed" && it.resource) lastGoodKept += 1;
    }
    diagnostics.event("resource_discover", {
      origin,
      ms,
      requests,
      refused,
      acceptedBytes,
      ...counts,
      external: externalReferences.length,
      skillsOverCap,
      fromCache,
      notModified,
      robots: robotsSource,
      llmsTxt: items[0]?.status ?? "none",
      agentsMd: items[1]?.status ?? "none",
      skillsIndex: indexItem.status,
    });
    // Only probed items count: an index entry Scout never asks about (`source: "none"`) says nothing about freshness.
    const probed = items.filter((it) => it.source !== "none").length;
    const source = cached === null ? "miss" : fromCache === probed ? "fresh" : "revalidated";
    diagnostics.event("resource_cache", {
      origin,
      source,
      stale: lastGoodKept > 0,
      ...(Number.isFinite(oldest) ? { ageMs: clock.now() - oldest } : {}),
    });
  }

  return {
    origin,
    checkedAt: clock.now(),
    robots: robotsSource,
    items,
    externalReferences,
    skillsOverCap,
    acceptedBytes,
    stats: { requests, refused, ms },
  };
}

export interface SiteResourceDiscovererOptions {
  /** Scout's home directory; the cache lives in `<scoutHome>/cache/discovery`. */
  scoutHome: string;
  clock: Clock;
  diagnostics?: Diagnostics;
  /** Test hook; defaults to the real `guardedFetch`. */
  guardedFetch?: (url: string, options: GuardedFetchOptions) => Promise<GuardedFetchResult>;
  /** Test hook; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SiteResourceDiscoverer {
  /**
   * `session` shares one paced, coalesced fetch with a catalog resolve of the same origin;
   * its owner has opened the pacing window. Without one, discovery gets a private session
   * and opens its window itself.
   */
  discover(origin: string, options?: { refresh?: boolean; session?: OriginFetchSession }): Promise<DiscoveryResult>;
}

/** Discovery with the on-disk cache and, unless the caller passes one, a private fetch session per call. */
export function createSiteResourceDiscoverer(options: SiteResourceDiscovererOptions): SiteResourceDiscoverer {
  const { clock, diagnostics } = options;
  const cache = createDiscoveryCache({ clock, dir: join(options.scoutHome, "cache", "discovery"), ...(diagnostics ? { diagnostics } : {}) });
  return {
    async discover(origin, { refresh = false, session } = {}) {
      let active = session;
      if (!active) {
        active = createOriginFetchSession({
          origin,
          clock,
          ...(options.guardedFetch ? { guardedFetch: options.guardedFetch } : {}),
          ...(options.sleep ? { sleep: options.sleep } : {}),
        });
        active.startWindow();
      }
      if (active.origin !== new URL(origin).origin) throw new TypeError("session is for another origin");
      return discoverSiteResources(origin, { fetch: active.fetch, clock, cache, refresh, ...(diagnostics ? { diagnostics } : {}) });
    },
  };
}
