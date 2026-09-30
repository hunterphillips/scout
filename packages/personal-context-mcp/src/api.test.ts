import { describe, expect, it } from "vitest";
import {
  AGENT_OUTPUT_JSON_SCHEMA,
  ActivityObservationSchema,
  AgentOutputSchema,
  ContextStatusSchema,
  RankRequestSchema,
  RankResponseSchema,
} from "./api.js";

const status = { serviceInstanceId: "svc-1", activityRevision: 3, sourceGrantRevision: "0123456789abcdef" };

const request = {
  requestId: "r1",
  site: { origin: "https://docs.stripe.com" },
  candidates: [{ id: "c1", title: "Billing", labelQuality: "published" }],
  maxResults: 3,
  deadlineMs: 20_000,
};

describe("RankRequestSchema", () => {
  it("accepts a minimal request and optional fields", () => {
    expect(RankRequestSchema.safeParse(request).success).toBe(true);
    expect(RankRequestSchema.safeParse({ ...request, supersedes: "r0", site: { origin: "https://x.dev", name: "X" } }).success).toBe(true);
  });

  it.each([
    ["maxResults 0", { maxResults: 0 }],
    ["maxResults 4", { maxResults: 4 }],
    ["fractional maxResults", { maxResults: 1.5 }],
    ["deadline over 26 s", { deadlineMs: 26_001 }],
    ["deadline 0", { deadlineMs: 0 }],
    ["501 candidates", { candidates: Array.from({ length: 501 }, (_, i) => ({ id: `c${i}`, title: "t", labelQuality: "slug" })) }],
    ["empty requestId", { requestId: "" }],
    ["requestId over 128 chars", { requestId: "r".repeat(129) }],
    ["supersedes over 128 chars", { supersedes: "r".repeat(129) }],
    ["origin over 2048 chars", { site: { origin: `https://${"a".repeat(2050)}.dev` } }],
    ["http origin", { site: { origin: "http://docs.stripe.com" } }],
    ["origin with a path", { site: { origin: "https://docs.stripe.com/billing" } }],
    ["origin with credentials", { site: { origin: "https://u:p@docs.stripe.com" } }],
    ["not a URL", { site: { origin: "docs.stripe.com" } }],
    ["candidate title over 160", { candidates: [{ id: "c1", title: "t".repeat(161), labelQuality: "slug" }] }],
    ["candidate description over 400", { candidates: [{ id: "c1", title: "t", description: "d".repeat(401), labelQuality: "slug" }] }],
    ["labelQuality over 32", { candidates: [{ id: "c1", title: "t", labelQuality: "q".repeat(33) }] }],
  ])("rejects %s", (_label, patch) => {
    expect(RankRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false);
  });

  it("accepts exactly 500 candidates", () => {
    const candidates = Array.from({ length: 500 }, (_, i) => ({ id: `c${i}`, title: "t", labelQuality: "slug" }));
    expect(RankRequestSchema.safeParse({ ...request, candidates }).success).toBe(true);
  });
});

describe("AgentOutputSchema", () => {
  it("accepts the two model shapes", () => {
    expect(AgentOutputSchema.safeParse({ status: "empty" }).success).toBe(true);
    expect(AgentOutputSchema.safeParse({ status: "ok", items: [{ id: "c1", reason: "fits", evidenceIds: ["e1", "e12"] }] }).success).toBe(true);
  });

  it.each([
    ["service-only status", { status: "error", reason: "x" }],
    ["empty with items", { status: "empty", items: [] }],
    ["ok with no items", { status: "ok", items: [] }],
    ["four items", { status: "ok", items: Array.from({ length: 4 }, () => ({ id: "c1", reason: "r", evidenceIds: ["e1"] })) }],
    ["reason over 140 chars", { status: "ok", items: [{ id: "c1", reason: "x".repeat(141), evidenceIds: ["e1"] }] }],
    ["no evidence", { status: "ok", items: [{ id: "c1", reason: "r", evidenceIds: [] }] }],
    ["path-style citation", { status: "ok", items: [{ id: "c1", reason: "r", evidenceIds: ["notes/a.md:3"] }] }],
    ["e0", { status: "ok", items: [{ id: "c1", reason: "r", evidenceIds: ["e0"] }] }],
    ["model-supplied labels", { status: "ok", items: [{ id: "c1", reason: "r", evidenceIds: ["e1"], evidence: [] }] }],
  ])("rejects %s", (_label, value) => {
    expect(AgentOutputSchema.safeParse(value).success).toBe(false);
  });
});

describe("AGENT_OUTPUT_JSON_SCHEMA", () => {
  it("is a closed top-level object with the spike's limits and the tightened evidence pattern", () => {
    const s = AGENT_OUTPUT_JSON_SCHEMA;
    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.status.enum).toEqual(["ok", "empty"]);
    expect(s.properties.items.maxItems).toBe(3);
    expect(s.properties.items.minItems).toBe(1);
    expect(s.properties.items.items.properties.id.minLength).toBe(1);
    expect(s.properties.items.items.properties.reason.minLength).toBe(1);
    expect(s.properties.items.items.additionalProperties).toBe(false);
    expect(s.properties.items.items.properties.reason.maxLength).toBe(140);
    const pattern = new RegExp(s.properties.items.items.properties.evidenceIds.items.pattern);
    expect(["e1", "e9", "e10", "e123"].every((e) => pattern.test(e))).toBe(true);
    expect(["e0", "e01", "E1", "e", "e1a", "x/e1"].some((e) => pattern.test(e))).toBe(false);
  });

  it("serializes to plain JSON and cannot be mutated", () => {
    expect(JSON.parse(JSON.stringify(AGENT_OUTPUT_JSON_SCHEMA))).toEqual(AGENT_OUTPUT_JSON_SCHEMA);
    expect(Object.isFrozen(AGENT_OUTPUT_JSON_SCHEMA.properties.items)).toBe(true);
  });
});

describe("RankResponseSchema", () => {
  it("requires the three ContextStatus fields on every variant", () => {
    const variants = [
      { status: "ok", items: [{ id: "c1", reason: "r", evidence: [{ id: "e1", kind: "note", label: "second-brain note: a.md" }] }], droppedCount: 0 },
      { status: "empty" },
      { status: "unavailable", reason: "billing route unverified" },
      { status: "error", reason: "validation_failed", droppedCount: 2 },
      { status: "cancelled", reason: "deadline" },
    ];
    for (const v of variants) {
      expect(RankResponseSchema.safeParse({ ...v, ...status }).success, JSON.stringify(v)).toBe(true);
      expect(RankResponseSchema.safeParse(v).success, JSON.stringify(v)).toBe(false);
    }
  });

  it("rejects an unknown evidence kind and an ok response without droppedCount", () => {
    const item = { id: "c1", reason: "r", evidence: [{ id: "e1", kind: "email", label: "x" }] };
    expect(RankResponseSchema.safeParse({ status: "ok", items: [item], droppedCount: 0, ...status }).success).toBe(false);
    const good = { ...item, evidence: [{ id: "e1", kind: "focus", label: "x" }] };
    expect(RankResponseSchema.safeParse({ status: "ok", items: [good], ...status }).success).toBe(false);
  });
});

describe("ContextStatusSchema and ActivityObservationSchema", () => {
  it("validates context status", () => {
    expect(ContextStatusSchema.safeParse(status).success).toBe(true);
    expect(ContextStatusSchema.safeParse({ ...status, activityRevision: -1 }).success).toBe(false);
  });

  it("accepts a viewed_page observation of any text length (the store truncates)", () => {
    const obs = { sensor: "scout", kind: "viewed_page", observedAt: "2026-09-30T12:00:00Z", url: "https://github.com/o/r/issues/1", title: "t", truncated: false };
    expect(ActivityObservationSchema.safeParse(obs).success).toBe(true);
    expect(ActivityObservationSchema.safeParse({ ...obs, text: "x".repeat(20_000) }).success).toBe(true);
    expect(ActivityObservationSchema.safeParse({ ...obs, kind: "clicked" }).success).toBe(false);
  });

  it("bounds every observation string except text", () => {
    const obs = { sensor: "scout", kind: "viewed_page", observedAt: "2026-09-30T12:00:00Z", url: "https://x.dev/", title: "t", truncated: false };
    expect(ActivityObservationSchema.safeParse({ ...obs, url: `https://x.dev/${"a".repeat(8 * 1024 - 14)}` }).success).toBe(true);
    for (const patch of [
      { url: `https://x.dev/${"a".repeat(10 * 1024 * 1024)}` }, // 10 MB
      { url: "u".repeat(8 * 1024 + 1) },
      { title: "t".repeat(1025) },
      { sensor: "s".repeat(65) },
      { observedAt: "o".repeat(65) },
    ]) {
      expect(ActivityObservationSchema.safeParse({ ...obs, ...patch }).success, Object.keys(patch)[0]).toBe(false);
    }
  });
});
