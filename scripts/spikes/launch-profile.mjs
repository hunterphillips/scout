// Scout Phase 0: service-owned direct Claude launch profile. Runs NO model calls.
//
// The personal-context service launches `claude` with its own settings so the
// child uses Hunter's existing claude.ai (Max) login directly, instead of the
// model gateway this workspace routes through. Nothing global changes: the
// parent env, process.env and every settings file stay untouched. The profile
// only decides what the CHILD gets:
//   - an absolute claude path (resolved from the parent PATH),
//   - a fresh private (0700) cwd under a caller-supplied scratch root that is
//     outside the workspace, so workspace project settings don't apply,
//   - an explicit child env built from an allowlist (routing, provider,
//     model and nested-session variables never reach the child),
//   - an optional service-owned `--model` choice as CLI args.
// The same profile object feeds the preflight and any later agent run, so both
// see exactly the same env, cwd and binary. Serializing a profile yields key
// names and classifications only.

import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { resolveOnPath, runPreflight } from "./auth-preflight.mjs";

export const PROFILE_ID = "scout-direct-claude-subscription/v1";

// Non-routing variables the child needs: identity for the OS keychain login,
// PATH (claude may be a node script), shell, locale and temp dir.
const FORWARD_KEYS = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"];

// Only a plain alias or model name; never anything that parses as a flag.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/;

export class LaunchProfileError extends Error {
  constructor(code) {
    super(code); // fixed code only: never a path or value
    this.code = code;
  }
}

// realpath(3): resolves symlinks AND the on-disk spelling, so a case-variant
// alias on a case-insensitive volume can't slip past containment checks.
function real(p) {
  return realpathSync.native(p);
}

function isInside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Canonicalize a scratch root and its workspace roots to physical paths
 * (realpath(3)) and refuse a scratch root that is missing, relative, not a
 * directory, or inside a workspace root. Creates nothing. Shared by the launch
 * profile and callers that make their own directories under the scratch root.
 * @returns {{ scratch: string, roots: string[] }}
 */
export function resolveScratchRoot(scratchRoot, workspaceRoots) {
  if (typeof scratchRoot !== "string" || !isAbsolute(scratchRoot)) {
    throw new LaunchProfileError("profile: scratch root is not an absolute path");
  }
  let scratch;
  try {
    scratch = real(scratchRoot);
    if (!statSync(scratch).isDirectory()) throw new Error();
  } catch {
    throw new LaunchProfileError("profile: scratch root is missing or not a directory");
  }
  const roots = (workspaceRoots ?? []).map((r) => {
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

/**
 * @param {{ parentEnv: Record<string,string|undefined>, scratchRoot: string,
 *           workspaceRoots: string[], model?: string }} opts
 */
export function createLaunchProfile({ parentEnv, scratchRoot, workspaceRoots, model }) {
  if (model !== undefined && (typeof model !== "string" || !MODEL_RE.test(model))) {
    throw new LaunchProfileError("profile: model choice is not a plain model name");
  }

  const env = {};
  for (const k of FORWARD_KEYS) if (typeof parentEnv[k] === "string") env[k] = parentEnv[k];
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

  const claudePath = resolveOnPath("claude", parentEnv.PATH);
  if (!claudePath) throw new LaunchProfileError("profile: claude not found on PATH");

  const { scratch, roots } = resolveScratchRoot(scratchRoot, workspaceRoots);

  let cwd;
  try {
    // `scratch` is already physical, so the new directory's path is too.
    cwd = mkdtempSync(join(scratch, "scout-direct-"));
  } catch {
    throw new LaunchProfileError("profile: neutral cwd could not be created");
  }
  const cleanup = () => rmSync(cwd, { recursive: true, force: true });
  let neutralCwd;
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

  const forwardedKeys = Object.keys(env).sort();
  const droppedKeys = Object.keys(parentEnv).filter((k) => !Object.hasOwn(env, k)).sort();
  const modelArgs = model === undefined ? [] : ["--model", model];

  return Object.freeze({
    id: PROFILE_ID,
    claudePath,
    cwd,
    env,
    modelArgs: Object.freeze(modelArgs),
    forwardedKeys,
    droppedKeys,
    neutralCwd,
    cleanup,
    /** Key names and classifications only: no values, paths or identity. */
    toJSON() {
      return { id: PROFILE_ID, forwardedKeys, droppedKeys, neutralCwd, modelArgs };
    },
  });
}

/**
 * Run the audited billing preflight against exactly this profile's child env,
 * cwd and claude binary. The profile never short-circuits any check: user,
 * project (cwd ancestors) and managed settings, env routes and
 * `claude auth status` all still decide the verdict.
 * Test seams (API only): `managedPaths`, `projectStopAt`, `username`, `fs`,
 * `timeoutMs`, `platform` as in runPreflight; `preflight` replaces runPreflight.
 */
export function runProfilePreflight(profile, { parentEnv, preflight = runPreflight, managedPaths, projectStopAt, username, fs, timeoutMs, platform } = {}) {
  return preflight({
    env: parentEnv ?? {},
    cwd: profile.cwd,
    child: { env: profile.env, claudePath: profile.claudePath, strategy: profile.id },
    ...Object.fromEntries(Object.entries({ managedPaths, projectStopAt, username, fs, timeoutMs, platform }).filter(([, v]) => v !== undefined)),
  });
}
