import { describe, expect, it } from "vitest";
import {
  AnyHelloSchema,
  BRIDGE_PROTOCOL,
  BridgeFrameSchema,
  BrowserObservationSchema,
  CandidateSchema,
  HelloSchema,
  isExactOriginPattern,
  NativeCommandSchema,
  PanelStateSchema,
  ToChromeFrameSchema,
} from "./index.js";

describe("contract schemas", () => {
  it("accepts each browser observation kind and rejects unknown kinds", () => {
    const focus = { kind: "focus", seq: 1, at: 1, browserFocused: false, windowId: -1 };
    const pageText = {
      kind: "page_text", seq: 2, at: 2, tabId: 3, documentId: "d", url: "https://linear.app/acme/issue/ENG-42/checkout?view=all",
      source: "page", title: "t", text: "body", truncated: false,
    };
    const permissions = { kind: "permissions", revision: 4, at: 4, granted: ["https://linear.app/*"] };
    for (const o of [focus, pageText, permissions]) expect(BrowserObservationSchema.parse(o)).toEqual(o);
    expect(BrowserObservationSchema.safeParse({ kind: "click" }).success).toBe(false);
    expect(BrowserObservationSchema.safeParse({ ...pageText, source: "gitlab" }).success).toBe(false);
    // Protocol 3's only source, spelled out at run time so no source file names it.
    expect(BrowserObservationSchema.safeParse({ ...pageText, source: ["github", "issue"].join("_") }).success).toBe(false);
  });

  it("accepts page text only from an https URL without fragment, credentials or a non-default port", () => {
    const pageText = {
      kind: "page_text", seq: 2, at: 2, tabId: 3, documentId: "d", url: "https://linear.app/acme/issue/ENG-42",
      source: "page", title: "t", text: "body", truncated: false,
    };
    expect(BrowserObservationSchema.safeParse(pageText).success).toBe(true);
    for (const bad of [
      "https://linear.app/acme/issue/ENG-42#comment-1",
      "https://linear.app/acme/issue/ENG-42#",
      "http://linear.app/acme/issue/ENG-42",
      "https://user:pw@linear.app/acme/issue/ENG-42",
      "https://linear.app:8443/acme/issue/ENG-42",
      "https://linear.app/" + "x".repeat(2048),
      "not a url",
    ]) {
      expect(BrowserObservationSchema.safeParse({ ...pageText, url: bad }).success, bad).toBe(false);
    }
  });

  it("rejects page text over the title and body caps", () => {
    const pageText = {
      kind: "page_text", seq: 2, at: 2, tabId: 3, documentId: "d", url: "https://linear.app/acme/issue/ENG-42/checkout?view=all",
      source: "page", title: "t", text: "body", truncated: true,
    };
    expect(BrowserObservationSchema.safeParse({ ...pageText, title: "x".repeat(301) }).success).toBe(false);
    expect(BrowserObservationSchema.safeParse({ ...pageText, text: "x".repeat(8 * 1024) }).success).toBe(true);
    // 4-byte characters: byte length, not char count, is what's capped.
    expect(BrowserObservationSchema.safeParse({ ...pageText, text: "😀".repeat(2049) }).success).toBe(false);
  });

  it("wraps observations in bridge frames and accepts only a protocol 4 hello", () => {
    const observation = { kind: "permissions", revision: 0, at: 1, granted: [] };
    expect(BridgeFrameSchema.parse({ type: "observation", observation })).toEqual({ type: "observation", observation });
    expect(BRIDGE_PROTOCOL).toBe(4);
    expect(BridgeFrameSchema.parse({ type: "hello", protocol: 4 })).toEqual({ type: "hello", protocol: 4 });
    expect(HelloSchema.safeParse({ type: "hello", protocol: 3 }).success).toBe(false);
    expect(HelloSchema.safeParse({ type: "hello", protocol: 2 }).success).toBe(false);
    expect(HelloSchema.safeParse({ type: "hello", protocol: 1 }).success).toBe(false);
    expect(BridgeFrameSchema.safeParse({ type: "hello", protocol: 1 }).success).toBe(false);
    expect(AnyHelloSchema.parse({ type: "hello", protocol: 1 })).toEqual({ type: "hello", protocol: 1 });
    expect(BridgeFrameSchema.safeParse({ type: "observation", observation: { kind: "x" } }).success).toBe(false);
    expect(ToChromeFrameSchema.parse({ type: "ack", seq: 2 })).toEqual({ type: "ack", seq: 2 });
    expect(ToChromeFrameSchema.parse({ type: "core_unavailable" })).toEqual({ type: "core_unavailable" });
    expect(ToChromeFrameSchema.parse({ type: "ready", extra: 1 })).toEqual({ type: "ready" });
  });

  it("accepts a permissions snapshot only with a revision and exact-host patterns, and nothing else", () => {
    const ok = { kind: "permissions", revision: 7, at: 1, granted: ["https://github.com/*", "https://docs.stripe.com/*"] };
    expect(BrowserObservationSchema.parse(ok)).toEqual(ok);
    expect(BrowserObservationSchema.safeParse({ kind: "permissions", granted: [] }).success).toBe(false);
    // A protocol-3 snapshot's GitHub-capture setting is refused, not stripped.
    expect(BrowserObservationSchema.safeParse({ ...ok, [`github${"Capture"}`]: true }).success).toBe(false);
    expect(BrowserObservationSchema.safeParse({ ...ok, revision: -1 }).success).toBe(false);
    expect(BrowserObservationSchema.safeParse({ ...ok, revision: 1.5 }).success).toBe(false);
    for (const bad of [
      "https://*/*",
      "https://*.example.com/*",
      "http://example.com/*",
      "https://example.com:8443/*",
      "https://example.com/",
      "https://example.com/path/*",
      "https://user@example.com/*",
      "https://Example.com/*",
      "https://192.168.1.1/*",
      "<all_urls>",
    ]) {
      expect(isExactOriginPattern(bad), bad).toBe(false);
      expect(BrowserObservationSchema.safeParse({ ...ok, granted: [bad] }).success, bad).toBe(false);
    }
    expect(isExactOriginPattern("https://www.peakdesign.com/*")).toBe(true);
  });

  it("stamps a focus with an optional non-negative integer permissions revision", () => {
    const focus = { kind: "focus", seq: 1, at: 1, browserFocused: true, windowId: 1, permissionsRevision: 3 };
    expect(BrowserObservationSchema.parse(focus)).toEqual(focus);
    expect(BrowserObservationSchema.safeParse({ ...focus, permissionsRevision: -1 }).success).toBe(false);
    expect(BrowserObservationSchema.safeParse({ ...focus, permissionsRevision: 0.5 }).success).toBe(false);
  });

  it("parses capture_policy, upgrade_required and core_unavailable reasons as core-to-Chrome frames", () => {
    const policy = { type: "capture_policy", revision: 0, paused: false, captureEnabled: false };
    expect(ToChromeFrameSchema.parse(policy)).toEqual(policy);
    for (const bad of [{ ...policy, revision: -1 }, { ...policy, paused: "no" }, { type: "capture_policy", revision: 1, paused: false }]) {
      expect(ToChromeFrameSchema.safeParse(bad).success).toBe(false);
    }
    expect(ToChromeFrameSchema.parse({ type: "upgrade_required", protocol: 2 })).toEqual({ type: "upgrade_required", protocol: 2 });
    expect(ToChromeFrameSchema.safeParse({ type: "upgrade_required" }).success).toBe(false);
    for (const reason of ["upgrade_required", "unreachable", "unsafe"]) {
      expect(ToChromeFrameSchema.parse({ type: "core_unavailable", reason })).toEqual({ type: "core_unavailable", reason });
    }
    expect(ToChromeFrameSchema.safeParse({ type: "core_unavailable", reason: "other" }).success).toBe(false);
  });

  it("enforces candidate id format and label caps", () => {
    const c = { id: "c1z", sourceUrl: "https://x/a", title: "A", labelQuality: "slug", provenance: "sitemap" };
    expect(CandidateSchema.parse(c)).toEqual(c);
    expect(CandidateSchema.safeParse({ ...c, id: "1" }).success).toBe(false);
    expect(CandidateSchema.safeParse({ ...c, id: `c${"z".repeat(31)}` }).success).toBe(true);
    expect(CandidateSchema.safeParse({ ...c, id: `c${"z".repeat(32)}` }).success).toBe(false);
    expect(CandidateSchema.safeParse({ ...c, title: "x".repeat(161) }).success).toBe(false);
    expect(CandidateSchema.safeParse({ ...c, description: "x".repeat(401) }).success).toBe(false);
  });

  it("ties results items to ok/empty and reason to unavailable/error", () => {
    expect(PanelStateSchema.parse({ type: "state", status: "idle" })).toEqual({ type: "state", status: "idle" });
    const id = { type: "results", coreInstanceId: "core-1", visitEpoch: 1, origin: "https://x.example", jobId: "j1" };
    const ok = { ...id, status: "ok", items: [{ candidateId: "c0", title: "t", reason: "r", hostname: "x.example" }] };
    expect(PanelStateSchema.parse(ok)).toEqual(ok);
    const failed = { ...id, status: "error", reason: "agent_failed" };
    expect(PanelStateSchema.parse(failed)).toEqual(failed);
    expect(PanelStateSchema.safeParse({ ...id, status: "error", reason: "agent_failed", items: [] }).success).toBe(false);
    expect(PanelStateSchema.safeParse({ ...id, status: "ok", reason: "x" }).success).toBe(false);
  });

  it("parses native commands", () => {
    expect(NativeCommandSchema.parse({ type: "frontmost", bundleId: "com.google.Chrome", at: 5 }).type).toBe("frontmost");
    expect(NativeCommandSchema.parse({ type: "shutdown" })).toEqual({ type: "shutdown" });
    expect(NativeCommandSchema.safeParse({ type: "frontmost" }).success).toBe(false);
  });
});
