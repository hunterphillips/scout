import { describe, expect, it, vi } from "vitest";
import { activityHash, createJobResumeCache, type JobResumeKey, RESUME_MAX_ENTRIES, RESUME_TTL_MS } from "./resumeCache.js";

describe("job resume cache", () => {
  const key = (extra: Partial<JobResumeKey> = {}): JobResumeKey => ({
    coreInstanceId: "core",
    origin: "https://docs.example.com",
    url: "https://docs.example.com/billing#top",
    catalogHash: "cat",
    activityHash: activityHash([{ url: "https://github.com/o/r/issues/1", title: "Issue", text: "Body" }]),
    approvalRevision: 1,
    grantRevision: 0,
    profileFingerprint: "fp",
    toolsRevision: 0,
    ...extra,
  });

  it("reuses an answer for the same key under 15 min (the fragment and the activity ignored); every other key field counts", () => {
    expect(RESUME_TTL_MS).toBe(15 * 60 * 1000);
    const clock = { t: 0, now: () => clock.t };
    const cache = createJobResumeCache<string>({ clock });
    cache.store(key(), { result: "answer", browserOnly: false });
    expect(cache.restore(key({ url: "https://docs.example.com/billing" }), { hasUserTools: false })).toBe("answer");
    // The user has been reading since: other activity still gets the page's answer back.
    expect(cache.restore(key({ activityHash: activityHash([]) }), { hasUserTools: false })).toBe("answer");
    for (const changed of [
      { coreInstanceId: "core-2" },
      { origin: "https://docs2.example.com" },
      { url: "https://docs.example.com/other" },
      { url: "https://docs.example.com/billing?tab=2" },
      { catalogHash: "cat-2" },
      { approvalRevision: 2 },
      { grantRevision: 1 },
      { profileFingerprint: "fp-2" },
      { toolsRevision: 1 },
    ]) {
      expect(cache.restore(key(changed), { hasUserTools: false }), JSON.stringify(changed)).toBeNull();
    }
    clock.t = RESUME_TTL_MS;
    expect(cache.restore(key(), { hasUserTools: false })).toBeNull();
    expect(cache.size).toBe(0);
  });

  // Ported from the legacy rank cache's tests when P4.4 removed it.
  it("sweeps expired entries on store", () => {
    const clock = { t: 0, now: () => clock.t };
    const cache = createJobResumeCache<string>({ clock });
    cache.store(key(), { result: "a", browserOnly: false });
    clock.t = RESUME_TTL_MS;
    cache.store(key({ catalogHash: "cat-2" }), { result: "b", browserOnly: false });
    expect(cache.size).toBe(1);
  });

  it("one entry per page and inputs: a later answer for the same page under other activity replaces it", () => {
    const cache = createJobResumeCache<string>({ clock: { now: () => 0 } });
    cache.store(key(), { result: "a", browserOnly: false });
    cache.store(key({ activityHash: activityHash([]) }), { result: "b", browserOnly: false });
    expect(cache.size).toBe(1);
    expect(cache.restore(key(), { hasUserTools: false })).toBe("b");
  });

  it("show() holds the shown page's entries (fragment ignored) and restarts their window when it stops being shown; other pages age", () => {
    const clock = { t: 0, now: () => clock.t };
    const cache = createJobResumeCache<string>({ clock });
    cache.store(key(), { result: "a", browserOnly: false });
    cache.store(key({ url: "https://docs.example.com/other" }), { result: "b", browserOnly: false });
    cache.show("https://docs.example.com/billing#elsewhere");
    // A long read: the shown page's answer outlives the window, and a store's sweep keeps it.
    clock.t = RESUME_TTL_MS + 5;
    cache.store(key({ url: "https://docs.example.com/third" }), { result: "c", browserOnly: false });
    expect(cache.restore(key({ url: "https://docs.example.com/other" }), { hasUserTools: false })).toBeNull();
    cache.show(null);
    clock.t += RESUME_TTL_MS - 1;
    expect(cache.restore(key(), { hasUserTools: false })).toBe("a");
    clock.t += 1;
    expect(cache.restore(key(), { hasUserTools: false })).toBeNull();
  });

  it("dropWhere() removes the entries the predicate names, by origin or by whether the job saw activity", () => {
    const cache = createJobResumeCache<string>({ clock: { now: () => 0 } });
    cache.store(key(), { result: "a", browserOnly: false });
    cache.store(key({ url: "https://docs.example.com/plain", activityHash: activityHash([]) }), { result: "p", browserOnly: false });
    cache.store(key({ origin: "https://other.example.com", url: "https://other.example.com/", activityHash: activityHash([]) }), { result: "b", browserOnly: false });
    cache.dropWhere((e) => e.origin === "https://other.example.com");
    expect(cache.size).toBe(2);
    cache.dropWhere((e) => e.hadActivity);
    expect(cache.size).toBe(1);
    expect(cache.restore(key({ url: "https://docs.example.com/plain" }), { hasUserTools: false })).toBe("p");
  });

  it("holds at most RESUME_MAX_ENTRIES entries, evicting the oldest-stored; re-storing a key refreshes its order", () => {
    const cache = createJobResumeCache<string>({ clock: { now: () => 0 } });
    for (let i = 0; i < RESUME_MAX_ENTRIES; i++) cache.store(key({ approvalRevision: i }), { result: `r${i}`, browserOnly: false });
    cache.store(key({ approvalRevision: 0 }), { result: "r0-again", browserOnly: false });
    cache.store(key({ approvalRevision: 99 }), { result: "new", browserOnly: false });
    expect(cache.size).toBe(RESUME_MAX_ENTRIES);
    expect(cache.restore(key({ approvalRevision: 1 }), { hasUserTools: false })).toBeNull();
    expect(cache.restore(key({ approvalRevision: 0 }), { hasUserTools: false })).toBe("r0-again");
    expect(cache.restore(key({ approvalRevision: 99 }), { hasUserTools: false })).toBe("new");
  });

  it("clear() empties every entry", () => {
    const cache = createJobResumeCache<string>({ clock: { now: () => 0 } });
    cache.store(key(), { result: "a", browserOnly: false });
    cache.store(key({ catalogHash: "cat-2" }), { result: "b", browserOnly: false });
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.restore(key(), { hasUserTools: false })).toBeNull();
  });

  it("treats a clock that went backwards as expired and reports each miss reason", () => {
    const clock = { t: 1_000, now: () => clock.t };
    const events: [string, unknown][] = [];
    const diagnostics = { event: vi.fn((name: string, fields: unknown) => events.push([name, fields])) };
    const cache = createJobResumeCache<string>({ clock, diagnostics: diagnostics as never });
    expect(cache.restore(key(), { hasUserTools: false })).toBeNull();
    cache.store(key(), { result: "a", browserOnly: false });
    expect(cache.restore(key({ catalogHash: "other" }), { hasUserTools: false })).toBeNull();
    clock.t = 500;
    expect(cache.restore(key(), { hasUserTools: false })).toBeNull();
    expect(cache.size).toBe(0);
    expect(events).toEqual([
      ["resume_miss", { reason: "empty" }],
      ["resume_miss", { reason: "key" }],
      ["resume_miss", { reason: "expired" }],
    ]);
  });

  it("a job with user tools never reuses a browser-only answer; one without them may", () => {
    const cache = createJobResumeCache<string>({ clock: { now: () => 0 } });
    cache.store(key({ toolsRevision: 3 }), { result: "browser-only", browserOnly: true });
    expect(cache.restore(key({ toolsRevision: 3 }), { hasUserTools: true })).toBeNull();
    expect(cache.restore(key({ toolsRevision: 3 }), { hasUserTools: false })).toBe("browser-only");
    cache.store(key({ toolsRevision: 3 }), { result: "with-tools", browserOnly: false });
    expect(cache.restore(key({ toolsRevision: 3 }), { hasUserTools: true })).toBe("with-tools");
  });

  it("the activity hash depends on order and content", () => {
    const a = { url: "u1", title: "A", text: "x" };
    const b = { url: "u2", title: "B" };
    expect(activityHash([a, b])).not.toBe(activityHash([b, a]));
    expect(activityHash([a])).not.toBe(activityHash([{ ...a, text: "y" }]));
    expect(activityHash([])).toBe(activityHash([]));
  });
});
