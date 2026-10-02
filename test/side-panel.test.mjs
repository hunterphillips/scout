// End-to-end: Scout's side panel in a real Chrome for Testing (new headless) driven by
// puppeteer-core, on the real native host and the real core in a temp SCOUT_HOME, with the
// scripted fake CLI as the user's agent (never a model) and DNS stubbed in the core. The site
// is served locally over HTTPS (self-signed, Chrome's resolver mapped to it); the core never
// fetches it (a fresh cached catalog). Builds the extension into the temp home; run
// `npm run build` first for the core and host. Never touches ~/.scout or a real Chrome profile.
//
// Opt-in: SCOUT_E2E_CHROME=1, plus SCOUT_E2E_CHROME_PATH (the Chrome for Testing executable) or
// SCOUT_E2E_BROWSERS (a @puppeteer/browsers cache dir holding one, e.g. from
// `npx @puppeteer/browsers install chrome@stable --path <dir>`).

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = join(ROOT, "packages/scout-core/dist/main.js");
const HOST = join(ROOT, "packages/native-host/dist/host.js");
const FAKE_CLAUDE = join(ROOT, "packages/scout-core/src/agents/testing/fake-claude.mjs");
const HOSTNAME = "docs.scout-panel.invalid";
const SITE = `https://${HOSTNAME}`;

async function findChrome() {
  if (process.env.SCOUT_E2E_CHROME_PATH) return existsSync(process.env.SCOUT_E2E_CHROME_PATH) ? process.env.SCOUT_E2E_CHROME_PATH : null;
  const cacheDir = process.env.SCOUT_E2E_BROWSERS;
  if (!cacheDir) return null;
  const { getInstalledBrowsers } = await import("@puppeteer/browsers");
  const chrome = (await getInstalledBrowsers({ cacheDir })).find((b) => b.browser === "chrome");
  return chrome?.executablePath ?? null;
}

const OPT_IN = process.env.SCOUT_E2E_CHROME === "1";
const BUILT = existsSync(CORE) && existsSync(HOST);
const CHROME = OPT_IN ? await findChrome() : null;
const SKIP = !OPT_IN
  ? "set SCOUT_E2E_CHROME=1 with SCOUT_E2E_CHROME_PATH or SCOUT_E2E_BROWSERS to run it in Chrome for Testing"
  : !CHROME
    ? "no Chrome for Testing at SCOUT_E2E_CHROME_PATH or in SCOUT_E2E_BROWSERS"
    : !BUILT
      ? "run `npm run build` first"
      : null;
if (SKIP) console.warn(`side-panel e2e: skipped: ${SKIP}`);

async function until(cond, what, ms = 10_000) {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function exitOf(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
}

/** A DNS stub the core preloads: every lookup fails, nothing leaves the machine. */
function dnsStub(dir) {
  const path = join(dir, "dns-stub.mjs");
  writeFileSync(
    path,
    [
      'import dns from "node:dns";',
      'import { syncBuiltinESMExports } from "node:module";',
      "dns.promises.lookup = () => new Promise(() => {});",
      "dns.lookup = (host, ...rest) => { const cb = rest.at(-1); if (typeof cb === 'function') process.nextTick(cb, Object.assign(new Error('stubbed'), { code: 'ENOTFOUND' })); };",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
  );
  return pathToFileURL(path).href;
}

// The reason is in the title too: vitest prints nothing a skipped file logs.
describe.skipIf(SKIP !== null)(SKIP ? `Scout's side panel in Chrome for Testing (skipped: ${SKIP})` : "Scout's side panel in Chrome for Testing", () => {
  let home;
  let browser;
  let server;
  const children = [];

  afterEach(async () => {
    await browser?.close().catch(() => {});
    server?.close();
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("the toolbar opens the panel, which shows the site, Allow's result, a settled visit's results, and opens the clicked link in a new tab", async () => {
    const steps = {};
    const { default: puppeteer } = await import("puppeteer-core");
    const { extensionIdFromPem, generateKeyPem, manifestKey } = await import(pathToFileURL(join(ROOT, "scripts/lib/extension-key.mjs")).href);
    home = mkdtempSync(join(tmpdir(), "scout-sp-"));
    const userHome = join(home, "u");
    const profile = join(home, "profile");
    const ext = join(home, "ext");
    mkdirSync(join(userHome, ".claude"), { recursive: true });
    mkdirSync(join(home, "bin"));
    mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });

    // The extension, built with a key so its ID is known before Chrome loads it.
    const pem = generateKeyPem();
    const extId = extensionIdFromPem(pem);
    mkdirSync(ext);
    writeFileSync(join(ext, "manifest.json"), JSON.stringify({ key: manifestKey(pem) }));
    const built = spawnSync(process.execPath, ["build.mjs"], { cwd: join(ROOT, "packages/browser-extension"), env: { ...process.env, SCOUT_EXT_DIST: ext }, encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);

    // Scout's home: config, the fake agent, a fresh cached catalog for the site.
    writeFileSync(join(home, "config.json"), JSON.stringify({ extensionId: extId, destinations: [HOSTNAME] }));
    const claudePath = join(home, "bin", "claude");
    writeFileSync(claudePath, `#!/bin/sh\nFAKE_MODE=ok FAKE_VERSION=2.1.286 FAKE_LOG='${home}/fake.log' exec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`);
    chmodSync(claudePath, 0o755);
    writeFileSync(join(home, "agent-profile.json"), JSON.stringify({ schemaVersion: 1, adapter: "claude-code", claudePath, model: "claude-sonnet-5-5" }), { mode: 0o600 });
    const { cacheFileName } = await import(pathToFileURL(join(ROOT, "packages/scout-core/dist/privateCacheFile.js")).href);
    const now = Date.now();
    const candidates = ["billing", "pricing", "webhooks"].map((p, i) => ({ id: `c${i}`, sourceUrl: `${SITE}/docs/${p}`, title: `Docs ${p}`, labelQuality: "published", provenance: "llms.txt" }));
    mkdirSync(join(home, "cache", "catalog"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, "cache", "catalog", cacheFileName(SITE)),
      JSON.stringify({ schemaVersion: 3, origin: SITE, fetchedAt: now, resources: [], catalog: { origin: SITE, version: "panel-v1", fetchedAt: now, candidates, truncated: false, errors: [] } }),
      { mode: 0o600 },
    );

    // The native host as Chrome launches it: a wrapper and a manifest in the profile's own dir.
    const wrapper = join(home, "bin", "scout-host");
    writeFileSync(wrapper, `#!/bin/sh\nSCOUT_HOME='${home}' exec '${process.execPath}' '${HOST}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    writeFileSync(
      join(profile, "NativeMessagingHosts", "dev.scout.bridge.json"),
      JSON.stringify({ name: "dev.scout.bridge", description: "Scout e2e", path: wrapper, type: "stdio", allowed_origins: [`chrome-extension://${extId}/`] }),
    );

    // The core, as the Mac app runs it (JSONL on stdio), told Chrome is frontmost.
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: userHome, USER: "e2e", LOGNAME: "e2e", LANG: "en_US.UTF-8", TMPDIR: tmpdir(), SCOUT_HOME: home };
    const core = spawn(process.execPath, ["--import", dnsStub(home), CORE, "--stdio"], { env: { ...env, SCOUT_DWELL_MS: "1500" }, cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    children.push(core);
    let coreOut = "";
    let coreErr = "";
    core.stdout.on("data", (c) => (coreOut += c));
    core.stderr.on("data", (c) => (coreErr += c));
    const coreExit = exitOf(core);
    const app = () => coreOut.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    await until(() => coreErr.includes("listening on"), "the core to listen");
    const frontmost = () => core.stdin.write(`${JSON.stringify({ type: "frontmost", bundleId: "com.google.Chrome", at: Date.now() })}\n`);
    frontmost();

    // The site, over HTTPS on a local port that Chrome's resolver maps port 443 to.
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(home, "k.pem"), "-out", join(home, "c.pem"), "-days", "1", "-subj", `/CN=${HOSTNAME}`, "-addext", `subjectAltName=DNS:${HOSTNAME}`], { stdio: "ignore" });
    server = createServer({ key: readFileSync(join(home, "k.pem")), cert: readFileSync(join(home, "c.pem")) }, (req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<!doctype html><title>Docs ${req.url}</title><h1>${req.url}</h1>`);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      pipe: true,
      enableExtensions: true,
      userDataDir: profile,
      args: ["--no-first-run", "--no-default-browser-check", `--host-resolver-rules=MAP ${HOSTNAME}:443 127.0.0.1:${port}`, "--ignore-certificate-errors", "--enable-unsafe-extension-debugging"],
    });
    expect(await browser.installExtension(ext)).toBe(extId);
    const extension = (await browser.extensions()).get(extId);
    const sw = await (await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`))).worker();

    // 1. Visit the site before Scout may see it, then click the toolbar icon.
    const site = (await browser.pages())[0];
    await site.goto(`${SITE}/docs/billing`, { waitUntil: "domcontentloaded" });
    await site.bringToFront();
    const urlBefore = await sw.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t?.url ?? null));
    await extension.triggerAction(site);
    let panelTarget = await browser.waitForTarget((t) => t.url() === `chrome-extension://${extId}/panel.html`, { timeout: 5_000 }).catch(() => null);
    let panel;
    if (panelTarget) {
      panel = await panelTarget.asPage();
      steps.panelOpenedByToolbar = "headless";
    } else {
      panel = await browser.newPage();
      await panel.goto(`chrome-extension://${extId}/panel.html`);
      await site.bringToFront();
      steps.panelOpenedByToolbar = "fell back: panel.html in a tab (live check)";
    }
    const urlAfter = await sw.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t?.url ?? null));
    steps.activeTab = { urlBeforeClick: urlBefore, urlAfterClick: urlAfter };
    expect(urlBefore).toBeNull();
    expect(urlAfter).toBe(`${SITE}/docs/billing`);
    steps.sidePanelContexts = await sw.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }).then((c) => c.length));

    const text = () => panel.evaluate(() => document.body.innerText);
    /** A trusted click (CDP input), as a user's: permissions.request needs the gesture. */
    const click = async (key) => {
      for (let i = 0; ; i++) {
        try {
          return await panel.click(`[data-key="${key}"]`);
        } catch (e) {
          if (i >= 5 || !/detached|not clickable|No element/.test(String(e))) throw e;
          await new Promise((r) => setTimeout(r, 100)); // a frame re-rendered the panel under the pointer
        }
      }
    };
    await until(async () => (await text()).includes("Idle"), "the panel to connect to the core", 20_000);
    await click("nav-site");
    await until(async () => (await text()).includes("Scout is not allowed on this site."), "This site to show the ungranted site");
    expect(await text()).toContain(HOSTNAME);
    expect(await text()).not.toContain("/docs/billing"); // an origin at most, never the page URL

    // 2. Allow it from the panel. Headless Chrome can't show the permission prompt, so the
    // origin is first recorded as runtime-granted from chrome://extensions (the Phase 2
    // technique), which lets the panel's own Allow click be granted without a prompt.
    const extPage = await browser.newPage();
    await extPage.goto(`chrome://extensions/?id=${extId}`);
    const granted = await extPage.evaluate(
      (id, pattern) => new Promise((res) => chrome.developerPrivate.addHostPermission(id, pattern, () => res(chrome.runtime.lastError?.message ?? "ok"))),
      extId,
      `${SITE}/*`,
    );
    expect(granted).toBe("ok");
    await extPage.close();
    await site.bringToFront();
    expect(await sw.evaluate(() => chrome.permissions.getAll().then((p) => p.origins))).toEqual([]);
    await click("site-allow");
    await until(async () => (await text()).includes("Scout is allowed on this site."), "This site to show the grant");
    expect(await sw.evaluate(() => chrome.permissions.getAll().then((p) => p.origins))).toEqual([`${SITE}/*`]);
    steps.allow = "headless: the panel's Allow → permissions.request (prompt pre-answered via developerPrivate; the prompt itself is a live check)";
    frontmost();
    await click("nav-results");

    // 3. The settled visit: the fake agent's results reach the panel.
    await until(() => app().some((f) => f.type === "results"), "results from the core", 40_000);
    const results = app().find((f) => f.type === "results");
    expect(results).toMatchObject({ status: "ok", origin: SITE });
    const first = results.items[0];
    await until(() => panel.evaluate((k) => document.querySelector(`[data-key="${k}"]`) !== null, `open-${first.candidateId}`), "the panel to render the results");
    expect(await panel.evaluate((k) => document.querySelector(`[data-key="${k}"]`).getAttribute("aria-label"), `open-${first.candidateId}`)).toBe(`Open ${first.title} on ${first.hostname}`);
    expect(await panel.evaluate(() => document.body.innerHTML)).not.toContain(`${SITE}/docs/`); // no href before the ack
    const width = await panel.evaluate(() => [window.innerWidth, document.documentElement.scrollWidth]);
    steps.panelWidth = width;
    expect(width[1]).toBeLessThanOrEqual(width[0]); // no horizontal scroll at the panel's width

    // 4. Click: open_link → ack → a new tab on exactly the ack's target, next to the site's tab.
    const target = candidates.find((c) => c.id === first.candidateId).sourceUrl;
    const siteTab = await sw.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => ({ id: t.id, index: t.index })));
    const before = new Set((await browser.pages()).map((p) => p.target()));
    const opened = browser.waitForTarget((t) => t.type() === "page" && t.url() === target && !before.has(t), { timeout: 15_000 });
    await click(`open-${first.candidateId}`);
    await opened;
    const tabs = await until(async () => {
      const ts = await sw.evaluate((pattern) => chrome.tabs.query({ url: pattern }).then((all) => all.map((t) => ({ id: t.id, url: t.url, index: t.index, openerTabId: t.openerTabId ?? null }))), `${SITE}/*`);
      return ts.some((t) => t.url === target && t.id !== siteTab.id) ? ts : null;
    }, "the new tab to load");
    const to = tabs.filter((t) => t.id !== siteTab.id);
    expect(to).toEqual([{ id: expect.any(Number), url: target, openerTabId: siteTab.id, index: siteTab.index + 1 }]);
    expect(await site.url()).toBe(`${SITE}/docs/billing`); // the current tab never navigates
    steps.openLink = "headless";

    // 5. Pause from the panel reaches the core and the extension.
    await click("nav-settings");
    await click("pause");
    await until(() => app().some((f) => f.type === "state" && f.status === "paused"), "the core to pause");
    expect(await sw.evaluate(() => chrome.storage.local.get("paused").then((s) => s.paused))).toBe(true);
    await until(async () => (await text()).includes("Resume"), "the control to offer Resume");
    steps.pause = "headless";

    console.log(`side-panel e2e steps: ${JSON.stringify(steps)}`);
    await browser.close();
    browser = undefined;
    core.stdin.end();
    expect(await coreExit).toBe(0);
    for (const secret of ["Docs billing", `${SITE}/docs`]) expect(coreErr.includes(secret), `core stderr contains ${secret}`).toBe(false);
  }, 120_000);
});
