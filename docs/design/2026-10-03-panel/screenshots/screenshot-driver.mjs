// Screenshot driver: serves the built extension's dist/ over local http and opens panel.html in
// Chrome for Testing with a scripted `chrome` stand-in (the worker side: status, frames, replies).
// The panel code, CSS and font are the real build; only the worker and core are scripted.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";

const WT = process.env.WT;
const OUT = process.env.OUT;
const DIST = join(WT, "packages/browser-extension/dist");
const require = createRequire(join(WT, "package.json"));
const { default: puppeteer } = await import(pathToFileURL(require.resolve("puppeteer-core")).href);
const { getInstalledBrowsers } = await import(pathToFileURL(require.resolve("@puppeteer/browsers")).href);
const chromePath = (await getInstalledBrowsers({ cacheDir: process.env.BROWSERS })).find((b) => b.browser === "chrome").executablePath;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".woff2": "font/woff2", ".png": "image/png", ".txt": "text/plain" };
const server = createServer((req, res) => {
  try {
    const body = readFileSync(join(DIST, decodeURIComponent(req.url.split("?")[0])));
    res.setHeader("content-type", TYPES[extname(req.url.split("?")[0])] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const INSTANCE = "core-7f3a9c";
const RID = `res_${"a".repeat(64)}`;
const RID2 = `res_${"b".repeat(64)}`;
const AGENTS = "## Using the Stripe API\nPrefer the latest API version.\nSend an idempotency key with every write.\nUse test-mode keys while building.\nNever log a secret key; read it from the environment.\n";
const SKILL = "---\nname: stripe-cli\n---\nUse the Stripe CLI to forward webhooks to your local server.\n";
const sha = (t) => createHash("sha256").update(t).digest("hex");
const V1 = sha(AGENTS);
const V2 = sha(SKILL);

const status = (over = {}) => ({
  link: "connected",
  paused: false,
  granted: ["https://docs.stripe.com/*", "https://github.com/*"],
  githubCapture: true,
  broadGrantIgnored: false,
  policy: { revision: 2, captureEnabled: true, paused: false },
  counters: { focus: 14, forwarded: 3, dropped: 0, acked: 17, denied: 0 },
  ...over,
});
const offers = [
  { resourceId: RID, version: V1, kind: "agents_md", siteOrigin: "https://docs.stripe.com", sourceUrl: "https://docs.stripe.com/AGENTS.md", byteLength: Buffer.byteLength(AGENTS), fetchedAt: Date.now(), resourceRevision: 1 },
  { resourceId: RID2, version: V2, kind: "skill", siteOrigin: "https://docs.stripe.com", sourceUrl: "https://docs.stripe.com/.well-known/agent-skills/stripe-cli/SKILL.md", byteLength: Buffer.byteLength(SKILL), fetchedAt: Date.now(), resourceRevision: 1, skill: { name: "stripe-cli" } },
];
const library = [{ resourceId: `res_${"c".repeat(64)}`, kind: "llms_txt", siteOrigin: "https://docs.stripe.com", sourceUrl: "https://docs.stripe.com/llms.txt", defaultVersion: "4".repeat(64), state: "approved", versions: [{ hash: "4".repeat(64), state: "approved", byteLength: 4000, fetchedAt: Date.now() }], resourceRevision: 2 }];
const caps = { type: "capabilities", coreInstanceId: INSTANCE, revision: 3, approvalRevision: 1, offers, library, conflicts: [], origins: [{ origin: "https://docs.stripe.com", autoAcquire: false, permitted: true }, { origin: "https://github.com", autoAcquire: false, permitted: true }], truncated: false };
const grant = { type: "grant", agentBrowserContext: true, destinations: ["https://docs.stripe.com"] };
const audit = {
  type: "audit",
  entries: [
    { at: Date.now() - 600_000, role: "interactive", method: "current_site", outcome: "ok", origin: "https://docs.stripe.com" },
    { at: Date.now() - 300_000, role: "job", method: "recent_activity", outcome: "ok" },
    { at: Date.now() - 120_000, role: "job", method: "site_links", outcome: "ok", origin: "https://docs.stripe.com" },
  ],
};
const idle = { type: "state", status: "idle", visitEpoch: 3, detail: "docs.stripe.com", permitted: true };
const results = {
  type: "results",
  coreInstanceId: INSTANCE,
  visitEpoch: 3,
  origin: "https://docs.stripe.com",
  jobId: "job-3a",
  status: "ok",
  items: [
    { candidateId: "c1", title: "Usage-based billing", reason: "How metered prices roll up into the invoice", hostname: "docs.stripe.com" },
    { candidateId: "c2", title: "Billing thresholds", reason: "The setting the issue asks about", hostname: "docs.stripe.com" },
    { candidateId: "c3", title: "The Meter object", reason: "Where the issue's error comes from", hostname: "docs.stripe.com" },
  ],
};
const site = { kind: "ok", origin: "https://docs.stripe.com", pattern: "https://docs.stripe.com/*", host: "docs.stripe.com", tabId: 13, index: 3 };
const TEXTS = { [`${RID}/${V1}`]: AGENTS, [`${RID2}/${V2}`]: SKILL };

const SCENARIOS = {
  "page-links": { status: status(), site, frames: [grant, caps, audit, idle, results] },
  "page-review": { status: status(), site, frames: [grant, caps, audit, idle, results], click: ["review-open"] },
  "page-empty": { status: status(), site, frames: [grant, { ...caps, offers: [], library: [] }, audit, idle] },
  "page-working": { status: status(), site, frames: [grant, { ...caps, offers: [], library: [] }, audit, { type: "state", status: "working", visitEpoch: 3, jobId: "job-3b" }] },
  "page-not-allowed": { status: status({ granted: ["https://github.com/*"] }), site, frames: [{ ...grant, destinations: [] }, { ...caps, offers: [], library: [] }, audit, { type: "state", status: "idle", visitEpoch: 3, detail: "docs.stripe.com", permitted: false }] },
  "page-down": { status: status({ link: "core_unavailable" }), site, frames: [] },
  sites: { status: status(), site, frames: [grant, caps, audit, idle, results], click: ["nav-sites"] },
  activity: { status: status(), site, frames: [grant, { ...caps, conflicts: [{ name: "scout-skill-1a2b3c4d5e6f7a8b", resourceId: RID2, code: "left_modified" }] }, audit, idle, results], click: ["nav-activity"] },
  settings: { status: status(), site, frames: [grant, caps, audit, idle, results], click: ["nav-settings", "diagnostics-open"] },
};

const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, pipe: true, args: ["--no-first-run", "--no-default-browser-check"] });
const only = process.argv.slice(2);
try {
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    for (const theme of name === "page-links" || name === "page-review" || name === "page-empty" ? ["light", "dark"] : ["light"]) {
      const shot = theme === "dark" ? `${name}-dark` : name;
      if (only.length && !only.includes(shot)) continue;
      const page = await browser.newPage();
      await page.setViewport({ width: 400, height: 860, deviceScaleFactor: 2 });
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }]);
      page.on("pageerror", (e) => console.error(`${shot}: pageerror ${e.message}`));
      page.on("console", (m) => m.type() === "error" && console.error(`${shot}: console ${m.text()}`));
      await page.evaluateOnNewDocument(
        (sc, texts) => {
          const ev = () => {
            const fns = [];
            return { addListener: (f) => fns.push(f), emit: (...a) => fns.forEach((f) => f(...a)) };
          };
          const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
          const onMessage = ev();
          const port = {
            onMessage,
            onDisconnect: ev(),
            async postMessage(m) {
              if (m.type !== "request") return;
              const r = m.request;
              let result = null;
              if (r.type === "status") result = sc.status;
              else if (r.type === "site") result = sc.site;
              else if (r.type === "pause") result = { status: sc.status, written: true };
              else if (r.type === "command") {
                result = { written: true };
                const c = r.command;
                if (c.type === "preview") {
                  const text = texts[`${c.resourceId}/${c.version}`];
                  const offer = sc.frames.find((f) => f.type === "capabilities").offers.find((o) => o.resourceId === c.resourceId);
                  setTimeout(async () => onMessage.emit({ type: "frame", state: { type: "preview", commandId: c.commandId, resourceId: c.resourceId, version: c.version, seq: 0, offset: 0, totalBytes: new TextEncoder().encode(text).length, text, sha256: await sha(text), descriptor: { kind: offer.kind, siteOrigin: offer.siteOrigin, sourceUrl: offer.sourceUrl, ...(offer.skill ? { skill: offer.skill } : {}) } } }), 50);
                }
              }
              setTimeout(() => onMessage.emit({ type: "reply", id: m.id, result }), 0);
            },
            disconnect() {},
          };
          window.chrome = {
            runtime: {
              connect() {
                setTimeout(() => {
                  onMessage.emit({ type: "status", status: sc.status });
                  for (const f of sc.frames) onMessage.emit({ type: "frame", state: f });
                }, 0);
                return port;
              },
              get lastError() {
                return undefined;
              },
            },
            windows: { getCurrent: async () => ({ id: 1 }), onFocusChanged: ev() },
            tabs: { onActivated: ev(), onUpdated: ev(), create: async () => ({ id: 99 }) },
            permissions: { onAdded: ev(), onRemoved: ev(), request: async () => true, remove: async () => true },
          };
        },
        sc,
        TEXTS,
      );
      await page.goto(`${base}/panel.html`, { waitUntil: "networkidle0" });
      await page.evaluate(() => document.fonts.ready);
      await new Promise((r) => setTimeout(r, 300));
      for (const k of sc.click ?? []) {
        if (k === "diagnostics-open") await page.evaluate(() => (document.querySelector("details.diagnostics").open = true));
        else await page.click(`[data-key="${k}"]`);
        await new Promise((r) => setTimeout(r, 400));
      }
      const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily + " | loaded=" + document.fonts.check('14px "Figtree"'));
      const overflow = await page.evaluate(() => [window.innerWidth, document.documentElement.scrollWidth]);
      await page.screenshot({ path: join(OUT, `${shot}.png`) });
      console.log(`${shot}.png  font=${font}  width=${overflow}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
