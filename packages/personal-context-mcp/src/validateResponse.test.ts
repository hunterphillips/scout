import { describe, expect, it } from "vitest";
import { RankOkSchema } from "./api.js";
import { parseAuditIndex } from "./auditIndex.js";
import { cleanReason, validateResponse } from "./validateResponse.js";

const AUDIT_TEXT = [
  { type: "lifecycle", event: "start", pid: 1 },
  { type: "call", tool: "list_sources", status: "ok", evidence: [] },
  { type: "call", tool: "read_recent_activity", status: "ok", evidence: [{ id: "e1", kind: "activity", sourceId: "activity", path: "o2" }] },
  {
    type: "call",
    tool: "search_source",
    status: "ok",
    evidence: [
      { id: "e2", kind: "note", sourceId: "notes", path: "billing-migration.md", lines: [1, 4] },
      { id: "e3", kind: "note", sourceId: "notes", path: "projects/scout.md", lines: [2, 2] },
    ],
  },
  { type: "call", tool: "get_focus", status: "ok", evidence: [{ id: "e4", kind: "focus", sourceId: "focus", path: "f1" }] },
  // A refused call's ids were never shown to the model.
  { type: "call", tool: "read_source", status: "budget_exhausted", evidence: [{ id: "e5", kind: "note", sourceId: "notes", path: "x.md" }] },
]
  .map((l) => JSON.stringify(l))
  .concat(["{broken"])
  .join("\n");

const audit = parseAuditIndex(AUDIT_TEXT);
const req = {
  candidates: ["c1", "c2", "c3", "c4", "c5"].map((id) => ({ id, title: `t ${id}`, labelQuality: "published" })),
  maxResults: 3,
};
const item = (id: string, evidenceIds: string[], reason = "fits the billing work") => ({ id, reason, evidenceIds });
const ok = (...items: unknown[]) => ({ status: "ok", items });

describe("parseAuditIndex", () => {
  it("indexes only ids from ok call lines and counts every call", () => {
    expect([...audit.evidence.keys()]).toEqual(["e1", "e2", "e3", "e4"]);
    expect(audit.toolCalls).toBe(5);
    expect(audit.sourceIds).toEqual(["activity", "focus", "notes"]);
  });
});

describe("validateResponse", () => {
  it("model empty returns empty", () => {
    expect(validateResponse({ output: { status: "empty" }, req, audit })).toEqual({ status: "empty" });
  });

  it("keeps valid items with service-written labels and droppedCount 0", () => {
    const r = validateResponse({ output: ok(item("c1", ["e1", "e2"]), item("c2", ["e4"])), req, audit });
    expect(r).toEqual({
      status: "ok",
      droppedCount: 0,
      items: [
        {
          id: "c1",
          reason: "fits the billing work",
          evidence: [
            { id: "e1", kind: "activity", label: "recent page" },
            { id: "e2", kind: "note", label: "notes: billing-migration.md" },
          ],
        },
        { id: "c2", reason: "fits the billing work", evidence: [{ id: "e4", kind: "focus", label: "focus item" }] },
      ],
    });
    expect(RankOkSchema.omit({ serviceInstanceId: true, activityRevision: true, sourceGrantRevision: true }).safeParse(r).success).toBe(true);
  });

  it("drops an unknown candidate id", () => {
    const r = validateResponse({ output: ok(item("c99", ["e2"]), item("c1", ["e2"])), req, audit });
    expect(r).toMatchObject({ status: "ok", droppedCount: 1, items: [{ id: "c1" }] });
  });

  it("drops unissued evidence ids, and the item when none survive", () => {
    const r = validateResponse({ output: ok(item("c1", ["e2", "e99", "e5"]), item("c2", ["e98"])), req, audit });
    expect(r).toMatchObject({ status: "ok", droppedCount: 1, items: [{ id: "c1", evidence: [{ id: "e2" }] }] });
  });

  it("treats a path-style citation as an unissued id", () => {
    const r = validateResponse({ output: ok(item("c1", ["billing-migration.md", "notes/billing-migration.md"])), req, audit });
    expect(r).toEqual({ status: "error", reason: "validation_failed", droppedCount: 1 });
  });

  it("keeps at most maxResults items; the fourth is dropped", () => {
    const r = validateResponse({ output: ok(item("c1", ["e2"]), item("c2", ["e2"]), item("c3", ["e3"]), item("c4", ["e3"])), req, audit });
    expect(r).toMatchObject({ status: "ok", droppedCount: 1 });
    expect(r.status === "ok" && r.items.map((i) => i.id)).toEqual(["c1", "c2", "c3"]);
    const r1 = validateResponse({ output: ok(item("c1", ["e2"]), item("c2", ["e2"])), req: { ...req, maxResults: 1 }, audit });
    expect(r1).toMatchObject({ status: "ok", droppedCount: 1, items: [{ id: "c1" }] });
  });

  it("drops a duplicated candidate id", () => {
    const r = validateResponse({ output: ok(item("c1", ["e2"]), item("c1", ["e3"]), item("c2", ["e3"])), req, audit });
    expect(r).toMatchObject({ status: "ok", droppedCount: 1 });
    expect(r.status === "ok" && r.items.map((i) => i.id)).toEqual(["c1", "c2"]);
  });

  it("strips URLs from reasons and caps them at 140 characters", () => {
    const r = validateResponse({
      output: ok(item("c1", ["e2"], "See https://evil.example/x?y=1 and www.evil.example/p or javascript:alert(1) — " + "z".repeat(300))),
      req,
      audit,
    });
    const reason = r.status === "ok" ? r.items[0]!.reason : "";
    expect(reason).not.toMatch(/https?:|www\.|javascript:|evil/);
    expect([...reason].length).toBeLessThanOrEqual(140);
    expect(reason.startsWith("See and or —")).toBe(true);
    expect(cleanReason("a\u0000b‮c\n\nd")).toBe("a b c d");
  });

  it("all picks failing validation is error: validation_failed with droppedCount, not empty", () => {
    const r = validateResponse({ output: ok(item("c99", ["e2"]), item("c1", ["e99"]), item("c2", [])), req, audit });
    expect(r).toEqual({ status: "error", reason: "validation_failed", droppedCount: 3 });
  });

  it("never reads a model-supplied label or path", () => {
    const r = validateResponse({
      output: ok({ ...item("c1", ["e2"]), label: "MODEL LABEL", path: "/etc/passwd", evidence: [{ id: "e2", label: "x" }] }),
      req,
      audit,
    });
    expect(JSON.stringify(r)).not.toMatch(/MODEL LABEL|passwd/);
    expect(r).toMatchObject({ status: "ok", items: [{ evidence: [{ id: "e2", label: "notes: billing-migration.md" }] }] });
  });

  it("uses the supplied labelFor for every surviving evidence id", () => {
    const r = validateResponse({ output: ok(item("c1", ["e1", "e2"])), req, audit, labelFor: (l) => `L:${l.kind}` });
    expect(r.status === "ok" && r.items[0]!.evidence.map((e) => e.label)).toEqual(["L:activity", "L:note"]);
  });

  it.each([
    ["not an object", "nope"],
    ["null", null],
    ["unknown status", { status: "maybe" }],
    ["empty with items", { status: "empty", items: [] }],
    ["ok without items", { status: "ok" }],
    ["ok with zero items", { status: "ok", items: [] }],
    ["ok with extra key", { status: "ok", items: [item("c1", ["e2"])], note: "x" }],
  ])("a parse failure (%s) is error: invalid_output", (_l, output) => {
    expect(validateResponse({ output, req, audit })).toEqual({ status: "error", reason: "invalid_output" });
  });

  it("drops items with a non-string reason or non-array evidence", () => {
    const r = validateResponse({ output: ok({ id: "c1", reason: 5, evidenceIds: ["e2"] }, { id: "c2", reason: "r", evidenceIds: "e2" }, item("c3", ["e2"])), req, audit });
    expect(r).toMatchObject({ status: "ok", droppedCount: 2, items: [{ id: "c3" }] });
  });
});
