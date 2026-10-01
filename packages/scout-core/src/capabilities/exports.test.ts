import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiscoveryResult, ProbeItem } from "./discovery.js";
import { createSkillExporter, ExportError, resolveSkillsRoot, type SkillExporter } from "./exports.js";
import { wrapperName } from "./identity.js";
import { type CapabilityStore, createCapabilityStore } from "./store.js";
import { parseWrapperFrontmatter } from "./wrapper.js";

const ORIGIN = "https://s.example";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function skillDiscovery(skills: { name: string; text: string; description?: string }[]): DiscoveryResult {
  const items: ProbeItem[] = skills.map((s) => {
    const sourceUrl = `${ORIGIN}/skills/${s.name}/SKILL.md`;
    return {
      kind: "skill",
      sourceUrl,
      status: "found",
      source: "network",
      resource: {
        kind: "skill",
        siteOrigin: ORIGIN,
        publisherOrigin: ORIGIN,
        sourceUrl,
        finalUrl: sourceUrl,
        text: s.text,
        sha256: sha(s.text),
        byteLength: Buffer.byteLength(s.text),
        fetchedAt: 1,
        skill: { name: s.name, sha256: sha(s.text), ...(s.description ? { description: s.description } : {}) },
      },
    };
  });
  return { origin: ORIGIN, checkedAt: 1, robots: "not_fetched", items, externalReferences: [], skillsOverCap: 0, acceptedBytes: 0, stats: { requests: 0, refused: 0, ms: 0 } };
}

let root: string;
let scoutHome: string;
let skillsRoot: string;
let outside: string;
const clock = { now: () => 1_800_000_000_000 };

beforeEach(() => {
  // realpath: macOS tmpdir sits behind the /var -> /private/var symlink, and the exporter refuses symlinked roots.
  root = realpathSync(mkdtempSync(join(tmpdir(), "scout-exports-")));
  scoutHome = join(root, "scout-home");
  skillsRoot = join(root, "claude", "skills");
  outside = join(root, "outside");
  mkdirSync(skillsRoot, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "user file");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function setup(): Promise<{ store: CapabilityStore; exporter: SkillExporter }> {
  let exporter!: SkillExporter;
  const store = await createCapabilityStore({ scoutHome, clock, syncExports: () => exporter.sync(store.snapshot()) });
  exporter = createSkillExporter({ scoutHome, skillsRoot });
  return { store, exporter };
}

async function approvedSkill(store: CapabilityStore, name = "pay", text = `---\nname: ${name}\ndescription: d\n---\n# ${name}\n`, description?: string) {
  const report = await store.ingest(skillDiscovery([{ name, text, ...(description ? { description } : {}) }]), { chromePermitted: false });
  const { resourceId, version } = report.results[0]!;
  await store.approve({ resourceId, version, expectedRevision: store.getResource(resourceId)!.revision });
  return { id: resourceId, version, name: wrapperName("skill", resourceId) };
}

/** Every path under the temp root, relative. */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    out.push(relative(root, p));
    if (lstatSync(p).isDirectory()) walk(p, out);
  }
  return out;
}

describe("skill export", () => {
  it("writes one managed wrapper per approved skill, privately, with only name and description", async () => {
    const { store, exporter } = await setup();
    const s = await approvedSkill(store, "pay", undefined, "Pays things");
    // A non-skill resource never gets a wrapper.
    const report = await exporter.sync(store.snapshot());
    expect(report).toMatchObject({ written: 1, removed: 0, conflicts: [] });

    const dir = join(skillsRoot, s.name);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "SKILL.md")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["SKILL.md"]);
    const text = readFileSync(join(dir, "SKILL.md"), "utf8");
    expect(Object.keys(parseWrapperFrontmatter(text))).toEqual(["name", "description"]);
    expect(text).toContain(s.version);
    expect(text).not.toContain("# pay");

    const manifest = exporter.manifest();
    expect(manifest.entries).toEqual([expect.objectContaining({ name: s.name, resourceId: s.id, version: s.version, files: ["SKILL.md"] })]);
    expect(statSync(join(scoutHome, "capabilities", "exports.json")).mode & 0o777).toBe(0o600);

    expect((await exporter.sync(store.snapshot())).unchanged).toBe(1);
  });

  it("replaces the wrapper for a newer approved version and removes it on revocation", async () => {
    const { store, exporter } = await setup();
    const s = await approvedSkill(store, "pay", "v1");
    await exporter.sync(store.snapshot());
    const s2 = await approvedSkill(store, "pay", "v2");
    expect((await exporter.sync(store.snapshot())).written).toBe(1);
    expect(readFileSync(join(skillsRoot, s.name, "SKILL.md"), "utf8")).toContain(s2.version);

    const result = await store.revoke(s.id);
    expect(await result.cleanup).toEqual({ ok: true });
    expect(existsSync(join(skillsRoot, s.name))).toBe(false);
    expect(exporter.manifest().entries).toEqual([]);
  });

  it("reports a foreign directory with the managed name as a conflict and never touches it", async () => {
    const { store, exporter } = await setup();
    const report0 = await store.ingest(skillDiscovery([{ name: "pay", text: "v1" }]), { chromePermitted: false });
    const name = wrapperName("skill", report0.results[0]!.resourceId);
    mkdirSync(join(skillsRoot, name));
    writeFileSync(join(skillsRoot, name, "SKILL.md"), "the user's own skill");
    const { resourceId, version } = report0.results[0]!;
    await store.approve({ resourceId, version, expectedRevision: store.getResource(resourceId)!.revision });

    const report = await exporter.sync(store.snapshot());
    expect(report.conflicts).toEqual([{ name, resourceId, code: "foreign_collision" }]);
    expect(readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8")).toBe("the user's own skill");
    expect(exporter.manifest().entries).toEqual([]);

    await store.revoke(resourceId).then((r) => r.cleanup);
    expect(readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8")).toBe("the user's own skill");
  });

  it("leaves a modified owned wrapper in place on update and on revocation, while reads stay revoked", async () => {
    const { store, exporter } = await setup();
    const s = await approvedSkill(store, "pay", "v1");
    await exporter.sync(store.snapshot());
    const file = join(skillsRoot, s.name, "SKILL.md");
    writeFileSync(file, "edited by the user");

    await approvedSkill(store, "pay", "v2");
    const update = await exporter.sync(store.snapshot());
    expect(update.conflicts.map((c) => c.code)).toEqual(["left_modified"]);
    expect(readFileSync(file, "utf8")).toBe("edited by the user");

    const result = await store.revoke(s.id);
    await result.cleanup;
    expect(readFileSync(file, "utf8")).toBe("edited by the user");
    expect(exporter.manifest().conflicts.map((c) => c.code)).toEqual(["left_modified"]);
    expect(store.resolveRead(s.id)).toEqual({ ok: false, code: "revoked" });
  });

  it("sweeps an atomic-write leftover from an owned wrapper but still reports a foreign file as a conflict", async () => {
    const { store, exporter } = await setup();
    const s = await approvedSkill(store, "pay", "v1");
    await exporter.sync(store.snapshot());
    const dir = join(skillsRoot, s.name);
    writeFileSync(join(dir, ".scout-tmp-SKILL.md.0123456789ab"), "half-written", { mode: 0o600 });
    expect(await exporter.sync(store.snapshot())).toMatchObject({ unchanged: 1, conflicts: [] });
    expect(readdirSync(dir)).toEqual(["SKILL.md"]);

    writeFileSync(join(dir, "notes.md"), "the user's file");
    expect((await exporter.sync(store.snapshot())).conflicts.map((c) => c.code)).toEqual(["left_modified"]);
    expect(readdirSync(dir).sort()).toEqual(["SKILL.md", "notes.md"]);
  });

  it("removes a wrapper on the next writable open after another process revoked its resource", async () => {
    const { store, exporter } = await setup();
    const s = await approvedSkill(store, "pay", "v1");
    await exporter.sync(store.snapshot());
    await store.close();

    // The dev CLI path: a store with no exporter commits the revocation.
    const cli = await createCapabilityStore({ scoutHome, clock });
    await cli.revoke(s.id);
    await cli.close();
    expect(existsSync(join(skillsRoot, s.name))).toBe(true);

    const next = await setup();
    expect(await next.store.startupExportSync).toEqual({ ok: true });
    expect(existsSync(join(skillsRoot, s.name))).toBe(false);
    expect(next.exporter.manifest().entries).toEqual([]);
    await next.store.close();
  });

  it("refuses to follow a wrapper directory swapped for a symlink", async () => {
    const { store, exporter } = await setup();
    const s = await approvedSkill(store, "pay", "v1");
    await exporter.sync(store.snapshot());
    const dir = join(skillsRoot, s.name);
    const owned = readFileSync(join(dir, "SKILL.md"), "utf8");
    rmSync(dir, { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), owned);
    symlinkSync(outside, dir);

    await store.revoke(s.id).then((r) => r.cleanup);
    expect(exporter.manifest().conflicts.map((c) => c.code)).toEqual(["left_symlink"]);
    expect(readdirSync(outside).sort()).toEqual(["SKILL.md", "keep.txt"]);
  });

  it("refuses a wrapper file that is a symlink", async () => {
    const { store, exporter } = await setup();
    const s = await approvedSkill(store, "pay", "v1");
    await exporter.sync(store.snapshot());
    const file = join(skillsRoot, s.name, "SKILL.md");
    rmSync(file);
    symlinkSync(join(outside, "keep.txt"), file);
    await store.revoke(s.id).then((r) => r.cleanup);
    expect(exporter.manifest().conflicts.map((c) => c.code)).toEqual(["left_symlink"]);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("user file");
  });

  it("accepts only an existing, real skills root", () => {
    const link = join(root, "link-skills");
    symlinkSync(skillsRoot, link);
    for (const bad of [link, join(root, "missing"), "relative/skills", join(outside, "keep.txt")]) {
      expect(() => createSkillExporter({ scoutHome, skillsRoot: bad })).toThrow(ExportError);
    }
    expect(resolveSkillsRoot({ CLAUDE_CONFIG_DIR: "/c" })).toBe("/c/skills");
    expect(resolveSkillsRoot({ HOME: "/h" })).toBe("/h/.claude/skills");
  });

  it("treats a corrupt or foreign-root manifest as an explicit error and writes nothing", async () => {
    const { store, exporter } = await setup();
    await approvedSkill(store);
    mkdirSync(join(scoutHome, "capabilities"), { recursive: true });
    const manifest = join(scoutHome, "capabilities", "exports.json");
    writeFileSync(manifest, "{not json", { mode: 0o600 });
    await expect(exporter.sync(store.snapshot())).rejects.toMatchObject({ code: "manifest_parse" });
    writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, skillsRoot: "/elsewhere", entries: [], conflicts: [] }), { mode: 0o600 });
    await expect(exporter.sync(store.snapshot())).rejects.toMatchObject({ code: "root_mismatch" });
    writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, skillsRoot, entries: [{ name: "../escape", resourceId: `res_${"a".repeat(64)}`, version: "a".repeat(64), files: ["SKILL.md"], ownershipHash: "a".repeat(64) }], conflicts: [] }), { mode: 0o600 });
    await expect(exporter.sync(store.snapshot())).rejects.toMatchObject({ code: "manifest_schema" });
    expect(readdirSync(skillsRoot)).toEqual([]);
  });

  it("writes nowhere but Scout's capabilities directory and the skills root", async () => {
    const before = new Set(walk(root));
    const { store, exporter } = await setup();
    const a = await approvedSkill(store, "pay", "v1");
    await approvedSkill(store, "ship", "s1");
    await store.ingest(skillDiscovery([{ name: "pay", text: "v2" }]), { chromePermitted: false });
    await exporter.sync(store.snapshot());
    await store.revoke(a.id).then((r) => r.cleanup);
    await store.collectGarbage();

    const added = walk(root).filter((p) => !before.has(p));
    const allowed = (p: string) =>
      p === "scout-home" || p.startsWith(join("scout-home", "capabilities")) || p.startsWith(join("claude", "skills", "scout-skill-"));
    expect(added.filter((p) => !allowed(p))).toEqual([]);
    expect(readdirSync(skillsRoot)).toHaveLength(1);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("user file");
  });

  it("syncs exports after a user approval and after an auto-approving ingest; a failed sync keeps the approval", async () => {
    let exporter!: SkillExporter;
    let failNext = false;
    const store = await createCapabilityStore({
      scoutHome,
      clock,
      syncExports: async () => {
        if (failNext) throw new Error("sync failed");
        return exporter.sync(store.snapshot());
      },
    });
    exporter = createSkillExporter({ scoutHome, skillsRoot });

    const report = await store.ingest(skillDiscovery([{ name: "pay", text: "v1" }]), { chromePermitted: false });
    const { resourceId, version } = report.results[0]!;
    const approved = await store.approve({ resourceId, version, expectedRevision: store.getResource(resourceId)!.revision });
    expect(await approved.cleanup).toEqual({ ok: true });
    expect(existsSync(join(skillsRoot, wrapperName("skill", resourceId), "SKILL.md"))).toBe(true);

    await store.setOriginPolicy({ origin: ORIGIN, autoAcquire: true, acknowledgeRisk: true });
    const auto = await store.ingest(skillDiscovery([{ name: "ship", text: "s1" }]), { chromePermitted: true });
    expect(auto.results[0]!.outcome).toBe("auto_approved");
    expect(await auto.cleanup).toEqual({ ok: true });
    expect(existsSync(join(skillsRoot, wrapperName("skill", auto.results[0]!.resourceId), "SKILL.md"))).toBe(true);

    failNext = true;
    const again = await store.ingest(skillDiscovery([{ name: "ship", text: "s2" }]), { chromePermitted: true });
    expect(await again.cleanup).toEqual({ ok: false });
    expect(store.getApprovedDefault(again.results[0]!.resourceId)?.hash).toBe(again.results[0]!.version);
    await store.close();
  });
});

