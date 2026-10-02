// Vitest global setup: build the packages whose dist/ the agent-job tests run (contracts,
// scout-mcp, and scout-core itself for the per-job bridge entrypoint), once, before any
// test file. Each output is replaced atomically, so another run's tests never load a
// half-written module (build-dist.mjs).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDist } from "../../../scripts/lib/build-dist.mjs";

export default function setup() {
  const packages = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  for (const name of ["contracts", "scout-mcp", "scout-core"]) buildDist(join(packages, name));
}
