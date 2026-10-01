import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentProfileError,
  agentProfilePath,
  createDefaultAgentProfile,
  DEFAULT_AGENT_MODEL,
  loadAgentProfile,
  profileFingerprint,
  writeAgentProfile,
  type AgentProfile,
} from "./profile.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function home(): string {
  const d = mkdtempSync(join(tmpdir(), "scout-profile-"));
  dirs.push(d);
  return d;
}

const profile: AgentProfile = { schemaVersion: 1, adapter: "claude-code", claudePath: "/opt/bin/claude", model: DEFAULT_AGENT_MODEL };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AgentProfileError ? e.code : "other";
  }
  return undefined;
}

describe("agent profile", () => {
  it("defaults to Hunter's 2026-09-30 model and the claude found on PATH", () => {
    const h = home();
    const bin = join(h, "bin");
    const claude = join(bin, "claude");
    mkdirSync(bin);
    writeFileSync(claude, "#!/bin/sh\n");
    chmodSync(claude, 0o755);
    expect(createDefaultAgentProfile({ PATH: bin })).toEqual({ ...profile, claudePath: claude });
    expect(DEFAULT_AGENT_MODEL).toBe("claude-sonnet-5-5");
    expect(codeOf(() => createDefaultAgentProfile({ PATH: h }))).toBe("profile: claude not found on PATH");
  });

  it("round-trips through a 0600 file", () => {
    const h = home();
    writeAgentProfile(h, profile);
    expect(statSync(agentProfilePath(h)).mode & 0o777).toBe(0o600);
    expect(loadAgentProfile(h)).toEqual(profile);
  });

  it("fingerprints content, not key order; any edit changes it", () => {
    const reordered = { model: profile.model, claudePath: profile.claudePath, adapter: profile.adapter, schemaVersion: profile.schemaVersion } as AgentProfile;
    expect(profileFingerprint(reordered)).toBe(profileFingerprint(profile));
    expect(profileFingerprint({ ...profile, model: "claude-opus-5" })).not.toBe(profileFingerprint(profile));
  });

  it.each<[string, unknown]>([
    ["a relative claude path", { ...profile, claudePath: "claude" }],
    ["no model (no silent inheritance)", { schemaVersion: 1, adapter: "claude-code", claudePath: "/opt/bin/claude" }],
    ["a null model", { ...profile, model: null }],
    ["a flag-shaped model", { ...profile, model: "--dangerously-skip-permissions" }],
    ["tool references before P1.3 supports them", { ...profile, tools: [{ server: "notes" }] }],
    ["another schema version", { ...profile, schemaVersion: 2 }],
  ])("refuses %s", (_l, content) => {
    const h = home();
    writeFileSync(agentProfilePath(h), JSON.stringify(content), { mode: 0o600 });
    expect(codeOf(() => loadAgentProfile(h))).toBe("profile: invalid");
  });

  it("refuses a missing, malformed or group-readable file", () => {
    const h = home();
    expect(codeOf(() => loadAgentProfile(h))).toBe("profile: missing");
    writeFileSync(agentProfilePath(h), "{nope", { mode: 0o600 });
    expect(codeOf(() => loadAgentProfile(h))).toBe("profile: invalid");
    writeFileSync(agentProfilePath(h), JSON.stringify(profile));
    chmodSync(agentProfilePath(h), 0o644);
    expect(codeOf(() => loadAgentProfile(h))).toBe("profile: not a private regular file");
  });
});
