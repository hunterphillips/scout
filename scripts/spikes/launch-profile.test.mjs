import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLaunchProfile, LaunchProfileError } from "./launch-profile.mjs";
import { makeSandbox, cleanupSandboxes, expectNoSentinels } from "./test-helpers.mjs";

const scratchDirs = [];
function makeScratch() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "scout-profile-scratch-")));
  scratchDirs.push(d);
  return d;
}
afterEach(() => {
  cleanupSandboxes();
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A parent env shaped like this workspace's: gateway, API, provider, model and
// nested-session variables plus the ordinary variables a child needs.
function gatewayParentEnv(sb, extra = {}) {
  return {
    ...sb.baseEnv(),
    USER: "someone",
    LOGNAME: "someone",
    LANG: "en_US.UTF-8",
    TMPDIR: "/tmp/",
    SHELL: "/bin/zsh",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:4000/sentinel-gateway.example.invalid",
    ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a",
    ANTHROPIC_AUTH_TOKEN: "SENTINEL-AUTH-TOKEN-91c2",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "SENTINEL-FILE-CONTENT-8b8b",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    CLAUDE_CODE_MESSAGING_TOKEN: "SENTINEL-AUTH-TOKEN-91c2",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    SCOUT_TEST_MARKER: "1",
    ...extra,
  };
}

describe("launch profile: child environment", () => {
  it("forwards only allowlisted non-routing keys and drops routing and nested-session keys", () => {
    const sb = makeSandbox();
    const parentEnv = gatewayParentEnv(sb);
    const profile = createLaunchProfile({ parentEnv, scratchRoot: makeScratch(), workspaceRoots: [sb.root] });
    try {
      expect(Object.keys(profile.env).sort()).toEqual(["HOME", "LANG", "LOGNAME", "PATH", "SHELL", "TMPDIR", "USER"]);
      expect(profile.forwardedKeys).toEqual(["HOME", "LANG", "LOGNAME", "PATH", "SHELL", "TMPDIR", "USER"]);
      for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "SCOUT_TEST_MARKER"]) {
        expect(profile.droppedKeys).toContain(k);
        expect(profile.env).not.toHaveProperty(k);
      }
      expect(profile.env.HOME).toBe(sb.home);
    } finally {
      profile.cleanup();
    }
  });

  it("never mutates the parent env object or process.env", () => {
    const sb = makeSandbox();
    const parentEnv = gatewayParentEnv(sb);
    const before = JSON.stringify(parentEnv);
    const procBefore = JSON.stringify(process.env);
    const profile = createLaunchProfile({ parentEnv, scratchRoot: makeScratch(), workspaceRoots: [sb.root] });
    profile.cleanup();
    expect(JSON.stringify(parentEnv)).toBe(before);
    expect(JSON.stringify(process.env)).toBe(procBefore);
  });

  it("preserves an absolute CLAUDE_CONFIG_DIR (the login lives there) but not a relative one", () => {
    const sb = makeSandbox();
    const abs = createLaunchProfile({ parentEnv: gatewayParentEnv(sb, { CLAUDE_CONFIG_DIR: join(sb.root, "cfg") }), scratchRoot: makeScratch(), workspaceRoots: [sb.root] });
    abs.cleanup();
    expect(abs.env.CLAUDE_CONFIG_DIR).toBe(join(sb.root, "cfg"));
    expect(() => createLaunchProfile({ parentEnv: gatewayParentEnv(sb, { CLAUDE_CONFIG_DIR: "rel/cfg" }), scratchRoot: makeScratch(), workspaceRoots: [sb.root] })).toThrow(/CLAUDE_CONFIG_DIR/);
  });

  it("serializes no env values, paths or secrets", () => {
    const sb = makeSandbox();
    const profile = createLaunchProfile({ parentEnv: gatewayParentEnv(sb), scratchRoot: makeScratch(), workspaceRoots: [sb.root], model: "opus" });
    profile.cleanup();
    const text = JSON.stringify(profile);
    expectNoSentinels(expect, text);
    expect(text).not.toContain(sb.home);
    expect(text).not.toContain(profile.cwd);
    expect(text).not.toContain("someone");
  });
});

describe("launch profile: neutral cwd, CLI path, model", () => {
  it("creates a fresh private 0700 cwd under the scratch root and removes it on cleanup", () => {
    const sb = makeSandbox();
    const scratch = makeScratch();
    const profile = createLaunchProfile({ parentEnv: gatewayParentEnv(sb), scratchRoot: scratch, workspaceRoots: [sb.root] });
    expect(profile.cwd.startsWith(scratch + "/")).toBe(true);
    const st = statSync(profile.cwd);
    expect(st.mode & 0o777).toBe(0o700);
    expect(st.uid).toBe(process.getuid());
    expect(profile.neutralCwd).toEqual({ fresh: true, private0700: true, ownedByCurrentUser: true, outsideWorkspace: true });
    profile.cleanup();
    expect(existsSync(profile.cwd)).toBe(false);
    expect(existsSync(scratch)).toBe(true);
  });

  it("refuses a scratch root inside a workspace root, creating nothing", () => {
    const sb = makeSandbox();
    expect(() => createLaunchProfile({ parentEnv: gatewayParentEnv(sb), scratchRoot: sb.cwd, workspaceRoots: [sb.root] })).toThrow(/inside a workspace/);
  });

  it("refuses a relative or missing scratch root", () => {
    const sb = makeSandbox();
    expect(() => createLaunchProfile({ parentEnv: gatewayParentEnv(sb), scratchRoot: "rel", workspaceRoots: [sb.root] })).toThrow(/scratch root/);
    expect(() => createLaunchProfile({ parentEnv: gatewayParentEnv(sb), scratchRoot: join(makeScratch(), "missing"), workspaceRoots: [sb.root] })).toThrow(/scratch root/);
  });

  it("resolves claude to an absolute path from the parent PATH", () => {
    const sb = makeSandbox();
    const profile = createLaunchProfile({ parentEnv: gatewayParentEnv(sb), scratchRoot: makeScratch(), workspaceRoots: [sb.root] });
    profile.cleanup();
    expect(profile.claudePath).toBe(join(sb.bin, "claude"));
  });

  it("fails when claude is not on PATH, creating nothing", () => {
    const sb = makeSandbox();
    const scratch = makeScratch();
    expect(() => createLaunchProfile({ parentEnv: gatewayParentEnv(sb, { PATH: sb.root }), scratchRoot: scratch, workspaceRoots: [sb.root] })).toThrow(/claude/);
  });

  it("carries a service-owned model choice as CLI args, validated against flag injection", () => {
    const sb = makeSandbox();
    const p = createLaunchProfile({ parentEnv: gatewayParentEnv(sb), scratchRoot: makeScratch(), workspaceRoots: [sb.root], model: "opus" });
    p.cleanup();
    expect(p.modelArgs).toEqual(["--model", "opus"]);
    const none = createLaunchProfile({ parentEnv: gatewayParentEnv(sb), scratchRoot: makeScratch(), workspaceRoots: [sb.root] });
    none.cleanup();
    expect(none.modelArgs).toEqual([]);
    expect(() => createLaunchProfile({ parentEnv: gatewayParentEnv(sb), scratchRoot: makeScratch(), workspaceRoots: [sb.root], model: "--dangerously-skip-permissions" })).toThrow(/model/);
  });
});

describe("launch profile: physical path containment", () => {
  it("refuses a scratch root that is a case-variant alias of a path inside a workspace root", () => {
    const sb = makeSandbox();
    const ws = join(sb.root, "CaseWorkspace");
    mkdirSync(join(ws, "Scratch"), { recursive: true });
    // macOS volumes are case-insensitive: the lowercase spelling names the same directory.
    const alias = join(sb.root, "caseworkspace", "scratch");
    if (!existsSync(alias)) return; // case-sensitive volume: no alias to test
    expect(() => createLaunchProfile({ parentEnv: gatewayParentEnv(sb), scratchRoot: alias, workspaceRoots: [ws] })).toThrow(/inside a workspace/);
    expect(readdirSync(join(ws, "Scratch"))).toEqual([]);
  });

  it("refuses when the workspace root itself is given as a case-variant alias", () => {
    const sb = makeSandbox();
    const ws = join(sb.root, "CaseWs");
    mkdirSync(join(ws, "Scratch"), { recursive: true });
    const wsAlias = join(sb.root, "casews");
    if (!existsSync(wsAlias)) return;
    expect(() => createLaunchProfile({ parentEnv: gatewayParentEnv(sb), scratchRoot: join(ws, "Scratch"), workspaceRoots: [wsAlias] })).toThrow(/inside a workspace/);
  });

  it("converts a neutral-cwd creation failure into a fixed error with no path or raw error", () => {
    const sb = makeSandbox();
    const scratch = makeScratch();
    chmodSync(scratch, 0o500); // not writable: mkdtemp fails
    try {
      let err;
      try {
        createLaunchProfile({ parentEnv: gatewayParentEnv(sb), scratchRoot: scratch, workspaceRoots: [sb.root] });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(LaunchProfileError);
      expect(err.code).toBe("profile: neutral cwd could not be created");
      expect(err.message).not.toContain(scratch);
      expect(String(err.stack)).not.toContain(scratch);
      expect(err.cause).toBeUndefined();
    } finally {
      chmodSync(scratch, 0o700);
    }
  });
});
