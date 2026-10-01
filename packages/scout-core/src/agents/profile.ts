// The agent profile: `<SCOUT_HOME>/agent-profile.json`. Which agent CLI Scout's background
// jobs run, and with which model. Not in the plan's P1.2 file list; it is small and every
// other agents/ file reads it.
//
// - `claudePath` is absolute; jobs never look `claude` up on PATH. createDefaultAgentProfile
//   resolves it once, from the PATH it is given, when the profile is first written.
// - `model` is explicit and required. The initial value is Hunter's 2026-09-30 choice,
//   `claude-sonnet-5-5`; he may edit it. A job never inherits a CLI, settings or gateway
//   default model, and the init check stops a job whose CLI reports a different model.
// - The fingerprint is a hash of the canonical profile content. Job requests and revisit
//   cache keys carry it, so an edited profile never reuses an older job's result.
//
// Extension point (P1.3 / P2.7): selected user tool references will be added here as a new
// field. Until then the schema is strict, so a profile that already names tools is refused
// rather than silently run without them.

import { createHash } from "node:crypto";
import { closeSync, constants as fsc, fstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { resolveOnPath, type Env } from "./authPreflight.js";

export const AGENT_PROFILE_FILE = "agent-profile.json";
export const AGENT_PROFILE_SCHEMA_VERSION = 1;
/** Hunter's 2026-09-30 choice for the initial Claude profile. Editable in the profile file. */
export const DEFAULT_AGENT_MODEL = "claude-sonnet-5-5";
const PROFILE_MAX_BYTES = 16 * 1024;

/** Only a plain alias or model name; never anything that parses as a flag. Same rule as the legacy service's MODEL_RE. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,63}$/;

export const AgentProfileSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_PROFILE_SCHEMA_VERSION),
  adapter: z.literal("claude-code"),
  claudePath: z
    .string()
    .max(1024)
    .refine((p) => isAbsolute(p) && !p.includes("\0"), { message: "claudePath must be absolute" }),
  model: z.string().regex(MODEL_RE),
});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export type AgentProfileErrorCode =
  | "profile: missing"
  | "profile: unreadable"
  | "profile: invalid"
  | "profile: not a private regular file"
  | "profile: claude not found on PATH";

export class AgentProfileError extends Error {
  constructor(readonly code: AgentProfileErrorCode) {
    super(code); // fixed code only: never a path or value
    this.name = "AgentProfileError";
  }
}

/** Stable hash of the profile content (keys sorted), hex. */
export function profileFingerprint(profile: AgentProfile): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(profile).sort(([a], [b]) => a.localeCompare(b))));
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
}

export function agentProfilePath(home: string): string {
  return join(home, AGENT_PROFILE_FILE);
}

/** The initial Claude profile: the `claude` found on `parentEnv.PATH`, and the default model. */
export function createDefaultAgentProfile(parentEnv: Env): AgentProfile {
  const claudePath = resolveOnPath("claude", parentEnv.PATH);
  if (!claudePath) throw new AgentProfileError("profile: claude not found on PATH");
  return { schemaVersion: AGENT_PROFILE_SCHEMA_VERSION, adapter: "claude-code", claudePath, model: DEFAULT_AGENT_MODEL };
}

/** Read and validate `<home>/agent-profile.json`. It must be a regular file owned by this user, without group/other bits. */
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
