// `cli.js capabilities unexport-all`: the one-shot uninstall runs before it drops the recorded
// skills root (P4.3).
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import type { Diagnostics } from "../diagnostics.js";
import type { DiscoveryResult, ProbeItem } from "./discovery.js";
import { createSkillExporter } from "./exports.js";
import { wrapperName } from "./identity.js";
import { type CapabilityStore, createCapabilityStore } from "./store.js";

const ORIGIN = "https://s.example";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const clock = { now: () => 1_800_000_000_000 };
const diagnostics: Diagnostics = { failures: 0, event: () => {} };

function discovery(name: string, text: string): DiscoveryResult {
  const sourceUrl = `${ORIGIN}/skills/${name}/SKILL.md`;
  const item: ProbeItem = {
    kind: "skill",
    sourceUrl,
    status: "found",
    source: "network",
    resource: { kind: "skill", siteOrigin: ORIGIN, publisherOrigin: ORIGIN, sourceUrl, finalUrl: sourceUrl, text, sha256: sha(text), byteLength: Buffer.byteLength(text), fetchedAt: 1, skill: { name, sha256: sha(text) } },
  };
  return { origin: ORIGIN, checkedAt: 1, robots: "not_fetched", items: [item], externalReferences: [], skillsOverCap: 0, acceptedBytes: 0, stats: { requests: 0, refused: 0, ms: 0 } };
}

let root: string;
let home: string;
let skillsRoot: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "scout-unexport-")));
  home = join(root, "scout-home");
  skillsRoot = join(root, "claude", "skills");
  mkdirSync(skillsRoot, { recursive: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "installed.json"), JSON.stringify({ version: 1, marker: "m", skillsRoot, files: [] }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Two approved skills exported as the core would, then the store closed (lock released). */
async function exported(): Promise<string[]> {
  const exporter = createSkillExporter({ scoutHome: home, skillsRoot });
  const store: CapabilityStore = await createCapabilityStore({ scoutHome: home, clock, syncExports: (state) => exporter.sync(state) });
  const names: string[] = [];
  for (const name of ["pay", "refund"]) {
    const report = await store.ingest(discovery(name, `---\nname: ${name}\ndescription: d\n---\n# ${name}\n`), { chromePermitted: false });
    const { resourceId, version } = report.results[0]!;
    await store.approve({ resourceId, version, expectedRevision: store.getResource(resourceId)!.revision });
    names.push(wrapperName("skill", resourceId));
  }
  await exporter.sync(store.snapshot());
  await store.close();
  for (const n of names) expect(existsSync(join(skillsRoot, n, "SKILL.md"))).toBe(true);
  return names;
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli(["capabilities", "unexport-all", "--home", home, ...args], {
    stdout: (t) => void (out += t),
    stderr: (t) => void (err += t),
    env: { HOME: root },
    deps: { clock, diagnostics },
  });
  return { code, out, err };
}

const manifestNames = () => (JSON.parse(readFileSync(join(home, "capabilities", "exports.json"), "utf8")) as { entries: { name: string }[] }).entries.map((e) => e.name);

describe("capabilities unexport-all", () => {
  it("removes every wrapper that is exactly what Scout wrote and empties exports.json; a foreign scout-* dir is untouched", async () => {
    const names = await exported();
    const foreign = join(skillsRoot, "scout-skill-0123456789abcdef");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "SKILL.md"), "mine");
    const r = await run(["--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ removed: names, kept: [] });
    for (const n of names) expect(existsSync(join(skillsRoot, n))).toBe(false);
    expect(manifestNames()).toEqual([]);
    expect(readFileSync(join(foreign, "SKILL.md"), "utf8")).toBe("mine");
    expect(existsSync(join(home, "capabilities", "store.lock"))).toBe(false);
  });

  it("keeps and lists a modified wrapper (exit 3), which stays in exports.json", async () => {
    const [changed, exact] = await exported();
    appendFileSync(join(skillsRoot, changed!, "SKILL.md"), "\nmy edit\n");
    const r = await run([]);
    expect(r.code).toBe(3);
    expect(r.out).toContain(`removed ${exact}`);
    expect(r.out).toContain(`kept ${changed} (left_modified)`);
    expect(readFileSync(join(skillsRoot, changed!, "SKILL.md"), "utf8")).toContain("my edit");
    expect(existsSync(join(skillsRoot, exact!))).toBe(false);
    expect(manifestNames()).toEqual([changed]);
  });

  it("refuses with exit 2 while the core holds the store lock, and removes nothing", async () => {
    const names = await exported();
    const core = await createCapabilityStore({ scoutHome: home, clock });
    try {
      const r = await run([]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("quit Scout first");
      for (const n of names) expect(existsSync(join(skillsRoot, n))).toBe(true);
    } finally {
      await core.close();
    }
  });

  it("does nothing without an exports manifest", async () => {
    const r = await run(["--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ removed: [], kept: [] });
    expect(existsSync(join(home, "capabilities"))).toBe(false);
  });

  it("refuses (exit 1, nothing removed) when installed.json records no skills root", async () => {
    const names = await exported();
    writeFileSync(join(home, "installed.json"), JSON.stringify({ version: 1, marker: "m", files: [] }));
    const r = await run([]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no skillsRoot");
    for (const n of names) expect(existsSync(join(skillsRoot, n))).toBe(true);
  });

  it("refuses a relative --home and unknown flags", async () => {
    let err = "";
    const io = { stdout: () => {}, stderr: (t: string) => void (err += t), deps: { diagnostics } };
    expect(await runCli(["capabilities", "unexport-all", "--home", "rel/dir"], io)).toBe(1);
    expect(await runCli(["capability", "unexport-all", "--rev", "1"], io)).toBe(1);
    expect(await runCli(["capability", "list", "--home", home], io)).toBe(1);
    expect(err).toContain("unexport-all");
  });
});
