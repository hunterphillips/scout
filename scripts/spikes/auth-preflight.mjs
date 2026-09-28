#!/usr/bin/env node
// Scout Phase 0 billing preflight. Runs NO model calls.
//
// Question answered: would a `claude` child process, started with the
// proposed child environment, bill a claude.ai subscription?
//
// Verdict is "subscription" only when every applicable env/settings source is
// free of API-key, auth-token, apiKeyHelper, provider-flag and non-Anthropic
// base-URL routes AND `claude auth status --json` (run in that same child
// environment) reports a first-party claude.ai login. Anything else, including
// any read/parse/shape uncertainty, is "ambiguous" with a nonzero exit.
//
// Output is a JSON report of presence flags, key names and fixed reason codes.
// It never contains env values, file contents, URLs, commands, credentials or
// account identity.

import { spawnSync } from "node:child_process";
import * as realFs from "node:fs";
import { accessSync, constants as fsc, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The only claude invocations this script may make. Enforced in runClaude.
const ALLOWED_CLAUDE_ARGS = [
  ["--version"],
  ["auth", "--help"],
  ["auth", "status", "--help"],
  ["auth", "status", "--json"],
];

// The child is started with the parent environment, unmodified. Auth status
// runs with exactly this environment, so the check covers the real child.
// (launch-profile.mjs passes an explicit `child` profile instead; see runPreflight.)
export const CHILD_ENV_STRATEGY = "inherit-parent-env-unmodified";

const KNOWN = {
  authMethod: new Set(["claude.ai", "console", "api_key", "apiKey", "oauth_token", "none", "gateway"]),
  apiProvider: new Set(["firstParty", "bedrock", "vertex", "foundry"]),
  subscriptionType: new Set(["pro", "max", "team", "enterprise"]),
};
const SUBSCRIPTION_TYPES = KNOWN.subscriptionType;

// ---------- environment ----------

// Model-selection names: presence is reported but does not change routing.
const MODEL_NAME_RE = /^ANTHROPIC_(MODEL|SMALL_FAST_MODEL|DEFAULT_[A-Z0-9]+_MODEL)$/;
const NESTED_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

function isRelevantName(name) {
  return name.startsWith("ANTHROPIC_") || name.startsWith("CLAUDE_CODE_USE_");
}

/** Classify a base URL without ever returning it. */
export function classifyBaseUrl(value) {
  if (typeof value !== "string") return "unparseable";
  let u;
  try {
    u = new URL(value);
  } catch {
    return "unparseable";
  }
  if (u.protocol === "https:" && u.hostname === "api.anthropic.com" && (u.port === "" || u.port === "443")) {
    return "anthropic";
  }
  const h = u.hostname.replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || /^127\./.test(h)) return "non-anthropic-loopback";
  return "non-anthropic-remote";
}

/**
 * Inspect one env-like map (process env or a settings `env` block).
 * Returns names only plus route flags; values are read in memory only.
 */
export function inspectEnvMap(env) {
  const names = Object.keys(env).filter(isRelevantName).sort();
  const route = {
    apiKey: false,
    authToken: false,
    providerFlags: [],
    baseUrl: "unset",
    modelNames: [],
    otherAnthropicNames: [],
  };
  for (const name of names) {
    if (name === "ANTHROPIC_API_KEY") route.apiKey = true;
    else if (name === "ANTHROPIC_AUTH_TOKEN") route.authToken = true;
    else if (name === "ANTHROPIC_BASE_URL") route.baseUrl = classifyBaseUrl(env[name]);
    else if (name.startsWith("CLAUDE_CODE_USE_")) route.providerFlags.push(name);
    else if (MODEL_NAME_RE.test(name)) route.modelNames.push(name);
    else route.otherAnthropicNames.push(name);
  }
  return { names, route };
}

/** Reasons (fixed codes) that an env route blocks a subscription verdict. */
function routeReasons(route, where) {
  const r = [];
  if (route.apiKey) r.push(`${where}: ANTHROPIC_API_KEY present`);
  if (route.authToken) r.push(`${where}: ANTHROPIC_AUTH_TOKEN present`);
  for (const f of route.providerFlags) r.push(`${where}: provider flag ${f} present`);
  if (route.baseUrl !== "unset" && route.baseUrl !== "anthropic") {
    r.push(`${where}: ANTHROPIC_BASE_URL is ${route.baseUrl}`);
  }
  // Unrecognized ANTHROPIC_* names may reroute or authenticate: fail closed.
  for (const n of route.otherAnthropicNames) r.push(`${where}: unrecognized ${n} present`);
  return r;
}

// ---------- settings files ----------

/**
 * Documented managed-settings locations for the installed CLI (2.1.x).
 * `files` are JSON; `dropInDirs` hold *.json fragments; `opaque` are MDM
 * plists this script does not parse, so their presence fails closed.
 * The remote (server-managed) cache in the config dir is read as JSON too.
 */
export function managedPathsFor(platform, configDir, user) {
  const remote = join(configDir, "remote-settings.json");
  if (platform === "darwin") {
    const base = "/Library/Application Support/ClaudeCode";
    return {
      files: [join(base, "managed-settings.json"), remote],
      dropInDirs: [join(base, "managed-settings.d")],
      opaque: [
        "/Library/Managed Preferences/com.anthropic.claudecode.plist",
        join("/Library/Managed Preferences", user, "com.anthropic.claudecode.plist"),
      ],
    };
  }
  if (platform === "linux") {
    return {
      files: ["/etc/claude-code/managed-settings.json", remote],
      dropInDirs: ["/etc/claude-code/managed-settings.d"],
      opaque: [],
    };
  }
  return { files: [remote], dropInDirs: [], opaque: [], unsupported: true };
}

/**
 * Project settings candidates: child cwd and every ancestor (fail closed).
 * `stopAt` (tests only, via the API) ends the walk at that directory.
 */
function projectSettingsPaths(cwd, userConfigDir, stopAt) {
  const out = [];
  let dir = resolve(cwd);
  for (;;) {
    const claudeDir = join(dir, ".claude");
    if (resolve(claudeDir) !== resolve(userConfigDir)) {
      out.push(join(claudeDir, "settings.json"), join(claudeDir, "settings.local.json"));
    }
    const parent = dirname(dir);
    if (parent === dir || (stopAt !== undefined && dir === resolve(stopAt))) return out;
    dir = parent;
  }
}

const isMissing = (e) => e?.code === "ENOENT" || e?.code === "ENOTDIR";

/** Read one settings file. Reports only status, apiKeyHelper presence and env key names. */
export function inspectSettingsFile(path, scope, fs = realFs) {
  const entry = { scope, path, status: "absent" };
  let text;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (e) {
    if (!isMissing(e)) entry.status = "unreadable";
    return entry;
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    entry.status = "malformed"; // parse error text may quote content: dropped
    return entry;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) {
    entry.status = "malformed";
    return entry;
  }
  if (j.env !== undefined && (!j.env || typeof j.env !== "object" || Array.isArray(j.env))) {
    entry.status = "malformed";
    entry.apiKeyHelper = Object.hasOwn(j, "apiKeyHelper");
    return entry;
  }
  entry.status = "ok";
  entry.apiKeyHelper = Object.hasOwn(j, "apiKeyHelper");
  entry.envKeys = Object.keys(j.env ?? {}).sort();
  entry.route = inspectEnvMap(j.env ?? {}).route;
  return entry;
}

function settingsReasons(entry) {
  const where = `${entry.scope} settings ${entry.path}`;
  if (entry.status === "unreadable" || entry.status === "malformed") return [`${where}: ${entry.status}`];
  if (entry.status === "present-not-inspected") return [`${where}: present but not inspected`];
  if (entry.status !== "ok") return [];
  const r = entry.apiKeyHelper ? [`${where}: apiKeyHelper present`] : [];
  return r.concat(routeReasons(entry.route, where));
}

function inspectAllSettings({ env, cwd, platform, managedPaths, projectStopAt, username, fs }) {
  const reasons = [];
  const home = env.HOME;
  if (typeof home !== "string" || !isAbsolute(home)) {
    return { reasons: ["settings: HOME is unset or not absolute"], entries: [] };
  }
  let configDir = join(home, ".claude");
  if (env.CLAUDE_CONFIG_DIR !== undefined) {
    if (!isAbsolute(env.CLAUDE_CONFIG_DIR)) {
      return { reasons: ["settings: CLAUDE_CONFIG_DIR is set but not an absolute path"], entries: [] };
    }
    configDir = env.CLAUDE_CONFIG_DIR;
  }
  let managed = managedPaths;
  if (!managed) {
    // Per-user MDM policy is keyed by the OS account, not by HOME.
    let user = username;
    try {
      user ??= userInfo().username;
    } catch {
      // handled below
    }
    if (typeof user !== "string" || user === "" || user.includes("/")) {
      return { reasons: ["settings: cannot determine OS username for per-user managed policy"], entries: [], configDir };
    }
    managed = managedPathsFor(platform, configDir, user);
  }
  if (managed.unsupported) reasons.push(`settings: managed settings locations unknown on ${platform}`);

  const entries = [
    inspectSettingsFile(join(configDir, "settings.json"), "user", fs),
    inspectSettingsFile(join(configDir, "settings.local.json"), "user", fs),
    ...projectSettingsPaths(cwd, configDir, projectStopAt).map((p) => inspectSettingsFile(p, "project", fs)),
    ...managed.files.map((p) => inspectSettingsFile(p, "managed", fs)),
  ];
  for (const dir of managed.dropInDirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      if (!isMissing(e)) entries.push({ scope: "managed", path: dir, status: "unreadable" });
      continue;
    }
    for (const n of names.filter((x) => x.endsWith(".json")).sort()) {
      entries.push(inspectSettingsFile(join(dir, n), "managed", fs));
    }
  }
  for (const p of managed.opaque) {
    try {
      fs.statSync(p);
      entries.push({ scope: "managed", path: p, status: "present-not-inspected" });
    } catch (e) {
      if (!isMissing(e)) entries.push({ scope: "managed", path: p, status: "unreadable" });
    }
  }
  for (const e of entries) reasons.push(...settingsReasons(e));
  return { reasons, entries: entries.filter((e) => e.status !== "absent"), configDir };
}

function samePath(a, b) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

// ---------- claude CLI ----------

/** Resolve `claude` to an absolute path from PATH. No config writes. */
export function resolveOnPath(cmd, pathValue) {
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, cmd);
    try {
      if (statSync(p).isFile()) {
        accessSync(p, fsc.X_OK);
        return p;
      }
    } catch {
      // not here
    }
  }
  return undefined;
}

function runClaude(claudePath, args, { env, cwd, timeoutMs }) {
  if (!ALLOWED_CLAUDE_ARGS.some((a) => a.length === args.length && a.every((x, i) => x === args[i]))) {
    throw new Error("refusing non-allowlisted claude invocation");
  }
  const r = spawnSync(claudePath, args, {
    env,
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL", // read-only checks: force termination on timeout
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // stderr is discarded unread: it may carry identity or config detail.
  return { ok: !r.error && r.status === 0, status: r.status, timedOut: r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL", stdout: r.stdout ?? "" };
}

/** Parse `claude auth status --json` output; expose only non-identity fields. */
export function parseAuthStatus(stdout) {
  let j;
  try {
    j = JSON.parse(stdout);
  } catch {
    return { parsed: false };
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { parsed: false };
  const pick = (k) => (typeof j[k] === "string" ? (KNOWN[k].has(j[k]) ? j[k] : "other") : j[k] === undefined ? "absent" : "other");
  return {
    parsed: true,
    loggedIn: j.loggedIn === true ? true : j.loggedIn === false ? false : "other",
    authMethod: pick("authMethod"),
    apiProvider: pick("apiProvider"),
    subscriptionType: pick("subscriptionType"),
    configDirectory: typeof j.configDirectory === "string" ? j.configDirectory : undefined, // in-memory only
  };
}

function isExecutableFile(p) {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsc.X_OK);
    return true;
  } catch {
    return false;
  }
}

function inspectCli({ env, cwd, timeoutMs, fixedClaudePath }) {
  const reasons = [];
  const cli = { resolved: false };
  let claudePath;
  if (fixedClaudePath !== undefined) {
    // A launch profile pins the binary: audit that exact file, never a PATH lookup.
    if (typeof fixedClaudePath !== "string" || !isAbsolute(fixedClaudePath) || !isExecutableFile(fixedClaudePath)) {
      reasons.push("cli: profile claude path is not an absolute executable file");
      return { cli, reasons };
    }
    claudePath = fixedClaudePath;
  } else {
    claudePath = resolveOnPath("claude", env.PATH);
  }
  if (!claudePath) {
    reasons.push("cli: claude not found on PATH");
    return { cli, reasons };
  }
  cli.resolved = true;
  cli.path = claudePath;

  const version = runClaude(claudePath, ["--version"], { env, cwd, timeoutMs });
  const m = version.ok && /^(\d+\.\d+\.\d+)/.exec(version.stdout.trim());
  cli.version = m ? m[1] : "unknown";

  const authHelp = runClaude(claudePath, ["auth", "--help"], { env, cwd, timeoutMs });
  const statusHelp = runClaude(claudePath, ["auth", "status", "--help"], { env, cwd, timeoutMs });
  const hasStatus = authHelp.ok && /^\s+status\b/m.test(authHelp.stdout);
  const hasJson = statusHelp.ok && /^\s+--json\b/m.test(statusHelp.stdout);
  if (!hasStatus || !hasJson) {
    cli.statusCommand = "unsupported";
    reasons.push("cli: `claude auth status --json` not confirmed by --help");
    return { cli, reasons };
  }
  cli.statusCommand = "auth status --json";

  const st = runClaude(claudePath, ["auth", "status", "--json"], { env, cwd, timeoutMs });
  if (!st.ok) {
    cli.statusExit = st.timedOut ? "timeout" : st.status;
    reasons.push("cli: auth status exited unsuccessfully");
    return { cli, reasons };
  }
  const parsed = parseAuthStatus(st.stdout);
  if (!parsed.parsed) {
    reasons.push("cli: auth status output was not a JSON object");
    return { cli, reasons };
  }
  const { configDirectory, parsed: _p, ...safe } = parsed;
  cli.status = safe;
  if (safe.loggedIn !== true) reasons.push("cli: not logged in");
  if (safe.authMethod !== "claude.ai") reasons.push(`cli: login method is ${safe.authMethod}, not claude.ai`);
  if (safe.apiProvider !== "firstParty") reasons.push(`cli: api provider is ${safe.apiProvider}, not firstParty`);
  if (!SUBSCRIPTION_TYPES.has(safe.subscriptionType)) {
    reasons.push(`cli: subscription type is ${safe.subscriptionType}`);
  }
  return { cli, reasons, configDirectory };
}

// ---------- orchestration ----------

/**
 * Run the preflight. All inputs are injectable so tests stay hermetic.
 * Test seams (API only; the CLI entrypoint never sets them): `managedPaths`
 * replaces the platform-derived managed locations, `projectStopAt` bounds the
 * ancestor walk, `username` replaces os.userInfo(), `fs` wraps settings reads,
 * `timeoutMs` bounds each claude invocation.
 *
 * `child` (optional) is an explicit launch profile: its env replaces the
 * inherited one and its absolute claude path is audited instead of a PATH
 * lookup. `cwd` is then the profile's cwd. Every env, settings (user, project,
 * managed) and CLI check below still runs, against that exact child.
 * @param {{ env: Record<string,string|undefined>, cwd: string, platform?: string,
 *           managedPaths?: { files: string[], dropInDirs: string[], opaque: string[], unsupported?: boolean },
 *           projectStopAt?: string, username?: string, fs?: typeof realFs, timeoutMs?: number,
 *           child?: { env: Record<string,string>, claudePath: string, strategy: string } }} deps
 */
export function runPreflight({
  env,
  cwd,
  platform = process.platform,
  managedPaths,
  projectStopAt,
  username,
  fs = realFs,
  timeoutMs = 20_000,
  child,
}) {
  const reasons = [];
  const childEnv = child ? { ...child.env } : { ...env }; // CHILD_ENV_STRATEGY unless a profile is given
  const parentEnv = inspectEnvMap(env);
  const childEnvInfo = inspectEnvMap(childEnv);
  reasons.push(...routeReasons(childEnvInfo.route, "child env"));

  // Settings are resolved from the child's env and cwd: they apply to the
  // child even though no env var names them.
  const settings = inspectAllSettings({ env: childEnv, cwd, platform, managedPaths, projectStopAt, username, fs });
  reasons.push(...settings.reasons);

  // Already ambiguous: don't run claude at all. Auth status could execute an
  // apiKeyHelper, and its answer could not change the verdict.
  const cliResult =
    reasons.length > 0
      ? { cli: { status: "skipped", skippedBecause: "env/settings already ambiguous" }, reasons: [] }
      : inspectCli({ env: childEnv, cwd, timeoutMs, fixedClaudePath: child ? child.claudePath : undefined });
  reasons.push(...cliResult.reasons);
  if (cliResult.configDirectory !== undefined && (!settings.configDir || !samePath(cliResult.configDirectory, settings.configDir))) {
    reasons.push("cli: auth status reports a different config directory than the one inspected");
  }

  return {
    verdict: reasons.length === 0 ? "subscription" : "ambiguous",
    reasons,
    inference: "none",
    childEnvStrategy: child ? child.strategy : CHILD_ENV_STRATEGY,
    env: { parent: parentEnv, child: childEnvInfo },
    nestedSessionMarkers: Object.fromEntries(NESTED_MARKERS.map((n) => [n, n in env])),
    nestedSessionMarkersInChild: Object.fromEntries(NESTED_MARKERS.map((n) => [n, n in childEnv])),
    configDir: settings.configDir,
    settings: settings.entries,
    cli: cliResult.cli,
  };
}

/** Build the report text and exit code. Never throws. */
export function main(deps = { env: process.env, cwd: process.cwd() }) {
  let report;
  try {
    report = runPreflight(deps);
  } catch {
    // Never echo the error: it could quote config content.
    report = { verdict: "ambiguous", reasons: ["internal: preflight failed unexpectedly"], inference: "none" };
  }
  return { stdout: JSON.stringify(report, null, 2) + "\n", code: report.verdict === "subscription" ? 0 : 1 };
}

// Compare real paths so a symlinked invocation still runs main (and never
// exits 0 silently without a verdict).
function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const { stdout, code } = main();
  process.stdout.write(stdout);
  process.exitCode = code;
}
