// The Codex member of the agent profile (agents/profile.ts):
//
// - `codexPath` is absolute; jobs never look `codex` up on PATH. createDefaultCodexProfile
//   resolves it once, from the PATH it is given, when the profile is first written.
// - `model` is explicit and required (a plain model name, never a flag). The initial value is
//   DEFAULT_CODEX_MODEL; a job never inherits a CLI or config default model.
// - `reasoningEffort` is optional; jobs run at DEFAULT_CODEX_REASONING_EFFORT without it.
//
// scripts/setup.mjs reads CODEX_ADAPTER_ID, DEFAULT_CODEX_MODEL and DEFAULT_CODEX_REASONING_EFFORT
// from the built file as plain `export const` literals: keep them literals.

import { isAbsolute } from "node:path";
import { z } from "zod";
import { resolveOnPath, type Env } from "../executables.js";
import { AGENT_PROFILE_SCHEMA_VERSION, AgentProfileError } from "../profileBase.js";
import { ToolsProfileSchema } from "../toolProfile.js";

export const CODEX_ADAPTER_ID = "codex";
/** The initial model for the Codex profile; editable in the profile file. */
export const DEFAULT_CODEX_MODEL = "gpt-6-sol";
/** The reasoning effort a job runs at when the profile names none. */
export const DEFAULT_CODEX_REASONING_EFFORT = "low";

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
  model: z.string().regex(CODEX_MODEL_RE, { message: "model must be a plain model name such as gpt-6-sol" }),
  reasoningEffort: z.enum(CODEX_REASONING_EFFORTS).optional(),
  tools: ToolsProfileSchema.optional(),
});

export type CodexProfile = z.infer<typeof CodexProfileSchema>;

/** The initial Codex profile: the `codex` found on `parentEnv.PATH`, and the default model. */
export function createDefaultCodexProfile(parentEnv: Env): CodexProfile {
  const codexPath = resolveOnPath("codex", parentEnv.PATH);
  if (!codexPath) throw new AgentProfileError("profile: codex not found on PATH");
  return { schemaVersion: AGENT_PROFILE_SCHEMA_VERSION, adapter: CODEX_ADAPTER_ID, codexPath, model: DEFAULT_CODEX_MODEL };
}
