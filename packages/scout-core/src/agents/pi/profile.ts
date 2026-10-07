// The Pi member of the agent profile (agents/profile.ts):
//
// - `piPath` is absolute. Jobs use the recorded executable, never a fresh PATH lookup.
// - `model`, when present, is `provider/id` and is passed as --model. Without it, a job
//   copies the user's model-selection settings and lets Pi choose its default model.
// - `thinking` is optional; jobs use DEFAULT_PI_THINKING when the profile omits it.
// - `tools` is the shared, optional selection of reviewed MCP tools for the job bridge.
//
// scripts/setup.mjs reads PI_ADAPTER_ID and DEFAULT_PI_THINKING from the built file as
// plain `export const` literals: keep them literals.

import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { homeOf, resolveExecutable, versionedBins, type Env, type ExecutableSearch } from "../executables.js";
import { AGENT_PROFILE_SCHEMA_VERSION, AgentProfileError } from "../profileBase.js";
import { ToolsProfileSchema } from "../toolProfile.js";

export const PI_ADAPTER_ID = "pi";
/** The adapter's name in the side panel's Settings. */
export const PI_LABEL = "Pi";
/** The thinking level used when the profile names none. */
export const DEFAULT_PI_THINKING = "low";
/** A provider-qualified model name, with no flag or shell syntax. */
export const PI_MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const PI_SYSTEM_DIRS: readonly string[] = ["/opt/homebrew/bin", "/usr/local/bin"];

export const PiProfileSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_PROFILE_SCHEMA_VERSION),
  adapter: z.literal(PI_ADAPTER_ID),
  piPath: z
    .string()
    .max(1024)
    .refine((p) => isAbsolute(p) && !p.includes("\0"), { message: "piPath must be absolute" }),
  model: z.string().regex(PI_MODEL_RE).optional(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  tools: ToolsProfileSchema.optional(),
});

export type PiProfile = z.infer<typeof PiProfileSchema>;

/** Usual Pi locations after PATH, including a bounded nvm version listing. */
export function defaultExecutableFallbacks(env: Env, systemDirs: readonly string[] = PI_SYSTEM_DIRS): string[] {
  const home = homeOf(env);
  return [
    ...systemDirs.map((dir) => join(dir, "pi")),
    ...(home
      ? [
          join(home, ".local", "bin", "pi"),
          join(home, ".pi", "agent", "bin", "pi"),
          ...versionedBins(join(home, ".nvm", "versions", "node"), "pi"),
        ]
      : []),
  ];
}

/** The executable a new Pi profile records: PATH first, then fallback locations. */
export function findExecutable(env: Env, search: ExecutableSearch = {}): string | undefined {
  return resolveExecutable("pi", env.PATH, defaultExecutableFallbacks(env, search.systemDirs));
}

/** Build Pi's initial profile without specifying a model, preserving the user's default. */
export function createDefaultPiProfile(parentEnv: Env, search: ExecutableSearch = {}): PiProfile {
  const piPath = findExecutable(parentEnv, search);
  if (!piPath) throw new AgentProfileError("profile: pi not found on PATH");
  return {
    schemaVersion: AGENT_PROFILE_SCHEMA_VERSION,
    adapter: PI_ADAPTER_ID,
    piPath,
    thinking: DEFAULT_PI_THINKING,
  };
}
