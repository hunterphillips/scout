import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentProfileError,
  agentProfilePath,
  AgentProfileSchema,
  loadAgentProfile,
  profileFingerprint,
  writeAgentProfile,
  type AgentProfile,
} from "./profile.js";
import { createDefaultAgentProfile } from "./registry.js";
import { DEFAULT_CLAUDE_CODE_MODEL, DEFAULT_CLAUDE_CODE_REASONING_EFFORT } from "./claudeCode/profile.js";
import { createDefaultCodexProfile, DEFAULT_CODEX_MODEL, DEFAULT_CODEX_REASONING_EFFORT } from "./codex/profile.js";

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
    expect(DEFAULT_CLAUDE_CODE_MODEL).toBe("claude-haiku-5-5");
    expect(DEFAULT_CLAUDE_CODE_REASONING_EFFORT).toBe("low");
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
    ["a bare list of tool references in place of a tools profile", { ...profile, tools: [{ server: "notes" }] }],
    ["another schema version", { ...profile, schemaVersion: 2 }],
    ["an unknown adapter", { ...profile, adapter: "other-agent" }],
    ["no adapter", { schemaVersion: 1, claudePath: "/opt/bin/claude", model: DEFAULT_CLAUDE_CODE_MODEL }],
    ["an unknown reasoning effort", { ...profile, reasoningEffort: "minimal" }],
    ["a flag-shaped reasoning effort", { ...profile, reasoningEffort: "--bare" }],
  ])("refuses %s", (_l, content) => {
    const h = home();
    writeFileSync(agentProfilePath(h), JSON.stringify(content), { mode: 0o600 });
    expect(codeOf(() => loadAgentProfile(h))).toBe("profile: invalid");
  });

  it("keeps a named model and accepts every Claude Code effort level", () => {
    const h = home();
    for (const reasoningEffort of ["low", "medium", "high", "xhigh", "max"] as const) {
      writeAgentProfile(h, { ...profile, model: "claude-sonnet-5-5", reasoningEffort });
      expect(loadAgentProfile(h)).toEqual({ ...profile, model: "claude-sonnet-5-5", reasoningEffort });
    }
    expect(profileFingerprint({ ...profile, reasoningEffort: "high" })).not.toBe(profileFingerprint(profile));
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

describe("agent profile: the Codex member", () => {
  const codex: AgentProfile = { schemaVersion: 1, adapter: "codex", codexPath: "/opt/bin/codex", model: DEFAULT_CODEX_MODEL };

  it("an existing Claude Code file still parses next to a Codex one", () => {
    const h = home();
    writeFileSync(agentProfilePath(h), JSON.stringify(profile), { mode: 0o600 });
    expect(loadAgentProfile(h)).toEqual(profile);
    writeAgentProfile(h, { ...codex, reasoningEffort: "medium" });
    expect(loadAgentProfile(h)).toEqual({ ...codex, reasoningEffort: "medium" });
  });

  it("defaults to gpt-6-luna at medium effort and the codex found on PATH", () => {
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-6-luna");
    expect(DEFAULT_CODEX_REASONING_EFFORT).toBe("medium");
    const h = home();
    const bin = join(h, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), "#!/bin/sh\n");
    chmodSync(join(bin, "codex"), 0o755);
    expect(createDefaultCodexProfile({ PATH: bin })).toEqual({ ...codex, codexPath: join(bin, "codex") });
    expect(codeOf(() => createDefaultCodexProfile({ PATH: h }))).toBe("profile: codex not found on PATH");
  });

  it("fingerprints differ between the two adapters", () => {
    expect(profileFingerprint(codex)).not.toBe(profileFingerprint(profile));
    expect(profileFingerprint({ ...codex, reasoningEffort: "high" })).not.toBe(profileFingerprint(codex));
  });

  it.each<[string, unknown]>([
    ["a relative codex path", { ...codex, codexPath: "codex" }],
    ["a NUL in the codex path", { ...codex, codexPath: "/opt/bin/co\0dex" }],
    ["a flag-shaped model", { ...codex, model: "--yolo" }],
    ["an upper-case model", { ...codex, model: "GPT-6" }],
    ["no model", { schemaVersion: 1, adapter: "codex", codexPath: "/opt/bin/codex" }],
    ["an unknown reasoning effort", { ...codex, reasoningEffort: "max" }],
    ["a Claude field on a Codex profile", { ...codex, claudePath: "/opt/bin/claude" }],
    ["a Codex field on a Claude profile", { ...profile, codexPath: "/opt/bin/codex" }],
    ["an unknown adapter", { ...codex, adapter: "other-agent" }],
  ])("refuses %s", (_l, content) => {
    const h = home();
    writeFileSync(agentProfilePath(h), JSON.stringify(content), { mode: 0o600 });
    expect(codeOf(() => loadAgentProfile(h))).toBe("profile: invalid");
  });
});
