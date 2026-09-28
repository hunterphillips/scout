import { describe, expect, it, vi } from "vitest";
import { type ContextStatus, createResumeCache, RESUME_MAX_ENTRIES, type ResumeKey } from "./resumeCache.js";

const STATUS: ContextStatus = { serviceInstanceId: "svc-1", activityRevision: 4, sourceGrantRevision: "grant-a" };
const KEY_A: ResumeKey = { tabId: 10, documentId: "doc-a", catalogVersion: "cat-1", contextRevision: 3 };
const KEY_B: ResumeKey = { tabId: 20, documentId: "doc-b", catalogVersion: "cat-2", contextRevision: 3 };

function setup() {
  const clock = { t: 0, now: () => clock.t };
  const cache = createResumeCache<string>({ clock });
  return { clock, cache };
}

const ok = (status: ContextStatus = STATUS) => vi.fn(async () => status);

describe("resumeCache", () => {
  // Plan: "A, then B, then A within 30 s re-emits A's result under the new epoch with no
  // rank call." A hit here is what lets the core skip the rank call.
  it("restores A after a brief switch away when the status matches", async () => {
    const { clock, cache } = setup();
    cache.store(KEY_A, "result-A", STATUS);
    clock.t = 5_000;
    // Brief visit to B, which never finished ranking: no entry for B, A survives.
    expect(await cache.restore(KEY_B, ok())).toBeNull();
    clock.t = 10_000;
    const fetchStatus = ok();
    expect(await cache.restore(KEY_A, fetchStatus)).toBe("result-A");
    expect(fetchStatus).toHaveBeenCalledOnce();
    expect(cache.size).toBe(1);
  });

  // Plan: "A's result never renders during B." B's key never returns A's result, and the
  // status is not even fetched for a different key.
  it("never returns A's result for B's key", async () => {
    const { cache } = setup();
    cache.store(KEY_A, "result-A", STATUS);
    const fetchStatus = ok();
    expect(await cache.restore(KEY_B, fetchStatus)).toBeNull();
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  // Plan: "A-B-A switching within 30 s shows A's result again with no new rank." B's
  // finished rank must not evict A.
  it("store A, store B, restore A within 30 s returns A's result", async () => {
    const { clock, cache } = setup();
    cache.store(KEY_A, "result-A", STATUS);
    clock.t = 5_000;
    cache.store(KEY_B, "result-B", STATUS);
    clock.t = 10_000;
    expect(await cache.restore(KEY_A, ok())).toBe("result-A");
    expect(cache.size).toBe(2);
  });

  // Each key keeps its own entry; B's lookup returns B's result, never A's.
  it("keeps A and B side by side under their own keys", async () => {
    const { cache } = setup();
    cache.store(KEY_A, "result-A", STATUS);
    cache.store(KEY_B, "result-B", STATUS);
    expect(await cache.restore(KEY_B, ok())).toBe("result-B");
    expect(await cache.restore(KEY_A, ok())).toBe("result-A");
  });

  it("discards only the mismatched key's entry", async () => {
    const { cache } = setup();
    cache.store(KEY_A, "result-A", STATUS);
    cache.store(KEY_B, "result-B", STATUS);
    expect(await cache.restore(KEY_A, ok({ ...STATUS, activityRevision: 5 }))).toBeNull();
    expect(cache.size).toBe(1);
    expect(await cache.restore(KEY_B, ok())).toBe("result-B");
  });

  it("sweeps expired entries on store", () => {
    const { clock, cache } = setup();
    cache.store(KEY_A, "result-A", STATUS);
    clock.t = 30_000;
    cache.store(KEY_B, "result-B", STATUS);
    expect(cache.size).toBe(1);
  });

  it("holds at most eight entries, evicting the oldest-stored", async () => {
    const { clock, cache } = setup();
    for (let i = 0; i < 9; i++) {
      clock.t = i;
      cache.store({ ...KEY_A, tabId: i }, `result-${i}`, STATUS);
    }
    expect(cache.size).toBe(RESUME_MAX_ENTRIES);
    expect(await cache.restore({ ...KEY_A, tabId: 0 }, ok())).toBeNull();
    expect(await cache.restore({ ...KEY_A, tabId: 8 }, ok())).toBe("result-8");
  });

  it("re-storing a key refreshes its age and eviction order", async () => {
    const { clock, cache } = setup();
    cache.store({ ...KEY_A, tabId: 0 }, "old", STATUS);
    for (let i = 1; i < 8; i++) cache.store({ ...KEY_A, tabId: i }, `result-${i}`, STATUS);
    clock.t = 1;
    cache.store({ ...KEY_A, tabId: 0 }, "new", STATUS);
    cache.store({ ...KEY_A, tabId: 8 }, "result-8", STATUS);
    expect(await cache.restore({ ...KEY_A, tabId: 1 }, ok())).toBeNull();
    expect(await cache.restore({ ...KEY_A, tabId: 0 }, ok())).toBe("new");
  });

  it("clear() empties every entry", () => {
    const { cache } = setup();
    cache.store(KEY_A, "result-A", STATUS);
    cache.store(KEY_B, "result-B", STATUS);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  // Plan: "after 30 s ... returning to A discards the entry."
  it("expires at 30 s without calling context_status", async () => {
    const { clock, cache } = setup();
    cache.store(KEY_A, "result-A", STATUS);
    clock.t = 30_000;
    const fetchStatus = ok();
    expect(await cache.restore(KEY_A, fetchStatus)).toBeNull();
    expect(fetchStatus).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
  });

  it("expires if the TTL passes while context_status is in flight", async () => {
    const { clock, cache } = setup();
    cache.store(KEY_A, "result-A", STATUS);
    clock.t = 29_000;
    const slow = vi.fn(async () => {
      clock.t = 31_000;
      return STATUS;
    });
    expect(await cache.restore(KEY_A, slow)).toBeNull();
    expect(cache.size).toBe(0);
  });

  // Plan: "when context_status reports a different instance, activity revision, or grant
  // revision ... returning to A discards the entry." The grant-revision row is also what
  // covers "A grant revoked (reload) between ranks means the cached result is not shown."
  it.each([
    ["service instance", { ...STATUS, serviceInstanceId: "svc-2" }],
    ["activity revision", { ...STATUS, activityRevision: 5 }],
    ["grant revision", { ...STATUS, sourceGrantRevision: "grant-b" }],
  ])("discards the entry when context_status reports a different %s", async (_name, status) => {
    const { cache } = setup();
    cache.store(KEY_A, "result-A", STATUS);
    expect(await cache.restore(KEY_A, ok(status))).toBeNull();
    expect(cache.size).toBe(0);
    // Discarded, not merely skipped: a matching status afterwards still misses.
    expect(await cache.restore(KEY_A, ok())).toBeNull();
  });

  // Plan: "... or fails, returning to A discards the entry."
  it("discards the entry when context_status fails", async () => {
    const { cache } = setup();
    cache.store(KEY_A, "result-A", STATUS);
    const failing = vi.fn(async (): Promise<ContextStatus> => {
      throw new Error("service down");
    });
    expect(await cache.restore(KEY_A, failing)).toBeNull();
    expect(cache.size).toBe(0);
  });

  // The key is exact: a lookup under a different contextRevision is a different key. The
  // plan's "grant revoked (reload) between ranks" case is covered by the grant-revision
  // status mismatch above, not by this test.
  it("misses when Scout's contextRevision changed since the rank", async () => {
    const { cache } = setup();
    cache.store(KEY_A, "result-A", STATUS);
    const fetchStatus = ok();
    expect(await cache.restore({ ...KEY_A, contextRevision: 4 }, fetchStatus)).toBeNull();
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it("does not discard an entry stored while context_status was in flight", async () => {
    const { cache } = setup();
    cache.store(KEY_A, "result-A", STATUS);
    const racing = vi.fn(async () => {
      cache.store(KEY_A, "result-A2", STATUS);
      return { ...STATUS, activityRevision: 99 };
    });
    expect(await cache.restore(KEY_A, racing)).toBeNull();
    expect(await cache.restore(KEY_A, ok())).toBe("result-A2");
  });

  it("treats a missing documentId as part of the key", async () => {
    const { cache } = setup();
    const { documentId: _d, ...noDoc } = KEY_A;
    cache.store(noDoc, "result-A", STATUS);
    expect(await cache.restore(KEY_A, ok())).toBeNull();
    expect(await cache.restore(noDoc, ok())).toBe("result-A");
  });
});
