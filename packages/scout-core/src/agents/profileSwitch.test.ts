import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentProfilePath, writeAgentProfile, type AgentProfile } from "./profile.js";
import { agentChoices, switchAgent } from "./profileSwitch.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    chmodSync(d, 0o700);
    rmSync(d, { recursive: true, force: true });
  }
});

/** A home with a bin dir holding the named (stub) executables. */
function setup(...executables: string[]): { home: string; bin: string } {
  const home = mkdtempSync(join(tmpdir(), "scout-switch-"));
  dirs.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin);
  for (const name of executables) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, name), 0o755);
  }
  return { home, bin };
}

const TOOLS = { revision: 3, connections: [], selections: [] };
const claudeProfile = (bin: string, extra: Partial<AgentProfile> = {}): AgentProfile =>
  ({ schemaVersion: 1, adapter: "claude-code", claudePath: join(bin, "claude"), model: "claude-sonnet-5-5", ...extra }) as AgentProfile;
const read = (home: string): unknown => JSON.parse(readFileSync(agentProfilePath(home), "utf8"));

describe("agent choices", () => {
  it("offers one option per adapter found on PATH, labelled, with the profile's adapter as current", () => {
    const { home, bin } = setup("claude", "codex");
    writeAgentProfile(home, claudeProfile(bin));
    expect(agentChoices(home, { PATH: bin })).toEqual({
      available: [
        { id: "claude-code", label: "Claude Code" },
        { id: "codex", label: "Codex" },
      ],
      current: "claude-code",
    });
  });

  it("leaves out an adapter whose executable is missing, and names no current agent without a usable profile", () => {
    const { home, bin } = setup("codex");
    expect(agentChoices(home, { PATH: bin })).toEqual({ available: [{ id: "codex", label: "Codex" }] });
    writeFileSync(agentProfilePath(home), "{not json", { mode: 0o600 });
    expect(agentChoices(home, { PATH: bin })).toEqual({ available: [{ id: "codex", label: "Codex" }] });
    expect(agentChoices(home, {})).toEqual({ available: [] });
  });

  it("keeps the current adapter while the executable its profile records exists, even off PATH", () => {
    const { home, bin } = setup("claude");
    writeAgentProfile(home, claudeProfile(bin));
    expect(agentChoices(home, { PATH: "/nonexistent-scout-test" })).toEqual({ available: [{ id: "claude-code", label: "Claude Code" }], current: "claude-code" });
    rmSync(join(bin, "claude"));
    expect(agentChoices(home, { PATH: bin })).toEqual({ available: [], current: "claude-code" });
  });
});

describe("switching the agent", () => {
  it("writes the chosen adapter's default profile 0600, keeping the selected tools", () => {
    const { home, bin } = setup("claude", "codex");
    writeAgentProfile(home, claudeProfile(bin, { tools: TOOLS }));
    expect(switchAgent(home, "codex", { PATH: bin })).toEqual({ ok: true, written: true });
    expect(read(home)).toEqual({ schemaVersion: 1, adapter: "codex", codexPath: join(bin, "codex"), model: "gpt-6-sol", tools: TOOLS });
    expect(statSync(agentProfilePath(home)).mode & 0o777).toBe(0o600);
    expect(switchAgent(home, "claude-code", { PATH: bin })).toEqual({ ok: true, written: true });
    expect(read(home)).toEqual(claudeProfile(bin, { tools: TOOLS }));
  });

  it("writes a profile where there was none, or an unusable one", () => {
    const { home, bin } = setup("codex");
    expect(switchAgent(home, "codex", { PATH: bin })).toEqual({ ok: true, written: true });
    expect(read(home)).toEqual({ schemaVersion: 1, adapter: "codex", codexPath: join(bin, "codex"), model: "gpt-6-sol" });
    writeFileSync(agentProfilePath(home), JSON.stringify({ schemaVersion: 1, adapter: "codex", codexPath: "relative/codex", model: "gpt-6-sol" }), { mode: 0o600 });
    expect(switchAgent(home, "codex", { PATH: bin })).toEqual({ ok: true, written: true });
    expect(read(home)).toEqual({ schemaVersion: 1, adapter: "codex", codexPath: join(bin, "codex"), model: "gpt-6-sol" });
  });

  it("choosing the current adapter writes nothing, so an edited model survives a retry", () => {
    const { home, bin } = setup("claude");
    const edited = claudeProfile(bin, { model: "claude-opus-5-5" });
    writeAgentProfile(home, edited);
    const before = statSync(agentProfilePath(home));
    expect(switchAgent(home, "claude-code", { PATH: bin })).toEqual({ ok: true, written: false });
    expect(switchAgent(home, "claude-code", { PATH: bin })).toEqual({ ok: true, written: false });
    expect(read(home)).toEqual(edited);
    expect(statSync(agentProfilePath(home)).ino).toBe(before.ino);
  });

  it("refuses an adapter whose executable is not found (not_found) or that does not exist (invalid), writing nothing", () => {
    const { home, bin } = setup("claude");
    writeAgentProfile(home, claudeProfile(bin, { tools: TOOLS }));
    expect(switchAgent(home, "codex", { PATH: bin })).toEqual({ ok: false, code: "not_found" });
    expect(switchAgent(home, "other-agent", { PATH: bin })).toEqual({ ok: false, code: "invalid" });
    expect(read(home)).toEqual(claudeProfile(bin, { tools: TOOLS }));
  });

  it("a failed write is store_error and leaves the profile as it was", () => {
    const { home, bin } = setup("claude", "codex");
    writeAgentProfile(home, claudeProfile(bin));
    chmodSync(home, 0o500);
    expect(switchAgent(home, "codex", { PATH: bin })).toEqual({ ok: false, code: "store_error" });
    chmodSync(home, 0o700);
    expect(read(home)).toEqual(claudeProfile(bin));
  });
});
