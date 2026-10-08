// Builds the unpacked extension into dist/:
//   manifest.json  background.js  panel.html  panel.js  content/page.js
//   icons/*.png (rendered from assets/mark.svg by scripts/render-icons.mjs, committed)
//   fonts/figtree-latin-wght.woff2 + fonts/OFL.txt (the panel's font; MV3 CSP forbids remote fonts)
// The manifest has no `key`; scripts/setup.mjs adds it to dist/manifest.json
// so the extension id is stable. A rebuild keeps a key already in dist/.
// SCOUT_EXT_DIST overrides the output dir (tests).
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { zodEnglishOnly } from "./zod-en-only.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const dist = process.env.SCOUT_EXT_DIST ?? join(root, "dist");
const common = { bundle: true, target: "chrome116", platform: "browser", legalComments: "none", logLevel: "warning" };

const key = await readFile(join(dist, "manifest.json"), "utf8").then((t) => JSON.parse(t).key).catch(() => undefined);
await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "content"), { recursive: true });
// Only the worker carries zod; zod-en-only.mjs drops its non-English locales (~820 KB -> ~456 KB).
await build({ ...common, format: "esm", entryPoints: { background: "src/background.ts", panel: "src/panel.ts" }, outdir: dist, absWorkingDir: root, plugins: [zodEnglishOnly] });
// Registered content scripts are classic scripts, not modules.
await build({ ...common, format: "iife", entryPoints: { "content/page": "src/content/page.ts" }, outdir: dist, absWorkingDir: root });
await copyFile(join(root, "src/panel.html"), join(dist, "panel.html"));
await cp(join(root, "icons"), join(dist, "icons"), { recursive: true });
await cp(join(root, "assets/fonts"), join(dist, "fonts"), { recursive: true });
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
if (typeof key === "string") manifest.key = key;
await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
