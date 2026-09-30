// Service-owned direct Claude launch profile. Runs NO model calls.
//
// Lifted from the Phase 0 spikes `scripts/spikes/launch-profile.mjs` and
// `direct-profile-preflight.mjs` without changing their invariants. Differences:
// the claude path comes from config (setup writes it) with PATH lookup only as a
// fallback; there is no default model (config `"model": null` means no `--model`).
//
// The service launches `claude` with its own settings so the child uses Hunter's
// existing claude.ai login directly, instead of any gateway the parent routes through.
// Nothing global changes: the parent env, process.env and every settings file stay
// untouched. The profile only decides what the CHILD gets:
//   - an absolute claude path,
//   - a fresh private (0700) cwd under a caller-supplied scratch root that is outside
//     the workspace, so workspace project settings don't apply,
//   - an explicit child env built from an allowlist (routing, provider, model and
//     nested-session variables never reach the child),
//   - an optional service-owned `--model` choice as CLI args.
// The same profile object feeds the preflight and any later agent run, so both see
// exactly the same env, cwd and binary. Serializing a profile yields key names and
// classifications only.

import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import {
  isExecutableFile,
  resolveOnPath,
  runPreflight,
  type Env,
  type PreflightDeps,
  type PreflightReport,
  type Verdict,
} from "./authPreflight.js";

export const PROFILE_ID = "scout-direct-claude-subscription/v1";

/**
 * Non-routing variables the child needs: identity for the OS keychain login, PATH
 * (claude may be a node script), shell, locale and temp dir. Nothing else is forwarded,
 * except an absolute CLAUDE_CONFIG_DIR (the login may live there).
 */
export const FORWARD_KEYS: readonly string[] = Object.freeze([
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
]);

/** Only a plain alias or model name; never anything that parses as a flag. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/;

export type LaunchProfileErrorCode =
  | "profile: model choice is not a plain model name"
  | "profile: CLAUDE_CONFIG_DIR is set but not absolute"
  | "profile: HOME is unset or not absolute"
  | "profile: claude not found on PATH"
  | "profile: claude path is not an absolute executable file"
  | "profile: scratch root is not an absolute path"
  | "profile: scratch root is missing or not a directory"
  | "profile: no workspace roots given"
  | "profile: scratch root is inside a workspace root"
  | "profile: neutral cwd could not be created"
  | "profile: neutral cwd is not private, owned and outside the workspace"
  | "profile: neutral cwd could not be verified";

export class LaunchProfileError extends Error {
  constructor(readonly code: LaunchProfileErrorCode) {
    super(code); // fixed code only: never a path or value
    this.name = "LaunchProfileError";
  }
}

// realpath(3): resolves symlinks AND the on-disk spelling, so a case-variant alias on a
// case-insensitive volume can't slip past containment checks.
function real(p: string): string {
  return realpathSync.native(p);
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Canonicalize a scratch root and its workspace roots to physical paths and refuse a
 * scratch root that is missing, relative, not a directory, or inside a workspace root.
 * Creates nothing.
 */
export function resolveScratchRoot(scratchRoot: string, workspaceRoots: readonly string[]): { scratch: string; roots: string[] } {
  if (typeof scratchRoot !== "string" || !isAbsolute(scratchRoot)) {
    throw new LaunchProfileError("profile: scratch root is not an absolute path");
  }
  let scratch: string;
  try {
    scratch = real(scratchRoot);
    if (!statSync(scratch).isDirectory()) throw new Error();
  } catch {
    throw new LaunchProfileError("profile: scratch root is missing or not a directory");
  }
  const roots = workspaceRoots.map((r) => {
    try {
      return real(r);
    } catch {
      return r;
    }
  });
  if (roots.length === 0) throw new LaunchProfileError("profile: no workspace roots given");
  if (roots.some((r) => isInside(scratch, r))) {
    throw new LaunchProfileError("profile: scratch root is inside a workspace root");
  }
  return { scratch, roots };
}

export interface NeutralCwdReport {
  fresh: true;
  private0700: boolean;
  ownedByCurrentUser: boolean;
  outsideWorkspace: boolean;
}

export interface LaunchProfileSummary {
  id: string;
  forwardedKeys: readonly string[];
  droppedKeys: readonly string[];
  neutralCwd: NeutralCwdReport;
  modelArgs: readonly string[];
}

export interface LaunchProfile {
  readonly id: string;
  readonly claudePath: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly modelArgs: readonly string[];
  readonly forwardedKeys: readonly string[];
  readonly droppedKeys: readonly string[];
  readonly neutralCwd: NeutralCwdReport;
  /** Removes the neutral cwd. */
  cleanup(): void;
  /** Key names and classifications only: no values, paths or identity. */
  toJSON(): LaunchProfileSummary;
}

export interface LaunchProfileOptions {
  parentEnv: Env;
  scratchRoot: string;
  workspaceRoots: readonly string[];
  /** Service-owned model choice; omitted (config `null`) means no `--model` flag. */
  model?: string;
  /** Absolute claude path from config (setup writes it). Absent: resolved from the parent PATH. */
  claudePath?: string;
}

export function createLaunchProfile(opts: LaunchProfileOptions): LaunchProfile {
  const { parentEnv, scratchRoot, workspaceRoots, model } = opts;
  if (model !== undefined && (typeof model !== "string" || !MODEL_RE.test(model))) {
    throw new LaunchProfileError("profile: model choice is not a plain model name");
  }

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
  if (typeof env.HOME !== "string" || !isAbsolute(env.HOME)) {
    throw new LaunchProfileError("profile: HOME is unset or not absolute");
  }
  Object.freeze(env);

  let claudePath: string;
  if (opts.claudePath !== undefined) {
    if (!isAbsolute(opts.claudePath) || !isExecutableFile(opts.claudePath)) {
      throw new LaunchProfileError("profile: claude path is not an absolute executable file");
    }
    claudePath = opts.claudePath;
  } else {
    const found = resolveOnPath("claude", parentEnv.PATH);
    if (!found) throw new LaunchProfileError("profile: claude not found on PATH");
    claudePath = found;
  }

  const { scratch, roots } = resolveScratchRoot(scratchRoot, workspaceRoots);

  let cwd: string;
  try {
    // `scratch` is already physical, so the new directory's path is too.
    cwd = mkdtempSync(join(scratch, "scout-direct-"));
  } catch {
    throw new LaunchProfileError("profile: neutral cwd could not be created");
  }
  const cleanup = (): void => rmSync(cwd, { recursive: true, force: true });
  let neutralCwd: NeutralCwdReport;
  try {
    const st = statSync(cwd);
    neutralCwd = {
      fresh: true,
      private0700: (st.mode & 0o777) === 0o700,
      ownedByCurrentUser: typeof process.getuid === "function" && st.uid === process.getuid(),
      outsideWorkspace: !roots.some((r) => isInside(real(cwd), r)),
    };
    if (!neutralCwd.private0700 || !neutralCwd.ownedByCurrentUser || !neutralCwd.outsideWorkspace) {
      throw new LaunchProfileError("profile: neutral cwd is not private, owned and outside the workspace");
    }
  } catch (e) {
    cleanup();
    throw e instanceof LaunchProfileError ? e : new LaunchProfileError("profile: neutral cwd could not be verified");
  }

  const forwardedKeys = Object.freeze(Object.keys(env).sort());
  const droppedKeys = Object.freeze(Object.keys(parentEnv).filter((k) => !Object.hasOwn(env, k)).sort());
  const modelArgs = Object.freeze(model === undefined ? [] : ["--model", model]);
  const summaryCwd = Object.freeze({ ...neutralCwd });

  return Object.freeze({
    id: PROFILE_ID,
    claudePath,
    cwd,
    env,
    modelArgs,
    forwardedKeys,
    droppedKeys,
    neutralCwd: summaryCwd,
    cleanup,
    toJSON(): LaunchProfileSummary {
      return { id: PROFILE_ID, forwardedKeys, droppedKeys, neutralCwd: summaryCwd, modelArgs };
    },
  });
}

/** Test seams passed through to runPreflight. */
export type ProfilePreflightSeams = Pick<PreflightDeps, "managedPaths" | "projectStopAt" | "username" | "fs" | "timeoutMs" | "platform" | "spawnSync">;

/**
 * Run the billing preflight against exactly this profile's child env, cwd and claude
 * binary. The profile never short-circuits any check: user, project (cwd ancestors) and
 * managed settings, env routes and `claude auth status` all still decide the verdict.
 */
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
  reasons: string[];
  inference: "none";
  profile:
    | { status: "not-created" }
    | (LaunchProfileSummary & {
        neutralCwd: NeutralCwdReport & { projectSettingsFound: number | "unknown" };
        cleanup: "removed" | "failed";
      });
  preflight?: Omit<PreflightReport, "verdict" | "reasons" | "inference">;
}

export type DirectPreflightOptions = LaunchProfileOptions & ProfilePreflightSeams & {
  preflight?: (deps: PreflightDeps) => PreflightReport;
};

/**
 * Build a fresh launch profile, run the preflight against that exact child, remove the
 * profile's cwd, and report. The verdict is `subscription` only when the profile was
 * created, the preflight found no reason, and the cwd was removed. Never throws; any
 * unexpected error becomes a fixed `internal:` reason.
 */
export function runDirectPreflight(opts: DirectPreflightOptions): DirectPreflightReport {
  try {
    return directPreflight(opts);
  } catch {
    // Never echo the error: it could quote config content.
    return { verdict: "ambiguous", reasons: ["internal: direct preflight failed unexpectedly"], inference: "none", profile: { status: "not-created" } };
  }
}

function directPreflight(opts: DirectPreflightOptions): DirectPreflightReport {
  const { parentEnv, scratchRoot, workspaceRoots, model, claudePath, preflight, ...seams } = opts;
  let profile: LaunchProfile;
  try {
    const profileOpts: LaunchProfileOptions = { parentEnv, scratchRoot, workspaceRoots };
    if (model !== undefined) profileOpts.model = model;
    if (claudePath !== undefined) profileOpts.claudePath = claudePath;
    profile = createLaunchProfile(profileOpts);
  } catch (e) {
    const reason = e instanceof LaunchProfileError ? e.code : "internal: launch profile failed unexpectedly";
    return { verdict: "ambiguous", reasons: [reason], inference: "none", profile: { status: "not-created" } };
  }

  const reasons: string[] = [];
  let pre: PreflightReport | undefined;
  try {
    pre = runProfilePreflight(profile, { parentEnv, ...(preflight ? { preflight } : {}), ...seams });
    reasons.push(...pre.reasons);
  } catch {
    // Never echo the error: it could quote config content.
    reasons.push("internal: preflight failed unexpectedly");
  } finally {
    // Removal is checked below; a failure makes the verdict ambiguous.
    try {
      profile.cleanup();
    } catch {
      // reported below
    }
  }
  const cleanup = existsSync(profile.cwd) ? "failed" : "removed";
  if (cleanup === "failed") reasons.push("profile: neutral cwd was not removed");

  const projectSettingsFound = pre ? pre.settings.filter((s) => s.scope === "project").length : "unknown";
  const summary = profile.toJSON();
  const report: DirectPreflightReport = {
    verdict: reasons.length === 0 ? "subscription" : "ambiguous",
    reasons,
    inference: "none",
    profile: { ...summary, neutralCwd: { ...summary.neutralCwd, projectSettingsFound }, cleanup },
  };
  if (pre) {
    const { verdict: _v, reasons: _r, inference: _i, ...rest } = pre;
    report.preflight = rest;
  }
  return report;
}
