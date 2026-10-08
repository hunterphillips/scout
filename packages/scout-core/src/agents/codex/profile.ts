// The Codex member of the agent profile (agents/profile.ts):
//
// - `codexPath` is absolute; jobs never look `codex` up on PATH. createDefaultCodexProfile
//   resolves it once, from the PATH it is given and then defaultExecutableFallbacks, when the
//   profile is first written.
// - `model` is explicit and required (a plain model name, never a flag). The initial value is
//   DEFAULT_CODEX_MODEL; a job never inherits a CLI or config default model.
// - `reasoningEffort` is optional; jobs run at DEFAULT_CODEX_REASONING_EFFORT without it.
//
// scripts/setup.mjs reads CODEX_ADAPTER_ID, DEFAULT_CODEX_MODEL and DEFAULT_CODEX_REASONING_EFFORT
// from the built file as plain `export const` literals: keep them literals.

import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { homeOf, resolveExecutable, versionedBins, type Env, type ExecutableSearch } from "../executables.js";
import { AGENT_PROFILE_SCHEMA_VERSION, AgentProfileError } from "../profileBase.js";
import { ToolsProfileSchema } from "../toolProfile.js";

export const CODEX_ADAPTER_ID = "codex";
/** The adapter's name in the side panel's Settings. */
export const CODEX_LABEL = "Codex";
/** The initial model for the Codex profile; editable in the profile file. */
export const DEFAULT_CODEX_MODEL = "gpt-6-luna";
/** The reasoning effort a job runs at when the profile names none. */
export const DEFAULT_CODEX_REASONING_EFFORT = "medium";

/** A plain model name: lower-case, never anything that parses as a flag. */
export const CODEX_MODEL_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

export const CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export const CodexProfileSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_PROFILE_SCHEMA_VERSION),
  adapter: z.literal(CODEX_ADAPTER_ID),
  codexPath: z
    .string()
    .max(1024)
    .refine((p) => isAbsolute(p) && !p.includes("\0"), { message: "codexPath must be absolute" }),
  model: z.string().regex(CODEX_MODEL_RE, { message: "model must be a plain model name such as gpt-6-luna" }),
  reasoningEffort: z.enum(CODEX_REASONING_EFFORTS).optional(),
  tools: ToolsProfileSchema.optional(),
});

export type CodexProfile = z.infer<typeof CodexProfileSchema>;

/** System directories searched for `codex` after PATH. */
export const CODEX_SYSTEM_DIRS: readonly string[] = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * Where `codex` usually lives when PATH does not have it (an app started from Finder or at login
 * gets launchd's minimal PATH), in search order. Home locations come from `env.HOME` only; the
 * nvm entries are a bounded directory listing (executables.ts versionedBins). Candidates: the
 * lookup checks each one.
 */
export function defaultExecutableFallbacks(env: Env, systemDirs: readonly string[] = CODEX_SYSTEM_DIRS): string[] {
  const home = homeOf(env);
  return [
    ...systemDirs.map((d) => join(d, "codex")),
    ...(home ? [join(home, ".local", "bin", "codex"), ...versionedBins(join(home, ".nvm", "versions", "node"), "codex")] : []),
  ];
}

/** The `codex` a new profile records: PATH first, then defaultExecutableFallbacks. */
export function findExecutable(env: Env, search: ExecutableSearch = {}): string | undefined {
  return resolveExecutable("codex", env.PATH, defaultExecutableFallbacks(env, search.systemDirs));
}

/** The initial Codex profile: the `codex` findExecutable finds, and the default model. */
export function createDefaultCodexProfile(parentEnv: Env, search: ExecutableSearch = {}): CodexProfile {
  const codexPath = findExecutable(parentEnv, search);
  if (!codexPath) throw new AgentProfileError("profile: codex not found on PATH");
  return { schemaVersion: AGENT_PROFILE_SCHEMA_VERSION, adapter: CODEX_ADAPTER_ID, codexPath, model: DEFAULT_CODEX_MODEL };
}
