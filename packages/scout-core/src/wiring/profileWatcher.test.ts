import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Timers } from "../clock.js";
import { fileSignature, PROFILE_DEBOUNCE_MS, PROFILE_POLL_MS, watchProfile, type WatchFn } from "./profileWatcher.js";

/** Manual one-shot timers on a fake clock. */
function fakeTimers(): Timers & { advance(ms: number): void; readonly pending: number } {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(h) {
      due.delete(h as number);
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (next === undefined) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = until;
    },
    get pending() {
      return due.size;
    },
  };
}

/** A watch double: `fire(name)` delivers an event, `fail()` reports a watcher error. */
function fakeWatch() {
  let listener: ((f: string | null) => void) | null = null;
  let onError: (() => void) | null = null;
  let closed = 0;
  const watch: WatchFn = (_dir, l, e) => {
    listener = l;
    onError = e;
    return { close: () => void closed++ };
  };
  return { watch, fire: (name: string | null) => listener?.(name), fail: () => onError?.(), closed: () => closed };
}

describe("profile watcher", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("debounces events for the profile file and reports a change only when the signature moved", () => {
    dir = mkdtempSync(join(tmpdir(), "spw-"));
    const path = join(dir, "agent-profile.json");
    writeFileSync(path, "{}");
    const timers = fakeTimers();
    const w = fakeWatch();
    let sig = "a";
    let changes = 0;
    const watcher = watchProfile({ path, onChange: () => void changes++, timers, watch: w.watch, signature: () => sig });
    expect(watcher.mode).toBe("watch");
    // Unrelated files never schedule a check.
    w.fire("config.json");
    timers.advance(PROFILE_DEBOUNCE_MS * 2);
    expect(changes).toBe(0);
    // A burst of events is one check, PROFILE_DEBOUNCE_MS after the last.
    sig = "b";
    w.fire("agent-profile.json");
    timers.advance(PROFILE_DEBOUNCE_MS - 1);
    w.fire(null);
    timers.advance(PROFILE_DEBOUNCE_MS - 1);
    expect(changes).toBe(0);
    timers.advance(1);
    expect(changes).toBe(1);
    // An event with the same signature (a touch that changed nothing we compare) is no change.
    w.fire("agent-profile.json");
    timers.advance(PROFILE_DEBOUNCE_MS);
    expect(changes).toBe(1);
    watcher.close();
    expect(w.closed()).toBe(1);
    sig = "c";
    w.fire("agent-profile.json");
    timers.advance(PROFILE_DEBOUNCE_MS);
    expect(changes).toBe(1);
  });

  it("falls back to a poll when the watch cannot start, or fails later", () => {
    dir = mkdtempSync(join(tmpdir(), "spw-"));
    const path = join(dir, "agent-profile.json");
    for (const how of ["throws", "errors"] as const) {
      const timers = fakeTimers();
      const w = fakeWatch();
      let sig = "a";
      let changes = 0;
      let fallbacks = 0;
      const watch: WatchFn =
        how === "throws"
          ? () => {
              throw new Error("ENOSPC");
            }
          : w.watch;
      const watcher = watchProfile({ path, onChange: () => void changes++, timers, watch, signature: () => sig, onFallback: () => void fallbacks++ });
      if (how === "errors") {
        expect(watcher.mode).toBe("watch");
        w.fail();
        expect(w.closed()).toBe(1);
      }
      expect(watcher.mode).toBe("poll");
      expect(fallbacks).toBe(1);
      sig = "b";
      timers.advance(PROFILE_POLL_MS - 1);
      expect(changes).toBe(0);
      timers.advance(1);
      expect(changes).toBe(1);
      timers.advance(PROFILE_POLL_MS * 3);
      expect(changes).toBe(1);
      watcher.close();
      expect(timers.pending).toBe(0);
    }
  });

  it("the real signature sees an atomic replace and a removal", () => {
    dir = mkdtempSync(join(tmpdir(), "spw-"));
    const path = join(dir, "agent-profile.json");
    expect(fileSignature(path)).toBe("missing");
    writeFileSync(path, "{}");
    const first = fileSignature(path);
    writeFileSync(join(dir, "next"), "{}");
    renameSync(join(dir, "next"), path);
    expect(fileSignature(path)).not.toBe(first);
    rmSync(path);
    expect(fileSignature(path)).toBe("missing");
  });
});
