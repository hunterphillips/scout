// Scout setup: every path setup, uninstall, and doctor read or write.
//
// Env overrides (used by tests; unset in normal use):
//   SCOUT_HOME             replaces ~/.scout
//   CHROME_NMH_DIR         replaces ~/Library/Application Support/Google/Chrome/NativeMessagingHosts
//   SCOUT_SKILLS_ROOT      replaces the Claude Code skills root (agent integration only)
//   SCOUT_CLAUDE_BIN       the `claude` executable the agent integration runs (lib/agent-integration.mjs)
//   LAUNCH_AGENTS_DIR      replaces ~/Library/LaunchAgents (setup --login-launch only; lib/app-bundle.mjs)
//   SCOUT_APPLICATIONS_DIR replaces ~/Applications (bundle-app --install, setup --login-launch)
// Each override moves only its own location. A Scout home that is not the real ~/.scout
// (isRealScoutHome) never authorizes touching the real Claude Code configuration, and the
// agent integration refuses SCOUT_SKILLS_ROOT / SCOUT_CLAUDE_BIN on the real ~/.scout.
// CHROME_NMH_DIR, LAUNCH_AGENTS_DIR and SCOUT_APPLICATIONS_DIR follow one rule
// (overrideRefusal): required with a test home, refused with the real ~/.scout.

import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "dev.scout.bridge";
/** The app bundle's CFBundleIdentifier and the login LaunchAgent's label. */
export const APP_BUNDLE_ID = "dev.scout.app";
/**
 * Hosts where background recommendations run (pivot P3.2). Empty by default: the plan
 * says per-origin enablement starts off, and a destination makes the core spend the
 * user's quota on every settled visit there. docs.stripe.com and www.peakdesign.com are
 * the acceptance examples a user may add to ~/.scout/config.json.
 */
export const DEFAULT_DESTINATIONS = [];

/** The scout/ directory this script lives in. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function scoutHome(env = process.env) {
  return env.SCOUT_HOME || join(env.HOME || homedir(), ".scout");
}

export function chromeNmhDir(env = process.env) {
  return env.CHROME_NMH_DIR || join(env.HOME || homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
}

export function launchAgentsDir(env = process.env) {
  return env.LAUNCH_AGENTS_DIR || join(env.HOME || homedir(), "Library", "LaunchAgents");
}

export function applicationsDir(env = process.env) {
  return env.SCOUT_APPLICATIONS_DIR || join(env.HOME || homedir(), "Applications");
}

/**
 * The rule for a location override `name` (CHROME_NMH_DIR, LAUNCH_AGENTS_DIR,
 * SCOUT_APPLICATIONS_DIR): required with a test home, so a test can never reach the real
 * location, and refused with the real ~/.scout. Returns the refusal, or null.
 */
export function locationOverrideRefusal(name, env = process.env, realHome) {
  const real = isRealScoutHome(env, realHome);
  if (real && env[name]) return `${name} is for test installs only and refused with the real ~/.scout; unset it and re-run`;
  if (!real && !env[name]) return `the Scout home is not the real ~/.scout, so ${name} must name a test location (a test install never touches the real one)`;
  return null;
}

/** Where `npm run bundle-app` builds Scout.app by default (gitignored). */
export function defaultAppBundle(scoutRoot = REPO_ROOT) {
  return join(resolve(scoutRoot), "native", "Scout", ".build", "Scout.app");
}

/** The executable inside a Scout.app bundle. */
export function appBinary(appBundle) {
  return join(appBundle, "Contents", "MacOS", "Scout");
}

/**
 * True when the Scout home is the account's real ~/.scout. userInfo() reads the account record,
 * so an overridden HOME cannot fake it. `realHome` replaces that account home (tests only).
 */
export function isRealScoutHome(env = process.env, realHome = userInfo().homedir) {
  return resolve(scoutHome(env)) === join(realHome, ".scout");
}

/** Where Claude Code reads user skills: SCOUT_SKILLS_ROOT, else `$CLAUDE_CONFIG_DIR/skills`, else ~/.claude/skills (as scout-core's resolveSkillsRoot). */
export function skillsRootFor(env = process.env) {
  if (env.SCOUT_SKILLS_ROOT) return resolve(env.SCOUT_SKILLS_ROOT);
  return resolve(env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, "skills") : join(env.HOME || homedir(), ".claude", "skills"));
}

/** All paths for one install, as absolute strings. */
export function layout({ env = process.env, scoutRoot = REPO_ROOT } = {}) {
  const home = resolve(scoutHome(env));
  // The legacy personal-context home (removed in P4.4). Setup never writes it; uninstall and
  // doctor only recognise a pre-P4.3 `config-merged` record pointing at its config.json.
  const legacyPcHome = resolve(join(env.HOME || homedir(), ".personal-context-mcp"));
  const nmhDir = resolve(chromeNmhDir(env));
  const agentsDir = resolve(launchAgentsDir(env));
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
    legacyPcHome,
    legacyPcConfig: join(legacyPcHome, "config.json"),
    nmhDir,
    nmhManifest: join(nmhDir, `${HOST_NAME}.json`),
    scoutRoot: root,
    extensionManifest: join(root, "packages", "browser-extension", "dist", "manifest.json"),
    hostJs: join(root, "packages", "native-host", "dist", "host.js"),
    coreMain: join(root, "packages", "scout-core", "dist", "main.js"),
    mcpMain: join(root, "packages", "scout-mcp", "dist", "main.js"),
    exportsManifest: join(home, "capabilities", "exports.json"),
    storeLock: join(home, "capabilities", "store.lock"),
    coreSock: join(home, "run", "core.sock"),
    agentSock: join(home, "run", "agent.sock"),
    agentToken: join(home, "run", "agent-token"),
    agentProfile: join(home, "agent-profile.json"),
    diagnosticsLog: join(home, "logs", "diagnostics.jsonl"),
    launchAgentsDir: agentsDir,
    launchAgent: join(agentsDir, `${APP_BUNDLE_ID}.plist`),
    appBundle: defaultAppBundle(root),
    applicationsDir: resolve(applicationsDir(env)),
    installedApp: join(resolve(applicationsDir(env)), "Scout.app"),
    coreCli: join(root, "packages", "scout-core", "dist", "cli.js"),
  };
}
