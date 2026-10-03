// Provenance: copied verbatim from packages/personal-context-mcp/src/authPreflight.ts
// (itself lifted from scripts/spikes/auth-preflight.mjs). That package and the spike were
// removed in P4.4 (git history has both); this is now the only copy. Differences: none in
// behaviour; only this header. authPreflight.parity.test.ts pins the legacy copy's verdicts,
// reasons and CLI calls over the same synthetic settings matrix.
//
// Billing preflight. Runs NO model calls.
//
// Lifted from the Phase 0 spike `scripts/spikes/auth-preflight.mjs` without changing
// behaviour; the only additions are typed injection seams (`spawnSync`) so tests never
// start a real `claude`.
//
// Question answered: would a `claude` child process, started with the proposed child
// environment, bill a claude.ai subscription?
//
// The verdict is "subscription" only when every applicable env/settings source is free
// of API-key, auth-token, apiKeyHelper, provider-flag and non-Anthropic base-URL routes
// AND `claude auth status --json` (run in that same child environment) reports a
// first-party claude.ai login of a subscription type. Anything else, including any
// read/parse/shape uncertainty, is "ambiguous".
//
// The report holds presence flags, key names, fixed reason codes and a few local paths.
// It never contains env values, file contents, URLs, commands, credentials or account
// identity. The paths it does contain (the resolved claude binary, `configDir`, and the
// settings files inspected) derive from HOME / CLAUDE_CONFIG_DIR and can reveal the
// username and directory layout.
// Callers must not forward the raw report to MCP clients or logs; surface the verdict
// and reason codes only.

import { spawnSync as nodeSpawnSync } from "node:child_process";
import * as realFs from "node:fs";
import { accessSync, constants as fsc, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

/** The only claude invocations the preflight may make. Enforced in runClaude. */
export const ALLOWED_CLAUDE_ARGS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(["--version"]),
  Object.freeze(["auth", "--help"]),
  Object.freeze(["auth", "status", "--help"]),
  Object.freeze(["auth", "status", "--json"]),
]);

/** Used when no explicit child profile is given: the child inherits the parent env unmodified. */
export const CHILD_ENV_STRATEGY = "inherit-parent-env-unmodified";

const KNOWN = {
  authMethod: new Set(["claude.ai", "console", "api_key", "apiKey", "oauth_token", "none", "gateway"]),
  apiProvider: new Set(["firstParty", "bedrock", "vertex", "foundry"]),
  subscriptionType: new Set(["pro", "max", "team", "enterprise"]),
};
const SUBSCRIPTION_TYPES = KNOWN.subscriptionType;

export type Env = Readonly<Record<string, string | undefined>>;
export type Verdict = "subscription" | "ambiguous";

// ---------- environment ----------

// Model-selection names: presence is reported but does not change routing.
const MODEL_NAME_RE = /^ANTHROPIC_(MODEL|SMALL_FAST_MODEL|DEFAULT_[A-Z0-9]+_MODEL)$/;
const NESTED_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"] as const;

function isRelevantName(name: string): boolean {
  return name.startsWith("ANTHROPIC_") || name.startsWith("CLAUDE_CODE_USE_");
}

export type BaseUrlClass = "unset" | "anthropic" | "non-anthropic-loopback" | "non-anthropic-remote" | "unparseable";

/** Classify a base URL without ever returning it. */
export function classifyBaseUrl(value: unknown): Exclude<BaseUrlClass, "unset"> {
  if (typeof value !== "string") return "unparseable";
  let u: URL;
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

export interface EnvRoute {
  apiKey: boolean;
  authToken: boolean;
  providerFlags: string[];
  baseUrl: BaseUrlClass;
  modelNames: string[];
  otherAnthropicNames: string[];
}

export interface EnvInspection {
  names: string[];
  route: EnvRoute;
}

/** Inspect one env-like map (process env or a settings `env` block). Names and route flags only. */
export function inspectEnvMap(env: Readonly<Record<string, unknown>>): EnvInspection {
  const names = Object.keys(env).filter(isRelevantName).sort();
  const route: EnvRoute = {
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
function routeReasons(route: EnvRoute, where: string): string[] {
  const r: string[] = [];
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

export interface ManagedPaths {
  files: string[];
  dropInDirs: string[];
  opaque: string[];
  unsupported?: boolean;
}

/**
 * Documented managed-settings locations for the installed CLI (2.1.x). `files` are JSON;
 * `dropInDirs` hold *.json fragments; `opaque` are MDM plists this module does not parse,
 * so their presence fails closed. The remote (server-managed) cache in the config dir is
 * read as JSON too.
 */
export function managedPathsFor(platform: string, configDir: string, user: string): ManagedPaths {
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

/** Project settings candidates: child cwd and every ancestor (fail closed). `stopAt` (tests) ends the walk. */
function projectSettingsPaths(cwd: string, userConfigDir: string, stopAt: string | undefined): string[] {
  const out: string[] = [];
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

const isMissing = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** The filesystem calls the settings inspection makes; tests may wrap them. */
export interface PreflightFs {
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string): string[];
  statSync(path: string): unknown;
}

export type SettingsStatus = "absent" | "ok" | "unreadable" | "malformed" | "present-not-inspected";

export interface SettingsEntry {
  scope: "user" | "project" | "managed";
  path: string;
  status: SettingsStatus;
  apiKeyHelper?: boolean;
  envKeys?: string[];
  route?: EnvRoute;
}

/** Read one settings file. Reports only status, apiKeyHelper presence and env key names. */
export function inspectSettingsFile(path: string, scope: SettingsEntry["scope"], fs: PreflightFs = realFs): SettingsEntry {
  const entry: SettingsEntry = { scope, path, status: "absent" };
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (e) {
    if (!isMissing(e)) entry.status = "unreadable";
    return entry;
  }
  let j: unknown;
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
  const obj = j as Record<string, unknown>;
  if (obj.env !== undefined && (!obj.env || typeof obj.env !== "object" || Array.isArray(obj.env))) {
    entry.status = "malformed";
    entry.apiKeyHelper = Object.hasOwn(obj, "apiKeyHelper");
    return entry;
  }
  const env = (obj.env ?? {}) as Record<string, unknown>;
  entry.status = "ok";
  entry.apiKeyHelper = Object.hasOwn(obj, "apiKeyHelper");
  entry.envKeys = Object.keys(env).sort();
  entry.route = inspectEnvMap(env).route;
  return entry;
}

function settingsReasons(entry: SettingsEntry): string[] {
  const where = `${entry.scope} settings ${entry.path}`;
  if (entry.status === "unreadable" || entry.status === "malformed") return [`${where}: ${entry.status}`];
  if (entry.status === "present-not-inspected") return [`${where}: present but not inspected`];
  if (entry.status !== "ok") return [];
  const r = entry.apiKeyHelper ? [`${where}: apiKeyHelper present`] : [];
  return entry.route ? r.concat(routeReasons(entry.route, where)) : r;
}

interface SettingsInspection {
  reasons: string[];
  entries: SettingsEntry[];
  configDir?: string;
}

function inspectAllSettings(opts: {
  env: Env;
  cwd: string;
  platform: string;
  managedPaths: ManagedPaths | undefined;
  projectStopAt: string | undefined;
  username: string | undefined;
  fs: PreflightFs;
}): SettingsInspection {
  const { env, cwd, platform, projectStopAt, fs } = opts;
  const reasons: string[] = [];
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
  let managed = opts.managedPaths;
  if (!managed) {
    // Per-user MDM policy is keyed by the OS account, not by HOME.
    let user = opts.username;
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

  const entries: SettingsEntry[] = [
    inspectSettingsFile(join(configDir, "settings.json"), "user", fs),
    inspectSettingsFile(join(configDir, "settings.local.json"), "user", fs),
    ...projectSettingsPaths(cwd, configDir, projectStopAt).map((p) => inspectSettingsFile(p, "project", fs)),
    ...managed.files.map((p) => inspectSettingsFile(p, "managed", fs)),
  ];
  for (const dir of managed.dropInDirs) {
    let names: string[];
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

function samePath(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

// ---------- claude CLI ----------

/** Resolve a command to an absolute executable path from a PATH value. No config writes. */
export function resolveOnPath(cmd: string, pathValue: string | undefined): string | undefined {
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

/** Whether `p` is an existing file the current user may execute. */
export function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsc.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The subset of `child_process.spawnSync` the preflight uses; tests inject a fake. */
export type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: {
    env: Env;
    cwd: string;
    encoding: "utf8";
    timeout: number;
    killSignal: "SIGKILL";
    maxBuffer: number;
    stdio: ["ignore", "pipe", "pipe"];
  },
) => { status: number | null; signal: NodeJS.Signals | null; stdout?: string | null; error?: Error | undefined };

const defaultSpawnSync: SpawnSyncFn = (command, args, options) =>
  nodeSpawnSync(command, [...args], { ...options, env: { ...options.env } as NodeJS.ProcessEnv });

interface ClaudeResult {
  ok: boolean;
  status: number | null;
  timedOut: boolean;
  stdout: string;
}

function runClaude(
  spawn: SpawnSyncFn,
  claudePath: string,
  args: readonly string[],
  { env, cwd, timeoutMs }: { env: Env; cwd: string; timeoutMs: number },
): ClaudeResult {
  if (!ALLOWED_CLAUDE_ARGS.some((a) => a.length === args.length && a.every((x, i) => x === args[i]))) {
    throw new Error("refusing non-allowlisted claude invocation");
  }
  const r = spawn(claudePath, args, {
    env,
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL", // read-only checks: force termination on timeout
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // stderr is discarded unread: it may carry identity or config detail.
  const errCode = (r.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    timedOut: errCode === "ETIMEDOUT" || r.signal === "SIGKILL",
    stdout: r.stdout ?? "",
  };
}

export interface AuthStatusFields {
  loggedIn: true | false | "other";
  authMethod: string;
  apiProvider: string;
  subscriptionType: string;
}

export type ParsedAuthStatus =
  | { parsed: false }
  | ({ parsed: true; configDirectory?: string } & AuthStatusFields);

/** Parse `claude auth status --json` output; expose only non-identity fields. */
export function parseAuthStatus(stdout: string): ParsedAuthStatus {
  let j: unknown;
  try {
    j = JSON.parse(stdout);
  } catch {
    return { parsed: false };
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { parsed: false };
  const o = j as Record<string, unknown>;
  const pick = (k: keyof typeof KNOWN): string => {
    const v = o[k];
    return typeof v === "string" ? (KNOWN[k].has(v) ? v : "other") : v === undefined ? "absent" : "other";
  };
  const out: ParsedAuthStatus = {
    parsed: true,
    loggedIn: o.loggedIn === true ? true : o.loggedIn === false ? false : "other",
    authMethod: pick("authMethod"),
    apiProvider: pick("apiProvider"),
    subscriptionType: pick("subscriptionType"),
  };
  if (typeof o.configDirectory === "string") out.configDirectory = o.configDirectory; // in-memory only
  return out;
}

export interface CliReport {
  resolved?: boolean;
  path?: string;
  version?: string;
  statusCommand?: "unsupported" | "auth status --json";
  statusExit?: number | null | "timeout";
  status?: AuthStatusFields | "skipped";
  skippedBecause?: string;
}

function inspectCli(opts: {
  env: Env;
  cwd: string;
  timeoutMs: number;
  fixedClaudePath: string | undefined;
  spawn: SpawnSyncFn;
}): { cli: CliReport; reasons: string[]; configDirectory?: string } {
  const { env, cwd, timeoutMs, fixedClaudePath, spawn } = opts;
  const reasons: string[] = [];
  const cli: CliReport = { resolved: false };
  let claudePath: string | undefined;
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

  const run = (args: readonly string[]): ClaudeResult => runClaude(spawn, claudePath, args, { env, cwd, timeoutMs });
  const version = run(["--version"]);
  const m = version.ok ? /^(\d+\.\d+\.\d+)/.exec(version.stdout.trim()) : null;
  cli.version = m?.[1] ?? "unknown";

  const authHelp = run(["auth", "--help"]);
  const statusHelp = run(["auth", "status", "--help"]);
  const hasStatus = authHelp.ok && /^\s+status\b/m.test(authHelp.stdout);
  const hasJson = statusHelp.ok && /^\s+--json\b/m.test(statusHelp.stdout);
  if (!hasStatus || !hasJson) {
    cli.statusCommand = "unsupported";
    reasons.push("cli: `claude auth status --json` not confirmed by --help");
    return { cli, reasons };
  }
  cli.statusCommand = "auth status --json";

  const st = run(["auth", "status", "--json"]);
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
  return configDirectory === undefined ? { cli, reasons } : { cli, reasons, configDirectory };
}

// ---------- orchestration ----------

/** An explicit child launch: its env replaces the inherited one, its claude path is audited as given. */
export interface PreflightChild {
  env: Env;
  claudePath: string;
  strategy: string;
}

export interface PreflightDeps {
  /** The parent (service) environment. Reported by key name only. */
  env: Env;
  /** The child's cwd. */
  cwd: string;
  platform?: string;
  /** Test seam: replaces the platform-derived managed-settings locations. */
  managedPaths?: ManagedPaths;
  /** Test seam: ends the project-settings ancestor walk at this directory. */
  projectStopAt?: string;
  /** Test seam: replaces os.userInfo().username. */
  username?: string;
  /** Test seam: wraps settings reads. */
  fs?: PreflightFs;
  /** Bound on each claude invocation. */
  timeoutMs?: number;
  child?: PreflightChild;
  /** Test seam: replaces child_process.spawnSync for the allowlisted claude calls. */
  spawnSync?: SpawnSyncFn;
}

export interface PreflightReport {
  verdict: Verdict;
  reasons: string[];
  inference: "none";
  childEnvStrategy: string;
  env: { parent: EnvInspection; child: EnvInspection };
  nestedSessionMarkers: Record<string, boolean>;
  nestedSessionMarkersInChild: Record<string, boolean>;
  configDir?: string;
  settings: SettingsEntry[];
  cli: CliReport;
}

/**
 * Run the preflight. Every env, settings (user, project, managed) and CLI check runs
 * against the exact child: `child.env` when a profile is given, else the parent env.
 * Settings are resolved from the child's env and cwd, since they apply to the child even
 * though no env var names them. If env/settings already make the verdict ambiguous,
 * claude is never started (auth status could execute an apiKeyHelper).
 *
 * Low-level: this can throw (e.g. on a non-allowlisted invocation). Service code should
 * call `runDirectPreflight` from launchProfile.ts, which never throws.
 */
export function runPreflight(deps: PreflightDeps): PreflightReport {
  const {
    env,
    cwd,
    platform = process.platform,
    managedPaths,
    projectStopAt,
    username,
    fs = realFs,
    timeoutMs = 20_000,
    child,
    spawnSync = defaultSpawnSync,
  } = deps;
  const reasons: string[] = [];
  const childEnv: Env = child ? { ...child.env } : { ...env };
  const parentEnv = inspectEnvMap(env);
  const childEnvInfo = inspectEnvMap(childEnv);
  reasons.push(...routeReasons(childEnvInfo.route, "child env"));

  const settings = inspectAllSettings({ env: childEnv, cwd, platform, managedPaths, projectStopAt, username, fs });
  reasons.push(...settings.reasons);

  const cliResult: { cli: CliReport; reasons: string[]; configDirectory?: string } =
    reasons.length > 0
      ? { cli: { status: "skipped", skippedBecause: "env/settings already ambiguous" }, reasons: [] }
      : inspectCli({ env: childEnv, cwd, timeoutMs, fixedClaudePath: child?.claudePath, spawn: spawnSync });
  reasons.push(...cliResult.reasons);
  if (cliResult.configDirectory !== undefined && (!settings.configDir || !samePath(cliResult.configDirectory, settings.configDir))) {
    reasons.push("cli: auth status reports a different config directory than the one inspected");
  }

  const report: PreflightReport = {
    verdict: reasons.length === 0 ? "subscription" : "ambiguous",
    reasons,
    inference: "none",
    childEnvStrategy: child ? child.strategy : CHILD_ENV_STRATEGY,
    env: { parent: parentEnv, child: childEnvInfo },
    nestedSessionMarkers: Object.fromEntries(NESTED_MARKERS.map((n) => [n, n in env])),
    nestedSessionMarkersInChild: Object.fromEntries(NESTED_MARKERS.map((n) => [n, n in childEnv])),
    settings: settings.entries,
    cli: cliResult.cli,
  };
  if (settings.configDir !== undefined) report.configDir = settings.configDir;
  return report;
}
