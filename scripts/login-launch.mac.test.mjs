// setup --login-launch / bundle-app --install / uninstall and the override rules, against
// a temp home and a stand-in app binary. Nothing is loaded into launchd: the real-home case
// injects the bootout.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup } from "./setup.mjs";
import { runUninstall } from "./uninstall.mjs";
import { runBundle } from "./bundle-app.mjs";
import { runChecks } from "./doctor.mjs";
import { appBinary, layout } from "./lib/paths.mjs";
import { bundleHash, infoPlist, launchAgentPlist, sha256 } from "./lib/app-bundle.mjs";
import { listTree, makeFixture } from "./lib/test-fixture.mjs";

let fx, env, L, agents, apps;
beforeEach(() => {
  fx = makeFixture();
  agents = join(fx.root, "Launch Agents");
  apps = join(fx.root, "Applications");
  env = { ...fx.env, LAUNCH_AGENTS_DIR: agents, SCOUT_APPLICATIONS_DIR: apps };
  L = layout({ env, scoutRoot: fx.scoutRoot });
});
afterEach(() => fx.cleanup());

function capture() {
  const lines = [];
  const push = (s) => lines.push(String(s));
  return { lines, out: push, err: push, text: () => lines.join("\n") };
}
const setup = (args = [], e = env, extra = {}) => {
  const c = capture();
  const code = runSetup(["--scout-root", fx.scoutRoot, ...args], { env: e, out: c.out, err: c.err, claudeFallbacks: [], ...extra });
  return { code, ...c };
};
const uninstall = async (args = ["--yes"], e = env, extra = {}) => {
  const c = capture();
  const code = await runUninstall(args, { env: e, out: c.out, err: c.err, claudeFallbacks: [], ...extra });
  return { code, ...c };
};
function standIn() {
  const bin = join(fx.root, "ScoutApp");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  return bin;
}
/** A bundle with `id` as its CFBundleIdentifier (and dev.scout.app elsewhere in the plist for a foreign one). */
function fakeBundle(app, id = "dev.scout.app") {
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  const plist = infoPlist({ version: "0.0.0" }).replace("<string>dev.scout.app</string>", `<string>${id}</string>`).replace("<string>Scout</string>", "<string>dev.scout.app</string>");
  writeFileSync(join(app, "Contents", "Info.plist"), plist);
  writeFileSync(appBinary(app), "#!/bin/sh\nexit 0\n");
  chmodSync(appBinary(app), 0o755);
  return app;
}
/** setup, then bundle-app --install with a stand-in binary. */
function installApp(e = env) {
  expect(setup([], e).code).toBe(0);
  const c = capture();
  expect(runBundle(["--out", join(fx.root, "build"), "--binary", standIn(), "--install"], { ...c, env: e }), c.text()).toBe(0);
  return c;
}
const record = () => JSON.parse(readFileSync(L.installed, "utf8"));

describe("bundle-app --install", () => {
  it("copies the bundle to the applications dir, records it with its hash and the record's kinds", () => {
    const c = installApp();
    expect(c.text()).toContain(`installed ${L.installedApp}`);
    expect(existsSync(appBinary(L.installedApp))).toBe(true);
    const entry = record().files.find((f) => f.kind === "app-bundle");
    expect(entry).toEqual({ path: L.installedApp, kind: "app-bundle", sha256: bundleHash(L.installedApp) });
    expect(record().kinds).toContain("app-bundle");
    if (!spawnSync("codesign", ["--help"]).error) expect(spawnSync("codesign", ["--verify", "--deep", "--strict", L.installedApp]).status).toBe(0);
    // A re-install replaces its own unchanged copy.
    expect(runBundle(["--out", join(fx.root, "build"), "--binary", standIn(), "--install"], { ...capture(), env })).toBe(0);
  });

  it("refuses without SCOUT_APPLICATIONS_DIR on a test home, with it on the real home, and without a setup record", () => {
    expect(setup().code).toBe(0);
    const before = listTree(fx.root);
    const c = capture();
    expect(runBundle(["--out", join(fx.root, "b"), "--binary", standIn(), "--install"], { ...c, env: { ...env, SCOUT_APPLICATIONS_DIR: undefined } })).toBe(1);
    expect(c.text()).toMatch(/--install: the Scout home is not the real ~\/\.scout, so SCOUT_APPLICATIONS_DIR must name a test location/);
    const real = capture();
    expect(runBundle(["--dry-run", "--install"], { ...real, env, realHome: fx.home })).toBe(1);
    expect(real.text()).toMatch(/SCOUT_APPLICATIONS_DIR is for test installs only/);
    const none = capture();
    expect(runBundle(["--dry-run", "--install"], { ...none, env: { ...env, SCOUT_HOME: join(fx.root, "empty-home") } })).toBe(1);
    expect(none.text()).toMatch(/no install record .*run `npm run setup` first/);
    expect(listTree(fx.root).filter((f) => f !== "ScoutApp")).toEqual(before);
  });

  it("refuses to replace a copy it did not install, or one changed since", () => {
    expect(setup().code).toBe(0);
    fakeBundle(L.installedApp);
    const c = capture();
    expect(runBundle(["--out", join(fx.root, "b"), "--binary", standIn(), "--install"], { ...c, env })).toBe(1);
    expect(c.text()).toMatch(/was not installed by bundle-app; move it aside/);
  });
});

describe("setup --login-launch", () => {
  it("starts the installed app by default: a RunAtLoad LaunchAgent for its absolute binary, recorded with its hash", () => {
    installApp();
    const r = setup(["--login-launch"]);
    expect(r.code, r.text()).toBe(0);
    const text = readFileSync(L.launchAgent, "utf8");
    expect(text).toBe(launchAgentPlist({ program: appBinary(L.installedApp) }));
    expect(text).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(text).not.toContain("KeepAlive");
    const lint = spawnSync("plutil", ["-lint", L.launchAgent], { encoding: "utf8" });
    if (!lint.error) expect(lint.status, lint.stdout).toBe(0);
    expect(record().files.find((f) => f.kind === "launch-agent")).toEqual({ path: L.launchAgent, kind: "launch-agent", sha256: sha256(text), program: appBinary(L.installedApp) });
    expect(r.text()).toMatch(/takes effect at your next login/);
    expect(setup(["--login-launch"]).code).toBe(0);
    expect(record().files.filter((f) => f.kind === "launch-agent")).toHaveLength(1);
  });

  it("--app names another bundle explicitly (a build dir included); --dry-run writes nothing", () => {
    const other = fakeBundle(join(fx.scoutRoot, "native", "Scout", ".build", "Scout.app"));
    const before = listTree(fx.root);
    const dry = setup(["--dry-run", "--login-launch", "--app", other]);
    expect(dry.code, dry.text()).toBe(0);
    expect(dry.text()).toContain(`would write ${L.launchAgent} (0644): RunAtLoad ${appBinary(other)}`);
    expect(listTree(fx.root)).toEqual(before);
    expect(setup(["--login-launch", "--app", other]).code).toBe(0);
    expect(readFileSync(L.launchAgent, "utf8")).toContain(appBinary(other));
  });

  it("refuses a bundle whose CFBundleIdentifier is not dev.scout.app, even when the string appears elsewhere", () => {
    const foreign = fakeBundle(join(fx.root, "Foreign", "Scout.app"), "com.example.other");
    expect(readFileSync(join(foreign, "Contents", "Info.plist"), "utf8")).toContain("<string>dev.scout.app</string>");
    const r = setup(["--login-launch", "--app", foreign]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/is not a Scout bundle \(CFBundleIdentifier com\.example\.other/);
  });

  it("refuses without an installed app, and --app without --login-launch", () => {
    const r = setup(["--login-launch"]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/no app at .*run `npm run bundle-app -- --install` first/);
    expect(existsSync(L.scoutHome)).toBe(false);
    expect(setup(["--app", "/x/Scout.app"]).text()).toMatch(/--app goes with --login-launch/);
  });

  it("a test home needs LAUNCH_AGENTS_DIR and SCOUT_APPLICATIONS_DIR; the real ~/.scout refuses them", () => {
    fakeBundle(L.installedApp);
    let r = setup(["--login-launch"], { ...env, LAUNCH_AGENTS_DIR: undefined });
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/so LAUNCH_AGENTS_DIR must name a test location/);
    r = setup(["--login-launch"], { ...env, SCOUT_APPLICATIONS_DIR: undefined });
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/so SCOUT_APPLICATIONS_DIR must name a test location/);
    const realEnv = { ...env, CHROME_NMH_DIR: undefined, SCOUT_CLAUDE_BIN: undefined };
    r = setup(["--login-launch"], realEnv, { realHome: fx.home });
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/LAUNCH_AGENTS_DIR is for test installs only/);
    expect(existsSync(agents)).toBe(false);
  });

  it("refuses to overwrite a LaunchAgent it did not write, or one changed since", () => {
    installApp();
    mkdirSync(agents, { recursive: true });
    writeFileSync(L.launchAgent, "<plist>theirs</plist>");
    let r = setup(["--login-launch"]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/refusing to overwrite .*setup did not write it/);
    expect(readFileSync(L.launchAgent, "utf8")).toBe("<plist>theirs</plist>");

    spawnSync("rm", [L.launchAgent]);
    expect(setup(["--login-launch"]).code).toBe(0);
    writeFileSync(L.launchAgent, readFileSync(L.launchAgent, "utf8") + "<!-- mine -->");
    r = setup(["--login-launch"]);
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/changed since setup wrote it/);
  });
});

describe("doctor and the installed app", () => {
  it("FAILs when the LaunchAgent's binary is missing, telling you to re-install", () => {
    installApp();
    expect(setup(["--login-launch"]).code).toBe(0);
    spawnSync("rm", ["-rf", L.installedApp]);
    const checks = runChecks(env, { claudeFallbacks: [] }).filter((c) => c.section === "Mac app");
    expect(checks.find((c) => c.label === "login LaunchAgent starts an existing app binary")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/re-run `npm run bundle-app -- --install`/) });
    expect(checks.find((c) => c.label === "installed Scout.app")).toMatchObject({ status: "FAIL" });
  });

  it("FAILs when a recorded LaunchAgent's override rule is broken", () => {
    installApp();
    expect(setup(["--login-launch"]).code).toBe(0);
    const checks = runChecks({ ...env, LAUNCH_AGENTS_DIR: undefined }, { claudeFallbacks: [] });
    expect(checks.find((c) => c.label === "LAUNCH_AGENTS_DIR test-override rule")).toMatchObject({ status: "FAIL" });
  });
});

describe("uninstall: LaunchAgent and installed app", () => {
  it("removes both when unchanged, skips launchctl on a test home, and a second run finds nothing", async () => {
    installApp();
    expect(setup(["--login-launch"]).code).toBe(0);
    const r = await uninstall(["--yes", "--include-key"]);
    expect(r.code, r.text()).toBe(0);
    expect(existsSync(L.launchAgent)).toBe(false);
    expect(existsSync(L.installedApp)).toBe(false);
    expect(r.text()).toMatch(/skip launchctl bootout gui\/\d+\/dev\.scout\.app \(a test home; launchd is never touched\)/);
    expect(r.text()).toMatch(/remove .*dev\.scout\.app\.plist \(unchanged since setup wrote it\)/);
    expect(r.text()).toMatch(/remove .*Applications\/Scout\.app \(the app bundle-app --install copied, unchanged\)/);
    expect(existsSync(L.installed)).toBe(false);
    const again = await uninstall(["--yes", "--include-key"]);
    expect(again.code).toBe(0);
    expect(again.text()).toMatch(/Nothing to uninstall/);
  });

  it("boots the LaunchAgent out on the real home before removing it; a bootout failure is reported, not fatal", async () => {
    // The "real" home here is the fixture home: no location overrides, the default paths under it.
    const realEnv = { HOME: fx.home, PATH: fx.env.PATH, SCOUT_HOME: fx.env.SCOUT_HOME };
    const R = layout({ env: realEnv, scoutRoot: fx.scoutRoot });
    expect(setup([], realEnv, { realHome: fx.home }).code).toBe(0);
    fakeBundle(R.installedApp);
    expect(setup(["--login-launch"], realEnv, { realHome: fx.home }).code).toBe(0);
    const calls = [];
    const r = await uninstall(["--yes", "--include-key"], realEnv, { realHome: fx.home, bootout: () => (calls.push(1), { ok: false, detail: "exit 3: Boot-out failed" }) });
    expect(r.code, r.text()).toBe(0);
    expect(calls).toHaveLength(1);
    expect(r.text()).toMatch(/launchctl bootout gui\/\d+\/dev\.scout\.app did not succeed \(exit 3: Boot-out failed\)/);
    expect(existsSync(R.launchAgent)).toBe(false);
  });

  it("keeps a changed LaunchAgent and a changed app, explains, keeps them recorded, and exits 2", async () => {
    installApp();
    expect(setup(["--login-launch"]).code).toBe(0);
    writeFileSync(L.launchAgent, readFileSync(L.launchAgent, "utf8") + "<!-- mine -->");
    writeFileSync(appBinary(L.installedApp), "#!/bin/sh\necho mine\n");
    const r = await uninstall(["--yes", "--include-key"]);
    expect(r.code).toBe(2);
    expect(existsSync(L.launchAgent)).toBe(true);
    expect(existsSync(L.installedApp)).toBe(true);
    expect(r.text()).toMatch(/SKIP .*dev\.scout\.app\.plist \(changed since setup wrote it; not removing\)/);
    expect(r.text()).toMatch(/SKIP .*Scout\.app \(Scout\.app has files setup did not write; left in place\)/);
    expect(record().files.map((f) => f.kind).sort()).toEqual(["app-bundle", "launch-agent"]);
    expect(record().kinds).toEqual(["app-bundle", "launch-agent"]);
  });

  it("leaves an installed app holding an extra file in place, says so, and exits 2; removes a clean one", async () => {
    installApp();
    writeFileSync(join(L.installedApp, "Contents", "Resources", "notes.txt"), "mine\n");
    const r = await uninstall(["--yes", "--include-key"]);
    expect(r.code, r.text()).toBe(2);
    expect(existsSync(join(L.installedApp, "Contents", "Resources", "notes.txt"))).toBe(true);
    expect(r.text()).toMatch(/SKIP .*Scout\.app \(Scout\.app has files setup did not write; left in place\)/);
    expect(record().files.map((f) => f.kind)).toEqual(["app-bundle"]);
    rmSync(join(L.installedApp, "Contents", "Resources", "notes.txt"));
    const clean = await uninstall(["--yes", "--include-key"]);
    expect(clean.code, clean.text()).toBe(0);
    expect(existsSync(L.installedApp)).toBe(false);
  });

  it("refuses up front when a recorded LaunchAgent's override is missing, changing nothing", async () => {
    installApp();
    expect(setup(["--login-launch"]).code).toBe(0);
    const before = listTree(fx.root);
    const r = await uninstall(["--yes"], { ...env, LAUNCH_AGENTS_DIR: undefined });
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/uninstall: launch-agent: .*LAUNCH_AGENTS_DIR must name a test location.*Nothing changed/);
    expect(listTree(fx.root)).toEqual(before);
  });

  it("ignores a tampered entry pointing elsewhere", async () => {
    installApp();
    expect(setup(["--login-launch"]).code).toBe(0);
    const victim = join(fx.root, "victim.plist");
    writeFileSync(victim, "keep");
    const rec = record();
    rec.files = rec.files.map((f) => (f.kind === "launch-agent" ? { ...f, path: victim, sha256: sha256("keep") } : f));
    writeFileSync(L.installed, JSON.stringify(rec));
    const r = await uninstall(["--yes"]);
    expect(r.code).toBe(2);
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(r.text()).toMatch(/SKIP .*victim\.plist \(not a path setup writes for kind launch-agent/);
  });

  it("stops while Scout runs even with no wrappers, naming the lock, leaving the agent profile", async () => {
    expect(setup().code).toBe(0);
    mkdirSync(join(L.scoutHome, "capabilities"), { recursive: true, mode: 0o700 });
    writeFileSync(L.storeLock, JSON.stringify({ pid: process.pid, instanceId: "core", startedAt: 1 }));
    const r = await uninstall(["--yes", "--include-key"]);
    expect(r.code).toBe(1);
    expect(r.text()).toContain(`Scout is running (pid ${process.pid} holds ${L.storeLock}); quit Scout first. Nothing changed.`);
    expect(existsSync(L.agentProfile)).toBe(true);
    expect(existsSync(L.installed)).toBe(true);
  });

  it("removes an unchanged agent profile but keeps an edited one", async () => {
    expect(setup().code).toBe(0);
    writeFileSync(L.agentProfile, readFileSync(L.agentProfile, "utf8").replace("claude-haiku-5-5", "claude-opus-5-5"));
    const r = await uninstall(["--yes", "--include-key"]);
    expect(r.code).toBe(2);
    expect(existsSync(L.agentProfile)).toBe(true);
    expect(r.text()).toMatch(/SKIP .*agent-profile\.json \(changed since setup wrote it; not removing\)/);
  });

  it("a failure part way records what is left and says a re-run is safe", async () => {
    expect(setup().code).toBe(0);
    // A file the loop cannot unlink: its directory is read-only.
    chmodSync(L.binDir, 0o500);
    try {
      const r = await uninstall(["--yes", "--include-key"]);
      expect(r.code).toBe(1);
      expect(r.text()).toMatch(/uninstall: failed at .*scout-native-host/);
      expect(r.text()).toMatch(/re-running is safe/);
      const kinds = record().files.map((f) => f.kind);
      expect(kinds).toContain("wrapper");
      expect(kinds).toContain("nmh-manifest");
      expect(kinds).not.toContain("config");
    } finally {
      chmodSync(L.binDir, 0o700);
    }
    const again = await uninstall(["--yes", "--include-key"]);
    expect(again.code, again.text()).toBe(0);
    expect(existsSync(L.installed)).toBe(false);
  });
});
