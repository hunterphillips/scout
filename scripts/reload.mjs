#!/usr/bin/env node
// Rebuild Scout and restart the installed menu-bar app so the new core runs (macOS).
//
//   npm run reload [-- --no-build]
//
// Runs `npm run build` (skipped with --no-build), quits ~/Applications/Scout.app (the app sends
// the core a shutdown and waits up to 7 s; after 10 s it is killed), opens it again, and waits
// for the core process. The Chrome extension still needs its reload at chrome://extensions when
// panel or background code changed.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isMain } from "./lib/is-main.mjs";
import { APP_BUNDLE_ID, REPO_ROOT, applicationsDir } from "./lib/paths.mjs";

const CORE_PATTERN = "scout-core/dist/main.js --stdio";

/** Pids whose command line matches `pattern` (pgrep -f), newest last. */
const pids = (pattern) => {
  const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split("\n").filter(Boolean) : [];
};

/** Polls `cond` every 250 ms for up to `ms`; true once it holds. */
async function waitFor(cond, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (cond()) return true;
  return cond();
}

export async function runReload(argv, { out = console.log, err = console.error } = {}) {
  const unknown = argv.filter((a) => a !== "--no-build");
  if (unknown.length > 0) {
    err(`reload: unknown option ${unknown[0]}\nusage: npm run reload [-- --no-build]`);
    return 1;
  }
  if (!argv.includes("--no-build")) {
    const build = spawnSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
    if (build.status !== 0) return 1;
  }

  const app = join(applicationsDir(), "Scout.app");
  if (!existsSync(app)) {
    err(`reload: no app at ${app}; run: npm run bundle-app -- --install`);
    return 1;
  }
  const appPattern = `${app}/Contents/MacOS/`;
  if (pids(appPattern).length > 0) {
    out("quitting Scout…");
    spawnSync("osascript", ["-e", `quit app id "${APP_BUNDLE_ID}"`], { stdio: "ignore" });
    if (!(await waitFor(() => pids(appPattern).length === 0, 10_000))) {
      err("reload: Scout did not quit in 10 s; killing it");
      spawnSync("pkill", ["-f", appPattern]);
      await sleep(1000);
    }
  }

  spawnSync("open", [app]);
  if (await waitFor(() => pids(CORE_PATTERN).length > 0, 10_000)) {
    out(`Scout is running with the new core (pid ${pids(CORE_PATTERN)[0]}).`);
    return 0;
  }
  err("reload: Scout launched but no core process appeared in 10 s; check: npm run doctor");
  return 1;
}

if (isMain(import.meta.url)) process.exitCode = await runReload(process.argv.slice(2));
