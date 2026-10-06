// What every adapter's profile shares, apart from profile.ts so an adapter's profile module can
// use it without importing the union that includes it.

export const AGENT_PROFILE_SCHEMA_VERSION = 1;

export type AgentProfileErrorCode =
  | "profile: missing"
  | "profile: unreadable"
  | "profile: invalid"
  | "profile: not a private regular file"
  /** An adapter's default profile could not find its agent's executable. */
  | `profile: ${string} not found on PATH`;

export class AgentProfileError extends Error {
  constructor(readonly code: AgentProfileErrorCode) {
    super(code); // fixed code only: never a path or value
    this.name = "AgentProfileError";
  }
}
