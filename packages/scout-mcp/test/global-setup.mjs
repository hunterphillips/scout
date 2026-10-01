// Vitest global setup: build @scout/contracts and this package's dist/ once, so the stdio
// test spawns the current source.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export default function setup() {
  const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
  for (const dir of [join(pkgDir, "..", "contracts"), pkgDir]) {
    execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.build.json")], { stdio: "inherit" });
  }
}
