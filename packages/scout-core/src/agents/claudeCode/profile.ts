// The Claude Code member of the agent profile (agents/profile.ts):
//
// - `claudePath` is absolute; jobs never look `claude` up on PATH. createDefaultClaudeCodeProfile
//   resolves it once, from the PATH it is given, when the profile is first written.
// - `model` is explicit, required and a full model name (no alias). The initial value is
//   DEFAULT_CLAUDE_CODE_MODEL; editable in the profile file. A job never inherits a CLI, settings
//   or gateway default model, and the init check stops a job whose CLI reports a different model.
//
// scripts/setup.mjs reads CLAUDE_CODE_ADAPTER_ID and DEFAULT_CLAUDE_CODE_MODEL from the built
// file as plain `export const` literals: keep them literals.

import { isAbsolute } from "node:path";
import { z } from "zod";
import { resolveOnPath, type Env } from "../executables.js";
import { AGENT_PROFILE_SCHEMA_VERSION, AgentProfileError } from "../profileBase.js";
import { ToolsProfileSchema } from "../toolProfile.js";

export const CLAUDE_CODE_ADAPTER_ID = "claude-code";
/** The adapter's name in the side panel's Settings. */
export const CLAUDE_CODE_LABEL = "Claude Code";
/** The initial model for the Claude Code profile; editable in the profile file. */
export const DEFAULT_CLAUDE_CODE_MODEL = "claude-sonnet-5-5";

/**
 * A profile's model: the full `claude-<family>-<major>-<minor>` name, optionally dated
 * (`-YYYYMMDD`). A bare alias such as `sonnet` is refused: the init event reports the
 * resolved name, so a job launched with an alias would always fail its model check.
 */
export const PROFILE_MODEL_RE = /^claude-[a-z]+-\d{1,3}-\d{1,3}(?:-\d{8})?$/;

export const ClaudeCodeProfileSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_PROFILE_SCHEMA_VERSION),
  adapter: z.literal(CLAUDE_CODE_ADAPTER_ID),
  claudePath: z
    .string()
    .max(1024)
    .refine((p) => isAbsolute(p) && !p.includes("\0"), { message: "claudePath must be absolute" }),
  model: z.string().regex(PROFILE_MODEL_RE, {
    message: "model must be a full Claude model name such as claude-sonnet-5-5, not an alias such as sonnet",
  }),
  tools: ToolsProfileSchema.optional(),
});

export type ClaudeCodeProfile = z.infer<typeof ClaudeCodeProfileSchema>;

/** The initial Claude Code profile: the `claude` found on `parentEnv.PATH`, and the default model. */
export function createDefaultClaudeCodeProfile(parentEnv: Env): ClaudeCodeProfile {
  const claudePath = resolveOnPath("claude", parentEnv.PATH);
  if (!claudePath) throw new AgentProfileError("profile: claude not found on PATH");
  return { schemaVersion: AGENT_PROFILE_SCHEMA_VERSION, adapter: CLAUDE_CODE_ADAPTER_ID, claudePath, model: DEFAULT_CLAUDE_CODE_MODEL };
}
