import { PAGE_TEXT_BODY_MAX_BYTES, type PageTextObservation } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import { ACTIVITY_MAX_ENTRIES, ACTIVITY_SEEN_SEQ_MAX, ACTIVITY_TTL_MS, canonicalPageUrl, createActivityStore } from "./store.js";

function setup() {
  const clock = { t: 1_000_000, now: () => clock.t };
  const store = createActivityStore({ clock });
  let seq = 0;
  const obs = (overrides: Partial<PageTextObservation> = {}): PageTextObservation => ({
    kind: "page_text",
    seq: ++seq,
    at: 0,
    tabId: 1,
    documentId: "d",
    url: "https://linear.app/acme/issue/ENG-1",
    source: "page",
    title: "Title",
    text: "Body",
    truncated: false,
    policyRevision: 1,
    ...overrides,
  });
  return { clock, store, obs };
}

describe("activity store", () => {
  it("stores the canonical page URL, its origin, bounded fields and the core's observed time; nothing else", () => {
    const { clock, store, obs } = setup();
    expect(store.accept(obs({ url: "https://Linear.APP/acme/issue/ENG-1/Title?view=all#comment-9", at: 5 }), "c1")).toEqual({
      accepted: true,
      duplicate: false,
      revision: 1,
    });
    expect(store.entries()).toEqual([
      { origin: "https://linear.app", url: "https://linear.app/acme/issue/ENG-1/Title?view=all", observedAt: clock.t, source: "page", title: "Title", text: "Body", textTruncated: false, revision: 1 },
    ]);
  });

  it("canonicalPageUrl: https, no credentials, default port, host lowercased, fragment dropped, path and query kept", () => {
    expect(canonicalPageUrl("https://Docs.Stripe.com/API/Charges?Expand=x#top")).toBe("https://docs.stripe.com/API/Charges?Expand=x");
    expect(canonicalPageUrl("https://docs.stripe.com:443/a")).toBe("https://docs.stripe.com/a");
    expect(canonicalPageUrl("https://docs.stripe.com/a#")).toBe("https://docs.stripe.com/a");
    for (const bad of [
      "http://docs.stripe.com/a",
      "https://u:p@docs.stripe.com/a",
      "https://docs.stripe.com:8443/a",
      "https://docs.stripe.com/" + "x".repeat(2048),
      "not a url",
    ]) {
      expect(canonicalPageUrl(bad), bad).toBeNull();
    }
  });

  it("cuts an oversized body at a code point and marks it truncated", () => {
    const { store, obs } = setup();
    // Bypasses the wire schema on purpose: the store bounds what it is handed.
    store.accept(obs({ text: "é".repeat(PAGE_TEXT_BODY_MAX_BYTES), title: "t".repeat(400) }), "c1");
    const [e] = store.entries();
    expect(Buffer.byteLength(e!.text)).toBeLessThanOrEqual(PAGE_TEXT_BODY_MAX_BYTES);
    expect(e!.text).not.toContain("�");
    expect(e!.textTruncated).toBe(true);
    expect(e!.title).toHaveLength(300);
  });

  it("refuses a URL canonicalPageUrl refuses, or another source, without a change", () => {
    const { store, obs } = setup();
    expect(store.accept(obs({ url: "http://linear.app/acme/issue/ENG-1" }), "c1")).toEqual({ accepted: false, duplicate: false, revision: 0 });
    expect(store.accept(obs({ source: "gitlab_issue" as "page" }), "c1")).toEqual({ accepted: false, duplicate: false, revision: 0 });
    expect(store.entries()).toEqual([]);
  });

  it("keeps at most ten entries: the eleventh evicts the oldest", () => {
    const { clock, store, obs } = setup();
    for (let i = 1; i <= ACTIVITY_MAX_ENTRIES + 1; i++) {
      clock.t += 1;
      store.accept(obs({ url: `https://linear.app/acme/issue/ENG-${i}` }), "c1");
    }
    const urls = store.entries().map((e) => e.url);
    expect(urls).toHaveLength(ACTIVITY_MAX_ENTRIES);
    expect(urls[0]).toBe("https://linear.app/acme/issue/ENG-11");
    expect(urls).not.toContain("https://linear.app/acme/issue/ENG-1");
  });

  it("expires entries after 15 minutes, and the expiry is a change", () => {
    const { clock, store, obs } = setup();
    store.accept(obs({ url: "https://linear.app/acme/issue/ENG-1" }), "c1");
    clock.t += 60_000;
    store.accept(obs({ url: "https://linear.app/acme/issue/ENG-2" }), "c1");
    expect(store.revision).toBe(2);
    clock.t += ACTIVITY_TTL_MS - 60_000;
    expect(store.entries().map((e) => e.url)).toEqual(["https://linear.app/acme/issue/ENG-2"]);
    expect(store.revision).toBe(3);
    clock.t += 60_000;
    expect(store.entries()).toEqual([]);
    expect(store.revision).toBe(4);
  });

  it("treats a repeated (connection, seq) as a duplicate, even with other content", () => {
    const { store, obs } = setup();
    const first = obs();
    expect(store.accept(first, "c1").accepted).toBe(true);
    expect(store.accept({ ...first, text: "changed" }, "c1")).toEqual({ accepted: false, duplicate: true, revision: 1 });
    // The same seq on another connection is new.
    expect(store.accept({ ...first, text: "changed" }, "c2")).toEqual({ accepted: true, duplicate: false, revision: 2 });
  });

  it("remembers only the last 64 (connection, seq) pairs", () => {
    const { store, obs } = setup();
    const first = obs({ text: "first" });
    store.accept(first, "c1");
    for (let i = 0; i < ACTIVITY_SEEN_SEQ_MAX; i++) store.accept(obs({ text: `n${i}` }), "c1");
    expect(store.accept({ ...first, text: "again" }, "c1").accepted).toBe(true);
  });

  it("treats identical URL, title and text under a new seq as a duplicate that refreshes the observed time; the newest entry keeps the revision", () => {
    const { clock, store, obs } = setup();
    store.accept(obs(), "c1");
    clock.t += 1000;
    expect(store.accept(obs({ url: "https://linear.app/acme/issue/ENG-1#x" }), "c2")).toEqual({ accepted: false, duplicate: true, revision: 1 });
    expect(store.entries()[0]!.observedAt).toBe(clock.t);
    expect(store.revision).toBe(1);
  });

  it("re-reading an older issue moves it to the front, keeps it alive past its first TTL, and is a change", () => {
    const { clock, store, obs } = setup();
    store.accept(obs({ url: "https://linear.app/acme/issue/ENG-1" }), "c1");
    clock.t += 60_000;
    store.accept(obs({ url: "https://linear.app/acme/issue/ENG-2" }), "c1");
    clock.t += 60_000;
    expect(store.accept(obs({ url: "https://linear.app/acme/issue/ENG-1" }), "c1")).toEqual({ accepted: false, duplicate: true, revision: 3 });
    expect(store.entries().map((e) => [e.url, e.observedAt, e.revision])).toEqual([
      ["https://linear.app/acme/issue/ENG-1", clock.t, 3],
      ["https://linear.app/acme/issue/ENG-2", clock.t - 60_000, 2],
    ]);
    // Past issue 1's first TTL, but not its refreshed one.
    clock.t += ACTIVITY_TTL_MS - 60_000;
    expect(store.entries().map((e) => e.url)).toEqual(["https://linear.app/acme/issue/ENG-1"]);
  });

  it("a repeated (connection, seq) with the same content is a pure no-op: no refresh", () => {
    const { clock, store, obs } = setup();
    const first = obs();
    store.accept(first, "c1");
    clock.t += 1000;
    expect(store.accept(first, "c1")).toEqual({ accepted: false, duplicate: true, revision: 1 });
    expect(store.entries()[0]!.observedAt).toBe(clock.t - 1000);
  });

  it("view() returns the entries with the revision they belong to, after one prune", () => {
    const { clock, store, obs } = setup();
    store.accept(obs({ url: "https://linear.app/acme/issue/ENG-1" }), "c1");
    clock.t += 1;
    store.accept(obs({ url: "https://linear.app/acme/issue/ENG-2" }), "c1");
    clock.t += ACTIVITY_TTL_MS - 1;
    const view = store.view();
    expect(view.entries.map((e) => e.url)).toEqual(["https://linear.app/acme/issue/ENG-2"]);
    expect(view.revision).toBe(3);
    expect(Object.isFrozen(view.entries)).toBe(true);
  });

  it("replaces a stored issue on new content, moving it to the front with a fresh observed time", () => {
    const { clock, store, obs } = setup();
    store.accept(obs({ url: "https://linear.app/acme/issue/ENG-1" }), "c1");
    clock.t += 1;
    store.accept(obs({ url: "https://linear.app/acme/issue/ENG-2" }), "c1");
    clock.t += 1;
    store.accept(obs({ url: "https://linear.app/acme/issue/ENG-1", title: "Renamed" }), "c1");
    const entries = store.entries();
    expect(entries.map((e) => [e.url, e.title, e.observedAt])).toEqual([
      ["https://linear.app/acme/issue/ENG-1", "Renamed", clock.t],
      ["https://linear.app/acme/issue/ENG-2", "Title", clock.t - 1],
    ]);
    expect(store.revision).toBe(3);
  });

  it("returns frozen copies, and clear() is a change only when something was stored", () => {
    const { store, obs } = setup();
    store.clear();
    expect(store.revision).toBe(0);
    store.accept(obs(), "c1");
    const entries = store.entries();
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0])).toBe(true);
    expect(() => {
      (entries[0] as { title: string }).title = "x";
    }).toThrow(TypeError);
    store.clear();
    expect(store.entries()).toEqual([]);
    expect(store.revision).toBe(2);
  });

  it("removeOrigin drops that site's pages only, as one change", () => {
    const { store, obs } = setup();
    store.accept(obs({ url: "https://linear.app/acme/issue/ENG-1" }), "c1");
    store.accept(obs({ url: "https://docs.stripe.com/api" }), "c1");
    store.accept(obs({ url: "https://linear.app/acme/issue/ENG-2" }), "c1");
    expect(store.revision).toBe(3);
    expect(store.removeOrigin("https://linear.app")).toBe(true);
    expect(store.entries().map((e) => e.url)).toEqual(["https://docs.stripe.com/api"]);
    expect(store.revision).toBe(4);
    expect(store.removeOrigin("https://linear.app")).toBe(false);
    expect(store.removeOrigin("https://example.com")).toBe(false);
    expect(store.revision).toBe(4);
  });
});
