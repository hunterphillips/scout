import { describe, expect, it } from "vitest";
import { DISCOVERY_SCHEMA_PREFIX, parseSkillsIndex } from "./skillsIndex.js";

const ORIGIN = "https://s.example";
const INDEX_URL = `${ORIGIN}/.well-known/agent-skills/index.json`;
const DIGEST = `sha256:${"a".repeat(64)}`;

const index = (skills: unknown[], extra: object = {}) => JSON.stringify({ $schema: `${DISCOVERY_SCHEMA_PREFIX}v1.json`, skills, ...extra });
const skill = (over: object = {}) => ({ name: "checkout", type: "skill-md", description: "Pay", url: "checkout/SKILL.md", digest: DIGEST, ...over });

describe("parseSkillsIndex", () => {
  it("rejects bodies that are not a discovery index", () => {
    expect(parseSkillsIndex("{", INDEX_URL, ORIGIN)).toEqual({ ok: false, reason: "not_json" });
    expect(parseSkillsIndex("[]", INDEX_URL, ORIGIN)).toEqual({ ok: false, reason: "not_object" });
    expect(parseSkillsIndex(JSON.stringify({ $schema: "https://other.example/x", skills: [] }), INDEX_URL, ORIGIN)).toEqual({ ok: false, reason: "schema" });
    expect(parseSkillsIndex(JSON.stringify({ $schema: `${DISCOVERY_SCHEMA_PREFIX}v1.json` }), INDEX_URL, ORIGIN)).toEqual({ ok: false, reason: "no_skills_array" });
  });

  it("resolves a same-origin skill-md entry against the index URL as fetchable", () => {
    const parsed = parseSkillsIndex(index([skill()]), INDEX_URL, ORIGIN);
    expect(parsed).toEqual({
      ok: true,
      overCap: 0,
      entries: [
        { position: 0, name: "checkout", description: "Pay", url: `${ORIGIN}/.well-known/agent-skills/checkout/SKILL.md`, disposition: "fetch", sha256: "a".repeat(64) },
      ],
    });
  });

  it("classifies archives, other file types, missing digests, and bad entries as unsupported", () => {
    const parsed = parseSkillsIndex(
      index([
        skill({ name: "a1", type: "archive", url: "a1.zip" }),
        skill({ name: "a2", url: "a2.tar.gz" }),
        skill({ name: "a3", url: "a3.skill" }),
        skill({ name: "f1", url: "f1.sh" }),
        skill({ name: "n1", digest: undefined, url: "n1.md" }),
        skill({ name: "Bad_Name", url: "b.md" }),
        skill({ name: "d1", digest: "md5:abc", url: "d1.md" }),
        skill({ name: "h1", url: "http://s.example/h1.md" }),
        skill({ name: "c1", url: "https://user:pw@s.example/c1.md" }),
        "not an object",
      ]),
      INDEX_URL,
      ORIGIN,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries.map((e) => (e.disposition === "unsupported" ? e.reason : e.disposition))).toEqual([
      "archive",
      "archive",
      "archive",
      "file_type",
      "no_digest",
      "invalid_entry",
      "invalid_entry",
      "invalid_entry",
      "invalid_entry",
      "invalid_entry",
    ]);
  });

  it("marks cross-origin skills as external references", () => {
    const parsed = parseSkillsIndex(index([skill({ url: "https://cdn.other.example/skills/checkout.md", digest: undefined })]), INDEX_URL, ORIGIN);
    expect(parsed.ok && parsed.entries[0]).toMatchObject({ disposition: "external_reference", publisherOrigin: "https://cdn.other.example" });
  });

  it("keeps the first of duplicate names or URLs and counts entries past the cap", () => {
    const many = Array.from({ length: 23 }, (_, i) => skill({ name: `s${i}`, url: `s${i}.md` }));
    many[1] = skill({ name: "s0", url: "other.md" });
    many[2] = skill({ name: "s2", url: "s0.md" });
    const parsed = parseSkillsIndex(index(many), INDEX_URL, ORIGIN);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toHaveLength(20);
    expect(parsed.overCap).toBe(3);
    expect(parsed.entries.slice(0, 3).map((e) => (e.disposition === "unsupported" ? e.reason : e.disposition))).toEqual(["fetch", "duplicate", "duplicate"]);
  });

  it("ignores index fields it does not define, such as advertised MCP servers", () => {
    const parsed = parseSkillsIndex(index([skill()], { mcpServers: [{ url: "https://s.example/mcp" }] }), INDEX_URL, ORIGIN);
    expect(parsed.ok && parsed.entries.map((e) => e.url)).toEqual([`${ORIGIN}/.well-known/agent-skills/checkout/SKILL.md`]);
  });

  it("treats non-string fields and an oversized description as invalid entries without echoing them", () => {
    const huge = "d".repeat(64 * 1024);
    const parsed = parseSkillsIndex(
      index([skill({ name: 1 }), skill({ name: "a", url: {} }), skill({ name: "b", type: 7 }), skill({ name: "c", description: huge }), skill({ name: "d", digest: 5 })]),
      INDEX_URL,
      ORIGIN,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries.map((e) => (e.disposition === "unsupported" ? e.reason : e.disposition))).toEqual(["invalid_entry", "invalid_entry", "invalid_entry", "invalid_entry", "invalid_entry"]);
    expect(parsed.entries[0]?.name).toBeUndefined();
    expect(parsed.entries[1]?.url).toBeUndefined();
    expect(parsed.entries[3]?.description).toBeUndefined();
  });
});
