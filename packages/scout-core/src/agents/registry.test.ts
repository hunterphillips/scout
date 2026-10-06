import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { profileFingerprint, type AgentProfile } from "./profile.js";
import { createJobAdapter, createReadinessChecks } from "./registry.js";

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
});
