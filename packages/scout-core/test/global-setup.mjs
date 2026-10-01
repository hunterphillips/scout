// Vitest global setup: build the packages whose dist/ the agent-job tests run or compare
// against (contracts, scout-mcp, personal-context-mcp, and scout-core itself for the
// per-job bridge entrypoint), once, before any test file.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export default function setup() {
  const packages = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
  for (const name of ["contracts", "scout-mcp", "personal-context-mcp", "scout-core"]) {
    execFileSync(process.execPath, [tsc, "-p", join(packages, name, "tsconfig.build.json")], { stdio: "inherit" });
  }
}
