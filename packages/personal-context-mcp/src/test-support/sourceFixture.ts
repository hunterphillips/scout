// A synthetic home for source-tool tests. Everything lives in a temp dir; nothing here
// reads or writes Hunter's real files.

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SourceConfig } from "../config.js";
import type { RunFiles, RunSnapshot, SnapshotObservation } from "../sourceTools/runFiles.js";

export const SENTINEL = "SENTINEL-7f3a-DO-NOT-LEAK";

export interface Fixture {
  base: string;
  home: string;
  runDir: string;
  notes: string;
  outside: string;
  cleanup(): void;
}

export function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * <base>/home        fake HOME
 *   .ssh/id_rsa      sentinel
 *   notes/           a markdown_dir root
 *   workspace/second-brain/{notes,inbox}/...
 * <base>/outside/    outside every root, sentinel content
 * <base>/run/        the run dir (0700)
 */
export function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pcm-src-")));
  const home = join(base, "home");
  const notes = join(home, "notes");
  const outside = join(base, "outside");
  const runDir = join(base, "run");
  mkdirSync(runDir, { mode: 0o700 });
  write(join(home, ".ssh", "id_rsa"), `-----BEGIN KEY----- ${SENTINEL} ssh\n`);
  write(join(outside, "secret-plan.md"), `outside ${SENTINEL} billing\n`);
  write(join(outside, "plain.md"), `outside plain ${SENTINEL} billing\n`);
  write(
    join(notes, "billing-migration.md"),
    ["# Billing migration", "", "We move invoices to usage-based billing.", "Metered usage lands next week.", "", "Unrelated line."].join("\n"),
  );
  write(join(notes, "projects", "scout.md"), ["Scout ranks links.", "It reads the billing notes", "when invoices matter."].join("\n"));
  write(join(notes, "todo.txt"), "billing todo item\n");
  write(join(notes, "data.json"), `{"billing": "${SENTINEL}"}\n`);
  write(join(notes, ".env"), `BILLING=${SENTINEL}\n`);
  write(join(notes, "x.pem"), `billing ${SENTINEL}\n`);
  write(join(notes, "secrets", "billing.md"), `billing ${SENTINEL}\n`);
  write(join(notes, ".git", "billing.md"), `billing ${SENTINEL}\n`);
  return {
    base,
    home,
    runDir,
    notes,
    outside,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

export function link(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
}

export function observation(n: number, extra: Partial<SnapshotObservation> = {}): SnapshotObservation {
  return {
    observationId: `o${n}`,
    sensor: "scout",
    kind: "viewed_page",
    observedAt: `2026-09-30T12:0${n % 10}:00Z`,
    url: `https://github.com/o/r/issues/${n}`,
    title: `issue ${n}`,
    text: `activity text ${n}`,
    truncated: false,
    ...extra,
  };
}

export function snapshot(extra: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    observations: [observation(2), observation(1)],
    candidateCount: 3,
    budgets: { maxCalls: 20, maxTotalBytes: 128 * 1024 },
    ...extra,
  };
}

export function runFiles(sources: SourceConfig[], snap: Partial<RunSnapshot> = {}): RunFiles {
  return { snapshot: snapshot(snap), sources };
}

export function mdSource(root: string, extra: Record<string, unknown> = {}): SourceConfig {
  return { id: "notes", kind: "markdown_dir", enabled: true, root, exclude: [], ...extra } as SourceConfig;
}

/** mode, size, mtime and content hash of every entry under `dir` (links are not followed). */
export function treeState(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      const st = lstatSync(p);
      const hash = ent.isFile() ? createHash("sha256").update(readFileSync(p)).digest("hex") : ent.isSymbolicLink() ? "link" : "dir";
      out[p] = `${st.mode}:${st.size}:${st.mtimeMs}:${hash}`;
      if (ent.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}
