// The agent profile: `<SCOUT_HOME>/agent-profile.json`. Which agent Scout's background jobs run,
// and how. It is small, and every other agents/ file reads it.
//
// - The profile is a union on `adapter`: one strict member per agent adapter (each in its
//   adapter's folder), so an unknown adapter id, or a field another member owns, is refused.
// - The fingerprint is a hash of the canonical profile content. Job requests and revisit
//   cache keys carry it, so an edited profile never reuses an older job's result.
//
// - `tools` (optional, toolProfile.ts): the existing MCP tools the user selected for jobs and
//   the reviewed stdio definitions that serve them, as references and bindings only, never
//   secret values. The schema stays strict: an unknown field is refused, never ignored.

import { createHash } from "node:crypto";
import { closeSync, constants as fsc, fstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ClaudeCodeProfileSchema } from "./claudeCode/profile.js";
import { CodexProfileSchema } from "./codex/profile.js";
import { PiProfileSchema } from "./pi/profile.js";
import { AgentProfileError } from "./profileBase.js";
import { canonicalJson } from "./toolProfile.js";

export { AGENT_PROFILE_SCHEMA_VERSION, AgentProfileError, type AgentProfileErrorCode } from "./profileBase.js";

export const AGENT_PROFILE_FILE = "agent-profile.json";
/** The lock (capabilities/storeLock.ts) the core holds; every profile CLI write takes it. */
export const AGENT_PROFILE_LOCK_FILE = "agent-profile.lock";
/** Room for the selected tools' frozen input schemas. */
export const PROFILE_MAX_BYTES = 512 * 1024;

/**
 * Only a plain alias or model name; never anything that parses as a flag. Same rule as the
 * removed package's MODEL_RE.
 */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/;

export const AgentProfileSchema = z.discriminatedUnion("adapter", [ClaudeCodeProfileSchema, CodexProfileSchema, PiProfileSchema]);

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/** Every adapter id a profile may name. */
export const AGENT_ADAPTER_IDS = ["claude-code", "codex", "pi"] as const satisfies readonly AgentProfile["adapter"][];

/**
 * Stable hash of the profile content (keys sorted at every depth), hex. Any change to the
 * selected tools, their schemas or the connection definitions changes it.
 */
export function profileFingerprint(profile: AgentProfile): string {
  return createHash("sha256").update(canonicalJson(profile), "utf8").digest("hex").slice(0, 32);
}

export function agentProfilePath(home: string): string {
  return join(home, AGENT_PROFILE_FILE);
}

/**
 * Read and validate `<home>/agent-profile.json`. It must be a regular file owned by this user,
 * without group/other bits.
 */
export function loadAgentProfile(home: string): AgentProfile {
  let raw: string;
  let fd: number | undefined;
  try {
    fd = openSync(agentProfilePath(home), fsc.O_RDONLY | fsc.O_NOFOLLOW);
  } catch (e) {
    throw new AgentProfileError((e as NodeJS.ErrnoException).code === "ENOENT" ? "profile: missing" : "profile: unreadable");
  }
  try {
    const st = fstatSync(fd);
    const owned = typeof process.getuid !== "function" || st.uid === process.getuid();
    if (!st.isFile() || !owned || (st.mode & 0o077) !== 0) throw new AgentProfileError("profile: not a private regular file");
    if (st.size > PROFILE_MAX_BYTES) throw new AgentProfileError("profile: invalid");
    raw = readFileSync(fd, "utf8");
  } catch (e) {
    throw e instanceof AgentProfileError ? e : new AgentProfileError("profile: unreadable");
  } finally {
    closeSync(fd);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AgentProfileError("profile: invalid");
  }
  const parsed = AgentProfileSchema.safeParse(json);
  if (!parsed.success) throw new AgentProfileError("profile: invalid");
  return parsed.data;
}

/** Write the profile 0600, atomically (temp file + rename). */
export function writeAgentProfile(home: string, profile: AgentProfile): void {
  const valid = AgentProfileSchema.parse(profile);
  const path = agentProfilePath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(valid, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}
