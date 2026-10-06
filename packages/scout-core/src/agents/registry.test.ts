import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { profileFingerprint, type AgentProfile } from "./profile.js";
import { createDefaultProfileFor, createJobAdapter, createReadinessChecks } from "./registry.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const profile: AgentProfile = { schemaVersion: 1, adapter: "claude-code", claudePath: "/nonexistent-scout-test/claude", model: "claude-sonnet-5-5" };

describe("adapter registry", () => {
  it("builds the profile's adapter, bound to its fingerprint and not ready before a check", () => {
    const home = mkdtempSync(join(tmpdir(), "scout-registry-"));
    dirs.push(home);
    const adapter = createJobAdapter(profile, { home, parentEnv: {} });
    expect(adapter.id).toBe("claude-code");
    expect(adapter.profileFingerprint).toBe(profileFingerprint(profile));
    expect(adapter.readiness).toMatchObject({ ok: false, verdict: "unchecked" });
  });

  it("readiness checks cancelled before any adapter exists stay cancelled for adapters built later", async () => {
    const home = mkdtempSync(join(tmpdir(), "scout-registry-"));
    dirs.push(home);
    const checks = createReadinessChecks();
    checks.cancelAll();
    const adapter = createJobAdapter(profile, { home, parentEnv: {}, readinessChecks: checks });
    const readiness = await adapter.refreshReadiness();
    // The shared check refused to start a preflight child at all.
    expect(readiness).toMatchObject({ ok: false, reasons: ["internal: preflight cancelled"] });
  });

  it("builds the Codex adapter for a Codex profile; one cancelAll stops both adapters' checks", async () => {
    const home = mkdtempSync(join(tmpdir(), "scout-registry-"));
    dirs.push(home);
    const codex: AgentProfile = { schemaVersion: 1, adapter: "codex", codexPath: "/nonexistent-scout-test/codex", model: "gpt-6-sol" };
    const checks = createReadinessChecks();
    const adapter = createJobAdapter(codex, { home, parentEnv: {}, readinessChecks: checks });
    expect(adapter.id).toBe("codex");
    expect(adapter.profileFingerprint).toBe(profileFingerprint(codex));
    expect(adapter.readiness).toMatchObject({ ok: false, verdict: "unchecked" });
    const claude = createJobAdapter(profile, { home, parentEnv: {}, readinessChecks: checks });
    checks.cancelAll();
    expect(await adapter.refreshReadiness()).toMatchObject({ ok: false, reasons: ["internal: readiness cancelled"] });
    expect(await claude.refreshReadiness()).toMatchObject({ ok: false, reasons: ["internal: preflight cancelled"] });
  });

  it("createDefaultProfileFor names each adapter's executable", () => {
    expect(() => createDefaultProfileFor("codex", { PATH: "/nonexistent-scout-test" })).toThrow("profile: codex not found on PATH");
    expect(() => createDefaultProfileFor("claude-code", { PATH: "/nonexistent-scout-test" })).toThrow("profile: claude not found on PATH");
  });
});
