#!/usr/bin/env node
// Scout Phase 0: billing preflight for the service-owned direct launch profile.
// Runs NO model calls.
//
//   node scripts/spikes/direct-profile-preflight.mjs --scratch-root <absolute dir>
//
// Builds the launch profile (launch-profile.mjs) in a fresh private cwd under
// the scratch root, runs the same audited preflight (auth-preflight.mjs)
// against that exact child env/cwd/binary, removes the cwd, and prints a JSON
// report of key names, classifications and sanitized CLI fields only.
// Exit 0 means `subscription`; anything else is `ambiguous` (inference blocked).
// The inherited-environment preflight (auth-preflight.mjs) is unchanged.

import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLaunchProfile, LaunchProfileError, runProfilePreflight } from "./launch-profile.mjs";

const SCOUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Service-owned model choice for the later agent smoke. Not verified here.
export const DEFAULT_MODEL = "opus";

/**
 * @param {{ parentEnv: Record<string,string|undefined>, scratchRoot: string, workspaceRoots: string[],
 *           model?: string } & Record<string, unknown>} deps  (remaining keys: runProfilePreflight seams)
 * @returns {{ report: object, code: number }}
 */
export function runDirectPreflight(deps) {
  const { parentEnv, scratchRoot, workspaceRoots, model = DEFAULT_MODEL } = deps;
  let profile;
  try {
    profile = createLaunchProfile({ parentEnv, scratchRoot, workspaceRoots, model });
  } catch (e) {
    const reason = e instanceof LaunchProfileError ? e.code : "internal: launch profile failed unexpectedly";
    return finish({ reasons: [reason], profile: { status: "not-created" } });
  }

  const reasons = [];
  let pre;
  try {
    pre = runProfilePreflight(profile, deps);
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
  const out = {
    reasons,
    profile: { ...summary, neutralCwd: { ...summary.neutralCwd, projectSettingsFound }, cleanup },
  };
  if (pre) {
    const { verdict: _v, reasons: _r, inference: _i, ...rest } = pre;
    out.preflight = rest;
  }
  return finish(out);
}

function finish({ reasons, ...rest }) {
  const verdict = reasons.length === 0 ? "subscription" : "ambiguous";
  return { report: { verdict, reasons, inference: "none", ...rest }, code: verdict === "subscription" ? 0 : 1 };
}

/** Parse `--scratch-root <dir>`; anything else is refused. */
export function parseArgs(argv) {
  if (argv.length === 2 && argv[0] === "--scratch-root" && argv[1]) return { scratchRoot: argv[1] };
  return { error: "usage: --scratch-root <absolute dir outside the workspace> is required" };
}

function realOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Build the report text and exit code. Never throws. */
export function main(deps) {
  let result;
  try {
    result = runDirectPreflight(deps);
  } catch {
    result = finish({ reasons: ["internal: direct preflight failed unexpectedly"] });
  }
  return { stdout: JSON.stringify(result.report, null, 2) + "\n", code: result.code };
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const args = parseArgs(process.argv.slice(2));
  let out;
  if (args.error) {
    out = { stdout: JSON.stringify(finish({ reasons: [args.error] }).report, null, 2) + "\n", code: 1 };
  } else {
    out = main({
      parentEnv: process.env,
      scratchRoot: args.scratchRoot,
      // The scratch root must sit outside the invoking dir and the workspace containing scout/.
      workspaceRoots: [realOrSelf(process.cwd()), realOrSelf(dirname(SCOUT_DIR))],
    });
  }
  process.stdout.write(out.stdout);
  process.exitCode = out.code;
}
