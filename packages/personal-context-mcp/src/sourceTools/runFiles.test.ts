import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshot } from "../test-support/sourceFixture.js";
import { createRunBudget } from "./budget.js";
import { createEvidenceLedger } from "./evidence.js";
import { readRunFiles, RunFileError } from "./runFiles.js";

const dirs: string[] = [];
function runDir(snap: unknown, sources: unknown): string {
  const d = mkdtempSync(join(tmpdir(), "pcm-run-"));
  dirs.push(d);
  if (snap !== undefined) writeFileSync(join(d, "snapshot.json"), typeof snap === "string" ? snap : JSON.stringify(snap));
  if (sources !== undefined) writeFileSync(join(d, "sources.json"), typeof sources === "string" ? sources : JSON.stringify(sources));
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof RunFileError ? e.code : "other";
  }
  return undefined;
}

const md = (extra: Record<string, unknown> = {}) => ({ id: "notes", kind: "markdown_dir", enabled: true, root: "/data/notes", exclude: [], ...extra });

describe("run files", () => {
  it("reads both files and keeps enabled sources only", () => {
    const d = runDir(snapshot(), { sources: [md(), md({ id: "off", enabled: false })] });
    const files = readRunFiles(d);
    expect(files.snapshot.observations).toHaveLength(2);
    expect(files.sources.map((s) => s.id)).toEqual(["notes"]);
  });

  it.each([
    ["missing snapshot", undefined, { sources: [] }, "snapshot-unreadable"],
    ["snapshot not JSON", "{", { sources: [] }, "snapshot-invalid"],
    ["snapshot with an extra key", { ...snapshot(), extra: 1 }, { sources: [] }, "snapshot-invalid"],
    ["call budget over 20", snapshot({ budgets: { maxCalls: 21, maxTotalBytes: 1024 } }), { sources: [] }, "snapshot-invalid"],
    ["byte budget over 128 KiB", snapshot({ budgets: { maxCalls: 1, maxTotalBytes: 128 * 1024 + 1 } }), { sources: [] }, "snapshot-invalid"],
    ["observation with an extra key", { ...snapshot(), observations: [{ ...snapshot().observations[0], secret: 1 }] }, { sources: [] }, "snapshot-invalid"],
    ["missing sources", snapshot(), undefined, "sources-unreadable"],
    ["relative root", snapshot(), { sources: [md({ root: "notes" })] }, "sources-invalid"],
    ["duplicate ids", snapshot(), { sources: [md(), md()] }, "sources-invalid"],
    ["unknown kind", snapshot(), { sources: [{ id: "x", kind: "shell", enabled: true }] }, "sources-invalid"],
    ["extra top-level key", snapshot(), { sources: [], more: [] }, "sources-invalid"],
  ])("refuses %s with a fixed code", (_l, snap, sources, code) => {
    expect(codeOf(() => readRunFiles(runDir(snap, sources)))).toBe(code);
  });

  it("refuses a symlinked run file", () => {
    const d = runDir(undefined, { sources: [] });
    const real = join(d, "real");
    mkdirSync(real);
    writeFileSync(join(real, "s.json"), JSON.stringify(snapshot()));
    symlinkSync(join(real, "s.json"), join(d, "snapshot.json"));
    expect(codeOf(() => readRunFiles(d))).toBe("snapshot-unreadable");
  });
});

describe("budget", () => {
  it("counts every call and stays exhausted once a limit is passed", () => {
    const b = createRunBudget({ maxCalls: 3, maxTotalBytes: 100 });
    expect(b.admitCall() && b.admitBytes(60)).toBe(true);
    expect(b.admitCall()).toBe(true);
    expect(b.admitBytes(50)).toBe(false);
    expect(b.admitCall()).toBe(false);
    expect(b.admitBytes(1)).toBe(false);
    expect(b.exhausted).toBe(true);
    expect(b.bytes).toBe(60);
  });
});

describe("evidence ledger", () => {
  it("issues e1, e2, ... and a rolled-back transaction leaves no gap", () => {
    const l = createEvidenceLedger();
    const a = l.begin();
    expect(a.mint({ kind: "note", sourceId: "s", path: "a.md", lines: [1, 2] })).toBe("e1");
    a.commit();
    const b = l.begin();
    b.mint({ kind: "focus", sourceId: "f" });
    b.rollback();
    const c = l.begin();
    expect(c.mint({ kind: "activity", sourceId: "activity", path: "o1" })).toBe("e2");
    c.commit();
    expect(l.all().map((r) => r.id)).toEqual(["e1", "e2"]);
    expect(l.get("e1")).toEqual({ id: "e1", kind: "note", sourceId: "s", path: "a.md", lines: [1, 2] });
  });
});
