import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runPreflight } from "./auth-preflight.mjs";
import { createLaunchProfile, runProfilePreflight } from "./launch-profile.mjs";
import { main, runDirectPreflight } from "./direct-profile-preflight.mjs";
import { makeSandbox, cleanupSandboxes, hostileOutside, expectNoSentinels, sandboxManagedPaths, SUBSCRIPTION_STATUS } from "./test-helpers.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "direct-profile-preflight.mjs");
afterEach(() => cleanupSandboxes());

const GATEWAY = { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000/sentinel-gateway.example.invalid" } };
const SHELL_ADDED = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);

/**
 * Sandbox shaped like the real layout: a workspace dir whose project settings
 * route to a gateway, the invoking cwd inside it, and a scratch root outside it.
 * Everything (HOME, managed paths, ancestor walk) stays inside the sandbox.
 */
function world(opts) {
  const sb = makeSandbox(opts);
  const rootReal = realpathSync(sb.root);
  const workspace = join(rootReal, "workspace");
  const invokingCwd = join(workspace, "scout");
  mkdirSync(invokingCwd, { recursive: true });
  sb.writeFile("workspace/.claude/settings.local.json", JSON.stringify(GATEWAY));
  const scratch = join(rootReal, "scratch");
  mkdirSync(scratch);
  const parentEnv = {
    ...sb.baseEnv(),
    USER: "someone",
    LANG: "en_US.UTF-8",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:4000/sentinel-gateway.example.invalid",
    ANTHROPIC_AUTH_TOKEN: "SENTINEL-AUTH-TOKEN-91c2",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "SENTINEL-FILE-CONTENT-8b8b",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
  };
  const deps = (extra = {}) => ({
    parentEnv,
    scratchRoot: scratch,
    workspaceRoots: [workspace, invokingCwd],
    model: "opus",
    managedPaths: sandboxManagedPaths(sb),
    projectStopAt: rootReal,
    username: "someone",
    ...extra,
  });
  return { sb, rootReal, workspace, invokingCwd, scratch, parentEnv, deps };
}

describe("direct profile preflight: legitimate Max login", () => {
  it("passes a synthetic Max login where the inherited-env preflight is ambiguous", () => {
    const w = world();
    const inherited = runPreflight({ env: w.parentEnv, cwd: w.invokingCwd, managedPaths: sandboxManagedPaths(w.sb), projectStopAt: w.rootReal });
    expect(inherited.verdict).toBe("ambiguous");
    expect(inherited.reasons.join("\n")).toMatch(/child env: ANTHROPIC_BASE_URL is non-anthropic-loopback/);
    expect(inherited.reasons.join("\n")).toMatch(/project settings .*ANTHROPIC_BASE_URL/);

    const { report, code } = runDirectPreflight(w.deps());
    expect(report.verdict, JSON.stringify(report.reasons)).toBe("subscription");
    expect(code).toBe(0);
    expect(report.inference).toBe("none");
    expect(report.profile.id).toBe("scout-direct-claude-subscription/v1");
    expect(report.profile.modelArgs).toEqual(["--model", "opus"]);
    expect(report.profile.neutralCwd).toEqual({ fresh: true, private0700: true, ownedByCurrentUser: true, outsideWorkspace: true, projectSettingsFound: 0 });
    expect(report.profile.droppedKeys).toEqual(expect.arrayContaining(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_VERTEX", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]));
    expect(report.preflight.childEnvStrategy).toBe("scout-direct-claude-subscription/v1");
    expect(report.preflight.cli.status).toMatchObject({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" });
    expect(w.sb.invocations()).toEqual(["--version", "auth --help", "auth status --help", "auth status --json"]);
  });

  it("runs auth status with exactly the profile's env, cwd and claude binary", () => {
    const w = world();
    const d = w.deps();
    const profile = createLaunchProfile(d);
    try {
      const report = runProfilePreflight(profile, d);
      expect(report.verdict).toBe("subscription");
      const ctx = w.sb.statusRunContext();
      expect(ctx.cwd).toBe(realpathSync(profile.cwd));
      const seen = ctx.envNames.filter((n) => !SHELL_ADDED.has(n));
      expect(seen.sort()).toEqual([...profile.forwardedKeys]);
      expect(report.cli.path).toBe(profile.claudePath);
    } finally {
      profile.cleanup();
    }
  });

  it("the command's neutral cwd is a fresh dir under the scratch root, removed afterwards", () => {
    const w = world();
    runDirectPreflight(w.deps());
    const ctx = w.sb.statusRunContext();
    expect(dirname(ctx.cwd)).toBe(w.scratch);
    expect(existsSync(ctx.cwd)).toBe(false);
    expect(readdirSync(w.scratch)).toEqual([]);
  });

  it("host managed state cannot affect the synthetic pass", () => {
    const w = world();
    const hostile = hostileOutside(w.sb.root);
    const { report } = runDirectPreflight(w.deps({ fs: hostile.fs }));
    expect(report.verdict).toBe("subscription");
    expect(hostile.probedOutside).toEqual([]);
  });
});

describe("direct profile preflight: overrides cannot be laundered into a pass", () => {
  it.each([
    ["user settings gateway", (w) => w.sb.writeUserSettings(GATEWAY), /user settings .*ANTHROPIC_BASE_URL is non-anthropic-loopback/],
    ["user settings provider flag", (w) => w.sb.writeUserSettings({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }, "settings.local.json"), /CLAUDE_CODE_USE_BEDROCK/],
    ["user settings apiKeyHelper", (w) => w.sb.writeUserSettings({ apiKeyHelper: "SENTINEL-HELPER-CMD-44d0" }), /apiKeyHelper/],
    ["managed settings API key", (w) => w.sb.writeFile("managed/managed-settings.json", JSON.stringify({ env: { ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" } })), /managed settings .*ANTHROPIC_API_KEY/],
    ["managed drop-in", (w) => w.sb.writeFile("managed/managed-settings.d/x.json", JSON.stringify(GATEWAY)), /managed settings .*x\.json/],
    ["unparsed MDM plist", (w) => w.sb.writeFile("managed/com.anthropic.claudecode.plist", "SENTINEL-FILE-CONTENT-8b8b"), /not inspected/],
    ["project settings above the scratch root", (w) => w.sb.writeFile(".claude/settings.json", JSON.stringify(GATEWAY)), /project settings/],
  ])("%s still blocks and claude is never run", (_label, setup, reason) => {
    const w = world();
    setup(w);
    const { report, code } = runDirectPreflight(w.deps());
    expect(report.verdict).toBe("ambiguous");
    expect(code).toBe(1);
    expect(report.reasons.join("\n")).toMatch(reason);
    expect(w.sb.invocations()).toEqual([]);
    expectNoSentinels(expect, JSON.stringify(report));
  });

  it("a preserved CLAUDE_CONFIG_DIR is inspected, not bypassed", () => {
    const w = world();
    const cfg = join(w.rootReal, "cfg");
    w.sb.writeFile("cfg/settings.json", JSON.stringify({ apiKeyHelper: "SENTINEL-HELPER-CMD-44d0" }));
    const { report } = runDirectPreflight(w.deps({ parentEnv: { ...w.parentEnv, CLAUDE_CONFIG_DIR: cfg } }));
    expect(report.verdict).toBe("ambiguous");
    expect(report.profile.forwardedKeys).toContain("CLAUDE_CONFIG_DIR");
    expect(report.reasons.join("\n")).toMatch(/cfg\/settings\.json: apiKeyHelper present/);
  });

  it.each([
    ["bedrock provider", { ...SUBSCRIPTION_STATUS, apiProvider: "bedrock" }, /api provider is bedrock/],
    ["API key login", { ...SUBSCRIPTION_STATUS, authMethod: "api_key" }, /login method is api_key/],
    ["gateway login", { ...SUBSCRIPTION_STATUS, authMethod: "gateway" }, /login method is gateway/],
    ["no subscription", { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }, /subscription type is absent/],
    ["other config dir", { ...SUBSCRIPTION_STATUS, configDirectory: "/elsewhere" }, /different config directory/],
  ])("CLI reporting %s is ambiguous", (_label, status, reason) => {
    const w = world({ status });
    const { report } = runDirectPreflight(w.deps());
    expect(report.verdict).toBe("ambiguous");
    expect(report.reasons.join("\n")).toMatch(reason);
    expectNoSentinels(expect, JSON.stringify(report));
  });
});

describe("direct profile preflight: safety", () => {
  it("leaves the parent env, process.env and every fixture settings file unchanged", () => {
    const w = world();
    w.sb.writeUserSettings({ theme: "dark" });
    const files = [join(w.sb.home, ".claude/settings.json"), join(w.workspace, ".claude/settings.local.json")];
    const before = files.map((f) => readFileSync(f, "utf8"));
    const envBefore = JSON.stringify(w.parentEnv);
    const procBefore = JSON.stringify(process.env);
    runDirectPreflight(w.deps());
    expect(files.map((f) => readFileSync(f, "utf8"))).toEqual(before);
    expect(JSON.stringify(w.parentEnv)).toBe(envBefore);
    expect(JSON.stringify(process.env)).toBe(procBefore);
  });

  it("the report carries no env values, secrets, identity or neutral cwd path", () => {
    const w = world();
    const { stdout } = main(w.deps());
    expectNoSentinels(expect, stdout);
    expect(stdout).not.toContain("someone");
    expect(stdout).not.toContain("en_US");
    expect(stdout).not.toContain(join(w.scratch, "scout-direct-"));
    expect(stdout).not.toContain("127.0.0.1");
  });

  it("removes the neutral cwd even when the preflight throws, and fails closed", () => {
    const w = world();
    let seenCwd;
    const { report, code } = runDirectPreflight(
      w.deps({
        preflight: (args) => {
          seenCwd = args.cwd;
          throw new Error("SENTINEL-FILE-CONTENT-8b8b");
        },
      }),
    );
    expect(report.verdict).toBe("ambiguous");
    expect(code).toBe(1);
    expect(existsSync(seenCwd)).toBe(false);
    expectNoSentinels(expect, JSON.stringify(report));
  });

  it("a profile that cannot be built is ambiguous, creates nothing and runs no claude", () => {
    const w = world();
    const { report } = runDirectPreflight(w.deps({ scratchRoot: w.invokingCwd }));
    expect(report.verdict).toBe("ambiguous");
    expect(report.reasons).toEqual(["profile: scratch root is inside a workspace root"]);
    expect(readdirSync(w.invokingCwd)).toEqual([]);
    expect(w.sb.invocations()).toEqual([]);
  });
});

describe("direct profile preflight entrypoint (real subprocess)", () => {
  function runCli(w, args, env = {}) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: w.invokingCwd, env: { ...w.parentEnv, ...env }, encoding: "utf8", timeout: 30_000 });
  }

  it("requires --scratch-root and fails closed without it", () => {
    const w = world();
    const r = runCli(w, []);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).reasons.join("\n")).toMatch(/--scratch-root/);
    expect(w.sb.invocations()).toEqual([]);
  });

  it("prints a JSON report, stays ambiguous under a blocking user setting, leaks nothing", () => {
    // Deterministic whatever host managed state exists: a user apiKeyHelper blocks.
    const w = world();
    w.sb.writeUserSettings({ apiKeyHelper: "SENTINEL-HELPER-CMD-44d0" });
    const r = runCli(w, ["--scratch-root", w.scratch]);
    const report = JSON.parse(r.stdout);
    expect(r.status).toBe(1);
    expect(report.verdict).toBe("ambiguous");
    expect(report.profile.id).toBe("scout-direct-claude-subscription/v1");
    expect(w.sb.invocations()).toEqual([]);
    expect(readdirSync(w.scratch)).toEqual([]);
    expectNoSentinels(expect, r.stdout, r.stderr);
  });
});
