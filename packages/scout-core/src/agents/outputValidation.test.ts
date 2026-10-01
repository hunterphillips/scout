import { cleanReason as legacyCleanReason } from "personal-context-mcp";
import { describe, expect, it } from "vitest";
import { cleanReason, validateJobOutput } from "./outputValidation.js";

const req = { candidates: ["c1", "c2", "c3", "c4"].map((id) => ({ id, title: id, labelQuality: "slug" as const })), maxPicks: 3 };
const pick = (id: unknown, reason: unknown = "fits the work") => ({ id, reason });

describe("validateJobOutput", () => {
  it("accepts empty and valid picks", () => {
    expect(validateJobOutput({ status: "empty" }, req)).toEqual({ status: "empty" });
    expect(validateJobOutput({ status: "ok", items: [pick("c2"), pick("c1")] }, req)).toEqual({
      status: "ok",
      items: [pick("c2"), pick("c1")],
      droppedPicks: 0,
      cutPicks: 0,
    });
  });

  it.each<[string, unknown]>([
    ["not an object", "ok"],
    ["unknown status", { status: "maybe" }],
    ["empty with items", { status: "empty", items: [] }],
    ["ok with an extra key", { status: "ok", items: [pick("c1")], note: "x" }],
    ["ok without items", { status: "ok" }],
    ["ok with zero items", { status: "ok", items: [] }],
    ["more than three items", { status: "ok", items: ["c1", "c2", "c3", "c4"].map((id) => pick(id)) }],
  ])("%s is invalid, never empty", (_l, output) => {
    expect(validateJobOutput(output, req).status).toBe("invalid");
  });

  it("all picks invalid is invalid with the dropped count, never empty", () => {
    const out = validateJobOutput({ status: "ok", items: [pick("c999"), pick("c1", ""), pick("https://evil.example")] }, req);
    expect(out).toEqual({ status: "invalid", droppedPicks: 3 });
  });

  it("keeps the valid picks and counts the dropped ones", () => {
    const out = validateJobOutput(
      {
        status: "ok",
        items: [pick("c999"), pick("c1"), pick("c1", "again")],
      },
      req,
    );
    expect(out).toEqual({ status: "ok", items: [pick("c1")], droppedPicks: 2, cutPicks: 0 });
  });

  it.each<[string, unknown]>([
    ["unknown id", pick("c9")],
    ["id not matching the pattern", pick("C1")],
    ["non-string id", pick(1)],
    ["missing reason", { id: "c1" }],
    ["extra key on an item", { ...pick("c1"), url: "https://x.example" }],
    ["reason over 140 code points", pick("c1", "x".repeat(141))],
    ["reason that is only a URL", pick("c1", "https://evil.example/x")],
  ])("drops an item with %s", (_l, item) => {
    expect(validateJobOutput({ status: "ok", items: [item, pick("c2")] }, req)).toMatchObject({ status: "ok", items: [pick("c2")], droppedPicks: 1 });
  });

  it("cuts valid picks past maxPicks without counting them as dropped", () => {
    const out = validateJobOutput({ status: "ok", items: [pick("c1"), pick("c2"), pick("c3")] }, { ...req, maxPicks: 1 });
    expect(out).toEqual({ status: "ok", items: [pick("c1")], droppedPicks: 0, cutPicks: 2 });
  });

  it("strips URL-like text from kept reasons", () => {
    const out = validateJobOutput({ status: "ok", items: [pick("c1", "See https://evil.example/x?a=1 and www.evil.example now")] }, req);
    expect(out).toMatchObject({ status: "ok", items: [{ id: "c1", reason: "See and now" }] });
  });
});

describe("cleanReason parity with the legacy validator", () => {
  it.each([
    "Fits the open billing work",
    "See https://evil.example/x?a=1 and www.evil.example now",
    "javascript:alert(1) data:text/html,x mailto:a@b.example file:///etc/passwd",
    "config file: README.md e.g. v1.2 foo/bar evil.com docs.example.org/path",
    "tabs\tand\nnewlines​ and ‮ bidi",
    "a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a.",
    "Café naïve ✓ 日本 fits",
    "x".repeat(150),
  ])("%j", (reason) => {
    expect(cleanReason(reason)).toBe(legacyCleanReason(reason));
  });
});
