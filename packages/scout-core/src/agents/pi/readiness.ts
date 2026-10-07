// Whether Pi can run a job: the profile's executable answers and has a usable local login.
// No model call or network request is made. Each check uses a disposable private Pi agent
// dir, with the same allowlisted env as a job, and removes it in finally.
//
// Invocations, both spawnSync with a 20 s deadline and SIGKILL:
//   pi --version                  bare x.y.z, else version_unknown
//   pi --list-models [model]      provider/model table; no models means not_logged_in;
//                                 an explicit model with no match means model_not_found
// Checked before those calls: cli_missing, auth_link_invalid, node_too_old (<22.19).
// Unexpected preparation failures return a fixed internal reason without echoing paths.

import { spawnSync as nodeSpawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureJobsRoot } from "../claudeCode/launchProfile.js";
import { isExecutableFile, type Env } from "../executables.js";
import { piChildEnv } from "./launch.js";
import type { PiProfile } from "./profile.js";
import { ensurePiAgentDir, userPiAgentDir } from "./userAgentDir.js";

export const READINESS_TIMEOUT_MS = 20_000;
export const READINESS_INVOCATIONS = [["--version"], ["--list-models"]] as const;

/** Cached by readinessWorker.ts; version is present only when --version parsed. */
export interface PiReadinessReport {
  verdict: "ready" | "unavailable";
  reasons: string[];
  version?: string;
}

export interface SpawnSyncResult {
  status: number | null;
  stdout: string | null;
  stderr: string | null;
  error?: Error;
}

/** Injectable spawn seam; all invocations have the same bounded options. */
export type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: {
    env: Readonly<Record<string, string>>;
    cwd: string;
    timeout: number;
    killSignal: "SIGKILL";
    encoding: "utf8";
    stdio: ["ignore", "pipe", "pipe"];
  },
) => SpawnSyncResult;

const defaultSpawnSync: SpawnSyncFn = (command, args, options) => {
  const result = nodeSpawnSync(command, [...args], { ...options, env: { ...options.env } });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error ? { error: result.error } : {}),
  };
};

/** Plain data that crosses the forked readiness child's IPC channel. */
export interface PiReadinessInput {
  home: string;
  parentEnv: Env;
  piPath: string;
  profile: PiProfile;
}

export interface PiReadinessOptions extends PiReadinessInput {
  spawnSync?: SpawnSyncFn;
  timeoutMs?: number;
  /** Test seam for the core's node version, which leads the child PATH. */
  nodeVersion?: string;
}

/** Run the two local Pi commands against a fresh private agent dir. Never throws. */
export function runPiReadiness(o: PiReadinessOptions): PiReadinessReport {
  try {
    const reasons: string[] = [];
    if (!isExecutableFile(o.piPath)) {
      return { verdict: "unavailable", reasons: ["cli_missing"] };
    }
    const userDir = userPiAgentDir(o.parentEnv);
    if (!userDir) {
      return { verdict: "unavailable", reasons: ["auth_link_invalid"] };
    }
    const node = /^(\d+)\.(\d+)\./.exec((o.nodeVersion ?? process.versions.node).replace(/^v/, ""));
    if (!node || Number(node[1]) < 22 || (Number(node[1]) === 22 && Number(node[2]) < 19)) {
      reasons.push("node_too_old");
    }

    const jobsRoot = ensureJobsRoot(join(o.home, "run", "jobs"));
    const root = mkdtempSync(join(jobsRoot, "pi-readiness-"));
    let version: string | undefined;
    try {
      const agentDir = join(root, "pi-agent");
      try {
        ensurePiAgentDir(agentDir, userDir);
      } catch {
        return { verdict: "unavailable", reasons: [...reasons, "auth_link_invalid"] };
      }
      const env = piChildEnv(o.parentEnv, o.piPath, agentDir, join(root, "answer-schema.json"));
      const spawn = o.spawnSync ?? defaultSpawnSync;
      const call = (args: readonly string[]): SpawnSyncResult =>
        spawn(o.piPath, args, {
          env,
          cwd: root,
          timeout: o.timeoutMs ?? READINESS_TIMEOUT_MS,
          killSignal: "SIGKILL",
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });

      const versionResult = call(READINESS_INVOCATIONS[0]);
      const versionText = String(versionResult.stdout ?? "").trim();
      if (!versionResult.error && versionResult.status === 0 && /^\d+\.\d+\.\d+$/.test(versionText)) {
        version = versionText;
      } else {
        reasons.push("version_unknown");
      }

      const modelsArgs = o.profile.model
        ? ["--list-models", o.profile.model]
        : READINESS_INVOCATIONS[1];
      const models = call(modelsArgs);
      const modelsText = String(models.stdout ?? "");
      if (o.profile.model && /No models matching/i.test(modelsText)) {
        reasons.push("model_not_found");
      } else if (
        models.error ||
        models.status !== 0 ||
        !/\bprovider\s+model\b/i.test(modelsText) ||
        /No models available/i.test(modelsText)
      ) {
        reasons.push("not_logged_in");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    return {
      verdict: reasons.length === 0 ? "ready" : "unavailable",
      reasons,
      ...(version ? { version } : {}),
    };
  } catch {
    return { verdict: "unavailable", reasons: ["internal: readiness failed unexpectedly"] };
  }
}

/** Prepare and run readiness from IPC-safe input; optional seams are test-only. */
export function runPiReadinessFor(
  input: PiReadinessInput,
  seams: Pick<PiReadinessOptions, "spawnSync" | "timeoutMs" | "nodeVersion"> = {},
): PiReadinessReport {
  return runPiReadiness({ ...input, ...seams });
}
