// Readiness: can a `claude` child, started with the proposed child environment, run a job?
// Runs NO model calls.
//
// Provenance: started as a copy of the removed personal-context package's billing preflight
// (see git history before 2026-10-02). Since 2026-10-06 it checks only that the CLI runs and
// is logged in by any method; how the user's Claude Code authenticates or bills is theirs.
//
// The verdict is `ready` when the pinned (or PATH-resolved) `claude` is executable, its
// `auth status --json` is confirmed by `--help`, exits 0 with a JSON object, and reports
// `loggedIn: true`. Anything else is `unavailable` with fixed reason codes. Each claude call's
// PATH starts with the binary's own directory (executables.ts pathWithCliDir), so an npm or
// nvm install finds its `node` under launchd's minimal PATH. The only additions to the
// original check are typed injection seams (`spawnSync`), so tests never start a real
// `claude`.
//
// The report holds the verdict, fixed reason codes, the CLI version and the resolved binary
// path (which can reveal the username). It never contains env values, credentials or account
// identity. Callers surface the verdict and reason codes only.

import { isAbsolute } from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { isExecutableFile, pathWithCliDir, resolveOnPath, type Env } from "../executables.js";

export { isExecutableFile, resolveOnPath, type Env };

/** The only claude invocations the preflight may make. Enforced in runClaude. */
export const ALLOWED_CLAUDE_ARGS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(["--version"]),
  Object.freeze(["auth", "--help"]),
  Object.freeze(["auth", "status", "--help"]),
  Object.freeze(["auth", "status", "--json"]),
]);

/** Used when no explicit child profile is given: the child inherits the parent env unmodified. */
export const CHILD_ENV_STRATEGY = "inherit-parent-env-unmodified";

export type Verdict = "ready" | "unavailable";

// ---------- claude CLI ----------

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
    // The CLI's own directory leads PATH, as at the job's spawn (executables.ts pathWithCliDir).
    env: { ...env, PATH: pathWithCliDir(claudePath, env.PATH) },
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
}

export type ParsedAuthStatus =
  | { parsed: false }
  | ({ parsed: true } & AuthStatusFields);

/** Parse `claude auth status --json` output; expose only login state. */
export function parseAuthStatus(stdout: string): ParsedAuthStatus {
  let j: unknown;
  try {
    j = JSON.parse(stdout);
  } catch {
    return { parsed: false };
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { parsed: false };
  const o = j as Record<string, unknown>;
  return {
    parsed: true,
    loggedIn: o.loggedIn === true ? true : o.loggedIn === false ? false : "other",
  };
}

export interface CliReport {
  resolved?: boolean;
  path?: string;
  version?: string;
  statusCommand?: "unsupported" | "auth status --json";
  statusExit?: number | null | "timeout";
  status?: AuthStatusFields;
}

function inspectCli(opts: {
  env: Env;
  cwd: string;
  timeoutMs: number;
  fixedClaudePath: string | undefined;
  spawn: SpawnSyncFn;
}): { cli: CliReport; reasons: string[] } {
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
  cli.status = { loggedIn: parsed.loggedIn };
  if (parsed.loggedIn !== true) reasons.push("cli: not logged in");
  return { cli, reasons };
}

// ---------- orchestration ----------

/**
 * An explicit child launch: its env replaces the inherited one, and its claude path is audited
 * as given.
 */
export interface PreflightChild {
  env: Env;
  claudePath: string;
  strategy: string;
}

export interface PreflightDeps {
  /** The parent (service) environment. */
  env: Env;
  /** The child's cwd. */
  cwd: string;
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
  cli: CliReport;
}

/** Check whether the configured Claude CLI runs and reports a login. */
export function runPreflight(deps: PreflightDeps): PreflightReport {
  const {
    env,
    cwd,
    timeoutMs = 20_000,
    child,
    spawnSync = defaultSpawnSync,
  } = deps;
  const reasons: string[] = [];
  const childEnv: Env = child ? { ...child.env } : { ...env };
  const cliResult = inspectCli({ env: childEnv, cwd, timeoutMs, fixedClaudePath: child?.claudePath, spawn: spawnSync });
  reasons.push(...cliResult.reasons);

  const report: PreflightReport = {
    verdict: reasons.length === 0 ? "ready" : "unavailable",
    reasons,
    inference: "none",
    childEnvStrategy: child ? child.strategy : CHILD_ENV_STRATEGY,
    cli: cliResult.cli,
  };
  return report;
}
