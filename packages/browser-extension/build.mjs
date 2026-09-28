// Builds the unpacked extension into dist/:
//   manifest.json  background.js  popup.html  popup.js  content/github-issue.js
// The manifest has no `key`; scripts/setup.mjs (Task 6) adds it to
// dist/manifest.json so the extension id is stable.
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const common = { bundle: true, target: "chrome116", platform: "browser", legalComments: "none", logLevel: "warning" };

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "content"), { recursive: true });
await build({ ...common, format: "esm", entryPoints: { background: "src/background.ts", popup: "src/popup.ts" }, outdir: dist, absWorkingDir: root });
// Registered content scripts are classic scripts, not modules.
await build({ ...common, format: "iife", entryPoints: { "content/github-issue": "src/content/github-issue.ts" }, outdir: dist, absWorkingDir: root });
await copyFile(join(root, "src/popup.html"), join(dist, "popup.html"));
await copyFile(join(root, "manifest.json"), join(dist, "manifest.json"));
