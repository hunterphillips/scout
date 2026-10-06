// The live list of recommendation-enabled hosts (`config.json` `destinations`). The core
// reads it once at start, then keeps it current two ways, with no restart:
//   - the side panel's per-site switch (`set_destination`): `set` writes config.json
//     (config.ts writeDestinations: read-modify-write, other keys kept, atomic, 0600, refused
//     unless config.json is a regular file this user owns and the whole file passes readConfig)
//     and applies the list it wrote;
//   - a hand edit: config.json is watched like the agent profile (profileWatcher.ts: the
//     directory, PROFILE_DEBOUNCE_MS debounce, PROFILE_POLL_MS poll fallback), and a changed file
//     is read again.
// Either way `onChanged` runs only when the list itself differs from the one held (order
// included), so the core's own write, a browser-context grant write, or a touch that leaves
// `destinations` as it was changes nothing: the watcher's later reload of a self-write reads the
// list `set` already applied. An edit that leaves config.json unreadable or its `destinations`
// malformed turns every destination off (a destination spends the user's quota; a broken file
// is not consent) until the file reads again.
//
// The compare-and-set of `set` is against the file as it is now (like the browser-context
// grant), not the held list: a hand edit the debounce has not delivered yet is not undone.
//
// Diagnostics: `destination_set {origin, enabled}` per applied switch, `destinations_changed
// {count}` per applied hand edit, `destinations_reload_failed {code}`,
// `destinations_watch_fallback`. Origins and counts only.

import { join } from "node:path";
import type { AckFailureCode } from "@scout/contracts";
import type { Timers } from "../clock.js";
import { ConfigError, DestinationsWriteError, readConfig, writeDestinations } from "../config.js";
import type { Diagnostics } from "../diagnostics.js";
import { type ProfileWatcher, watchProfile, type WatchFn } from "./profileWatcher.js";

export type SetDestinationOutcome = { ok: true } | { ok: false; code: Extract<AckFailureCode, "stale_revision" | "invalid" | "store_error"> };

export interface LiveDestinationsOptions {
  /** SCOUT_HOME. */
  home: string;
  /** The list the core started with (`readConfig(home).destinations`). */
  initial: readonly string[];
  /** The held list changed; `hosts` is the new one. */
  onChanged: (hosts: readonly string[]) => void;
  diagnostics: Diagnostics;
  /** Test seams for the watcher. */
  timers?: Timers;
  watch?: WatchFn;
}

export interface LiveDestinations {
  /** The hosts with recommendations on, as the core applies them now. */
  current(): readonly string[];
  /** Turn `origin`'s host on or off, compare-and-set on `expectedEnabled`. Synchronous. */
  set(origin: string, enabled: boolean, expectedEnabled: boolean): SetDestinationOutcome;
  /** Stop watching. Idempotent. */
  close(): void;
}

export function createLiveDestinations(o: LiveDestinationsOptions): LiveDestinations {
  const { diagnostics } = o;
  let held: readonly string[] = [...new Set(o.initial)];
  let closed = false;

  /** Hold `next`; true (and `onChanged`) only when it differs from the held list. */
  const apply = (next: readonly string[]): boolean => {
    const deduped = [...new Set(next)];
    if (deduped.length === held.length && deduped.every((h, i) => h === held[i])) return false;
    held = deduped;
    o.onChanged(held);
    return true;
  };

  const reload = (): void => {
    if (closed) return;
    let next: readonly string[];
    try {
      next = readConfig(o.home).destinations;
    } catch (e) {
      diagnostics.event("destinations_reload_failed", { code: e instanceof ConfigError ? e.code : "config-unreadable" });
      next = [];
    }
    if (apply(next)) diagnostics.event("destinations_changed", { count: held.length });
  };

  // Started after `held` is read; an edit between the core's start read and here is picked up by
  // the next change at worst (the start read is a few milliseconds earlier).
  const watcher: ProfileWatcher = watchProfile({
    path: join(o.home, "config.json"),
    onChange: reload,
    ...(o.timers ? { timers: o.timers } : {}),
    ...(o.watch ? { watch: o.watch } : {}),
    onFallback: () => diagnostics.event("destinations_watch_fallback", {}),
  });

  return {
    current: () => held,
    set(origin, enabled, expectedEnabled) {
      let host: string;
      try {
        host = new URL(origin).host;
      } catch {
        return { ok: false, code: "invalid" };
      }
      let result: { written: boolean; destinations: string[] };
      try {
        // The whole file must read (readConfig throws ConfigError) before anything is written:
        // the watcher's reload of this write runs readConfig, and a file it cannot read turns
        // every destination off, cancelling the job this switch just started.
        result = writeDestinations(o.home, host, enabled, (current) => {
          readConfig(o.home);
          return current.includes(host) === expectedEnabled;
        });
      } catch (e) {
        if (e instanceof ConfigError) {
          diagnostics.event("destination_set_failed", { origin, code: e.code });
          return { ok: false, code: "invalid" };
        }
        const code = e instanceof DestinationsWriteError && (e.code === "invalid" || e.code === "full") ? "invalid" : "store_error";
        diagnostics.event("destination_set_failed", { origin, code: e instanceof DestinationsWriteError ? e.code : "io" });
        return { ok: false, code };
      }
      // A stale compare still syncs the held list with the file it read.
      apply(result.destinations);
      if (!result.written) return { ok: false, code: "stale_revision" };
      diagnostics.event("destination_set", { origin, enabled });
      return { ok: true };
    },
    close() {
      if (closed) return;
      closed = true;
      watcher.close();
    },
  };
}
