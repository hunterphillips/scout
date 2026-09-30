import { renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { link, makeFixture, SENTINEL, write, type Fixture } from "../test-support/sourceFixture.js";
import {
  nodeFs,
  normalizeRelPath,
  parseQuery,
  readTreeFile,
  rootAvailability,
  searchTree,
  SEARCH_LIMITS,
  walkFiles,
  type FsOps,
  type TreeOptions,
} from "./markdownDir.js";

const fixtures: Fixture[] = [];
function fx(): Fixture {
  const f = makeFixture();
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

const tree = (f: Fixture, extra: Partial<TreeOptions> = {}): TreeOptions => ({ root: f.notes, exclusion: { home: f.home }, ...extra });

describe("walk", () => {
  it("lists text files only, sorted, skipping always-excluded names", () => {
    const f = fx();
    expect(walkFiles(tree(f)).files.map((x) => x.rel)).toEqual(["billing-migration.md", "projects/scout.md", "todo.txt"]);
  });

  it("never enters a symlinked directory, even one inside the root", () => {
    const f = fx();
    link(f.outside, join(f.notes, "outside-link"));
    link(join(f.notes, "projects"), join(f.notes, "projects-link"));
    const rels = walkFiles(tree(f)).files.map((x) => x.rel);
    expect(rels.some((r) => r.startsWith("outside-link/") || r.startsWith("projects-link/"))).toBe(false);
  });

  it("keeps a symlinked file inside the root and drops one pointing outside", () => {
    const f = fx();
    link(join(f.notes, "billing-migration.md"), join(f.notes, "alias.md"));
    link(join(f.outside, "plain.md"), join(f.notes, "escape.md"));
    link(join(f.home, ".ssh", "id_rsa"), join(f.notes, "key.md"));
    const rels = walkFiles(tree(f)).files.map((x) => x.rel);
    expect(rels).toContain("alias.md");
    expect(rels).not.toContain("escape.md");
    expect(rels).not.toContain("key.md");
  });

  it("drops second-brain inbox/ and log/ under a second-brain-shaped root", () => {
    const f = fx();
    const brain = join(f.base, "elsewhere", "second-brain");
    write(join(brain, "inbox", "billing.md"), `billing ${SENTINEL}`);
    write(join(brain, "log", "billing.md"), `billing ${SENTINEL}`);
    write(join(brain, "notes", "billing.md"), "billing ok");
    const rels = walkFiles({ root: brain, exclusion: { home: f.home } }).files.map((x) => x.rel);
    expect(rels).toEqual(["notes/billing.md"]);
    const hits = searchTree({ root: brain, exclusion: { home: f.home } }, ["billing"], 10).hits;
    expect(JSON.stringify(hits)).not.toContain(SENTINEL);
    expect(readTreeFile({ root: brain, exclusion: { home: f.home } }, "inbox/billing.md")).toEqual({ ok: false, code: "denied" });
  });

  it("honors user excludes by segment name and by relative path", () => {
    const f = fx();
    expect(walkFiles(tree(f, { exclude: ["projects"] })).files.map((x) => x.rel)).toEqual(["billing-migration.md", "todo.txt"]);
    expect(walkFiles(tree(f, { exclude: ["Projects/Scout.md"] })).files.map((x) => x.rel)).toEqual(["billing-migration.md", "todo.txt"]);
    expect(readTreeFile(tree(f, { exclude: ["projects"] }), "projects/scout.md")).toEqual({ ok: false, code: "denied" });
  });

  it("stops at the file cap and marks the walk truncated", () => {
    const f = fx();
    const r = walkFiles(tree(f), 2);
    expect(r.files).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it("reports an unusable root", () => {
    const f = fx();
    expect(rootAvailability(tree(f)).ok).toBe(true);
    expect(rootAvailability({ root: join(f.base, "missing"), exclusion: { home: f.home } })).toEqual({ ok: false, code: "unresolvable" });
    expect(rootAvailability({ root: f.home, exclusion: { home: f.home } })).toEqual({ ok: false, code: "too-broad" });
  });
});

describe("search", () => {
  it("matches every term case-insensitively within a three-line window, in path then line order", () => {
    const f = fx();
    const r = searchTree(tree(f), parseQuery("BILLING invoices")!, 10);
    expect(r.hits).toEqual([
      { path: "billing-migration.md", lines: [3, 3], snippet: "We move invoices to usage-based billing." },
      { path: "projects/scout.md", lines: [2, 3], snippet: "It reads the billing notes when invoices matter." },
    ]);
    expect(r.truncated).toBe(false);
  });

  it("does not match terms more than three lines apart", () => {
    const f = fx();
    write(join(f.notes, "far.md"), ["alpha", "x", "y", "beta"].join("\n"));
    expect(searchTree(tree(f), ["alpha", "beta"], 10).hits).toEqual([]);
    write(join(f.notes, "near.md"), ["alpha", "x", "beta"].join("\n"));
    expect(searchTree(tree(f), ["alpha", "beta"], 10).hits.map((h) => h.path)).toEqual(["near.md"]);
  });

  it("caps snippets at 300 characters and hits at the limit", () => {
    const f = fx();
    write(join(f.notes, "long.md"), Array.from({ length: 30 }, () => `needle ${"z".repeat(400)}`).join("\n"));
    const r = searchTree(tree(f), ["needle"], 4);
    expect(r.hits).toHaveLength(4);
    for (const h of r.hits) expect(Array.from(h.snippet).length).toBeLessThanOrEqual(300);
  });

  it("never returns excluded or outside content", () => {
    const f = fx();
    link(f.outside, join(f.notes, "outside-link"));
    link(join(f.outside, "plain.md"), join(f.notes, "escape.md"));
    const r = searchTree(tree(f), ["billing"], 10);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });

  it("reads at most 256 KiB of a file and marks the search truncated", () => {
    const f = fx();
    write(join(f.notes, "big.md"), "x\n".repeat(200 * 1024) + "late needle\n");
    const r = searchTree(tree(f), ["needle"], 10);
    expect(r.hits).toEqual([]);
    expect(r.truncated).toBe(true);
  });

  it("stops at 5 MiB scanned per call", () => {
    const f = fx();
    for (let i = 0; i < 24; i++) write(join(f.notes, "bulk", `f${String(i).padStart(2, "0")}.md`), "y".repeat(250 * 1024));
    write(join(f.notes, "zz-last.md"), "needle\n");
    const r = searchTree(tree(f), ["needle"], 10);
    expect(r.hits).toEqual([]);
    expect(r.truncated).toBe(true);
  });

  it("stops at 2,000 files per call", () => {
    const f = fx();
    for (let i = 0; i < SEARCH_LIMITS.maxFiles + 5; i++) writeFileSync(join(f.notes, `n${String(i).padStart(5, "0")}.md`), "n");
    const r = searchTree(tree(f), ["needle"], 10);
    expect(r.truncated).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["too long", "a".repeat(201)],
    ["NUL", "a\0b"],
    ["too many terms", "a b c d e f g h i"],
    ["term too long", "a".repeat(65)],
  ])("rejects a query that is %s", (_l, q) => {
    expect(parseQuery(q)).toBeUndefined();
  });
});

describe("read", () => {
  it("reads a line range with the real line numbers", () => {
    const f = fx();
    const r = readTreeFile(tree(f), "billing-migration.md", 3, 4);
    expect(r).toEqual({
      ok: true,
      path: "billing-migration.md",
      lines: [3, 4],
      totalLines: 6,
      text: "We move invoices to usage-based billing.\nMetered usage lands next week.",
      truncated: false,
    });
  });

  it.each([
    ["parent-relative", "../.ssh/id_rsa"],
    ["nested parent-relative", "projects/../../.ssh/id_rsa"],
    ["absolute", "/etc/passwd"],
    ["home-relative", "~/.ssh/id_rsa"],
    ["NUL byte", "billing-migration.md\0"],
    ["empty", ""],
    ["dot segment", "./billing-migration.md"],
    ["backslash", "projects\\scout.md"],
    ["trailing slash", "projects/"],
  ])("rejects a %s path", (_l, p) => {
    const f = fx();
    expect(readTreeFile(tree(f), p)).toEqual({ ok: false, code: "invalid-path" });
  });

  it("refuses the fixture's absolute ssh key path and every symlinked route to it", () => {
    const f = fx();
    link(join(f.home, ".ssh", "id_rsa"), join(f.notes, "key.md"));
    link(join(f.home, ".ssh"), join(f.notes, "sshdir"));
    for (const p of [join(f.home, ".ssh", "id_rsa"), "key.md", "sshdir/id_rsa", "sshdir/id_rsa.md", ".ssh/id_rsa"]) {
      const r = readTreeFile(tree(f), p);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(SENTINEL);
    }
  });

  it("refuses excluded, non-text, outside and missing files with one code", () => {
    const f = fx();
    link(join(f.outside, "plain.md"), join(f.notes, "escape.md"));
    for (const p of [".env", "x.pem", "secrets/billing.md", ".git/billing.md", "data.json", "escape.md", "missing.md", "projects"]) {
      expect(readTreeFile(tree(f), p)).toEqual({ ok: false, code: "denied" });
    }
  });

  it("reads a symlinked file whose target is inside the root", () => {
    const f = fx();
    link(join(f.notes, "billing-migration.md"), join(f.notes, "alias.md"));
    const r = readTreeFile(tree(f), "alias.md", 1, 1);
    expect(r).toMatchObject({ ok: true, path: "alias.md", text: "# Billing migration" });
  });

  it("caps a read at 200 lines", () => {
    const f = fx();
    write(join(f.notes, "many.md"), Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n"));
    const r = readTreeFile(tree(f), "many.md", 10, 400);
    expect(r).toMatchObject({ ok: true, lines: [10, 209], truncated: true });
    if (r.ok) expect(r.text.split("\n")).toHaveLength(200);
  });

  it("caps a read at 16 KiB", () => {
    const f = fx();
    write(join(f.notes, "wide.md"), Array.from({ length: 100 }, () => "w".repeat(1000)).join("\n"));
    const r = readTreeFile(tree(f), "wide.md");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(16 * 1024);
      expect(r.truncated).toBe(true);
      expect(r.lines[1]).toBeLessThan(100);
    }
    write(join(f.notes, "one.md"), "é".repeat(20 * 1024));
    const one = readTreeFile(tree(f), "one.md");
    expect(one.ok && Buffer.byteLength(one.text) <= 16 * 1024 && !one.text.includes("�")).toBe(true);
  });

  it("rejects a bad range", () => {
    const f = fx();
    expect(readTreeFile(tree(f), "billing-migration.md", 5, 2)).toEqual({ ok: false, code: "invalid-range" });
    expect(readTreeFile(tree(f), "billing-migration.md", 99)).toEqual({ ok: false, code: "invalid-range" });
  });

  it("fails when the file is swapped for a symlink after the check (O_NOFOLLOW)", () => {
    const f = fx();
    const target = join(f.notes, "billing-migration.md");
    let swapped = false;
    const racingFs: FsOps = {
      ...nodeFs,
      open(p, flags) {
        if (p === target && !swapped) {
          swapped = true;
          renameSync(target, join(f.base, "moved.md"));
          symlinkSync(join(f.outside, "plain.md"), target);
        }
        return nodeFs.open(p, flags);
      },
    };
    const r = readTreeFile(tree(f, { fs: racingFs }), "billing-migration.md");
    expect(swapped).toBe(true);
    expect(r).toEqual({ ok: false, code: "denied" });
  });

  it("fails when a parent directory is swapped for a symlink after the check", () => {
    const f = fx();
    const dir = join(f.notes, "projects");
    const target = join(dir, "scout.md");
    write(join(f.outside, "projects", "scout.md"), `swapped ${SENTINEL}`);
    let swapped = false;
    const racingFs: FsOps = {
      ...nodeFs,
      open(p, flags) {
        if (p === target && !swapped) {
          swapped = true;
          rmSync(dir, { recursive: true });
          symlinkSync(join(f.outside, "projects"), dir);
        }
        return nodeFs.open(p, flags);
      },
    };
    const r = readTreeFile(tree(f, { fs: racingFs }), "projects/scout.md");
    expect(swapped).toBe(true);
    expect(r).toEqual({ ok: false, code: "denied" });
  });
});

describe("normalizeRelPath", () => {
  it("keeps a plain relative path", () => {
    expect(normalizeRelPath("projects/scout.md")).toBe("projects/scout.md");
    expect(normalizeRelPath(42)).toBeUndefined();
  });
});
