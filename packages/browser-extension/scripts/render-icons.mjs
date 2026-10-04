// Renders the extension's PNG icons from assets/mark.svg in headless Chrome (puppeteer-core),
// into icons/. The PNGs are committed, so a build never needs Chrome; run this again after
// changing the mark:
//
//   SCOUT_ICON_CHROME=<Chrome for Testing executable> node scripts/render-icons.mjs
//   (or SCOUT_E2E_BROWSERS=<@puppeteer/browsers cache dir holding one>)
//
// Variants, as in the mark's design sheet: the 128 sits on a white rounded tile (the Chrome Web
// Store and chrome://extensions); 48 is the mark as drawn; the 16 and 32 toolbar icons have no
// tile and a heavier ring and dot so they read at 16 px; the paused toolbar icons are a grey ring
// with two bars in place of the dot.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "icons");
const source = readFileSync(join(root, "assets", "mark.svg"), "utf8");

/** Each variant edits a copy of the source SVG in the page (`svg`, `ring`, `dot` are its nodes). */
const VARIANTS = [
  { file: "icon-16.png", size: 16, edit: "toolbar" },
  { file: "icon-32.png", size: 32, edit: "toolbar" },
  { file: "icon-48.png", size: 48, edit: "plain" },
  { file: "icon-128.png", size: 128, edit: "tile" },
  { file: "paused-16.png", size: 16, edit: "paused" },
  { file: "paused-32.png", size: 32, edit: "paused" },
];

async function findChrome() {
  if (process.env.SCOUT_ICON_CHROME) return process.env.SCOUT_ICON_CHROME;
  const cacheDir = process.env.SCOUT_E2E_BROWSERS;
  if (!cacheDir) return null;
  const { getInstalledBrowsers } = await import("@puppeteer/browsers");
  return (await getInstalledBrowsers({ cacheDir })).find((b) => b.browser === "chrome")?.executablePath ?? null;
}

const chrome = await findChrome();
if (!chrome) {
  console.error("render-icons: set SCOUT_ICON_CHROME (a Chrome executable) or SCOUT_E2E_BROWSERS");
  process.exit(1);
}
const { default: puppeteer } = await import("puppeteer-core");
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, pipe: true, args: ["--no-first-run"] });
try {
  const page = await browser.newPage();
  mkdirSync(out, { recursive: true });
  for (const v of VARIANTS) {
    await page.setViewport({ width: v.size, height: v.size, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${source}</body></html>`);
    await page.evaluate(
      (edit, size) => {
        const NS = "http://www.w3.org/2000/svg";
        const svg = document.querySelector("svg");
        const ring = svg.querySelector("#ring");
        const dot = svg.querySelector("#dot");
        svg.setAttribute("width", String(size));
        svg.setAttribute("height", String(size));
        svg.style.display = "block";
        if (edit === "toolbar") {
          ring.setAttribute("stroke-width", "3");
          dot.setAttribute("r", "3.4");
        } else if (edit === "paused") {
          ring.setAttribute("stroke", "#8A939E");
          ring.setAttribute("stroke-width", "3");
          dot.remove();
          const bars = document.createElementNS(NS, "path");
          bars.setAttribute("d", "M10 9v6M14 9v6");
          bars.setAttribute("stroke", "#8A939E");
          bars.setAttribute("stroke-width", "2");
          svg.append(bars);
        } else if (edit === "tile") {
          // The 128 tile: rx 30 of 128, ring r 36 stroke 11, dot r 13 at (78, 50); in 24 units.
          const k = 24 / 128;
          const tile = document.createElementNS(NS, "rect");
          for (const [a, val] of [["width", 24], ["height", 24], ["rx", 30 * k], ["fill", "#FFFFFF"]]) tile.setAttribute(a, String(val));
          svg.prepend(tile);
          ring.setAttribute("r", String(36 * k));
          ring.setAttribute("stroke-width", String(11 * k));
          dot.setAttribute("cx", String(78 * k));
          dot.setAttribute("cy", String(50 * k));
          dot.setAttribute("r", String(13 * k));
        }
      },
      v.edit,
      v.size,
    );
    await page.screenshot({ path: join(out, v.file), omitBackground: true, clip: { x: 0, y: 0, width: v.size, height: v.size } });
    console.log(`icons/${v.file}`);
  }
} finally {
  await browser.close();
}
