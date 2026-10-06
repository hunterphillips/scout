// Notices edits to `agent-profile.json` while the core runs. The profile CLI cannot write
// it then (the core holds `agent-profile.lock`), but the file is user-editable, so a hand edit
// must reach the next job.
//
// The watch is on the profile's directory, not the file: an atomic write replaces the file, and a
// watch on the old inode would go quiet. Every event naming the file (or naming nothing) starts a
// DEBOUNCE_MS debounce; when it fires, the file's signature (mtime, size, inode, or "missing") is
// compared with the last one seen, and only a different signature calls `onChange`. When the
// watch cannot start or fails later, a poll every POLL_MS does the same comparison instead.
// Whether the content really changed (a new fingerprint or tools revision) is the caller's call.

import { type FSWatcher, statSync, watch as fsWatch } from "node:fs";
import { basename, dirname } from "node:path";
import { systemTimers, type Timers } from "../clock.js";

export const PROFILE_DEBOUNCE_MS = 250;
export const PROFILE_POLL_MS = 5000;

export type WatchFn = (dir: string, listener: (filename: string | null) => void, onError: () => void) => { close(): void };

export interface ProfileWatcherOptions {
  /** The watched file (`<SCOUT_HOME>/agent-profile.json`). */
  path: string;
  /** The signature changed. */
  onChange: () => void;
  timers?: Timers;
  /** Test seam; default fs.watch on the directory. Throwing means "cannot watch": poll instead. */
  watch?: WatchFn;
  /** Test seam: the file's signature. */
  signature?: (path: string) => string;
  /** Called once when the watcher falls back to polling. */
  onFallback?: () => void;
  debounceMs?: number;
  pollMs?: number;
}

export interface ProfileWatcher {
  /** "watch" or "poll". */
  readonly mode: "watch" | "poll";
  close(): void;
}

/** mtime, size and inode, or "missing" when the file cannot be stat'ed. */
export function fileSignature(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return "missing";
  }
}

const defaultWatch: WatchFn = (dir, listener, onError) => {
  const w: FSWatcher = fsWatch(dir, { persistent: false }, (_event, filename) => listener(filename === null ? null : String(filename)));
  w.on("error", onError);
  return w;
};

export function watchProfile(o: ProfileWatcherOptions): ProfileWatcher {
  const timers = o.timers ?? systemTimers;
  const signature = o.signature ?? fileSignature;
  const debounceMs = o.debounceMs ?? PROFILE_DEBOUNCE_MS;
  const pollMs = o.pollMs ?? PROFILE_POLL_MS;
  const name = basename(o.path);
  let last = signature(o.path);
  let closed = false;
  let mode: "watch" | "poll" = "watch";
  let debounce: unknown = null;
  let poll: unknown = null;
  let watcher: { close(): void } | null = null;

  const check = (): void => {
    if (closed) return;
    const now = signature(o.path);
    if (now === last) return;
    last = now;
    o.onChange();
  };
  const schedule = (): void => {
    if (closed) return;
    if (debounce !== null) timers.clearTimeout(debounce);
    debounce = timers.setTimeout(() => {
      debounce = null;
      check();
    }, debounceMs);
  };
  const pollTick = (): void => {
    poll = null;
    if (closed) return;
    check();
    poll = timers.setTimeout(pollTick, pollMs);
  };
  const fallBack = (): void => {
    if (closed || mode === "poll") return;
    mode = "poll";
    try {
      watcher?.close();
    } catch {
      // already gone
    }
    watcher = null;
    o.onFallback?.();
    poll = timers.setTimeout(pollTick, pollMs);
  };

  try {
    watcher = (o.watch ?? defaultWatch)(dirname(o.path), (filename) => {
      if (filename === null || filename === name) schedule();
    }, fallBack);
  } catch {
    fallBack();
  }

  return {
    get mode() {
      return mode;
    },
    close() {
      if (closed) return;
      closed = true;
      if (debounce !== null) timers.clearTimeout(debounce);
      if (poll !== null) timers.clearTimeout(poll);
      try {
        watcher?.close();
      } catch {
        // already gone
      }
      watcher = null;
    },
  };
}
