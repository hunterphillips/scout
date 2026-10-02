// Vitest global setup: build dist/ once so tests exercise the current source. Each output
// is replaced atomically (build-dist.mjs).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDist } from "../../../scripts/lib/build-dist.mjs";

export default function setup() {
  buildDist(join(dirname(fileURLToPath(import.meta.url)), ".."));
}
