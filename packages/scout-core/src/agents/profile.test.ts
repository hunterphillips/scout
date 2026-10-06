import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentProfileError,
  agentProfilePath,
  AgentProfileSchema,
  createDefaultAgentProfile,
  loadAgentProfile,
  profileFingerprint,
  writeAgentProfile,
  type AgentProfile,
} from "./profile.js";
import { DEFAULT_CLAUDE_CODE_MODEL } from "./claudeCode/profile.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function home(): string {
  const d = mkdtempSync(join(tmpdir(), "scout-profile-"));
  dirs.push(d);
  return d;
}

const profile: AgentProfile = { schemaVersion: 1, adapter: "claude-code", claudePath: "/opt/bin/claude", model: DEFAULT_CLAUDE_CODE_MODEL };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AgentProfileError ? e.code : "other";
  }
  return undefined;
}

describe("agent profile", () => {
  it("defaults to the initial model and the claude found on PATH", () => {
    const h = home();
    const bin = join(h, "bin");
    const claude = join(bin, "claude");
    mkdirSync(bin);
    writeFileSync(claude, "#!/bin/sh\n");
    chmodSync(claude, 0o755);
    expect(createDefaultAgentProfile({ PATH: bin })).toEqual({ ...profile, claudePath: claude });
    expect(DEFAULT_CLAUDE_CODE_MODEL).toBe("claude-sonnet-5-5");
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
    ["a bare model alias", { ...profile, model: "sonnet" }],
    ["a family alias", { ...profile, model: "claude-sonnet" }],
    ["a model without a minor version", { ...profile, model: "claude-opus-5" }],
    ["tool references before P1.3 supports them", { ...profile, tools: [{ server: "notes" }] }],
    ["another schema version", { ...profile, schemaVersion: 2 }],
    ["an unknown adapter", { ...profile, adapter: "other-agent" }],
    ["no adapter", { schemaVersion: 1, claudePath: "/opt/bin/claude", model: DEFAULT_CLAUDE_CODE_MODEL }],
  ])("refuses %s", (_l, content) => {
    const h = home();
    writeFileSync(agentProfilePath(h), JSON.stringify(content), { mode: 0o600 });
    expect(codeOf(() => loadAgentProfile(h))).toBe("profile: invalid");
  });

  it("accepts full model names, dated or not, and explains a refused alias", () => {
    for (const model of ["claude-sonnet-5-5", "claude-opus-4-1", "claude-sonnet-4-5-20250929"]) expect(AgentProfileSchema.safeParse({ ...profile, model }).success).toBe(true);
    const refused = AgentProfileSchema.safeParse({ ...profile, model: "sonnet" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((i) => i.path.join("."))).toEqual(["model"]);
    expect(refused.error?.issues[0]?.message).toMatch(/alias/);
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
