// Whether Codex jobs can run: the CLI answers and is logged in by any method, reached only
// through Scout's private Codex home. Runs NO model calls.
//
// Exactly two invocations, both through spawnSync (20 s, SIGKILL) with the job's child env
// (launch.ts codexChildEnv, whose PATH starts with the codex binary's directory so an npm or
// nvm install finds its `node` under launchd's minimal PATH) and a throwaway
// CODEX_SQLITE_HOME that is removed afterwards:
//   - `codex --version`: stdout `codex-cli <x.y.z>` (`version_unknown` otherwise);
//   - `codex login status`: "Logged in …" and exit 0, whether through ChatGPT or an API key
//     (`not_logged_in` otherwise; "Not logged in" exits 1). Codex prints it on stderr.
// Checked without running anything:
//   - `auth_link_invalid`: the private home's `auth.json` is not Scout's symlink to the user's
//     `auth.json`, or that target is not a regular file, mode 0600, owned by this user;
//   - `codex_home_unusable`: the private Codex home could not be prepared (no absolute HOME
//     or CODEX_HOME, or `run/codex-home` is not a private directory);
//   - `binary_not_executable`: the profile's codexPath is not an executable file (then
//     nothing is invoked).
// The verdict is `ready` only when no reason was found. Never throws.

import { spawnSync as nodeSpawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { isExecutableFile, type Env } from "../executables.js";
import { ensureJobsRoot } from "../claudeCode/launchProfile.js";
import { AUTH_FILE, codexChildEnv, ensureCodexHome } from "./launch.js";

export const READINESS_TIMEOUT_MS = 20_000;
const VERSION_RE = /^codex-cli (\d+\.\d+\.\d+)\b/;

export type CodexReadinessReason = "auth_link_invalid" | "codex_home_unusable" | "version_unknown" | "not_logged_in" | "binary_not_executable";

export interface CodexReadinessReport {
  verdict: "ready" | "unavailable";
  reasons: string[];
  /** `x.y.z` from `codex --version`, when it answered. */
  version?: string;
}

export interface SpawnSyncResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string | null;
  stderr: string | null;
  error?: Error;
}

export type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: { env: Readonly<Record<string, string>>; cwd: string; timeout: number; killSignal: "SIGKILL"; encoding: "utf8"; stdio: ["ignore", "pipe", "pipe"] },
) => SpawnSyncResult;

const defaultSpawnSync: SpawnSyncFn = (command, args, options) => {
  const r = nodeSpawnSync(command, [...args], { ...options, env: { ...options.env } });
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, ...(r.error ? { error: r.error } : {}) };
};

/** The only invocations readiness may make (tests assert nothing else ran). */
export const READINESS_INVOCATIONS: readonly (readonly string[])[] = Object.freeze([Object.freeze(["--version"]), Object.freeze(["login", "status"])]);

export interface CodexReadinessOptions {
  codexPath: string;
  parentEnv: Env;
  /** The private Codex home (`run/codex-home`). */
  codexHome: string;
  /** The user's `auth.json` the private home's link must name. */
  userAuthPath: string;
  spawnSync?: SpawnSyncFn;
  timeoutMs?: number;
}

/** Whether `<codexHome>/auth.json` is Scout's link to a private, owned regular file at userAuthPath. */
export function authLinkValid(codexHome: string, userAuthPath: string): boolean {
  try {
    const link = join(codexHome, AUTH_FILE);
    if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== userAuthPath) return false;
    const st = lstatSync(userAuthPath);
    const owned = typeof process.getuid !== "function" || st.uid === process.getuid();
    return st.isFile() && owned && (st.mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

export function runCodexReadiness(o: CodexReadinessOptions): CodexReadinessReport {
  try {
    return readiness(o);
  } catch {
    return { verdict: "unavailable", reasons: ["internal: readiness failed unexpectedly"] };
  }
}

function readiness(o: CodexReadinessOptions): CodexReadinessReport {
  const reasons: CodexReadinessReason[] = [];
  if (!authLinkValid(o.codexHome, o.userAuthPath)) reasons.push("auth_link_invalid");
  if (!isExecutableFile(o.codexPath)) {
    reasons.push("binary_not_executable");
    return { verdict: "unavailable", reasons };
  }
  const spawn = o.spawnSync ?? defaultSpawnSync;
  const timeout = o.timeoutMs ?? READINESS_TIMEOUT_MS;
  // A throwaway SQLite home beside the job dirs (the core's start sweeps leftovers).
  const stateDir = mkdtempSync(join(ensureJobsRoot(join(dirname(o.codexHome), "jobs")), "readiness-"));
  let version: string | undefined;
  try {
    const env = codexChildEnv(o.parentEnv, o.codexPath, o.codexHome, stateDir);
    const call = (args: readonly string[]): SpawnSyncResult => spawn(o.codexPath, args, { env, cwd: stateDir, timeout, killSignal: "SIGKILL", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    const v = call(READINESS_INVOCATIONS[0]!);
    const m = v.error || v.status !== 0 ? null : VERSION_RE.exec(String(v.stdout ?? "").trim());
    if (m) version = m[1];
    else reasons.push("version_unknown");

    const login = call(READINESS_INVOCATIONS[1]!);
    const text = `${login.stderr ?? ""}\n${login.stdout ?? ""}`;
    if (login.error || login.status !== 0 || !/^Logged in\b/m.test(text)) reasons.push("not_logged_in");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
  const report: CodexReadinessReport = { verdict: reasons.length === 0 ? "ready" : "unavailable", reasons };
  if (version !== undefined) report.version = version;
  return report;
}

/** What the core passes to a readiness run: plain data (it crosses a process boundary). */
export interface CodexReadinessInput {
  /** SCOUT_HOME. */
  home: string;
  parentEnv: Env;
  codexPath: string;
  model: string;
}

/** Prepare the private Codex home, then run the readiness check against it. Never throws. */
export function runCodexReadinessFor(input: CodexReadinessInput, seams: Pick<CodexReadinessOptions, "spawnSync" | "timeoutMs"> = {}): CodexReadinessReport {
  try {
    const home = ensureCodexHome(input.home, input.parentEnv);
    if (!home.ok) {
      const reasons: string[] = [home.reason];
      return { verdict: "unavailable", reasons };
    }
    return runCodexReadiness({ codexPath: input.codexPath, parentEnv: input.parentEnv, codexHome: home.codexHome, userAuthPath: home.userAuthPath, ...seams });
  } catch {
    return { verdict: "unavailable", reasons: ["internal: readiness failed unexpectedly"] };
  }
}
