import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLaunchProfile, filterChildEnv, FORWARD_KEYS, LaunchProfileError, PROFILE_ID, runDirectPreflight } from "./launchProfile.js";
import { cleanupSandboxes, fakeSpawnSync, gatewayParentEnv, makeSandbox, sentinelsIn, LOGGED_IN_STATUS, type Sandbox } from "./testing/preflightSandbox.js";

afterEach(() => cleanupSandboxes());

const opts = (sb: Sandbox, extra: Record<string, unknown> = {}) => ({
  parentEnv: gatewayParentEnv(sb.home),
  claudePath: sb.claudePath,
  model: "claude-sonnet-5-5",
  jobsRoot: sb.jobsRoot,
  jobId: "job-1",
  ...extra,
});

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof LaunchProfileError ? e.code : "not-a-LaunchProfileError";
  }
  return undefined;
}

// Pinned from the removed personal-context package's launch profile (git history has the
// package): the same parent env must yield the same child env.
describe("launch profile: parity with the removed package (pinned)", () => {
  it("forwards exactly the env the removed package's profile forwarded for the same parent env", () => {
    const sb = makeSandbox();
    const parentEnv = gatewayParentEnv(sb.home);
    const legacy = { HOME: sb.home, USER: "someone", LOGNAME: "someone", PATH: parentEnv.PATH, SHELL: "/bin/zsh", LANG: "en_US.UTF-8", TMPDIR: parentEnv.TMPDIR };
    expect(filterChildEnv(parentEnv)).toEqual(legacy);
    const withConfig = gatewayParentEnv(sb.home, { CLAUDE_CONFIG_DIR: join(sb.home, "cfg") });
    expect(filterChildEnv(withConfig)).toEqual({ ...legacy, CLAUDE_CONFIG_DIR: join(sb.home, "cfg") });
    expect(FORWARD_KEYS).toEqual(["HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"]);
  });
});

describe("launch profile: child environment", () => {
  it("drops routing, provider, model, nested-session and Scout variables", () => {
    const sb = makeSandbox();
    const p = createLaunchProfile(opts(sb));
    p.cleanup();
    expect(Object.keys(p.env).every((k) => FORWARD_KEYS.includes(k))).toBe(true);
    for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDECODE", "NODE_OPTIONS", "SCOUT_HOME"]) {
      expect(p.droppedKeys).toContain(k);
    }
    expect(p.modelArgs).toEqual(["--model", "claude-sonnet-5-5"]);
    const text = JSON.stringify(p);
    expect(sentinelsIn(text)).toEqual([]);
    expect(text).not.toContain(sb.root);
  });

  it("refuses a relative CLAUDE_CONFIG_DIR and a missing HOME", () => {
    const sb = makeSandbox();
    expect(codeOf(() => createLaunchProfile(opts(sb, { parentEnv: gatewayParentEnv(sb.home, { CLAUDE_CONFIG_DIR: "rel" }) })))).toMatch(/CLAUDE_CONFIG_DIR/);
    const { HOME: _h, ...noHome } = gatewayParentEnv(sb.home);
    expect(codeOf(() => createLaunchProfile(opts(sb, { parentEnv: noHome })))).toMatch(/HOME/);
  });
});

describe("launch profile: job dir, claude path, model", () => {
  it("creates SCOUT_HOME/run/jobs/<id> 0700 and removes it on cleanup", () => {
    const sb = makeSandbox();
    const p = createLaunchProfile(opts(sb));
    expect(p.cwd).toBe(join(sb.jobsRoot, "job-1"));
    expect(statSync(p.cwd).mode & 0o777).toBe(0o700);
    expect(statSync(sb.jobsRoot).mode & 0o777).toBe(0o700);
    expect(p.jobDir).toEqual({ fresh: true, private0700: true, ownedByCurrentUser: true });
    p.cleanup();
    expect(existsSync(p.cwd)).toBe(false);
  });

  it("refuses an existing job dir rather than reusing it", () => {
    const sb = makeSandbox();
    const p = createLaunchProfile(opts(sb));
    try {
      expect(codeOf(() => createLaunchProfile(opts(sb)))).toMatch(/could not be created/);
    } finally {
      p.cleanup();
    }
  });

  it.each(["../escape", "a/b", "", ".", "x".repeat(65), "job\0x"])("refuses job id %j before touching a path", (jobId) => {
    const sb = makeSandbox();
    expect(codeOf(() => createLaunchProfile(opts(sb, { jobId })))).toMatch(/job id/);
    expect(existsSync(sb.jobsRoot)).toBe(false);
  });

  it("refuses a jobs root that is not private, is a symlink, or sits in a workspace", () => {
    const sb = makeSandbox();
    mkdirSync(sb.jobsRoot, { recursive: true });
    chmodSync(sb.jobsRoot, 0o755);
    expect(codeOf(() => createLaunchProfile(opts(sb)))).toMatch(/jobs root is not a private/);
    const real = join(sb.root, "elsewhere");
    mkdirSync(real, { mode: 0o700 });
    const link = join(sb.root, "link-jobs");
    symlinkSync(real, link);
    expect(codeOf(() => createLaunchProfile(opts(sb, { jobsRoot: link })))).toMatch(/jobs root is not a private/);
    expect(codeOf(() => createLaunchProfile(opts(sb, { jobsRoot: real, workspaceRoots: [sb.root] })))).toMatch(/inside a workspace/);
    expect(codeOf(() => createLaunchProfile(opts(sb, { jobsRoot: "rel/jobs" })))).toMatch(/absolute/);
  });

  it("requires an absolute executable claude and a plain model name", () => {
    const sb = makeSandbox();
    expect(codeOf(() => createLaunchProfile(opts(sb, { claudePath: "claude" })))).toMatch(/claude path/);
    expect(codeOf(() => createLaunchProfile(opts(sb, { model: "--dangerously-skip-permissions" })))).toMatch(/model/);
    chmodSync(sb.claudePath, 0o644);
    expect(codeOf(() => createLaunchProfile(opts(sb)))).toMatch(/claude path/);
  });
});

describe("runDirectPreflight", () => {
  function direct(sb: Sandbox, fake = fakeSpawnSync()) {
    const { jobId: _j, ...o } = opts(sb);
    const report = runDirectPreflight({ ...o, spawnSync: fake.spawnSync });
    return { report, calls: fake.calls };
  }

  it("passes a synthetic Max login through the gateway-shaped parent env, reports the CLI version, removes its dir", () => {
    const sb = makeSandbox();
    const r = direct(sb);
    expect(r.report).toEqual({ verdict: "ready", reasons: [], inference: "none", cliVersion: "2.1.286" });
    expect(r.calls).toHaveLength(4);
    for (const c of r.calls) {
      expect(c.command).toBe(sb.claudePath);
      expect(c.cwd.startsWith(sb.jobsRoot + "/preflight-")).toBe(true);
      expect(c.envNames.every((n) => FORWARD_KEYS.includes(n))).toBe(true);
    }
    expect(readdirSync(sb.jobsRoot)).toEqual([]);
  });

  it("accepts an API key login through the pinned CLI", () => {
    const sb = makeSandbox();
    const r = direct(sb, fakeSpawnSync({ status: { ...LOGGED_IN_STATUS, authMethod: "api_key" } }));
    expect(r.report.verdict).toBe("ready");
  });

  it("never throws; a profile that cannot be created is ambiguous with its fixed code", () => {
    const sb = makeSandbox();
    const { jobId: _j, ...o } = opts(sb, { claudePath: "relative" });
    const r = runDirectPreflight(o);
    expect(r.verdict).toBe("unavailable");
    expect(r.reasons).toEqual(["profile: claude path is not an absolute executable file"]);
    expect(r.cliVersion).toBeUndefined();
    expect(PROFILE_ID).toMatch(/^scout-job-/);
  });
});
