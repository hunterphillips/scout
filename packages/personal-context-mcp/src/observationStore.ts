// The recent-activity list. In memory only: nothing here is ever written to disk.

import type { ActivityObservation } from "./api.js";
import type { Clock } from "./clock.js";

export const OBSERVATION_TTL_MS = 15 * 60_000;
export const OBSERVATION_MAX_ENTRIES = 10;
export const OBSERVATION_MAX_TEXT_BYTES = 8 * 1024;
/** The schema caps `title` at 1 KiB characters; the store also cuts it to 1 KiB of UTF-8 in case a caller skipped the schema. */
export const OBSERVATION_MAX_TITLE_BYTES = 1024;

/** One accepted observation, with its text already capped. */
export interface StoredObservation extends ActivityObservation {
  observationId: string;
}

export interface ObservationSnapshot {
  activityRevision: number;
  /** Newest first. */
  observations: readonly StoredObservation[];
}

export interface AddResult {
  accepted: true;
  observationId: string;
  /** True when the sensor said so or the store cut the text. */
  truncated: boolean;
}

export interface ObservationStore {
  add(obs: ActivityObservation): AddResult;
  /** Live entries, newest first, as frozen copies. */
  list(): readonly StoredObservation[];
  /** A deep-frozen copy for one run; later adds and expiries do not change it. */
  snapshot(): ObservationSnapshot;
  /** Bumps on each accepted add and on each expiry sweep that removed something. */
  readonly activityRevision: number;
  readonly size: number;
}

export interface ObservationStoreOptions {
  clock: Clock;
  ttlMs?: number;
  maxEntries?: number;
  maxTextBytes?: number;
}

interface Entry {
  obs: StoredObservation;
  addedAt: number;
}

/**
 * Cut `text` to at most `maxBytes` of UTF-8 without splitting a character.
 * Returns the text unchanged when it already fits.
 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; cut: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, cut: false };
  let end = maxBytes;
  // Step back over continuation bytes (10xxxxxx) to the start of the character.
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), cut: true };
}

/**
 * Policy: at most `maxEntries` observations, each kept for `ttlMs` from when the service
 * accepted it (the sensor's `observedAt` is informational and never trusted for expiry).
 * Adding past the cap evicts the oldest. Expired entries are dropped on every add and
 * read. Text past `maxTextBytes` is cut on a character boundary and flagged `truncated`.
 * A title past 1 KiB is cut silently (the schema already rejects one that long).
 * Ids are `o1`, `o2`, ... per process.
 */
export function createObservationStore(options: ObservationStoreOptions): ObservationStore {
  const ttlMs = options.ttlMs ?? OBSERVATION_TTL_MS;
  const maxEntries = options.maxEntries ?? OBSERVATION_MAX_ENTRIES;
  const maxTextBytes = options.maxTextBytes ?? OBSERVATION_MAX_TEXT_BYTES;
  // Oldest first.
  let entries: Entry[] = [];
  let revision = 0;
  let nextId = 1;

  const expired = (e: Entry): boolean => {
    const age = options.clock.now() - e.addedAt;
    // A clock that went backwards makes the age unknowable; treat it as expired.
    return age < 0 || age >= ttlMs;
  };

  const sweep = (): void => {
    const kept = entries.filter((e) => !expired(e));
    if (kept.length !== entries.length) {
      entries = kept;
      revision++;
    }
  };

  const newestFirst = (): StoredObservation[] => entries.map((e) => e.obs).reverse();

  return {
    get activityRevision() {
      sweep();
      return revision;
    },
    get size() {
      sweep();
      return entries.length;
    },
    add(obs) {
      sweep();
      const observationId = `o${nextId++}`;
      const stored: StoredObservation = {
        observationId,
        sensor: obs.sensor,
        kind: obs.kind,
        observedAt: obs.observedAt,
        url: obs.url,
        title: truncateUtf8(obs.title, OBSERVATION_MAX_TITLE_BYTES).text,
        truncated: obs.truncated,
      };
      if (obs.text !== undefined) {
        const t = truncateUtf8(obs.text, maxTextBytes);
        stored.text = t.text;
        stored.truncated = obs.truncated || t.cut;
      }
      entries.push({ obs: Object.freeze(stored), addedAt: options.clock.now() });
      while (entries.length > maxEntries) entries.shift();
      revision++;
      return { accepted: true, observationId, truncated: stored.truncated };
    },
    list() {
      sweep();
      return Object.freeze(newestFirst());
    },
    snapshot() {
      sweep();
      return Object.freeze({
        activityRevision: revision,
        observations: Object.freeze(newestFirst().map((o) => Object.freeze({ ...o }))),
      });
    },
  };
}
