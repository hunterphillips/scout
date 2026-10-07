// Build a package's dist/ for the test suites' global setups without ever leaving a
// half-written file behind. tsc truncates and rewrites every output in place, so a test run
// that spawns a dist entrypoint while another run's global setup is rebuilding the same
// checkout could load an empty or partial module and die at import ("Connection closed" in
// the bridge tests). Here tsc emits into a sibling staging directory (same depth as dist/, so
// source-map paths are unchanged); then each output that differs from dist/ is written to a
// temporary file beside its target and renamed over it. Unchanged outputs are not touched.
// Like tsc, outputs whose sources were deleted are left in place.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (e.isFile()) yield p;
  }
}

function sameBytes(path, bytes) {
  try {
    return readFileSync(path).equals(bytes);
  } catch {
    return false;
  }
}

/**
 * Compile `<pkgDir>/<tsconfig>` (whose outDir is `<pkgDir>/dist`) and install the outputs
 * into dist/ atomically per file. Returns the dist-relative paths it replaced.
 */
export function buildDist(pkgDir, tsconfig = "tsconfig.build.json") {
  const dist = join(pkgDir, "dist");
  const staging = mkdtempSync(join(pkgDir, ".dist-staging-"));
  try {
    execFileSync(process.execPath, [tsc, "-p", join(pkgDir, tsconfig), "--outDir", staging], { stdio: "inherit" });
    if (pkgDir.endsWith("scout-core") && existsSync(join(pkgDir, "src", "agents", "pi", "answerExtension.mjs"))) {
      const extension = join(pkgDir, "src", "agents", "pi", "answerExtension.mjs");
      const target = join(staging, "agents", "pi", "answerExtension.mjs");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(extension));
    }
    const replaced = [];
    for (const src of files(staging)) {
      const rel = relative(staging, src);
      const target = join(dist, rel);
      const bytes = readFileSync(src);
      if (sameBytes(target, bytes)) continue;
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, target);
      replaced.push(rel);
    }
    return replaced;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
