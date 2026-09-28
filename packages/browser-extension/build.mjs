// Builds the unpacked extension into dist/:
//   manifest.json  background.js  popup.html  popup.js  content/github-issue.js
// The manifest has no `key`; scripts/setup.mjs adds it to dist/manifest.json
// so the extension id is stable. A rebuild keeps a key already in dist/.
// SCOUT_EXT_DIST overrides the output dir (tests).
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const dist = process.env.SCOUT_EXT_DIST ?? join(root, "dist");
const common = { bundle: true, target: "chrome116", platform: "browser", legalComments: "none", logLevel: "warning" };

const key = await readFile(join(dist, "manifest.json"), "utf8").then((t) => JSON.parse(t).key).catch(() => undefined);
await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "content"), { recursive: true });
await build({ ...common, format: "esm", entryPoints: { background: "src/background.ts", popup: "src/popup.ts" }, outdir: dist, absWorkingDir: root });
// Registered content scripts are classic scripts, not modules.
await build({ ...common, format: "iife", entryPoints: { "content/github-issue": "src/content/github-issue.ts" }, outdir: dist, absWorkingDir: root });
await copyFile(join(root, "src/popup.html"), join(dist, "popup.html"));
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
if (typeof key === "string") manifest.key = key;
await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
