// Scout setup: every path setup, uninstall, and doctor read or write.
//
// Env overrides (used by tests; unset in normal use):
//   SCOUT_HOME             replaces ~/.scout
//   PERSONAL_CONTEXT_HOME  replaces ~/.personal-context-mcp
//   CHROME_NMH_DIR         replaces ~/Library/Application Support/Google/Chrome/NativeMessagingHosts

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "dev.scout.bridge";
export const DEFAULT_DESTINATIONS = ["docs.stripe.com", "www.peakdesign.com"];

/** The scout/ directory this script lives in. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function scoutHome(env = process.env) {
  return env.SCOUT_HOME || join(env.HOME || homedir(), ".scout");
}

export function personalContextHome(env = process.env) {
  return env.PERSONAL_CONTEXT_HOME || join(env.HOME || homedir(), ".personal-context-mcp");
}

export function chromeNmhDir(env = process.env) {
  return env.CHROME_NMH_DIR || join(env.HOME || homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
}

/** All paths for one install, as absolute strings. */
export function layout({ env = process.env, scoutRoot = REPO_ROOT } = {}) {
  const home = resolve(scoutHome(env));
  const pcHome = resolve(personalContextHome(env));
  const nmhDir = resolve(chromeNmhDir(env));
  const root = resolve(scoutRoot);
  return {
    scoutHome: home,
    binDir: join(home, "bin"),
    runDir: join(home, "run"),
    logsDir: join(home, "logs"),
    scoutConfig: join(home, "config.json"),
    keyPem: join(home, "extension-key.pem"),
    installed: join(home, "installed.json"),
    wrapper: join(home, "bin", "scout-native-host"),
    pcHome,
    pcConfig: join(pcHome, "config.json"),
    nmhDir,
    nmhManifest: join(nmhDir, `${HOST_NAME}.json`),
    scoutRoot: root,
    extensionManifest: join(root, "packages", "browser-extension", "dist", "manifest.json"),
    hostJs: join(root, "packages", "native-host", "dist", "host.js"),
    coreMain: join(root, "packages", "scout-core", "dist", "main.js"),
  };
}
