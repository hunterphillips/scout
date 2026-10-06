#!/usr/bin/env node
// Build Scout.app: a launchable, windowless (menu-bar only) bundle of the Swift app.
//
//   npm run bundle-app [-- --out <dir>] [--dry-run] [--binary <path>] [--install]
//
// Runs `swift build -c release --product ScoutApp` in native/Scout, then assembles
// `<out>/Scout.app/Contents/{MacOS/Scout, Info.plist, PkgInfo, Resources/}` (lib/app-bundle.mjs
// has the plist) and signs it ad hoc (`codesign --force --deep -s -`), so its code identity
// stays the same across rebuilds of an unchanged binary. `<out>` defaults to native/Scout/.build
// (gitignored). The bundle is assembled in a staging dir inside `<out>`; an existing
// `<out>/Scout.app` is replaced only when its CFBundleIdentifier (plutil) is dev.scout.app, by
// moving it into the staging dir and renaming the new one into place. Apart from SwiftPM's own
// build directory, nothing is written outside `<out>` (and, with --install, the install location).
//
// --install copies the finished bundle to ~/Applications/Scout.app (SCOUT_APPLICATIONS_DIR:
// required with a test Scout home, refused with the real ~/.scout), the stable path the login
// LaunchAgent starts, and records it in installed.json (kind app-bundle, hash of every file in the
// bundle; `npm run setup` must have run). An existing copy is replaced only while it still
// matches the recorded hash; uninstall removes it on the same condition.
//
// The bundle holds only the app binary: at launch the app reads ~/.scout/config.json for the
// absolute nodePath and scoutRoot that `npm run setup` recorded, and runs the built core from
// there, so it never depends on Finder's PATH.
//
// --binary <path> skips the Swift build and bundles that executable (tests; a prebuilt binary).

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { APP_BUNDLE_ID, REPO_ROOT, layout } from "./lib/paths.mjs";
import { APP_EXECUTABLE, APP_NAME, bundleHash, applicationsRefusal, infoPlist, isScoutBundle } from "./lib/app-bundle.mjs";
import { readInstalled, saveInstalled, upsertEntry } from "./lib/installed.mjs";
import { isExecutableFile } from "./lib/executables.mjs";
import { isMain } from "./lib/is-main.mjs";

const PACKAGE_DIR = join(REPO_ROOT, "native", "Scout");
export const DEFAULT_OUT = join(PACKAGE_DIR, ".build");

export function parseArgs(argv) {
  const opts = { out: DEFAULT_OUT, dryRun: false, binary: null, install: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--install") opts.install = true;
    else if (a === "--out" || a === "--binary") {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a path`);
      opts[a.slice(2)] = resolve(v);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function bundleVersion() {
  const v = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
  return /^\d+(\.\d+){0,2}$/.test(v) ? v : "0.0.0";
}

/**
 * Put `staged` at `dest`: an existing `dest` is first moved into `stagingDir` (same filesystem),
 * then `staged` is renamed into place, so `dest` is never half-written; `stagingDir` is removed.
 */
function replaceInto(staged, dest, stagingDir) {
  if (existsSync(dest)) renameSync(dest, join(stagingDir, "previous.app"));
  renameSync(staged, dest);
  rmSync(stagingDir, { recursive: true, force: true });
}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

/** Returns the exit code. `out`/`err` print lines. */
export function runBundle(argv, { out = console.log, err = console.error, env = process.env, realHome } = {}) {
  let opts, install;
  try {
    opts = parseArgs(argv);
    if (opts.install) install = planInstall(env, realHome);
  } catch (e) {
    err(`bundle-app: ${e.message}`);
    return 1;
  }
  const app = join(opts.out, `${APP_NAME}.app`);
  const plist = infoPlist({ version: bundleVersion() });
  const build = ["build", "-c", "release", "--product", "ScoutApp"];

  if (opts.dryRun) {
    out("Dry run: nothing is built or written.");
    out(opts.binary ? `would bundle the given binary ${opts.binary}` : `would run: swift ${build.join(" ")} (in ${PACKAGE_DIR})`);
    out(`would write ${join(app, "Contents", "MacOS", APP_EXECUTABLE)} (0755)`);
    out(`would write ${join(app, "Contents", "Info.plist")}:`);
    for (const line of plist.trimEnd().split("\n")) out(`  ${line}`);
    out(`would write ${join(app, "Contents", "PkgInfo")} and ${join(app, "Contents", "Resources")}/`);
    out(`would sign ad hoc: codesign --force --deep -s - ${app}`);
    if (install) out(`would install a copy at ${install.dest} (${install.replace ? "replacing this install's unchanged copy" : "new"}) and record it in ${install.L.installed}`);
    return 0;
  }

  if (existsSync(app) && !isScoutBundle(app)) {
    err(`bundle-app: ${app} exists and is not a Scout bundle (its CFBundleIdentifier is not ${APP_BUNDLE_ID}); move it aside and re-run`);
    return 1;
  }

  let binary = opts.binary;
  if (!binary) {
    out(`swift ${build.join(" ")} (in ${PACKAGE_DIR})`);
    const b = run("swift", build, { cwd: PACKAGE_DIR, stdio: ["ignore", "inherit", "inherit"] });
    if (b.status !== 0) {
      err(`bundle-app: swift build failed (${b.error ? b.error.message : `exit ${b.status}`})`);
      return 1;
    }
    const bin = run("swift", [...build.slice(0, 3), "--show-bin-path"], { cwd: PACKAGE_DIR });
    binary = join(bin.stdout.trim(), "ScoutApp");
  }
  if (!isAbsolute(binary) || !isExecutableFile(binary)) {
    err(`bundle-app: not an executable file: ${binary}`);
    return 1;
  }

  const stagingDir = join(opts.out, `.scout-bundle-${process.pid}.tmp`);
  const staging = join(stagingDir, `${APP_NAME}.app`);
  try {
    mkdirSync(opts.out, { recursive: true });
    rmSync(stagingDir, { recursive: true, force: true });
    const contents = join(staging, "Contents");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(join(contents, "Resources"), { recursive: true });
    copyFileSync(binary, join(contents, "MacOS", APP_EXECUTABLE));
    chmodSync(join(contents, "MacOS", APP_EXECUTABLE), 0o755);
    writeFileSync(join(contents, "Info.plist"), plist, { mode: 0o644 });
    writeFileSync(join(contents, "PkgInfo"), "APPL????", { mode: 0o644 });
    const sign = run("codesign", ["--force", "--deep", "-s", "-", staging]);
    if (sign.status !== 0) {
      err(`bundle-app: codesign failed (${sign.error ? sign.error.message : (sign.stderr || `exit ${sign.status}`).trim()})`);
      rmSync(stagingDir, { recursive: true, force: true });
      return 1;
    }
    replaceInto(staging, app, stagingDir);
  } catch (e) {
    rmSync(stagingDir, { recursive: true, force: true });
    err(`bundle-app: ${e.message}`);
    return 1;
  }
  const size = statSync(join(app, "Contents", "MacOS", APP_EXECUTABLE)).size;
  out(`built ${app} (${APP_BUNDLE_ID}, menu-bar only, ad hoc signed, binary ${size} bytes)`);
  if (install) {
    try {
      installCopy(app, install, out);
    } catch (e) {
      err(`bundle-app: install failed: ${e.message}`);
      return 1;
    }
  }
  out("The app reads ~/.scout/config.json at launch; run `npm run setup` first. Optional: `npm run setup -- --login-launch` starts the installed app at login.");
  return 0;
}

/** Check everything --install needs before building: the override rule, a setup record, the destination. */
function planInstall(env, realHome) {
  const refusal = applicationsRefusal(env, realHome);
  if (refusal) throw new Error(`--install: ${refusal}`);
  const L = layout({ env });
  const record = readInstalled(L.installed);
  if (!record) throw new Error(`--install: no install record at ${L.installed}; run \`npm run setup\` first`);
  const dest = L.installedApp;
  const recorded = record.files.find((f) => f.kind === "app-bundle" && f.path === dest);
  let replace = false;
  if (existsSync(dest)) {
    if (!recorded || bundleHash(dest) !== recorded.sha256) {
      throw new Error(`--install: ${dest} exists and ${recorded ? "changed since bundle-app installed it" : "was not installed by bundle-app"}; move it aside and re-run`);
    }
    replace = true;
  }
  return { L, dest, replace };
}

/** Copy the built bundle to the install location (ditto keeps the signature) and record it. */
function installCopy(app, { L, dest }, out) {
  mkdirSync(L.applicationsDir, { recursive: true });
  const stagingDir = join(L.applicationsDir, `.scout-install-${process.pid}.tmp`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir);
  try {
    const staged = join(stagingDir, `${APP_NAME}.app`);
    const r = run("ditto", [app, staged]);
    if (r.status !== 0) throw new Error(`ditto failed (${r.error ? r.error.message : (r.stderr || `exit ${r.status}`).trim()})`);
    const hash = bundleHash(staged);
    if (!hash) throw new Error("the copied bundle has no Info.plist or binary");
    replaceInto(staged, dest, stagingDir);
    const record = readInstalled(L.installed);
    saveInstalled(L.installed, upsertEntry(record, { path: dest, kind: "app-bundle", sha256: hash }));
    out(`installed ${dest} and recorded it in ${L.installed}`);
  } catch (e) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw e;
  }
}

if (isMain(import.meta.url)) process.exitCode = runBundle(process.argv.slice(2));
