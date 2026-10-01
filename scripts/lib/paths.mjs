// Scout setup: every path setup, uninstall, and doctor read or write.
//
// Env overrides (used by tests; unset in normal use):
//   SCOUT_HOME             replaces ~/.scout
//   PERSONAL_CONTEXT_HOME  replaces ~/.personal-context-mcp
//   CHROME_NMH_DIR         replaces ~/Library/Application Support/Google/Chrome/NativeMessagingHosts
//   SCOUT_SKILLS_ROOT      replaces the Claude Code skills root (agent integration only)
//   SCOUT_CLAUDE_BIN       the `claude` executable the agent integration runs (lib/agent-integration.mjs)
// Each override moves only its own location. A Scout home that is not the real ~/.scout
// (isRealScoutHome) never authorizes touching the real Claude Code configuration.

import { homedir, userInfo } from "node:os";
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

/** True when the Scout home is the account's real ~/.scout. userInfo() reads the account record, so an overridden HOME cannot fake it. */
export function isRealScoutHome(env = process.env) {
  return resolve(scoutHome(env)) === join(userInfo().homedir, ".scout");
}

/** Where Claude Code reads user skills: SCOUT_SKILLS_ROOT, else `$CLAUDE_CONFIG_DIR/skills`, else ~/.claude/skills (as scout-core's resolveSkillsRoot). */
export function skillsRootFor(env = process.env) {
  if (env.SCOUT_SKILLS_ROOT) return resolve(env.SCOUT_SKILLS_ROOT);
  return resolve(env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, "skills") : join(env.HOME || homedir(), ".claude", "skills"));
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
    mcpMain: join(root, "packages", "scout-mcp", "dist", "main.js"),
    exportsManifest: join(home, "capabilities", "exports.json"),
  };
}
