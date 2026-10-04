import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRANT_DESTINATIONS_MAX } from "@scout/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Timers } from "../clock.js";
import { DestinationsWriteError, readConfig, writeDestinations } from "../config.js";
import type { DiagnosticFields, Diagnostics } from "../diagnostics.js";
import { createLiveDestinations } from "./destinations.js";
import { PROFILE_DEBOUNCE_MS, PROFILE_POLL_MS, type WatchFn } from "./profileWatcher.js";

function fakeTimers(): Timers & { advance(ms: number): void } {
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
  };
}

function fakeWatch() {
  let listener: ((f: string | null) => void) | null = null;
  let onError: (() => void) | null = null;
  const watch: WatchFn = (_dir, l, e) => {
    listener = l;
    onError = e;
    return { close: () => {} };
  };
  return { watch, fire: (name: string | null) => listener?.(name), fail: () => onError?.() };
}

describe("config.json destinations, live", () => {
  let home: string;
  let path: string;
  let events: { name: string; fields: DiagnosticFields }[];
  let diagnostics: Diagnostics;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sdst-"));
    path = join(home, "config.json");
    events = [];
    diagnostics = { failures: 0, event: (name, fields = {}) => void events.push({ name, fields }) };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const live = (initial: readonly string[] = readConfig(home).destinations) => {
    const timers = fakeTimers();
    const w = fakeWatch();
    const changes: string[][] = [];
    const d = createLiveDestinations({ home, initial, onChanged: (hosts) => void changes.push([...hosts]), diagnostics, timers, watch: w.watch });
    return { d, timers, w, changes };
  };

  it("on and off write config.json, keep every other key and its value, and apply at once", () => {
    const original = {
      chromeBundleId: "com.google.chrome.for.testing",
      agentBrowserContext: true,
      destinations: ["docs.stripe.com"],
      futureKey: { nested: [1, "two", null, { deep: true }] },
      zeta: 0.5,
    };
    writeFileSync(path, JSON.stringify(original), { mode: 0o600 });
    const { d, changes } = live();
    expect(d.current()).toEqual(["docs.stripe.com"]);

    expect(d.set("https://docs.example.com", true, false)).toEqual({ ok: true });
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after).toEqual({ ...original, destinations: ["docs.stripe.com", "docs.example.com"] });
    expect(Object.keys(after)).toEqual(Object.keys(original)); // key order kept
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(d.current()).toEqual(["docs.stripe.com", "docs.example.com"]);
    expect(changes).toEqual([["docs.stripe.com", "docs.example.com"]]);
    expect(events.filter((e) => e.name === "destination_set")).toEqual([{ name: "destination_set", fields: { origin: "https://docs.example.com", enabled: true } }]);

    expect(d.set("https://docs.stripe.com", false, true)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...original, destinations: ["docs.example.com"] });
    expect(changes.at(-1)).toEqual(["docs.example.com"]);
    // The core's diagnostics carry the origin and the boolean only.
    for (const e of events) expect(Object.keys(e.fields).every((k) => ["origin", "enabled", "code", "count"].includes(k))).toBe(true);
  });

  it("a missing config.json becomes one holding only destinations, mode 0600", () => {
    const { d } = live();
    expect(d.set("https://docs.stripe.com", true, false)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ destinations: ["docs.stripe.com"] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("a stale expectedEnabled is stale_revision and writes nothing; the held list syncs with the file it read", () => {
    writeFileSync(path, JSON.stringify({ destinations: [] }));
    const { d, changes } = live();
    // A hand edit the watcher has not delivered yet.
    writeFileSync(path, JSON.stringify({ destinations: ["docs.stripe.com"] }));
    const before = readFileSync(path, "utf8");
    expect(d.set("https://docs.stripe.com", true, false)).toEqual({ ok: false, code: "stale_revision" });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(d.current()).toEqual(["docs.stripe.com"]);
    expect(changes).toEqual([["docs.stripe.com"]]);
    expect(d.set("https://docs.example.com", false, true)).toEqual({ ok: false, code: "stale_revision" });
  });

  it("dedupes in order and caps the list at GRANT_DESTINATIONS_MAX", () => {
    writeFileSync(path, JSON.stringify({ destinations: ["a.example", "b.example", "a.example"] }));
    const { d } = live();
    expect(d.current()).toEqual(["a.example", "b.example"]);
    expect(d.set("https://c.example", true, false)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(path, "utf8")).destinations).toEqual(["a.example", "b.example", "c.example"]);

    const full = Array.from({ length: GRANT_DESTINATIONS_MAX }, (_, i) => `h${i}.example`);
    writeFileSync(path, JSON.stringify({ destinations: full }));
    const before = readFileSync(path, "utf8");
    expect(d.set("https://one-more.example", true, false)).toEqual({ ok: false, code: "invalid" });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(d.set("https://h3.example", false, true)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(path, "utf8")).destinations).toHaveLength(GRANT_DESTINATIONS_MAX - 1);
  });

  it("refuses a config.json that is not a regular file (symlink, directory) with store_error, and a malformed one with invalid", () => {
    const real = join(home, "elsewhere.json");
    writeFileSync(real, JSON.stringify({ destinations: [] }));
    symlinkSync(real, path);
    const { d } = live([]);
    expect(d.set("https://docs.stripe.com", true, false)).toEqual({ ok: false, code: "store_error" });
    expect(readFileSync(real, "utf8")).toBe(JSON.stringify({ destinations: [] }));
    expect(() => writeDestinations(home, "docs.stripe.com", true)).toThrow(DestinationsWriteError);
    rmSync(path);
    mkdirSync(path);
    expect(d.set("https://docs.stripe.com", true, false)).toEqual({ ok: false, code: "store_error" });
    rmSync(path, { recursive: true });
    for (const bad of ["{not json", "[]", JSON.stringify({ destinations: "docs.stripe.com" }), JSON.stringify({ destinations: ["https://docs.stripe.com"] })]) {
      writeFileSync(path, bad);
      expect(d.set("https://docs.stripe.com", true, false)).toEqual({ ok: false, code: "invalid" });
      expect(readFileSync(path, "utf8")).toBe(bad);
    }
    expect(events.filter((e) => e.name === "destination_set_failed").map((e) => e.fields.code)).toEqual(["not_regular", "not_regular", "invalid", "invalid", "invalid", "invalid"]);
  });

  it("refuses with invalid, writing nothing and changing nothing held, when another key in config.json is malformed", () => {
    const { d, changes } = live(["www.peakdesign.com"]);
    for (const bad of [{ agentBrowserContext: "yes" }, { chromeBundleId: "not a bundle id" }]) {
      const text = JSON.stringify({ ...bad, destinations: ["www.peakdesign.com"] });
      writeFileSync(path, text);
      expect(d.set("https://docs.stripe.com", true, false)).toEqual({ ok: false, code: "invalid" });
      expect(readFileSync(path, "utf8")).toBe(text);
    }
    expect(d.current()).toEqual(["www.peakdesign.com"]);
    expect(changes).toEqual([]);
    expect(events.filter((e) => e.name === "destination_set")).toEqual([]);
    expect(events.filter((e) => e.name === "destination_set_failed").map((e) => e.fields.code)).toEqual([
      "config-invalid-agent-browser-context",
      "config-invalid-chrome-bundle-id",
    ]);
  });

  it("an unwritable home is store_error", () => {
    writeFileSync(path, JSON.stringify({ destinations: [] }));
    const { d } = live();
    chmodSync(home, 0o500);
    try {
      expect(d.set("https://docs.stripe.com", true, false)).toEqual({ ok: false, code: "store_error" });
    } finally {
      chmodSync(home, 0o700);
    }
    expect(d.current()).toEqual([]);
  });

  it("a hand edit is picked up after the debounce; the core's own write never reports a second change", () => {
    writeFileSync(path, JSON.stringify({ destinations: [] }));
    const { d, timers, w, changes } = live();
    // The core's own write: applied once by `set`; the watcher's reload finds the same list.
    expect(d.set("https://docs.stripe.com", true, false)).toEqual({ ok: true });
    w.fire("config.json");
    timers.advance(PROFILE_DEBOUNCE_MS);
    expect(changes).toEqual([["docs.stripe.com"]]);
    // A temp file's event is not the config.
    w.fire(".scout-tmp-config.json.abcdef123456");
    timers.advance(PROFILE_DEBOUNCE_MS);
    expect(changes).toHaveLength(1);
    // A hand edit (rename-save, like an editor).
    writeFileSync(join(home, "edit.tmp"), JSON.stringify({ destinations: ["docs.stripe.com", "www.peakdesign.com"], agentBrowserContext: false }));
    renameSync(join(home, "edit.tmp"), path);
    w.fire("config.json");
    timers.advance(PROFILE_DEBOUNCE_MS - 1);
    expect(changes).toHaveLength(1);
    timers.advance(1);
    expect(changes.at(-1)).toEqual(["docs.stripe.com", "www.peakdesign.com"]);
    expect(d.current()).toEqual(["docs.stripe.com", "www.peakdesign.com"]);
    expect(events.filter((e) => e.name === "destinations_changed")).toEqual([{ name: "destinations_changed", fields: { count: 2 } }]);
    // A write that leaves destinations as they were (the browser-context grant) changes nothing.
    writeFileSync(path, JSON.stringify({ destinations: ["docs.stripe.com", "www.peakdesign.com"], agentBrowserContext: true }));
    w.fire("config.json");
    timers.advance(PROFILE_DEBOUNCE_MS);
    expect(changes).toHaveLength(2);
  });

  it("a hand edit that breaks config.json turns every destination off until it reads again", () => {
    writeFileSync(path, JSON.stringify({ destinations: ["docs.stripe.com"] }));
    const { d, timers, w, changes } = live();
    writeFileSync(path, "{ broken");
    w.fire("config.json");
    timers.advance(PROFILE_DEBOUNCE_MS);
    expect(d.current()).toEqual([]);
    expect(changes).toEqual([[]]);
    expect(events.find((e) => e.name === "destinations_reload_failed")?.fields).toEqual({ code: "config-unreadable" });
    writeFileSync(path, JSON.stringify({ destinations: ["docs.stripe.com"] }));
    w.fire("config.json");
    timers.advance(PROFILE_DEBOUNCE_MS);
    expect(d.current()).toEqual(["docs.stripe.com"]);
  });

  it("falls back to polling when the watch fails, and stops on close", () => {
    writeFileSync(path, JSON.stringify({ destinations: [] }));
    const { d, timers, w, changes } = live();
    w.fail();
    expect(events.some((e) => e.name === "destinations_watch_fallback")).toBe(true);
    writeFileSync(path, JSON.stringify({ destinations: ["docs.stripe.com", "x.example"] }));
    timers.advance(PROFILE_POLL_MS);
    expect(changes).toEqual([["docs.stripe.com", "x.example"]]);
    d.close();
    writeFileSync(path, JSON.stringify({ destinations: [] }));
    timers.advance(PROFILE_POLL_MS * 2);
    expect(changes).toHaveLength(1);
  });
});
