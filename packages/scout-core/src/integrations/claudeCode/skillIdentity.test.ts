import { describe, expect, it } from "vitest";
import { deriveResourceId } from "@scout/contracts";
import { createHash } from "node:crypto";
import { assignWrapperNames, isScoutOwnedName, isValidSkillName, OWNERSHIP_HASH_TAG, ownershipHash, SKILL_NAME_MAX, wrapperName, WrapperIdentityError } from "./skillIdentity.js";

const id = (hex: string) => `res_${hex.padEnd(64, "0")}`;

describe("wrapperName", () => {
  it("is a valid skill name, stable per resource, and names the kind", async () => {
    const rid = await deriveResourceId("skill", "https://docs.example.com/skills/billing.md");
    const name = wrapperName("skill", rid);
    expect(name).toBe(`scout-skill-${rid.slice(4, 20)}`);
    expect(isValidSkillName(name)).toBe(true);
    expect(wrapperName("skill", rid)).toBe(name);
    expect(wrapperName("llms_txt", rid)).toMatch(/^scout-llms-/);
    expect(wrapperName("agents_md", rid)).toMatch(/^scout-agents-/);
  });

  it("differs for different resources", async () => {
    const a = await deriveResourceId("skill", "https://docs.example.com/a.md");
    const b = await deriveResourceId("skill", "https://docs.example.com/b.md");
    expect(wrapperName("skill", a)).not.toBe(wrapperName("skill", b));
  });

  it.each([
    ["path traversal", "res_../../etc"],
    ["uppercase hex", `res_${"A".repeat(64)}`],
    ["short", "res_abc"],
    ["no prefix", "f".repeat(64)],
    ["slash", `res_${"0".repeat(63)}/`],
  ])("refuses a malformed resource id (%s)", (_label, bad) => {
    expect(() => wrapperName("skill", bad)).toThrow(WrapperIdentityError);
  });

  it("refuses an unknown kind", () => {
    expect(() => wrapperName("hooks" as never, id("ab"))).toThrow(WrapperIdentityError);
    expect(() => wrapperName("__proto__" as never, id("ab"))).toThrow(WrapperIdentityError);
  });
});

describe("isValidSkillName", () => {
  it.each(["scout-skill-0123456789abcdef", "a", "scout-proof-1a2b3c4d5e"])("accepts %s", (n) => expect(isValidSkillName(n)).toBe(true));
  it.each([
    "",
    "Scout",
    "-scout",
    "scout-",
    "scout--x",
    "../x",
    "a/b",
    "a b",
    "a(b)",
    "a,b",
    "a\u0000b",
    "x".repeat(SKILL_NAME_MAX + 1),
  ])("refuses %j", (n) => expect(isValidSkillName(n)).toBe(false));
});

describe("assignWrapperNames", () => {
  it("names each resource once and accepts the same resource again", () => {
    const names = assignWrapperNames([
      { kind: "skill", resourceId: id("11") },
      { kind: "skill", resourceId: id("22") },
      { kind: "skill", resourceId: id("11") },
    ]);
    expect([...names.values()].sort()).toEqual([id("11"), id("22")]);
  });

  it("refuses two resources that share the 64-bit name prefix", () => {
    const a = `res_${"ab".repeat(8)}${"0".repeat(48)}`;
    const b = `res_${"ab".repeat(8)}${"f".repeat(48)}`;
    expect(() => assignWrapperNames([{ kind: "skill", resourceId: a }, { kind: "skill", resourceId: b }])).toThrow(WrapperIdentityError);
  });

  it("refuses a name the manifest already gives another resource", () => {
    const a = id("33");
    const owned = new Map([[wrapperName("skill", a), id("44")]]);
    expect(() => assignWrapperNames([{ kind: "skill", resourceId: a }], owned)).toThrow(WrapperIdentityError);
  });
});

describe("isScoutOwnedName", () => {
  it("is exact manifest membership, never a prefix match", () => {
    const manifest = ["scout-skill-0123456789abcdef"];
    expect(isScoutOwnedName("scout-skill-0123456789abcdef", manifest)).toBe(true);
    expect(isScoutOwnedName("scout-skill-0123456789abcdee", manifest)).toBe(false);
    expect(isScoutOwnedName("scout-skill", manifest)).toBe(false);
    expect(isScoutOwnedName("scout-skill-0123456789abcdef", new Set<string>())).toBe(false);
  });
});

describe("ownershipHash", () => {
  it("changes with any content, path or added file, and ignores insertion order", () => {
    const base = ownershipHash({ "SKILL.md": "abc" });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(ownershipHash({ "SKILL.md": "abc" })).toBe(base);
    expect(ownershipHash({ "SKILL.md": "abd" })).not.toBe(base);
    expect(ownershipHash({ "skill.md": "abc" })).not.toBe(base);
    expect(ownershipHash({ "SKILL.md": "abc", "x.md": "" })).not.toBe(base);
    expect(ownershipHash({ a: "1", b: "2" })).toBe(ownershipHash({ b: "2", a: "1" }));
    // Length prefixes: moving bytes between path and content changes the hash.
    expect(ownershipHash({ ab: "c" })).not.toBe(ownershipHash({ a: "bc" }));
  });

  it("starts with the domain tag (layout pinned)", () => {
    expect(OWNERSHIP_HASH_TAG).toBe("scout-own-v1\0");
    const want = createHash("sha256").update("scout-own-v1\0").update("8:SKILL.md3:abc").digest("hex");
    expect(ownershipHash({ "SKILL.md": "abc" })).toBe(want);
    const untagged = createHash("sha256").update("8:SKILL.md3:abc").digest("hex");
    expect(ownershipHash({ "SKILL.md": "abc" })).not.toBe(untagged);
  });
});
