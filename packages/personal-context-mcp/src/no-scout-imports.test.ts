// This package is an independent service; Scout is only one of its clients. It must never
// depend on @scout/* packages, in source or in package.json.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const PKG = join(SRC, "..", "package.json");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(ts|mts|cts|js|mjs|cjs|json)$/.test(e.name) ? [p] : [];
  });
}

// import/export ... from "@scout/..", import("@scout/.."), require("@scout/..").
const SCOUT_SPECIFIER = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["']@scout\//;

describe("no @scout imports", () => {
  it("no file under src/ imports @scout/*", () => {
    const self = fileURLToPath(import.meta.url);
    const files = sourceFiles(SRC).filter((f) => f !== self);
    expect(files.length).toBeGreaterThan(3);
    const offenders = files.filter((f) => SCOUT_SPECIFIER.test(readFileSync(f, "utf8"))).map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("the detector catches the forms it is meant to", () => {
    for (const line of [
      'import { x } from "@scout/contracts";',
      "import type { Y } from '@scout/scout-core';",
      'export * from "@scout/contracts";',
      'await import("@scout/contracts")',
      'import "@scout/contracts";',
    ]) {
      expect(SCOUT_SPECIFIER.test(line), line).toBe(true);
    }
  });

  it("package.json declares no @scout/* dependency of any kind", () => {
    const pkg = JSON.parse(readFileSync(PKG, "utf8")) as Record<string, unknown>;
    const deps = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) =>
      Object.keys((pkg[k] as Record<string, string> | undefined) ?? {}),
    );
    expect(deps.filter((d) => d.startsWith("@scout/"))).toEqual([]);
  });
});
