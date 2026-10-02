// Vitest global setup: build @scout/contracts and this package's dist/ once, so the stdio
// test spawns the current source. Each output is replaced atomically (build-dist.mjs).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDist } from "../../../scripts/lib/build-dist.mjs";

export default function setup() {
  const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  for (const dir of [join(pkgDir, "..", "contracts"), pkgDir]) buildDist(dir);
}
