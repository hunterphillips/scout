// The bounded in-memory record of browser activity the core accepted: the GitHub issues the
// user recently read. It is what `recent_activity` serves and what each job snapshot copies,
// and it is never a general browsing history: at most ACTIVITY_MAX_ENTRIES entries, each
// gone ACTIVITY_TTL_MS after it was last observed, one per canonical issue URL (query and
// fragment dropped), never persisted.
//
// `accept` is synchronous, so the coordinator can acknowledge an observation right after the
// store took it. A repeat is still acknowledged but changes nothing: the same
// `(connectionId, seq)` (a host re-sending after a reconnect) or the same URL, title and text
// already stored. A new title or text for a stored issue replaces its entry and refreshes its
// observed time. `revision` rises with every change to what `entries()` returns (accept,
// expiry, clear); it is Scout's context revision for visits and pins live paging cursors.

import { PAGE_TEXT_BODY_MAX_BYTES, PAGE_TEXT_TITLE_MAX_CHARS, type PageTextObservation } from "@scout/contracts";
import type { Clock } from "../clock.js";

export const ACTIVITY_MAX_ENTRIES = 10;
export const ACTIVITY_TTL_MS = 15 * 60 * 1000;
/** How many `(connectionId, seq)` pairs are remembered for reconnect dedupe. */
export const ACTIVITY_SEEN_SEQ_MAX = 64;

export const GITHUB_ISSUE_ORIGIN = "https://github.com";

export interface StoredActivity {
  readonly origin: string;
  /** Canonical issue URL: no query, no fragment, owner/repo lowercased. */
  readonly url: string;
  /** Core clock time it was last accepted. */
  readonly observedAt: number;
  readonly source: "github_issue";
  readonly title: string;
  readonly text: string;
  readonly textTruncated: boolean;
  /** The store revision that wrote this entry. */
  readonly revision: number;
}

export type ActivityAcceptResult =
  /** Stored; acknowledge it. */
  | { accepted: true; duplicate: false; revision: number }
  /** Already stored or already seen; acknowledge it, nothing changed. */
  | { accepted: false; duplicate: true; revision: number }
  /** Not an issue page the store can hold; do not acknowledge it. */
  | { accepted: false; duplicate: false; revision: number };

export interface ActivityStore {
  accept(obs: PageTextObservation, connectionId: string | number): ActivityAcceptResult;
  /** Unexpired entries, newest first, as frozen copies. Prunes first. */
  entries(): readonly StoredActivity[];
  /** Rises on every change to `entries()`; prunes first. */
  readonly revision: number;
  clear(): void;
  /** Drop expired entries. */
  prune(): void;
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** The longest prefix of `text` within `max` UTF-8 bytes, never splitting a code point. */
function cutUtf8(text: string, max: number): { text: string; cut: boolean } {
  const bytes = utf8.encode(text);
  if (bytes.byteLength <= max) return { text, cut: false };
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: utf8Decoder.decode(bytes.subarray(0, end)), cut: true };
}

export function createActivityStore(options: { clock: Clock }): ActivityStore {
  const { clock } = options;
  /** Newest first. */
  let list: StoredActivity[] = [];
  let revision = 0;
  const seen: string[] = [];

  const prune = (): void => {
    const cutoff = clock.now() - ACTIVITY_TTL_MS;
    const kept = list.filter((e) => e.observedAt > cutoff);
    if (kept.length === list.length) return;
    list = kept;
    revision++;
  };

  const remember = (key: string): void => {
    seen.push(key);
    if (seen.length > ACTIVITY_SEEN_SEQ_MAX) seen.splice(0, seen.length - ACTIVITY_SEEN_SEQ_MAX);
  };

  return {
    accept(obs, connectionId) {
      prune();
      const seqKey = JSON.stringify([String(connectionId), obs.seq]);
      if (seen.includes(seqKey)) return { accepted: false, duplicate: true, revision };
      const url = canonicalIssueUrl(obs.url);
      if (url === null || obs.source !== "github_issue") return { accepted: false, duplicate: false, revision };
      remember(seqKey);
      const title = obs.title.slice(0, PAGE_TEXT_TITLE_MAX_CHARS);
      const body = cutUtf8(obs.text, PAGE_TEXT_BODY_MAX_BYTES);
      const existing = list.find((e) => e.url === url);
      if (existing && existing.title === title && existing.text === body.text) return { accepted: false, duplicate: true, revision };
      revision++;
      const entry: StoredActivity = Object.freeze({
        origin: GITHUB_ISSUE_ORIGIN,
        url,
        observedAt: clock.now(),
        source: "github_issue",
        title,
        text: body.text,
        textTruncated: obs.truncated || body.cut,
        revision,
      });
      list = [entry, ...list.filter((e) => e.url !== url)].slice(0, ACTIVITY_MAX_ENTRIES);
      return { accepted: true, duplicate: false, revision };
    },
    entries() {
      prune();
      return Object.freeze(list.map((e) => Object.freeze({ ...e })));
    },
    get revision() {
      prune();
      return revision;
    },
    clear() {
      if (list.length === 0) return;
      list = [];
      revision++;
    },
    prune,
  };
}

// Same rule as the extension's route.ts (copied, not imported): a GitHub issue page,
// with query and fragment ignored.
const ISSUE_PATH_RE = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/;

/** `https://github.com/<owner>/<repo>/issues/<n>` with owner/repo lowercased, or null if not an issue page. */
export function canonicalIssueUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.port !== "" || u.username || u.password) return null;
  const m = ISSUE_PATH_RE.exec(u.pathname);
  if (m === null) return null;
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return `https://github.com/${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}/issues/${number}`;
}
