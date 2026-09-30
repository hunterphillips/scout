import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FORWARD_KEYS, createLaunchProfile, LaunchProfileError, PROFILE_ID, runDirectPreflight, runProfilePreflight } from "./launchProfile.js";
import { cleanupSandboxes, expectNoSentinels, fakeClaude, gatewayParentEnv, makeSandbox, SUBSCRIPTION_STATUS, type Sandbox } from "./test-support/preflightSandbox.js";

afterEach(() => cleanupSandboxes());

function profileOpts(sb: Sandbox, extra: Record<string, unknown> = {}) {
  return { parentEnv: gatewayParentEnv(sb), scratchRoot: sb.scratch, workspaceRoots: [sb.root], claudePath: sb.claudePath, ...extra };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof LaunchProfileError ? e.code : "not-a-LaunchProfileError";
  }
  return undefined;
}

describe("launch profile: child environment", () => {
  it("forwards only allowlisted names and drops routing, provider, model and nested-session names", () => {
    const sb = makeSandbox();
    const profile = createLaunchProfile(profileOpts(sb));
    try {
      expect(Object.keys(profile.env).every((k) => FORWARD_KEYS.includes(k))).toBe(true);
      expect(Object.keys(profile.env).sort()).toEqual(["HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "PATH", "SHELL", "TMPDIR", "USER"]);
      for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDECODE", "NODE_OPTIONS", "PERSONAL_CONTEXT_HOME"]) {
        expect(profile.droppedKeys).toContain(k);
        expect(profile.env).not.toHaveProperty(k);
      }
      expect(Object.isFrozen(profile.env)).toBe(true);
    } finally {
      profile.cleanup();
    }
  });

  it("never mutates the parent env or process.env", () => {
    const sb = makeSandbox();
    const opts = profileOpts(sb);
    const before = JSON.stringify(opts.parentEnv);
    const procBefore = JSON.stringify(process.env);
    createLaunchProfile(opts).cleanup();
    expect(JSON.stringify(opts.parentEnv)).toBe(before);
    expect(JSON.stringify(process.env)).toBe(procBefore);
  });

  it("keeps an absolute CLAUDE_CONFIG_DIR and refuses a relative one", () => {
    const sb = makeSandbox();
    const abs = createLaunchProfile(profileOpts(sb, { parentEnv: gatewayParentEnv(sb, { CLAUDE_CONFIG_DIR: join(sb.root, "cfg") }) }));
    abs.cleanup();
    expect(abs.env.CLAUDE_CONFIG_DIR).toBe(join(sb.root, "cfg"));
    expect(codeOf(() => createLaunchProfile(profileOpts(sb, { parentEnv: gatewayParentEnv(sb, { CLAUDE_CONFIG_DIR: "rel/cfg" }) })))).toMatch(/CLAUDE_CONFIG_DIR/);
  });

  it("refuses a missing or relative HOME", () => {
    const sb = makeSandbox();
    const { HOME: _h, ...noHome } = gatewayParentEnv(sb);
    expect(codeOf(() => createLaunchProfile(profileOpts(sb, { parentEnv: noHome })))).toMatch(/HOME/);
  });

  it("serializes no env values, paths or secrets", () => {
    const sb = makeSandbox();
    const profile = createLaunchProfile(profileOpts(sb, { model: "opus" }));
    profile.cleanup();
    const text = JSON.stringify(profile);
    expect(expectNoSentinels(text)).toEqual([]);
    expect(text).not.toContain(sb.home);
    expect(text).not.toContain(profile.cwd);
    expect(text).not.toContain(sb.claudePath);
    expect(text).not.toContain("someone");
  });
});

describe("launch profile: neutral cwd, claude path, model", () => {
  it("creates a fresh private 0700 cwd under the scratch root and removes it on cleanup", () => {
    const sb = makeSandbox();
    const profile = createLaunchProfile(profileOpts(sb));
    expect(profile.cwd.startsWith(sb.scratch + "/")).toBe(true);
    expect(statSync(profile.cwd).mode & 0o777).toBe(0o700);
    expect(profile.neutralCwd).toEqual({ fresh: true, private0700: true, ownedByCurrentUser: true, outsideWorkspace: true });
    profile.cleanup();
    expect(existsSync(profile.cwd)).toBe(false);
    expect(existsSync(sb.scratch)).toBe(true);
  });

  it("refuses a scratch root inside a workspace root, a relative one, or a missing one", () => {
    const sb = makeSandbox();
    expect(codeOf(() => createLaunchProfile(profileOpts(sb, { scratchRoot: sb.cwd })))).toMatch(/inside a workspace/);
    expect(codeOf(() => createLaunchProfile(profileOpts(sb, { scratchRoot: "rel" })))).toMatch(/scratch root/);
    expect(codeOf(() => createLaunchProfile(profileOpts(sb, { scratchRoot: join(sb.scratch, "missing") })))).toMatch(/scratch root/);
    expect(codeOf(() => createLaunchProfile(profileOpts(sb, { workspaceRoots: [] })))).toMatch(/workspace roots/);
    expect(readdirSync(sb.cwd)).toEqual([]);
  });

  it("uses the configured claude path, validated as an absolute executable", () => {
    const sb = makeSandbox();
    const p = createLaunchProfile(profileOpts(sb));
    p.cleanup();
    expect(p.claudePath).toBe(sb.claudePath);
    expect(codeOf(() => createLaunchProfile(profileOpts(sb, { claudePath: "claude" })))).toMatch(/claude path/);
    expect(codeOf(() => createLaunchProfile(profileOpts(sb, { claudePath: join(sb.root, "nope") })))).toMatch(/claude path/);
    chmodSync(sb.claudePath, 0o644);
    expect(codeOf(() => createLaunchProfile(profileOpts(sb)))).toMatch(/claude path/);
  });

  it("falls back to the parent PATH only when no claude path is configured", () => {
    const sb = makeSandbox();
    const { claudePath: _c, ...opts } = profileOpts(sb);
    const p = createLaunchProfile(opts);
    p.cleanup();
    expect(p.claudePath).toBe(sb.claudePath);
    expect(codeOf(() => createLaunchProfile({ ...opts, parentEnv: gatewayParentEnv(sb, { PATH: sb.root }) }))).toMatch(/not found on PATH/);
  });

  it("passes --model only when a plain model name is set", () => {
    const sb = makeSandbox();
    const withModel = createLaunchProfile(profileOpts(sb, { model: "opus" }));
    withModel.cleanup();
    expect(withModel.modelArgs).toEqual(["--model", "opus"]);
    const none = createLaunchProfile(profileOpts(sb));
    none.cleanup();
    expect(none.modelArgs).toEqual([]);
    expect(codeOf(() => createLaunchProfile(profileOpts(sb, { model: "--dangerously-skip-permissions" })))).toMatch(/model/);
  });

  it("turns a neutral-cwd creation failure into a fixed code with no path", () => {
    const sb = makeSandbox();
    chmodSync(sb.scratch, 0o500);
    try {
      let err: unknown;
      try {
        createLaunchProfile(profileOpts(sb));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(LaunchProfileError);
      expect((err as LaunchProfileError).code).toMatch(/could not be created/);
      expect((err as Error).message).not.toContain(sb.scratch);
    } finally {
      chmodSync(sb.scratch, 0o700);
    }
  });
});

describe("profile preflight", () => {
  it("runs the preflight with exactly the profile's env, cwd and claude binary", () => {
    const sb = makeSandbox();
    const claude = fakeClaude();
    const profile = createLaunchProfile(profileOpts(sb));
    try {
      const report = runProfilePreflight(profile, {
        parentEnv: gatewayParentEnv(sb),
        managedPaths: sb.managedPaths,
        projectStopAt: sb.root,
        spawnSync: claude.spawnSync,
      });
      expect(report.verdict, JSON.stringify(report.reasons)).toBe("subscription");
      expect(report.childEnvStrategy).toBe(PROFILE_ID);
      expect(claude.calls).toHaveLength(4);
      for (const c of claude.calls) {
        expect(c.command).toBe(profile.claudePath);
        expect(c.cwd).toBe(profile.cwd);
        expect(c.envNames).toEqual([...profile.forwardedKeys]);
        expect(c.envNames.every((n) => FORWARD_KEYS.includes(n))).toBe(true);
      }
      // The gateway in the parent env is reported by name, never passed on.
      expect(report.env.parent.route.baseUrl).toBe("non-anthropic-loopback");
      expect(report.env.child.names).toEqual([]);
      expect(expectNoSentinels(JSON.stringify(report))).toEqual([]);
    } finally {
      profile.cleanup();
    }
  });
});

describe("runDirectPreflight", () => {
  function direct(sb: Sandbox, extra: Record<string, unknown> = {}, fake = fakeClaude()) {
    const report = runDirectPreflight({
      ...profileOpts(sb),
      managedPaths: sb.managedPaths,
      projectStopAt: sb.root,
      username: "someone",
      spawnSync: fake.spawnSync,
      ...extra,
    });
    return { report, text: JSON.stringify(report), calls: fake.calls };
  }

  it("passes a synthetic Max login through the gateway-shaped parent env and removes its cwd", () => {
    const sb = makeSandbox();
    const r = direct(sb);
    expect(r.report.verdict, r.text).toBe("subscription");
    expect(r.report.profile).toMatchObject({ id: PROFILE_ID, modelArgs: [], cleanup: "removed" });
    expect(readdirSync(sb.scratch)).toEqual([]);
    expect(r.calls).toHaveLength(4);
    expect(expectNoSentinels(r.text)).toEqual([]);
  });

  it.each([
    ["api key in settings", (sb: Sandbox) => sb.writeUserSettings({ env: { ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" } }), /ANTHROPIC_API_KEY/],
    ["apiKeyHelper", (sb: Sandbox) => sb.writeUserSettings({ apiKeyHelper: "SENTINEL-HELPER-CMD-44d0" }), /apiKeyHelper/],
    ["provider flag", (sb: Sandbox) => sb.writeUserSettings({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }, "settings.local.json"), /CLAUDE_CODE_USE_BEDROCK/],
    ["foreign base URL", (sb: Sandbox) => sb.writeUserSettings({ env: { ANTHROPIC_BASE_URL: "https://sentinel-gateway.example.invalid" } }), /non-anthropic-remote/],
    ["managed API key", (sb: Sandbox) => sb.writeFile("managed/managed-settings.json", JSON.stringify({ env: { ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" } })), /managed settings/],
  ])("%s still blocks; claude never runs; nothing leaks", (_label, setup, reason) => {
    const sb = makeSandbox();
    setup(sb);
    const r = direct(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(reason);
    expect(r.calls).toEqual([]);
    expect(expectNoSentinels(r.text)).toEqual([]);
    expect(readdirSync(sb.scratch)).toEqual([]);
  });

  it("a non-subscription login is ambiguous", () => {
    const sb = makeSandbox();
    const r = direct(sb, {}, fakeClaude({ status: { ...SUBSCRIPTION_STATUS, authMethod: "console" } }));
    expect(r.report.verdict).toBe("ambiguous");
    expect(expectNoSentinels(r.text)).toEqual([]);
  });

  it("reports a profile that cannot be created as ambiguous with its fixed code", () => {
    const sb = makeSandbox();
    const r = direct(sb, { scratchRoot: sb.cwd });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.profile).toEqual({ status: "not-created" });
    expect(r.report.reasons.join("\n")).toMatch(/inside a workspace/);
    expect(r.calls).toEqual([]);
  });

  it("never throws, and hides unexpected errors behind a fixed reason", () => {
    const sb = makeSandbox();
    const r = direct(sb, {
      preflight: () => {
        throw new Error("SENTINEL-FILE-CONTENT-8b8b");
      },
    });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/^internal:/m);
    expect(r.report.profile).toMatchObject({ cleanup: "removed" });
    expect(expectNoSentinels(r.text)).toEqual([]);
  });

  it("project settings above the scratch root still apply to the child", () => {
    const sb = makeSandbox();
    // The scratch root sits under the system temp dir, not under sb.root, so write a
    // project settings file in the scratch root itself and stop the walk there.
    mkdirSync(join(sb.scratch, ".claude"));
    writeFileSync(join(sb.scratch, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "SENTINEL-AUTH-TOKEN-91c2" } }));
    const r = direct(sb, { projectStopAt: sb.scratch });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/project settings .*ANTHROPIC_AUTH_TOKEN/);
    expect(expectNoSentinels(r.text)).toEqual([]);
  });
});
