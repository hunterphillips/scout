// The direct Claude launch profile for Scout jobs. Runs NO model calls.
//
// Provenance: adapted from the removed personal-context package (see git history before 2026-10-02).
// Unchanged: the env allowlist (FORWARD_KEYS) and CLAUDE_CONFIG_DIR/HOME rules, so routing,
// provider, model and nested-session variables never reach the child; the preflight runs
// against exactly the profile's env, cwd and binary; serializing a profile yields key names
// and classifications only; runDirectPreflight never throws.
// launchProfile.test.ts holds the parity tests for the env filtering.
// Differences:
//   - The claude path and model come from the agent profile and are required: no PATH
//     fallback, no "inherit the CLI default" model.
//   - The cwd is `<jobsRoot>/<jobId>` (normally `SCOUT_HOME/run/jobs/<request-id>`), created
//     0700 and exclusive, instead of a mkdtemp under a scratch root. The job ID is checked
//     against the agent request-ID pattern before it touches a path.
//   - Workspace roots are optional (the core does not know the user's workspaces); when
//     given, a jobs root inside one is refused as before.
//   - The direct preflight reports the CLI version it saw, so a job can stop when the CLI
//     it launches reports another.
//
// The env allowlist is unchanged and deliberately keeps HOME (and an absolute
// CLAUDE_CONFIG_DIR): the user's own login and user-level instructions live there.

import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { AgentRequestIdSchema } from "@scout/contracts";
import { isExecutableFile, runPreflight, type Env, type PreflightDeps, type PreflightReport, type Verdict } from "./authPreflight.js";
import { MODEL_RE } from "./profile.js";

export const PROFILE_ID = "scout-job-claude-subscription/v1";

/** Unchanged from the legacy profile (parity-tested). */
export const FORWARD_KEYS: readonly string[] = Object.freeze(["HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"]);

export type LaunchProfileErrorCode =
  | "profile: model choice is not a plain model name"
  | "profile: CLAUDE_CONFIG_DIR is set but not absolute"
  | "profile: HOME is unset or not absolute"
  | "profile: claude path is not an absolute executable file"
  | "profile: job id is not valid"
  | "profile: jobs root is not an absolute path"
  | "profile: jobs root is not a private directory owned by this user"
  | "profile: jobs root is inside a workspace root"
  | "profile: job dir could not be created"
  | "profile: job dir is not private and owned";

export class LaunchProfileError extends Error {
  constructor(readonly code: LaunchProfileErrorCode) {
    super(code); // fixed code only: never a path or value
    this.name = "LaunchProfileError";
  }
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** The allowlisted child env. Shared with the parity test. */
export function filterChildEnv(parentEnv: Env): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const k of FORWARD_KEYS) {
    const v = parentEnv[k];
    if (typeof v === "string") env[k] = v;
  }
  if (parentEnv.CLAUDE_CONFIG_DIR !== undefined) {
    // The user's existing login may live there; a relative one is ambiguous.
    if (typeof parentEnv.CLAUDE_CONFIG_DIR !== "string" || !isAbsolute(parentEnv.CLAUDE_CONFIG_DIR)) {
      throw new LaunchProfileError("profile: CLAUDE_CONFIG_DIR is set but not absolute");
    }
    env.CLAUDE_CONFIG_DIR = parentEnv.CLAUDE_CONFIG_DIR;
  }
  if (typeof env.HOME !== "string" || !isAbsolute(env.HOME)) throw new LaunchProfileError("profile: HOME is unset or not absolute");
  return Object.freeze(env);
}

/**
 * Create (if missing) and check the jobs root: absolute, a real directory (not a symlink),
 * owned by this user, mode 0700, and outside every workspace root. Returns its physical path.
 */
export function ensureJobsRoot(jobsRoot: string, workspaceRoots: readonly string[] = []): string {
  if (typeof jobsRoot !== "string" || !isAbsolute(jobsRoot)) throw new LaunchProfileError("profile: jobs root is not an absolute path");
  let real: string;
  try {
    mkdirSync(jobsRoot, { recursive: true, mode: 0o700 });
    const st = lstatSync(jobsRoot);
    const owned = typeof process.getuid !== "function" || st.uid === process.getuid();
    if (!st.isDirectory() || !owned || (st.mode & 0o777) !== 0o700) throw new Error();
    real = realpathSync.native(jobsRoot);
  } catch {
    throw new LaunchProfileError("profile: jobs root is not a private directory owned by this user");
  }
  const roots = workspaceRoots.map((r) => {
    try {
      return realpathSync.native(r);
    } catch {
      return r;
    }
  });
  if (roots.some((r) => isInside(real, r))) throw new LaunchProfileError("profile: jobs root is inside a workspace root");
  return real;
}

export interface JobDirReport {
  fresh: true;
  private0700: boolean;
  ownedByCurrentUser: boolean;
}

export interface LaunchProfileSummary {
  id: string;
  forwardedKeys: readonly string[];
  droppedKeys: readonly string[];
  jobDir: JobDirReport;
  modelArgs: readonly string[];
}

export interface LaunchProfile {
  readonly id: string;
  readonly claudePath: string;
  /** The job's private working directory. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly model: string;
  readonly modelArgs: readonly string[];
  readonly forwardedKeys: readonly string[];
  readonly droppedKeys: readonly string[];
  readonly jobDir: JobDirReport;
  /** Removes the job dir and everything in it. */
  cleanup(): void;
  /** Key names and classifications only: no values, paths or identity. */
  toJSON(): LaunchProfileSummary;
}

export interface LaunchProfileOptions {
  parentEnv: Env;
  /** Absolute claude path from the agent profile. */
  claudePath: string;
  /** Explicit model from the agent profile. */
  model: string;
  /** `SCOUT_HOME/run/jobs`. */
  jobsRoot: string;
  /** The job's request ID (or a preflight ID); validated before use in a path. */
  jobId: string;
  workspaceRoots?: readonly string[];
}

export function createLaunchProfile(opts: LaunchProfileOptions): LaunchProfile {
  const { parentEnv, model, jobId } = opts;
  if (typeof model !== "string" || !MODEL_RE.test(model)) throw new LaunchProfileError("profile: model choice is not a plain model name");
  if (!AgentRequestIdSchema.safeParse(jobId).success) throw new LaunchProfileError("profile: job id is not valid");
  const env = filterChildEnv(parentEnv);
  if (typeof opts.claudePath !== "string" || !isAbsolute(opts.claudePath) || !isExecutableFile(opts.claudePath)) {
    throw new LaunchProfileError("profile: claude path is not an absolute executable file");
  }
  const root = ensureJobsRoot(opts.jobsRoot, opts.workspaceRoots);

  const cwd = join(root, jobId);
  try {
    mkdirSync(cwd, { mode: 0o700 }); // exclusive: an existing dir is refused
  } catch {
    throw new LaunchProfileError("profile: job dir could not be created");
  }
  const cleanup = (): void => rmSync(cwd, { recursive: true, force: true });
  let jobDir: JobDirReport;
  try {
    const st = statSync(cwd);
    jobDir = {
      fresh: true,
      private0700: (st.mode & 0o777) === 0o700,
      ownedByCurrentUser: typeof process.getuid === "function" && st.uid === process.getuid(),
    };
  } catch {
    cleanup();
    throw new LaunchProfileError("profile: job dir is not private and owned");
  }
  if (!jobDir.private0700 || !jobDir.ownedByCurrentUser) {
    cleanup();
    throw new LaunchProfileError("profile: job dir is not private and owned");
  }

  const forwardedKeys = Object.freeze(Object.keys(env).sort());
  const droppedKeys = Object.freeze(Object.keys(parentEnv).filter((k) => !Object.hasOwn(env, k)).sort());
  const modelArgs = Object.freeze(["--model", model]);
  const summaryDir = Object.freeze({ ...jobDir });

  return Object.freeze({
    id: PROFILE_ID,
    claudePath: opts.claudePath,
    cwd,
    env,
    model,
    modelArgs,
    forwardedKeys,
    droppedKeys,
    jobDir: summaryDir,
    cleanup,
    toJSON(): LaunchProfileSummary {
      return { id: PROFILE_ID, forwardedKeys, droppedKeys, jobDir: summaryDir, modelArgs };
    },
  });
}

/** Test seams passed through to runPreflight. */
export type ProfilePreflightSeams = Pick<PreflightDeps, "managedPaths" | "projectStopAt" | "username" | "fs" | "timeoutMs" | "platform" | "spawnSync">;

/** Run the billing preflight against exactly this profile's child env, cwd and claude binary. */
export function runProfilePreflight(
  profile: LaunchProfile,
  opts: { parentEnv?: Env; preflight?: (deps: PreflightDeps) => PreflightReport } & ProfilePreflightSeams = {},
): PreflightReport {
  const { parentEnv, preflight = runPreflight, ...seams } = opts;
  const deps: PreflightDeps = {
    env: parentEnv ?? {},
    cwd: profile.cwd,
    child: { env: profile.env, claudePath: profile.claudePath, strategy: profile.id },
  };
  for (const [k, v] of Object.entries(seams)) if (v !== undefined) (deps as unknown as Record<string, unknown>)[k] = v;
  return preflight(deps);
}

export interface DirectPreflightReport {
  verdict: Verdict;
  /** Fixed reason codes; settings reasons name local files, so redact before logging. */
  reasons: string[];
  inference: "none";
  /** The version `claude --version` reported, when the CLI was reached. */
  cliVersion?: string;
}

export type DirectPreflightOptions = Omit<LaunchProfileOptions, "jobId"> &
  ProfilePreflightSeams & {
    preflight?: (deps: PreflightDeps) => PreflightReport;
    /** Test seam for the preflight job dir's name. */
    jobId?: string;
  };

/**
 * Build a fresh launch profile in its own job dir, run the preflight against that exact
 * child, remove the dir, and report. `subscription` only when the profile was created, the
 * preflight found no reason, and the dir was removed. Never throws.
 *
 * Blocking: the preflight runs `claude` through spawnSync up to four times at up to 20 s
 * each. Call it when the profile is loaded or changed, never on the job path.
 */
export function runDirectPreflight(opts: DirectPreflightOptions): DirectPreflightReport {
  try {
    return directPreflight(opts);
  } catch {
    return { verdict: "ambiguous", reasons: ["internal: direct preflight failed unexpectedly"], inference: "none" };
  }
}

function directPreflight(opts: DirectPreflightOptions): DirectPreflightReport {
  const { parentEnv, claudePath, model, jobsRoot, workspaceRoots, preflight, jobId, ...seams } = opts;
  let profile: LaunchProfile;
  try {
    const profileOpts: LaunchProfileOptions = {
      parentEnv,
      claudePath,
      model,
      jobsRoot,
      jobId: jobId ?? `preflight-${process.pid}-${Date.now().toString(36)}`,
    };
    if (workspaceRoots !== undefined) profileOpts.workspaceRoots = workspaceRoots;
    profile = createLaunchProfile(profileOpts);
  } catch (e) {
    const reason = e instanceof LaunchProfileError ? e.code : "internal: launch profile failed unexpectedly";
    return { verdict: "ambiguous", reasons: [reason], inference: "none" };
  }

  const reasons: string[] = [];
  let pre: PreflightReport | undefined;
  try {
    pre = runProfilePreflight(profile, { parentEnv, ...(preflight ? { preflight } : {}), ...seams });
    reasons.push(...pre.reasons);
  } catch {
    reasons.push("internal: preflight failed unexpectedly");
  } finally {
    try {
      profile.cleanup();
    } catch {
      // reported below
    }
  }
  if (existsSync(profile.cwd)) reasons.push("profile: job dir was not removed");
  const report: DirectPreflightReport = { verdict: reasons.length === 0 ? "subscription" : "ambiguous", reasons, inference: "none" };
  const version = pre?.cli.version;
  if (version !== undefined && version !== "unknown") report.cliVersion = version;
  return report;
}
