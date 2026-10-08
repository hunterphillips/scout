#!/usr/bin/env node
// Agent-driven manual check: a throwaway Scout (core, native host, extension) in Chrome for
// Testing, on real sites, without touching ~/.scout, the installed app or a real Chrome profile.
//
//   node scripts/manual-check/check.mjs up [--chrome <path>]     (or SCOUT_CHROME=<path>)
//   node scripts/manual-check/check.mjs grant <host>
//   node scripts/manual-check/check.mjs goto <url> [--wait <seconds>]
//   node scripts/manual-check/check.mjs activity [--chars <n>]
//   node scripts/manual-check/check.mjs status
//   node scripts/manual-check/check.mjs down
// and, to drive the browser: tabs, front <urlSubstring>, click <urlSubstring> <selector>,
// back <urlSubstring>, panel, shot <file> [urlSubstring].
//
// `up` needs `npm run build` first (core, native host, scout-mcp). It creates a throwaway
// SCOUT_HOME under $TMPDIR (macOS caps Unix socket paths at 104 bytes, so not a deep scratch
// dir), builds the extension into it with a fresh key, and writes config.json, an
// agent-profile.json naming the fake Claude CLI, fake codex/pi wrappers, the native-host
// wrapper and the NMH manifest inside a throwaway Chrome profile. It then starts a detached
// keeper process that runs the core as the Mac app does (JSONL on a stdin pipe) with every
// CONTRIBUTING override pointed into the home, a throwaway HOME and a PATH holding only node
// and /usr/bin:/bin (so the real claude, codex and pi are never found), tells it Chrome is
// frontmost, and starts Chrome for Testing in new headless with --load-extension, a CDP port,
// --use-mock-keychain and --password-store=basic (without those two, macOS asks for the
// "Chromium Safe Storage" keychain item on every launch). Headed Chrome is not an option:
// unless its window is the focused macOS window, the extension reports it unfocused and every
// page read is blocked. The browser is driven with puppeteer-core over CDP (Playwright 1.63's
// connectOverCDP hangs against Chrome for Testing 153). Headless Chrome sends a
// "HeadlessChrome" user agent; --user-agent replaces it with the plain Chrome one so sites
// serve their normal pages. The Mac app is never started (it reads only ~/.scout); the core
// never sees a real agent (no real model call can happen).
//
// State lives in <SCOUT_HOME>/manual-check.json; $TMPDIR/scout-manual-check.json points at the
// latest home, so later commands need no environment. SCOUT_HOME, when set, must name a home
// this script created (it carries the state file).
//
// `grant` answers Chrome's site prompt ahead of time (chrome.developerPrivate.addHostPermission
// from chrome://extensions), then uses the side panel's Sites > "Allow another site" as a user
// would. The real prompt never appears, so it needs a check by hand in stable Chrome.
// The side panel runs as panel.html in an ordinary tab: CDP cannot open the real side panel
// (test/side-panel.test.mjs covers that). `activity` turns on the panel's agent-context switch
// if it is off and prints the core's recent_activity through scout-mcp, as the user's agent
// would read it. `down` stops the keeper (which stops Chrome, then closes the core's stdin;
// SIGTERM to the core after 8 s), kills anything left that names the home or the extension,
// and deletes the home. Diagnostics: <SCOUT_HOME>/logs/diagnostics.jsonl.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { extensionIdFromPem, generateKeyPem, manifestKey } from "../lib/extension-key.mjs";
import { isMain } from "../lib/is-main.mjs";
import { HOST_NAME, REPO_ROOT } from "../lib/paths.mjs";

const SELF = fileURLToPath(import.meta.url);
const STATE = "manual-check.json";
const MARKER = "scout-manual-check";
const POINTER = () => join(tmpdir(), "scout-manual-check.json");
const CORE = join(REPO_ROOT, "packages/scout-core/dist/main.js");
const HOST = join(REPO_ROOT, "packages/native-host/dist/host.js");
const MCP = join(REPO_ROOT, "packages/scout-mcp/dist/main.js");
const FAKES = {
  claude: "packages/scout-core/src/agents/claudeCode/testing/fake-claude.mjs",
  codex: "packages/scout-core/src/agents/codex/testing/fake-codex.mjs",
  pi: "packages/scout-core/src/agents/pi/testing/fake-pi.mjs",
};

// ---------- pure helpers (tested) ----------

/** The newest Chrome for Testing in Playwright's cache, or null. */
export function findChromeForTesting(cacheDir = join(homedir(), "Library/Caches/ms-playwright")) {
  let dirs;
  try {
    dirs = readdirSync(cacheDir).filter((d) => /^chromium-\d+$/.test(d));
  } catch {
    return null;
  }
  dirs.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const d of dirs) {
    for (const arch of ["chrome-mac-arm64", "chrome-mac-x64", "chrome-mac"]) {
      const p = join(cacheDir, d, arch, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * Parse a scout-mcp tool result's text: `Scout <meta JSON>`, then optionally a website-authored
 * block. Returns { meta, body } (body parsed as JSON when present), or { error } for a status code.
 */
export function parseScoutToolText(text) {
  const [first] = text.split("\n", 1);
  if (!first.startsWith("Scout ")) return { error: first };
  const rest = first.slice("Scout ".length);
  if (!rest.startsWith("{")) return { error: rest };
  const meta = JSON.parse(rest);
  const m = /<website-authored ([0-9a-f]+)>\n([\s\S]*)\n<\/website-authored \1>/.exec(text);
  return { meta, body: m ? JSON.parse(m[2]) : undefined };
}

/** True when `home` is a directory this script may delete: under the temp dir, with our state file. */
export function isThrowawayHome(home, temp = tmpdir()) {
  if (!home || !existsSync(join(home, STATE))) return false;
  const real = realpathSync(home);
  const root = realpathSync(temp);
  if (!real.startsWith(root + sep)) return false;
  try {
    return JSON.parse(readFileSync(join(home, STATE), "utf8")).marker === MARKER;
  } catch {
    return false;
  }
}

/** A user agent without "HeadlessChrome", from `--version` output ("Google Chrome for Testing 153.0.1.2"). */
export function userAgentFor(versionOutput) {
  const v = /(\d+\.\d+\.\d+\.\d+)/.exec(versionOutput)?.[1] ?? "140.0.0.0";
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
}

// ---------- state ----------

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeState = (home, s) => writeFileSync(join(home, STATE), JSON.stringify(s, null, 2));

function currentHome() {
  const fromEnv = process.env.SCOUT_HOME;
  if (fromEnv) {
    if (!isThrowawayHome(fromEnv)) throw new Error(`SCOUT_HOME=${fromEnv} is not a home this script created; unset it or run \`up\``);
    return fromEnv;
  }
  if (!existsSync(POINTER())) throw new Error("no throwaway Scout is running; run `up` first");
  const { home } = readJson(POINTER());
  if (!isThrowawayHome(home)) throw new Error(`${home} is gone or not a throwaway home; run \`up\``);
  return home;
}

const state = (home = currentHome()) => readJson(join(home, STATE));
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(cond, ms, every = 200) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) if (await cond()) return true;
  return Boolean(await cond());
}
const readText = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const diagnostics = (home) =>
  readText(join(home, "logs", "diagnostics.jsonl"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

// ---------- up ----------

function fillHome(home) {
  const profile = join(home, "profile");
  const nmh = join(profile, "NativeMessagingHosts");
  const bin = join(home, "bin");
  for (const d of [nmh, bin, join(home, "pathbin"), join(home, "u"), join(home, "la"), join(home, "apps"), join(home, "skills"), join(home, "codex"), join(home, "pi")]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  symlinkSync(process.execPath, join(home, "pathbin", "node"));

  // The extension, built with a fresh key so its ID is known before Chrome loads it.
  const pem = generateKeyPem();
  const extensionId = extensionIdFromPem(pem);
  const ext = join(home, "ext");
  mkdirSync(ext);
  writeFileSync(join(ext, "manifest.json"), JSON.stringify({ key: manifestKey(pem) }));
  const built = spawnSync(process.execPath, ["build.mjs"], { cwd: join(REPO_ROOT, "packages/browser-extension"), env: { ...process.env, SCOUT_EXT_DIST: ext }, encoding: "utf8" });
  if (built.status !== 0) throw new Error(`extension build failed:\n${built.stderr}`);

  // The fake agent CLIs (FAKE_* go in the wrapper: the job launch drops unknown env keys).
  const fake = (name, rel) => {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\nFAKE_MODE=ok FAKE_LOG='${join(home, `fake-${name}.log`)}' exec '${process.execPath}' '${join(REPO_ROOT, rel)}' "$@"\n`, { mode: 0o755 });
    return p;
  };
  const claude = fake("claude", FAKES.claude);
  const codex = fake("codex", FAKES.codex);
  const pi = fake("pi", FAKES.pi);
  writeFileSync(join(home, "config.json"), JSON.stringify({ extensionId, destinations: [] }), { mode: 0o600 });
  writeFileSync(join(home, "agent-profile.json"), JSON.stringify({ schemaVersion: 1, adapter: "claude-code", claudePath: claude, model: "claude-sonnet-5-5" }), { mode: 0o600 });

  // The native host as Chrome launches it: a wrapper and a manifest in the profile's own dir.
  const wrapper = join(bin, "scout-host");
  writeFileSync(wrapper, `#!/bin/sh\nSCOUT_HOME='${home}' exec '${process.execPath}' '${HOST}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  writeFileSync(
    join(nmh, `${HOST_NAME}.json`),
    JSON.stringify({ name: HOST_NAME, description: "Scout manual check", path: wrapper, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] }),
  );

  const env = {
    PATH: `${join(home, "pathbin")}:/usr/bin:/bin`,
    HOME: join(home, "u"),
    USER: "scout-manual-check",
    LOGNAME: "scout-manual-check",
    LANG: "en_US.UTF-8",
    TMPDIR: tmpdir(),
    SCOUT_HOME: home,
    CHROME_NMH_DIR: nmh,
    LAUNCH_AGENTS_DIR: join(home, "la"),
    SCOUT_APPLICATIONS_DIR: join(home, "apps"),
    SCOUT_SKILLS_ROOT: join(home, "skills"),
    SCOUT_CLAUDE_BIN: claude,
    SCOUT_CODEX_BIN: codex,
    SCOUT_CODEX_HOME: join(home, "codex"),
    SCOUT_PI_BIN: pi,
    SCOUT_PI_AGENT_DIR: join(home, "pi"),
  };
  return { extensionId, ext, profile, env };
}

async function up(args) {
  for (const f of [CORE, HOST, MCP]) if (!existsSync(f)) throw new Error(`${f} is missing: run \`npm run build\` first`);
  const ci = args.indexOf("--chrome");
  const chrome = ci >= 0 ? args[ci + 1] : (process.env.SCOUT_CHROME ?? findChromeForTesting());
  if (!chrome || !existsSync(chrome)) throw new Error("no Chrome for Testing found: `npx playwright install chromium`, or pass --chrome <path>");
  if (existsSync(POINTER())) {
    const { home: old } = readJson(POINTER());
    if (isThrowawayHome(old) && alive(state(old).keeperPid)) throw new Error(`a throwaway Scout is already up at ${old}; run \`down\` first`);
  }
  const home = mkdtempSync(join(tmpdir(), "scout-mc-"));
  chmodSync(home, 0o700);
  const { extensionId, ext, profile, env } = fillHome(home);
  const userAgent = userAgentFor(spawnSync(chrome, ["--version"], { encoding: "utf8" }).stdout ?? "");
  writeState(home, { marker: MARKER, home, extensionId, chrome, ext, profile, env, userAgent });
  writeFileSync(POINTER(), JSON.stringify({ home }));

  const log = openSync(join(home, "keeper.log"), "a");
  const keeper = spawn(process.execPath, [SELF, "_keep", home], { detached: true, stdio: ["ignore", log, log] });
  keeper.unref();
  closeSync(log);
  const ready = await waitFor(() => state(home).cdpPort || state(home).error, 30_000);
  const s = state(home);
  if (!ready || s.error) throw new Error(`up failed: ${s.error ?? "timed out"}; see ${join(home, "keeper.log")}`);
  const connected = await waitFor(() => diagnostics(home).some((e) => e.event === "sensor_connected"), 20_000);
  console.log(
    [
      `SCOUT_HOME=${home}`,
      `extension ${extensionId}`,
      `cdp http://127.0.0.1:${s.cdpPort}`,
      `pids keeper ${s.keeperPid} core ${s.corePid} chrome ${s.chromePid}`,
      `extension connected to the core: ${connected ? "yes" : "NO (see keeper.log, core.err, chrome.log)"}`,
      `diagnostics ${join(home, "logs", "diagnostics.jsonl")}`,
    ].join("\n"),
  );
  if (!connected) process.exitCode = 1;
}

/** The detached keeper: owns the core (stdin pipe) and Chrome until SIGTERM. */
async function keep(home) {
  const s = state(home);
  const fail = (error) => {
    writeState(home, { ...state(home), error });
    process.exit(1);
  };
  const out = openSync(join(home, "core.out"), "a");
  const err = openSync(join(home, "core.err"), "a");
  const core = spawn(process.execPath, [CORE, "--stdio"], { env: s.env, cwd: REPO_ROOT, stdio: ["pipe", out, err] });
  core.stdin.on("error", () => {});
  if (!(await waitFor(() => readText(join(home, "core.err")).includes("listening on") || core.exitCode !== null, 15_000)) || core.exitCode !== null) {
    fail("the core did not start (core.err)");
  }
  core.stdin.write(`${JSON.stringify({ type: "frontmost", bundleId: "com.google.Chrome", at: Date.now() })}\n`);

  const clog = openSync(join(home, "chrome.log"), "a");
  const chrome = spawn(
    s.chrome,
    [
      "--headless",
      `--user-data-dir=${s.profile}`,
      `--disable-extensions-except=${s.ext}`,
      `--load-extension=${s.ext}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      // Without these, every launch makes macOS ask for the "Chromium Safe Storage" keychain item.
      "--use-mock-keychain",
      "--password-store=basic",
      "--window-size=1280,900",
      `--user-agent=${s.userAgent}`,
      "about:blank",
    ],
    { stdio: ["ignore", clog, clog] },
  );
  const portFile = join(s.profile, "DevToolsActivePort");
  if (!(await waitFor(() => existsSync(portFile) && readText(portFile).includes("\n"), 20_000))) fail("Chrome did not open a CDP port (chrome.log)");
  const cdpPort = Number(readText(portFile).split("\n")[0]);
  writeState(home, { ...state(home), keeperPid: process.pid, corePid: core.pid, chromePid: chrome.pid, cdpPort });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    chrome.kill("SIGTERM");
    if (!(await waitFor(() => chrome.exitCode !== null || chrome.signalCode !== null, 5_000))) chrome.kill("SIGKILL");
    core.stdin.end();
    if (!(await waitFor(() => core.exitCode !== null || core.signalCode !== null, 8_000))) core.kill("SIGTERM");
    if (!(await waitFor(() => core.exitCode !== null || core.signalCode !== null, 7_000))) core.kill("SIGKILL");
    process.exit(0);
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, stop);
  core.on("exit", () => void stop());
  chrome.on("exit", () => void stop());
}

// ---------- down ----------

const pgrep = (pattern) => {
  const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split("\n").filter(Boolean).map(Number).filter((p) => p !== process.pid) : [];
};

async function down() {
  const home = currentHome();
  const s = state(home);
  if (alive(s.keeperPid)) process.kill(s.keeperPid, "SIGTERM");
  const pids = [s.keeperPid, s.corePid, s.chromePid].filter(Boolean);
  await waitFor(() => !pids.some(alive), 20_000);
  // Anything still naming this home or this extension: Chrome helpers, a native host, the core.
  const leftovers = () => [...new Set([...pids.filter(alive), ...pgrep(home), ...pgrep(`chrome-extension://${s.extensionId}/`)])];
  for (const pid of leftovers()) process.kill(pid, "SIGKILL");
  await waitFor(() => leftovers().length === 0, 5_000);
  const left = leftovers();
  const coreEnd = readText(join(home, "core.err")).trim().split("\n").at(-1);
  if (!isThrowawayHome(home)) throw new Error(`refusing to delete ${home}`);
  rmSync(home, { recursive: true, force: true });
  if (existsSync(POINTER()) && readJson(POINTER()).home === home) rmSync(POINTER());
  console.log(`stopped (${coreEnd || "no core output"}); deleted ${home}`);
  console.log(left.length ? `STILL RUNNING: ${left.join(" ")}` : "no processes left");
  if (left.length) process.exitCode = 1;
}

// ---------- browser ----------

async function connect(s) {
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${s.cdpPort}`, defaultViewport: null });
  return { browser, pages: () => browser.pages() };
}

const panelUrl = (s) => `chrome-extension://${s.extensionId}/panel.html`;
const webPages = async (b) => (await b.pages()).filter((p) => /^https?:/.test(p.url()));
const isChecked = (page, sel) => page.$eval(sel, (e) => e.checked === true);

/**
 * The panel tab, opened if needed. Bring it to front before clicking in it: a CDP click in a
 * background tab of headless Chrome can wait forever for a frame.
 */
async function panelPage(b, s) {
  let p = (await b.pages()).find((x) => x.url().startsWith(panelUrl(s)));
  if (!p) {
    p = await b.browser.newPage();
    await p.goto(panelUrl(s));
  }
  await p.waitForSelector('[data-key="nav-sites"]', { timeout: 10_000 });
  return p;
}

/** Bring the last web page (the site tab) back in front after working in the panel tab. */
async function frontSite(b) {
  const site = (await webPages(b)).at(-1);
  if (site) await site.bringToFront();
}

async function grant(host) {
  if (!host || host.includes("/")) throw new Error("usage: grant <host>  (e.g. developers.cloudflare.com)");
  const s = state();
  const origin = `https://${host}`;
  const b = await connect(s);
  try {
    const ext = await b.browser.newPage();
    await ext.goto(`chrome://extensions/?id=${s.extensionId}`);
    const pre = await ext.evaluate(
      (id, pattern) => new Promise((r) => chrome.developerPrivate.addHostPermission(id, pattern, () => r(chrome.runtime.lastError?.message ?? "ok"))),
      s.extensionId,
      `${origin}/*`,
    );
    await ext.close();
    if (pre !== "ok") throw new Error(`developerPrivate.addHostPermission: ${pre}`);
    const panel = await panelPage(b, s);
    await panel.bringToFront();
    await panel.click('[data-key="nav-sites"]');
    await panel.waitForSelector("#site-input", { timeout: 10_000 });
    if (!(await panel.$(`[data-key="remove-${host}"]`))) {
      await panel.$eval("#site-input", (e) => (e.value = ""));
      await panel.type("#site-input", host);
      await panel.click('[data-key="site-add"]'); // a trusted click: permissions.request needs the gesture
    }
    const has = () => panel.evaluate((o) => chrome.permissions.getAll().then((p) => p.origins.includes(`${o}/*`)), origin);
    const granted = await waitFor(has, 10_000);
    const origins = await panel.evaluate(() => chrome.permissions.getAll().then((p) => p.origins));
    await frontSite(b);
    console.log(`${granted ? "granted" : "NOT granted"} ${origin}; allowed: ${origins.join(", ") || "(none)"}`);
    if (!granted) process.exitCode = 1;
  } finally {
    await b.browser.disconnect();
  }
}

const INTERESTING = new Set(["visit_change", "dwell_settled", "dwell_cancelled", "activity_accepted", "activity_cleared", "page_text_dropped", "permissions", "job_started", "job_finished", "job_cancelled", "job_skipped"]);

/** Navigate the site tab (the last web page, else the blank start tab) to `url`. */
async function gotoUrl(url, args) {
  const s = state();
  const wi = args.indexOf("--wait");
  const wait = wi >= 0 ? Number(args[wi + 1]) : 0;
  const b = await connect(s);
  try {
    const since = Date.now();
    const p = (await webPages(b)).at(-1) ?? (await b.pages()).find((x) => x.url() === "about:blank") ?? (await b.browser.newPage());
    await p.bringToFront();
    await p.goto(url, { waitUntil: "domcontentloaded" });
    console.log(`front: ${p.url()}  "${await p.title()}"`);
    if (wait > 0) {
      await sleep(wait * 1000);
      for (const e of diagnostics(s.home).filter((d) => d.t >= since && INTERESTING.has(d.event))) console.log(`  +${((e.t - since) / 1000).toFixed(1)}s ${JSON.stringify(e)}`);
    }
  } finally {
    await b.browser.disconnect();
  }
}

/** Turn on Settings > "Let your agent see …" if it is off. */
async function ensureAgentContext(b, s) {
  const panel = await panelPage(b, s);
  await panel.bringToFront();
  await panel.click('[data-key="nav-settings"]');
  const sw = '[data-key="agent-context"]';
  await panel.waitForSelector(sw, { timeout: 10_000 });
  if (!(await isChecked(panel, sw))) {
    await panel.click(sw);
    await waitFor(() => isChecked(panel, sw), 10_000);
  }
  const on = await isChecked(panel, sw);
  await panel.click('[data-key="nav-page"]');
  await frontSite(b);
  return on;
}

async function callTool(home, tool, args = {}) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP], env: { SCOUT_HOME: home, PATH: "/usr/bin:/bin" } });
  const client = new Client({ name: "scout-manual-check", version: "0" });
  await client.connect(transport);
  try {
    const r = await client.callTool({ name: tool, arguments: args });
    return parseScoutToolText(r.content?.find((c) => c.type === "text")?.text ?? "");
  } finally {
    await client.close();
  }
}

async function activity(args) {
  const s = state();
  const ci = args.indexOf("--chars");
  const chars = ci >= 0 ? Number(args[ci + 1]) : Infinity;
  const b = await connect(s);
  try {
    if (!(await ensureAgentContext(b, s))) throw new Error("the agent-context switch did not turn on");
  } finally {
    await b.browser.disconnect();
  }
  const entries = [];
  let cursor;
  do {
    const r = await callTool(s.home, "recent_activity", cursor ? { cursor } : {});
    if (r.error) throw new Error(`recent_activity: ${r.error}`);
    entries.push(...(r.body ?? []));
    cursor = r.meta.nextCursor;
  } while (cursor);
  console.log(`${entries.length} page(s) in recent activity, newest first`);
  for (const e of entries) {
    const text = e.text ?? "";
    console.log(`\n--- ${e.url}\n    title: ${e.title}\n    ${Buffer.byteLength(text)} bytes${e.textTruncated ? ", truncated" : ""}, observed ${new Date(e.observedAt).toISOString()}`);
    console.log(Number.isFinite(chars) ? text.slice(0, chars) : text);
  }
}

async function status() {
  const s = state();
  const b = await connect(s);
  try {
    const panel = await panelPage(b, s);
    await panel.bringToFront();
    await panel.click('[data-key="nav-settings"]');
    await panel.waitForSelector('[data-key="diagnostics"]', { timeout: 10_000 });
    console.log(
      await panel.$eval('[data-key="diagnostics"]', (d) => {
        d.open = true;
        return d.innerText;
      }),
    );
    await panel.click('[data-key="nav-page"]');
    await frontSite(b);
  } finally {
    await b.browser.disconnect();
  }
  console.log(`\npids keeper ${s.keeperPid}${alive(s.keeperPid) ? "" : " (gone)"} core ${s.corePid}${alive(s.corePid) ? "" : " (gone)"} chrome ${s.chromePid}${alive(s.chromePid) ? "" : " (gone)"}`);
}

async function drive(cmd, args) {
  const s = state();
  const b = await connect(s);
  const find = async (sub) => {
    const p = (await b.pages()).find((x) => x.url().includes(sub));
    if (!p) throw new Error(`no tab matching ${sub}`);
    return p;
  };
  try {
    if (cmd === "tabs") for (const p of await b.pages()) console.log(p.url());
    else if (cmd === "panel") {
      const p = await panelPage(b, s);
      console.log(await p.$eval("body", (e) => e.innerText));
    } else if (cmd === "front") {
      const p = await find(args[0]);
      await p.bringToFront();
      console.log("front:", p.url());
    } else if (cmd === "click") {
      if (!args[1]) throw new Error("usage: click <urlSubstring> <selector>");
      const p = await find(args[0]);
      await p.bringToFront();
      await p.click(args[1]);
      await sleep(1000);
      console.log("now:", p.url());
    } else if (cmd === "back") {
      const p = await find(args[0]);
      await p.bringToFront();
      await p.goBack();
      console.log("now:", p.url());
    } else if (cmd === "shot") {
      if (!args[0]) throw new Error("usage: shot <file> [urlSubstring]");
      const p = args[1] ? await find(args[1]) : ((await webPages(b)).at(-1) ?? (await b.pages())[0]);
      await p.screenshot({ path: args[0] });
      console.log("saved", args[0]);
    }
  } finally {
    await b.browser.disconnect();
  }
}

async function main(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "up":
      return up(args);
    case "_keep":
      return keep(args[0]);
    case "grant":
      return grant(args[0]);
    case "goto":
      if (!args[0]) throw new Error("usage: goto <url> [--wait <seconds>]");
      return gotoUrl(args[0], args.slice(1));
    case "activity":
      return activity(args);
    case "status":
      return status();
    case "down":
      return down();
    case "tabs":
    case "panel":
    case "front":
    case "click":
    case "back":
    case "shot":
      return drive(cmd, args);
    default:
      throw new Error("usage: check.mjs up|grant <host>|goto <url> [--wait s]|activity [--chars n]|status|down|tabs|panel|front|click|back|shot (see the header)");
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`check.mjs: ${e?.message ?? e}`);
    process.exit(1);
  });
}
