import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Clock } from "../clock.js";
import { type Diagnostics, scoutHome } from "../diagnostics.js";
import { CACHE_STALE_MAX_MS, cacheFileName, checkPrivateDir, type DirRefusal, fsErrorCode } from "../privateCacheFile.js";
import type { IndexEntryUnsupportedReason } from "./skillsIndex.js";
import { sha256Hex, TEXT_MAX_BYTES, type TextRejectReason } from "./textValidation.js";

/**
 * The discovery cache is a preview store. It holds what resource discovery last learned
 * about one origin so Scout can show it and revalidate it cheaply. Approved text never
 * lives here: the capability store (P2.3) copies an approved version into its own
 * content-addressed blobs and never reads it back from this cache.
 *
 * Layout: `<scoutHome>/cache/discovery/<host>-<hash>.json` (dir 0700, file 0600, written
 * atomically; the same name and directory rules as the catalog cache, `privateCacheFile.ts`).
 *
 * Text persistence: the accepted text of every public resource (and the skills index) is
 * stored inline in the record, bounded by the per-kind caps (at most ~1.6 MiB per origin
 * with today's limits). Inline keeps each origin's state in one atomic write with no blob
 * files to collect. Every load re-hashes the text against its stored SHA-256, so a
 * hand-edited or truncated file is refused, never served.
 */

/** Bump when the file shape changes meaning; every older file is then ignored. */
export const DISCOVERY_CACHE_SCHEMA_VERSION = 1;

/** A settled answer (found, absent, unsupported, over a cap, robots-disallowed) is reused without any request for this long. */
export const DISCOVERY_FRESH_MS = 24 * 60 * 60 * 1000;

/** Wait before retrying a failed probe: after the first, second, and third-or-later consecutive failure. */
export const DISCOVERY_BACKOFF_MS: readonly number[] = [15 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000];

/** A `checkedAt` further than this in the future marks the file invalid (clock skew or tampering). */
export const DISCOVERY_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * A failed probe keeps its last good text only while the site confirmed it (a 200 or a
 * 304, `StoredText.confirmedAt`) less than this long ago (the catalog cache's stale limit).
 * Older text is dropped and the probe reports a plain failure.
 */
export const DISCOVERY_STALE_TEXT_MAX_MS = CACHE_STALE_MAX_MS;

/** A cache file larger than this is refused unread (`file_too_large`). Today's caps keep a file under ~2 MiB. */
export const DISCOVERY_CACHE_FILE_MAX_BYTES = 4 * 1024 * 1024;

export const PROBE_KINDS = ["llms_txt", "agents_md", "skills_index", "skill"] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

export const PROBE_STATUSES = ["found", "absent", "failed", "unsupported", "limited"] as const;
export type ProbeStatus = (typeof PROBE_STATUSES)[number];

/** Why a probe failed: the site's transport answer, a Scout protection, or a refused skill body. */
export type ProbeFailureCode =
  | "network"
  | "timeout"
  | "http_5xx"
  | "http_status"
  | "policy"
  | "robots_disallowed"
  | "digest_mismatch"
  | "unexpected_not_modified"
  /** A skill listed by an index that could not be read this pass, with nothing cached. */
  | "index_unavailable";

/** Why a probe was limited: a size cap, the pass budget, or Scout's own pacing refused the request (says nothing about the site). */
export type ProbeLimitCode = "too_large" | "pass_budget" | "refused";

export type IndexRejectReason = "index_not_json" | "index_not_object" | "index_schema" | "index_no_skills_array";

export type ProbeCode = ProbeFailureCode | ProbeLimitCode | Exclude<TextRejectReason, "too_large"> | IndexEntryUnsupportedReason | IndexRejectReason;

/** Every `ProbeCode`; the record type makes the compiler reject a missing or unknown one. */
const PROBE_CODE_TABLE: Record<ProbeCode, true> = {
  network: true,
  timeout: true,
  http_5xx: true,
  http_status: true,
  policy: true,
  robots_disallowed: true,
  digest_mismatch: true,
  unexpected_not_modified: true,
  index_unavailable: true,
  too_large: true,
  pass_budget: true,
  refused: true,
  empty: true,
  nul_byte: true,
  invalid_utf8: true,
  binary: true,
  html: true,
  frontmatter_invalid: true,
  frontmatter_executable: true,
  invalid_entry: true,
  duplicate: true,
  archive: true,
  file_type: true,
  no_digest: true,
  index_not_json: true,
  index_not_object: true,
  index_schema: true,
  index_no_skills_array: true,
};

export const PROBE_CODES = Object.keys(PROBE_CODE_TABLE) as ProbeCode[];

/** Accepted text plus what is needed to revalidate it. */
export interface StoredText {
  text: string;
  /** SHA-256 of the raw bytes, lowercase hex. */
  sha256: string;
  byteLength: number;
  /** When these bytes were downloaded (a 304 does not move it). */
  fetchedAt: number;
  /**
   * When the site last confirmed these bytes are current: set on every 200 and refreshed on
   * every 304. The stale-text limit counts from here. Absent in older records, which fall
   * back to `fetchedAt`.
   */
  confirmedAt?: number;
  /** URL the body was finally served from (same host); relative index entries resolve against it. */
  finalUrl: string;
  contentType?: string;
  etag?: string;
  lastModified?: string;
}

/** The skills-index entry a skill record was fetched for. */
export interface SkillDescriptor {
  name: string;
  description?: string;
  /** The digest the index published, lowercase hex. */
  sha256: string;
}

export interface ProbeRecord {
  kind: ProbeKind;
  /** Canonical source URL; the record's key. */
  url: string;
  status: ProbeStatus;
  code?: ProbeCode;
  /** Last time the site answered this probe. */
  checkedAt: number;
  /** No request before this unless the caller refreshes: 24 h after a settled answer, the backoff after a failure. */
  nextCheckAt: number;
  /** Consecutive failures, for the backoff. */
  failures: number;
  /** The accepted text: current when `found`, the last good copy when `failed` transiently. */
  stored?: StoredText;
  skill?: SkillDescriptor;
}

export interface DiscoveryCacheFile {
  schemaVersion: number;
  origin: string;
  probes: ProbeRecord[];
}

const StoredTextSchema = z.object({
  text: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteLength: z.int().min(0),
  fetchedAt: z.number(),
  confirmedAt: z.number().optional(),
  finalUrl: z.string(),
  contentType: z.string().optional(),
  etag: z.string().optional(),
  lastModified: z.string().optional(),
});

const FileSchema = z.object({
  schemaVersion: z.number(),
  origin: z.string(),
  probes: z
    .array(
      z.object({
        kind: z.enum(PROBE_KINDS),
        url: z.string(),
        status: z.enum(PROBE_STATUSES),
        code: z.enum(PROBE_CODES as [ProbeCode, ...ProbeCode[]]).optional(),
        checkedAt: z.number(),
        nextCheckAt: z.number(),
        failures: z.int().min(0),
        stored: StoredTextSchema.optional(),
        skill: z.object({ name: z.string(), description: z.string().optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
      }),
    )
    .max(64),
});

/** `stored` if it may still stand in for the site after a failure at `now`, else undefined (see `DISCOVERY_STALE_TEXT_MAX_MS`). */
export function usableLastGood(stored: StoredText | undefined, now: number): StoredText | undefined {
  return stored && now - (stored.confirmedAt ?? stored.fetchedAt) <= DISCOVERY_STALE_TEXT_MAX_MS ? stored : undefined;
}

/** When a probe last answered `checkedAt`, the next time it may be asked again. */
export function nextCheckAt(checkedAt: number, status: ProbeStatus, code: ProbeCode | undefined, failures: number): number {
  if (status !== "failed" || code === "robots_disallowed") return checkedAt + DISCOVERY_FRESH_MS;
  const step = DISCOVERY_BACKOFF_MS[Math.min(Math.max(failures, 1), DISCOVERY_BACKOFF_MS.length) - 1] ?? DISCOVERY_FRESH_MS;
  return checkedAt + step;
}

/** Whether `record` must be asked again now. `refresh` skips freshness and backoff, nothing else. */
export function isDue(record: ProbeRecord, now: number, refresh: boolean): boolean {
  return refresh || now >= record.nextCheckAt;
}

export interface DiscoveryCache {
  /** The cached file for `origin`, or null when missing or invalid (invalid emits `resource_cache_invalid`). */
  load(origin: string): DiscoveryCacheFile | null;
  /** Write atomically. Never throws; a failure emits `resource_cache_write_failed`. */
  save(file: DiscoveryCacheFile): void;
}

export interface DiscoveryCacheOptions {
  clock: Clock;
  /** Defaults to `<scoutHome>/cache/discovery`. */
  dir?: string;
  diagnostics?: Diagnostics;
}

function invalidReason(file: DiscoveryCacheFile, origin: string, now: number): string | null {
  if (file.origin !== origin) return "origin";
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const sameOrigin = (value: string): boolean => {
    try {
      return new URL(value).origin === origin;
    } catch {
      return false;
    }
  };
  for (const probe of file.probes) {
    let url: URL;
    try {
      url = new URL(probe.url);
    } catch {
      return "url";
    }
    if (url.origin !== origin || url.href !== probe.url) return "url";
    if (seen.has(probe.url)) return "duplicate_url";
    seen.add(probe.url);
    if (!Number.isFinite(probe.checkedAt) || !Number.isFinite(probe.nextCheckAt)) return "checked_at";
    if (probe.checkedAt > now + DISCOVERY_FUTURE_TOLERANCE_MS) return "future";
    if ((probe.kind === "skill") !== (probe.skill !== undefined)) return "skill";
    if (probe.status === "found" && !probe.stored) return "stored";
    const stored = probe.stored;
    if (stored) {
      if (!sameOrigin(stored.finalUrl)) return "final_url";
      if (!Number.isFinite(stored.fetchedAt) || (stored.confirmedAt !== undefined && !Number.isFinite(stored.confirmedAt))) return "checked_at";
      if ((stored.confirmedAt ?? stored.fetchedAt) > now + DISCOVERY_FUTURE_TOLERANCE_MS) return "future";
      const bytes = encoder.encode(stored.text);
      if (bytes.byteLength !== stored.byteLength || bytes.byteLength > TEXT_MAX_BYTES[probe.kind]) return "size";
      if (sha256Hex(bytes) !== stored.sha256) return "hash";
      if (probe.skill && probe.status === "found" && stored.sha256 !== probe.skill.sha256) return "hash";
    }
  }
  return null;
}

export function createDiscoveryCache(options: DiscoveryCacheOptions): DiscoveryCache {
  const dir = options.dir ?? join(scoutHome(), "cache", "discovery");
  const { clock, diagnostics } = options;

  const load = (origin: string): DiscoveryCacheFile | null => {
    const canonical = new URL(origin).origin;
    const invalid = (code: string) => {
      diagnostics?.event("resource_cache_invalid", { origin: canonical, code });
      return null;
    };
    let refusal: DirRefusal | null;
    try {
      refusal = checkPrivateDir(dir);
    } catch {
      return null; // no directory yet
    }
    if (refusal) return invalid(`dir_${refusal}`);
    let raw: string;
    let fd: number | null = null;
    try {
      fd = openSync(join(dir, cacheFileName(canonical)), "r");
      const st = fstatSync(fd);
      if (!st.isFile()) return invalid("not_file");
      if (st.size > DISCOVERY_CACHE_FILE_MAX_BYTES) return invalid("file_too_large");
      raw = readFileSync(fd, "utf8");
    } catch {
      return null;
    } finally {
      if (fd !== null) closeSync(fd);
    }
    if (raw.length > DISCOVERY_CACHE_FILE_MAX_BYTES) return invalid("file_too_large");
    let parsed: DiscoveryCacheFile;
    try {
      const json: unknown = JSON.parse(raw);
      if ((json as { schemaVersion?: unknown } | null)?.schemaVersion !== DISCOVERY_CACHE_SCHEMA_VERSION) return invalid("schema");
      // zod omits absent optional keys, so the parsed value satisfies the exact-optional interface.
      parsed = FileSchema.parse(json) as DiscoveryCacheFile;
    } catch {
      return invalid("parse");
    }
    const reason = invalidReason(parsed, canonical, clock.now());
    return reason ? invalid(reason) : parsed;
  };

  const save = (file: DiscoveryCacheFile): void => {
    const failed = (code: string) => diagnostics?.event("resource_cache_write_failed", { origin: file.origin, code });
    let temp: string | null = null;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const refusal = checkPrivateDir(dir);
      if (refusal) {
        failed(refusal);
        return;
      }
      const path = join(dir, cacheFileName(file.origin));
      temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(temp, JSON.stringify(file), { mode: 0o600, flag: "wx" });
      renameSync(temp, path);
    } catch (error) {
      if (temp !== null) {
        try {
          unlinkSync(temp);
        } catch {
          // Never written, or already gone.
        }
      }
      failed(fsErrorCode(error));
    }
  };

  return { load, save };
}
