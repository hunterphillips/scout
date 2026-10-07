// The bounded in-memory record of browser activity the core accepted: the pages the user
// recently read on sites they allowed. It is what `recent_activity` serves and what each job
// snapshot copies, and it is never a general browsing history: at most ACTIVITY_MAX_ENTRIES
// entries, each gone ACTIVITY_TTL_MS after it was last observed, one per canonical page URL
// (canonicalPageUrl: fragment dropped), never persisted. `removeOrigin` drops one site's
// pages when its grant goes.
//
// `accept` is synchronous, so the coordinator can acknowledge an observation right after the
// store took it. Two kinds of repeat are acknowledged without new content: the same
// `(connectionId, seq)` (the host re-sending on the same connection) changes nothing at all;
// the same URL, title and text already stored (the same page read again, or re-captured
// after a reconnect, which starts a new seq space) refreshes the entry's observed time and
// moves it to the front, so a page the user keeps returning to stays alive. A new title
// or text for a stored page replaces its entry, also at the front with a fresh observed time.
// `revision` rises with every change to the order or content of what `entries()` returns
// (new content, a re-read that reorders, expiry, clear, removeOrigin); a re-read of the newest entry only
// refreshes its observed time and leaves the revision alone. It is Scout's context revision
// for visits and pins live paging cursors; `view()` reads the entries and their revision
// after one prune, so the two always describe the same list.

import { PAGE_TEXT_BODY_MAX_BYTES, PAGE_TEXT_TITLE_MAX_CHARS, PAGE_URL_MAX_CHARS, type PageTextObservation } from "@scout/contracts";
import type { Clock } from "../clock.js";

export const ACTIVITY_MAX_ENTRIES = 10;
export const ACTIVITY_TTL_MS = 15 * 60 * 1000;
/**
 * How many `(connectionId, seq)` pairs are remembered, to dedupe re-sends on the same
 * connection. A reconnect is a new connection id; content dedupe covers that case.
 */
export const ACTIVITY_SEEN_SEQ_MAX = 64;

export interface StoredActivity {
  readonly origin: string;
  /** Canonical page URL (canonicalPageUrl). */
  readonly url: string;
  /** Core clock time it was last accepted. */
  readonly observedAt: number;
  readonly source: "page";
  readonly title: string;
  readonly text: string;
  readonly textTruncated: boolean;
  /** The store revision that last wrote or moved this entry. */
  readonly revision: number;
}

export type ActivityAcceptResult =
  /** Stored; acknowledge it. */
  | { accepted: true; duplicate: false; revision: number }
  /** Already seen, or the same content already stored (its observed time refreshed); acknowledge it. */
  | { accepted: false; duplicate: true; revision: number }
  /** Not a page the store can hold; do not acknowledge it. */
  | { accepted: false; duplicate: false; revision: number };

export interface ActivityStore {
  accept(obs: PageTextObservation, connectionId: string | number): ActivityAcceptResult;
  /** Unexpired entries, newest first, as frozen copies. Prunes first. */
  entries(): readonly StoredActivity[];
  /** Rises on every change to the order or content of `entries()`; prunes first. */
  readonly revision: number;
  /** The entries and the revision they belong to, read after a single prune. */
  view(): { entries: readonly StoredActivity[]; revision: number };
  clear(): void;
  /** Drop every entry from `origin`; true if any was removed (the revision rises once). */
  removeOrigin(origin: string): boolean;
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

  const snapshot = (): readonly StoredActivity[] => Object.freeze(list.map((e) => Object.freeze({ ...e })));

  return {
    accept(obs, connectionId) {
      prune();
      const seqKey = JSON.stringify([String(connectionId), obs.seq]);
      if (seen.includes(seqKey)) return { accepted: false, duplicate: true, revision };
      const url = canonicalPageUrl(obs.url);
      if (url === null || obs.source !== "page") return { accepted: false, duplicate: false, revision };
      remember(seqKey);
      const title = obs.title.slice(0, PAGE_TEXT_TITLE_MAX_CHARS);
      const body = cutUtf8(obs.text, PAGE_TEXT_BODY_MAX_BYTES);
      const existing = list.find((e) => e.url === url);
      if (existing && existing.title === title && existing.text === body.text) {
        // Read again: keep it alive and newest. Only a change of order is a change.
        const moved = list[0] !== existing;
        if (moved) revision++;
        const refreshed: StoredActivity = Object.freeze({ ...existing, observedAt: clock.now(), revision: moved ? revision : existing.revision });
        list = [refreshed, ...list.filter((e) => e !== existing)];
        return { accepted: false, duplicate: true, revision };
      }
      revision++;
      const entry: StoredActivity = Object.freeze({
        origin: new URL(url).origin,
        url,
        observedAt: clock.now(),
        source: "page",
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
      return snapshot();
    },
    view() {
      prune();
      return { entries: snapshot(), revision };
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
    removeOrigin(origin) {
      const kept = list.filter((e) => e.origin !== origin);
      if (kept.length === list.length) return false;
      list = kept;
      revision++;
      return true;
    },
    prune,
  };
}

/**
 * The URL a page is stored and compared under: https, no credentials, the default port, the
 * hostname lowercased and the fragment dropped; path and query kept verbatim. Null for
 * anything else, or when the result is over PAGE_URL_MAX_CHARS.
 */
export function canonicalPageUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return null;
  u.hash = "";
  const url = u.href;
  return url.length <= PAGE_URL_MAX_CHARS ? url : null;
}
