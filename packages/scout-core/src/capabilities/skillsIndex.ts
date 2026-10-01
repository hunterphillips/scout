// Modeled on rookkeeper/rook server/src/environments/services/agentSkillsDiscoveryIndex.ts
// (Rook, by John Berryman / Arcturus Labs): the `$schema` prefix, the `skills[]` entry shape
// (`name`, `type: skill-md | archive`, `description`, `url`, `digest: sha256:<hex>`), the
// name pattern, and first-wins duplicate handling. Scout changes: a closed outcome per
// entry instead of problem messages; description optional; a missing digest is
// `unsupported: no_digest`, not invalid; archives and non-`.md` files are detected by URL
// extension too; entries are classified same-origin (fetchable) or cross-origin (an
// external reference, never fetched); entries past the cap are counted, not dropped silently.
//
// MCP advertisements: neither the Rook schema nor the Agent Skills discovery RFC defines an
// index field for MCP servers, so this parser extracts none. Unknown fields (such as an
// `mcpServers` array) are ignored and never become requests.

import { sameOriginHttpsUrl } from "../catalog/sameOrigin.js";

/** Recognized `$schema` values all start with this. */
export const DISCOVERY_SCHEMA_PREFIX = "https://schemas.agentskills.io/discovery/";

/** Most index entries examined; the rest are counted as `overCap`. */
export const MAX_INDEX_ENTRIES = 20;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_URL_MAX = 2048;

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/;
const ARCHIVE_EXTENSIONS = /\.(?:zip|tar|tgz|tbz2?|txz|gz|bz2|xz|7z|rar|skill|jar)$/i;

export type IndexEntryUnsupportedReason =
  /** Not an object, or a missing/invalid name, type, description, URL, or digest format. */
  | "invalid_entry"
  /** A name or URL an earlier entry already used. */
  | "duplicate"
  | "archive"
  /** A single file that is not Markdown (`.md`). */
  | "file_type"
  /** No digest, so Scout cannot verify what it fetched. */
  | "no_digest";

interface EntryBase {
  /** Position in the index's `skills` array. */
  position: number;
  name?: string;
  description?: string;
  /** Resolved against the index URL; credentials and fragment removed. Absent when it did not resolve to https. */
  url?: string;
}

export type IndexEntry =
  /** Same-origin `.md` skill with a digest: Scout may fetch it. */
  | (EntryBase & { disposition: "fetch"; name: string; url: string; sha256: string })
  /** A skill on another origin: shown as a reference, never fetched. */
  | (EntryBase & { disposition: "external_reference"; name: string; url: string; publisherOrigin: string })
  | (EntryBase & { disposition: "unsupported"; reason: IndexEntryUnsupportedReason });

export type SkillsIndexParse =
  | { ok: true; entries: IndexEntry[]; /** Entries past `MAX_INDEX_ENTRIES`, not examined. */ overCap: number }
  | { ok: false; reason: "not_json" | "not_object" | "schema" | "no_skills_array" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The entry URL resolved against the index URL, canonical, or undefined unless it lands on https without credentials. */
function resolveEntryUrl(value: unknown, indexUrl: string): string | undefined {
  if (typeof value !== "string" || value.length > SKILL_URL_MAX) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim(), indexUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  url.hash = "";
  return url.href.length > SKILL_URL_MAX ? undefined : url.href;
}

function classify(raw: unknown, position: number, indexUrl: string, origin: string): IndexEntry {
  if (!isRecord(raw)) return { position, disposition: "unsupported", reason: "invalid_entry" };
  const base: EntryBase = { position };
  const { name, type, description, digest } = raw;
  const validName = typeof name === "string" && name.length <= SKILL_NAME_MAX && NAME_PATTERN.test(name);
  if (validName) base.name = name;
  if (typeof description === "string" && description.length <= SKILL_DESCRIPTION_MAX) base.description = description;
  const url = resolveEntryUrl(raw.url, indexUrl);
  if (url) base.url = url;
  const unsupported = (reason: IndexEntryUnsupportedReason): IndexEntry => ({ ...base, disposition: "unsupported", reason });

  if (!validName || !url) return unsupported("invalid_entry");
  if (description !== undefined && base.description === undefined) return unsupported("invalid_entry");
  if (type !== "skill-md" && type !== "archive") return unsupported("invalid_entry");
  const pathname = new URL(url).pathname;
  if (type === "archive" || ARCHIVE_EXTENSIONS.test(pathname)) return unsupported("archive");
  if (!/\.md$/i.test(pathname)) return unsupported("file_type");

  const sameOrigin = sameOriginHttpsUrl(url, origin);
  if (!sameOrigin) return { ...base, disposition: "external_reference", name, url, publisherOrigin: new URL(url).origin };
  if (digest === undefined || digest === null) return unsupported("no_digest");
  const match = typeof digest === "string" ? DIGEST_PATTERN.exec(digest) : null;
  if (!match) return unsupported("invalid_entry");
  return { ...base, disposition: "fetch", name, url, sha256: match[1] as string };
}

/**
 * Validate an Agent Skills discovery index body. `indexUrl` is the URL the index was
 * finally served from (relative entries resolve against it); `origin` is the site being
 * discovered. Never throws. Duplicate names or URLs keep the first entry.
 */
export function parseSkillsIndex(body: string, indexUrl: string, origin: string, maxEntries: number = MAX_INDEX_ENTRIES): SkillsIndexParse {
  let document: unknown;
  try {
    document = JSON.parse(body.replace(/^﻿/, ""));
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (!isRecord(document)) return { ok: false, reason: "not_object" };
  const schema = document.$schema;
  if (typeof schema !== "string" || !schema.startsWith(DISCOVERY_SCHEMA_PREFIX)) return { ok: false, reason: "schema" };
  if (!Array.isArray(document.skills)) return { ok: false, reason: "no_skills_array" };

  const listed: unknown[] = document.skills;
  const entries: IndexEntry[] = [];
  const names = new Set<string>();
  const urls = new Set<string>();
  for (const [position, raw] of listed.slice(0, maxEntries).entries()) {
    const entry = classify(raw, position, indexUrl, origin);
    if (entry.name !== undefined && entry.disposition !== "unsupported") {
      if (names.has(entry.name) || urls.has(entry.url)) {
        const { position: p, name, url, description } = entry;
        entries.push({ position: p, name, url, ...(description !== undefined ? { description } : {}), disposition: "unsupported", reason: "duplicate" });
        continue;
      }
      names.add(entry.name);
      urls.add(entry.url);
    }
    entries.push(entry);
  }
  return { ok: true, entries, overCap: Math.max(0, listed.length - maxEntries) };
}
