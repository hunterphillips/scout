import { describe, expect, it } from "vitest";
import {
  BridgeFrameSchema,
  BrowserObservationSchema,
  CandidateSchema,
  NativeCommandSchema,
  PanelStateSchema,
  ToChromeFrameSchema,
} from "./index.js";

describe("contract schemas", () => {
  it("accepts each browser observation kind and rejects unknown kinds", () => {
    const focus = { kind: "focus", seq: 1, at: 1, browserFocused: false, windowId: -1 };
    const pageText = {
      kind: "page_text", seq: 2, at: 2, tabId: 3, documentId: "d", url: "https://github.com/o/r/issues/1",
      source: "github_issue", title: "t", text: "body", truncated: false,
    };
    const permissions = { kind: "permissions", granted: ["https://github.com/*"] };
    for (const o of [focus, pageText, permissions]) expect(BrowserObservationSchema.parse(o)).toEqual(o);
    expect(BrowserObservationSchema.safeParse({ kind: "click" }).success).toBe(false);
    expect(BrowserObservationSchema.safeParse({ ...pageText, source: "gitlab" }).success).toBe(false);
  });

  it("rejects page text over the title and body caps", () => {
    const pageText = {
      kind: "page_text", seq: 2, at: 2, tabId: 3, documentId: "d", url: "https://github.com/o/r/issues/1",
      source: "github_issue", title: "t", text: "body", truncated: true,
    };
    expect(BrowserObservationSchema.safeParse({ ...pageText, title: "x".repeat(301) }).success).toBe(false);
    expect(BrowserObservationSchema.safeParse({ ...pageText, text: "x".repeat(8 * 1024) }).success).toBe(true);
    // 4-byte characters: byte length, not char count, is what's capped.
    expect(BrowserObservationSchema.safeParse({ ...pageText, text: "😀".repeat(2049) }).success).toBe(false);
  });

  it("wraps observations in bridge frames and accepts only protocol 1 hello", () => {
    const observation = { kind: "permissions", granted: [] };
    expect(BridgeFrameSchema.parse({ type: "observation", observation })).toEqual({ type: "observation", observation });
    expect(BridgeFrameSchema.parse({ type: "hello", protocol: 1 })).toEqual({ type: "hello", protocol: 1 });
    expect(BridgeFrameSchema.safeParse({ type: "hello", protocol: 2 }).success).toBe(false);
    expect(BridgeFrameSchema.safeParse({ type: "observation", observation: { kind: "x" } }).success).toBe(false);
    expect(ToChromeFrameSchema.parse({ type: "ack", seq: 2 })).toEqual({ type: "ack", seq: 2 });
    expect(ToChromeFrameSchema.parse({ type: "core_unavailable" })).toEqual({ type: "core_unavailable" });
  });

  it("enforces candidate id format and label caps", () => {
    const c = { id: "c1z", sourceUrl: "https://x/a", title: "A", labelQuality: "slug", provenance: "sitemap" };
    expect(CandidateSchema.parse(c)).toEqual(c);
    expect(CandidateSchema.safeParse({ ...c, id: "1" }).success).toBe(false);
    expect(CandidateSchema.safeParse({ ...c, title: "x".repeat(161) }).success).toBe(false);
    expect(CandidateSchema.safeParse({ ...c, description: "x".repeat(401) }).success).toBe(false);
  });

  it("ties results items to ok/empty and reason to unavailable/error", () => {
    expect(PanelStateSchema.parse({ type: "state", status: "idle" })).toEqual({ type: "state", status: "idle" });
    const ok = { type: "results", visitEpoch: 1, status: "ok", items: [{ candidateId: "c0", title: "t", href: "h", reason: "r" }] };
    expect(PanelStateSchema.parse(ok)).toEqual(ok);
    const failed = { type: "results", visitEpoch: 1, status: "error", reason: "boom" };
    expect(PanelStateSchema.parse(failed)).toEqual(failed);
    expect(PanelStateSchema.safeParse({ type: "results", visitEpoch: 1, status: "error", items: [] }).success).toBe(false);
    expect(PanelStateSchema.safeParse({ type: "results", visitEpoch: 1, status: "ok", reason: "x" }).success).toBe(false);
  });

  it("parses native commands", () => {
    expect(NativeCommandSchema.parse({ type: "frontmost", bundleId: "com.google.Chrome", at: 5 }).type).toBe("frontmost");
    expect(NativeCommandSchema.parse({ type: "shutdown" })).toEqual({ type: "shutdown" });
    expect(NativeCommandSchema.safeParse({ type: "frontmost" }).success).toBe(false);
  });
});
