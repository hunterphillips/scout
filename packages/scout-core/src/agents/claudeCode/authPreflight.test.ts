// The billing preflight's full suite: every fail-closed path of runPreflight and of the
// direct profile around it. Ported from the removed personal-context package's
// authPreflight.test.ts and the earlier auth-preflight / direct-profile-preflight tests (git
// history has all three). Hermetic: a fake `claude` (spawnSync stand-in), temp
// homes, managed paths inside the sandbox, the project walk stopped at the sandbox root.

import { chmodSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOWED_CLAUDE_ARGS, CHILD_ENV_STRATEGY, classifyBaseUrl, managedPathsFor, parseAuthStatus, runPreflight, type PreflightDeps } from "./authPreflight.js";
import { FORWARD_KEYS, runDirectPreflight } from "./launchProfile.js";
import { cleanupSandboxes, fakeSpawnSync, type FakeClaudeOptions, gatewayParentEnv, hostileOutside, makeSandbox, type Sandbox, sentinelsIn, SUBSCRIPTION_STATUS } from "./testing/preflightSandbox.js";

afterEach(() => cleanupSandboxes());

/** Inherited-env preflight, hermetic: sandbox managed paths, walk stopped at the sandbox, fake claude. */
function run(sb: Sandbox, { env = {}, fake = {}, ...deps }: { env?: Record<string, string>; fake?: FakeClaudeOptions } & Partial<PreflightDeps> = {}) {
  const claude = fakeSpawnSync(fake);
  const report = runPreflight({ env: sb.baseEnv(env), cwd: sb.cwd, managedPaths: sb.managedPaths, projectStopAt: sb.root, username: "someone", spawnSync: claude.spawnSync, ...deps });
  return { report, text: JSON.stringify(report), calls: claude.calls };
}

describe("runPreflight: clean subscription", () => {
  it("reports subscription for a clean env and a claude.ai Max login", () => {
    const r = run(makeSandbox());
    expect(r.report.verdict, r.text).toBe("subscription");
    expect(r.report.inference).toBe("none");
    expect(r.report.cli.status).toMatchObject({ authMethod: "claude.ai", subscriptionType: "max" });
    expect(sentinelsIn(r.text)).toEqual([]);
  });

  it("makes only the four allowlisted, non-inference claude invocations, on the claude found on PATH", () => {
    const sb = makeSandbox();
    const r = run(sb);
    expect(r.calls.map((c) => c.args)).toEqual(ALLOWED_CLAUDE_ARGS.map((a) => [...a]));
    expect(r.calls.every((c) => c.command === sb.claudePath)).toBe(true);
  });

  it("runs auth status in the same (inherited) environment as the proposed child", () => {
    const r = run(makeSandbox(), { env: { SCOUT_TEST_MARKER: "1" } });
    expect(r.report.childEnvStrategy).toBe(CHILD_ENV_STRATEGY);
    expect(r.calls.find((c) => c.args.join(" ") === "auth status --json")!.envNames).toContain("SCOUT_TEST_MARKER");
  });

  it("reports nested-session markers by presence only", () => {
    const r = run(makeSandbox(), { env: { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "SENTINEL-FILE-CONTENT-8b8b" } });
    expect(r.report.nestedSessionMarkers).toEqual({ CLAUDECODE: true, CLAUDE_CODE_ENTRYPOINT: true });
    expect(sentinelsIn(r.text)).toEqual([]);
  });

  it("treats model-selection names as informational and reports them by name only", () => {
    const r = run(makeSandbox(), { env: { ANTHROPIC_MODEL: "SENTINEL-FILE-CONTENT-8b8b", ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-y", ANTHROPIC_BASE_URL: "https://api.anthropic.com" } });
    expect(r.report.verdict).toBe("subscription");
    expect(r.report.env.child.route.modelNames).toEqual(["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_MODEL"]);
    expect(r.text).not.toContain("claude-y");
    expect(sentinelsIn(r.text)).toEqual([]);
  });
});

describe("runPreflight: routes that block a subscription verdict", () => {
  it.each([
    ["api key", { ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" }, /ANTHROPIC_API_KEY/],
    ["auth token", { ANTHROPIC_AUTH_TOKEN: "SENTINEL-AUTH-TOKEN-91c2" }, /ANTHROPIC_AUTH_TOKEN/],
    ["provider flag", { CLAUDE_CODE_USE_BEDROCK: "1" }, /CLAUDE_CODE_USE_BEDROCK/],
    ["unknown provider flag", { CLAUDE_CODE_USE_SOMETHING_NEW: "1" }, /CLAUDE_CODE_USE_SOMETHING_NEW/],
    ["remote base url", { ANTHROPIC_BASE_URL: "https://sentinel-gateway.example.invalid/v1" }, /non-anthropic-remote/],
    ["loopback gateway", { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000/sentinel-gateway.example.invalid" }, /non-anthropic-loopback/],
    ["unparseable base url", { ANTHROPIC_BASE_URL: "SENTINEL-FILE-CONTENT-8b8b" }, /unparseable/],
    ["unrecognized ANTHROPIC_* name", { ANTHROPIC_SOMETHING_NEW: "SENTINEL-FILE-CONTENT-8b8b" }, /unrecognized ANTHROPIC_SOMETHING_NEW/],
  ])("child env with %s is ambiguous, claude never runs, no value leaks", (_label, env, reason) => {
    const r = run(makeSandbox(), { env });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(reason);
    expect(r.calls).toEqual([]);
    expect(sentinelsIn(r.text)).toEqual([]);
  });

  it.each([
    ["apiKeyHelper", { apiKeyHelper: "/bin/echo SENTINEL-HELPER-CMD-44d0" }, /apiKeyHelper present/],
    ["api key in settings env", { env: { ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" } }, /user settings .*ANTHROPIC_API_KEY present/],
    ["provider flag in settings env", { env: { CLAUDE_CODE_USE_VERTEX: "1" } }, /provider flag CLAUDE_CODE_USE_VERTEX/],
    ["foreign base URL in settings env", { env: { ANTHROPIC_BASE_URL: "http://localhost:9/sentinel-gateway.example.invalid" } }, /non-anthropic-loopback/],
  ])("user settings with %s are ambiguous, claude never runs (no apiKeyHelper execution), no value leaks", (_label, settings, reason) => {
    const sb = makeSandbox();
    sb.writeUserSettings(settings);
    const r = run(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(reason);
    expect(r.report.cli.status).toBe("skipped");
    expect(r.calls).toEqual([]);
    expect(sentinelsIn(r.text)).toEqual([]);
  });

  it("reports settings.local.json by key names only", () => {
    const sb = makeSandbox();
    sb.writeUserSettings({ env: { ANTHROPIC_BASE_URL: "http://localhost:9/sentinel-gateway.example.invalid", OTHER_THING: "SENTINEL-FILE-CONTENT-8b8b" } }, "settings.local.json");
    const r = run(sb);
    expect(r.report.reasons.join("\n")).toMatch(/settings\.local\.json.*ANTHROPIC_BASE_URL is non-anthropic-loopback/);
    expect(r.report.settings.find((s) => s.path.endsWith("settings.local.json"))).toMatchObject({ status: "ok", apiKeyHelper: false, envKeys: ["ANTHROPIC_BASE_URL", "OTHER_THING"] });
    expect(sentinelsIn(r.text)).toEqual([]);
  });

  it.each([
    ["the child cwd", ".claude/settings.local.json"],
    ["an ancestor of the child cwd", "../.claude/settings.json"],
  ])("blocks on project settings in %s", (_label, rel) => {
    const sb = makeSandbox();
    sb.writeFile(join("work", rel), JSON.stringify({ env: { ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" } }));
    const r = run(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/project settings .*ANTHROPIC_API_KEY present/);
    expect(r.calls).toEqual([]);
    expect(sentinelsIn(r.text)).toEqual([]);
  });

  it("blocks on managed settings, drop-ins and unparsed MDM plists", () => {
    const sb = makeSandbox();
    sb.writeFile("managed/managed-settings.json", JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: "1" } }));
    sb.writeFile("managed/managed-settings.d/10-x.json", JSON.stringify({ apiKeyHelper: "SENTINEL-HELPER-CMD-44d0" }));
    sb.writeFile("managed/com.anthropic.claudecode.plist", "SENTINEL-FILE-CONTENT-8b8b");
    const r = run(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.text).toMatch(/CLAUDE_CODE_USE_VERTEX/);
    expect(r.text).toMatch(/10-x\.json: apiKeyHelper present/);
    expect(r.text).toMatch(/not inspected/);
    expect(sentinelsIn(r.text)).toEqual([]);
  });

  it.each([
    ["malformed JSON", '{ "apiKeyHelper": SENTINEL-FILE-CONTENT-8b8b'],
    ["non-object JSON", '["SENTINEL-FILE-CONTENT-8b8b"]'],
    ["env not an object", JSON.stringify({ env: "SENTINEL-FILE-CONTENT-8b8b" })],
  ])("fails closed on %s without echoing content", (_label, text) => {
    const sb = makeSandbox();
    sb.writeUserSettings(text);
    const r = run(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/settings\.json: malformed/);
    expect(sentinelsIn(r.text)).toEqual([]);
  });

  it("fails closed on an unreadable settings file", () => {
    const sb = makeSandbox();
    sb.writeUserSettings("{}");
    chmodSync(join(sb.home, ".claude", "settings.json"), 0o000);
    const r = run(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/settings\.json: unreadable/);
    expect(r.calls).toEqual([]);
  });

  it("uses CLAUDE_CONFIG_DIR for user settings instead of ~/.claude", () => {
    const sb = makeSandbox();
    const dir = join(sb.root, "altconfig");
    sb.writeFile("altconfig/settings.json", JSON.stringify({ apiKeyHelper: "SENTINEL-HELPER-CMD-44d0" }));
    const r = run(sb, { env: { CLAUDE_CONFIG_DIR: dir } });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.settings.some((s) => s.path === join(dir, "settings.json") && s.apiKeyHelper)).toBe(true);
  });

  it("fails closed on a relative CLAUDE_CONFIG_DIR", () => {
    const r = run(makeSandbox(), { env: { CLAUDE_CONFIG_DIR: "relative/dir" } });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/CLAUDE_CONFIG_DIR/);
  });
});

describe("runPreflight: auth status fails closed", () => {
  it.each([
    ["non-JSON output", { status: "Logged in as SENTINEL-FILE-CONTENT-8b8b" }, /not a JSON object/],
    ["nonzero exit", { statusExit: 3 }, /exited unsuccessfully/],
    ["console (API) login", { status: { loggedIn: true, authMethod: "console", apiProvider: "firstParty", subscriptionType: "max" } }, /login method is console/],
    ["unknown login method", { status: { ...SUBSCRIPTION_STATUS, authMethod: "SENTINEL-AUTH-TOKEN-91c2" } }, /login method is other/],
    ["third-party provider", { status: { ...SUBSCRIPTION_STATUS, apiProvider: "bedrock" } }, /api provider is bedrock/],
    ["logged out", { status: { loggedIn: false, authMethod: "none" } }, /not logged in/],
    ["no subscription type", { status: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" } }, /subscription type is absent/],
    ["status missing from help", { helpAuth: "Commands:\n  login  Sign in\n" }, /not confirmed by --help/],
    ["hung auth status", { statusTimeout: true }, /exited unsuccessfully/],
  ] as [string, FakeClaudeOptions, RegExp][])("%s is ambiguous with no identity in the report", (_label, fake, reason) => {
    const r = run(makeSandbox(), { fake });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(reason);
    expect(sentinelsIn(r.text)).toEqual([]);
  });

  it("reports a timed-out auth status as a timeout", () => {
    const r = run(makeSandbox(), { fake: { statusTimeout: true } });
    expect(r.report.cli.statusExit).toBe("timeout");
  });

  it("does not run auth status --json when help does not confirm it", () => {
    const r = run(makeSandbox(), { fake: { helpStatus: "Options:\n  --text\n" } });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.calls.map((c) => c.args.join(" "))).not.toContain("auth status --json");
  });

  it("fails closed when auth status reports a different config directory, without printing it", () => {
    const r = run(makeSandbox(), { fake: { status: { ...SUBSCRIPTION_STATUS, configDirectory: "/somewhere/else-SENTINEL-FILE-CONTENT-8b8b" } } });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/config directory/);
    expect(r.text).not.toContain("/somewhere/else");
    expect(sentinelsIn(r.text)).toEqual([]);
  });

  it("is ambiguous when claude is not on PATH", () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { PATH: sb.cwd } });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/not found on PATH/);
    expect(r.calls).toEqual([]);
  });
});

describe("runPreflight: explicit child", () => {
  it("audits the child env and the pinned claude path, not the parent's", () => {
    const sb = makeSandbox();
    const claude = fakeSpawnSync();
    const report = runPreflight({
      env: sb.baseEnv({ ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" }),
      cwd: sb.cwd,
      managedPaths: sb.managedPaths,
      projectStopAt: sb.root,
      username: "someone",
      spawnSync: claude.spawnSync,
      child: { env: { HOME: sb.home, PATH: "/usr/bin" }, claudePath: sb.claudePath, strategy: "test-profile" },
    });
    expect(report.verdict).toBe("subscription");
    expect(report.childEnvStrategy).toBe("test-profile");
    expect(report.env.parent.route.apiKey).toBe(true);
    expect(claude.calls.every((c) => c.command === sb.claudePath)).toBe(true);
    expect(claude.calls.every((c) => c.envNames.join() === "HOME,PATH")).toBe(true);
    expect(sentinelsIn(JSON.stringify(report))).toEqual([]);
  });

  it("each claude call's PATH leads with the claude binary's directory; the inspected child env is unchanged", () => {
    const sb = makeSandbox();
    const claude = fakeSpawnSync();
    const paths: (string | undefined)[] = [];
    const childEnv = { HOME: sb.home, PATH: "/usr/bin:/bin" };
    const report = runPreflight({
      env: sb.baseEnv(),
      cwd: sb.cwd,
      managedPaths: sb.managedPaths,
      projectStopAt: sb.root,
      username: "someone",
      spawnSync: (c, a, o) => {
        paths.push(o.env.PATH);
        return claude.spawnSync(c, a, o);
      },
      child: { env: childEnv, claudePath: sb.claudePath, strategy: "test-profile" },
    });
    expect(report.verdict).toBe("subscription");
    expect(paths).toHaveLength(ALLOWED_CLAUDE_ARGS.length);
    expect(paths.every((p) => p === `${dirname(sb.claudePath)}:/usr/bin:/bin`)).toBe(true);
    expect(childEnv.PATH).toBe("/usr/bin:/bin");
  });

  it("refuses a pinned claude path that is relative or not executable", () => {
    const sb = makeSandbox();
    const notExecutable = sb.writeFile("bin/not-exec", "#!/bin/sh\n");
    for (const claudePath of ["claude", join(sb.root, "missing"), notExecutable]) {
      const claude = fakeSpawnSync();
      const report = runPreflight({
        env: sb.baseEnv(),
        cwd: sb.cwd,
        managedPaths: sb.managedPaths,
        projectStopAt: sb.root,
        username: "someone",
        spawnSync: claude.spawnSync,
        child: { env: { HOME: sb.home }, claudePath, strategy: "x" },
      });
      expect(report.verdict, claudePath).toBe("ambiguous");
      expect(claude.calls).toEqual([]);
    }
  });
});

describe("runPreflight: managed state", () => {
  it("host managed state cannot affect a synthetic pass", () => {
    const sb = makeSandbox();
    const hostile = hostileOutside(sb.root);
    const r = run(sb, { fs: hostile.fs });
    expect(r.report.verdict).toBe("subscription");
    expect(hostile.probedOutside).toEqual([]);
  });

  it("finds the per-user MDM plist by OS username, not by HOME", () => {
    const sb = makeSandbox(); // HOME's basename is "home"
    const hostile = hostileOutside(sb.root);
    const claude = fakeSpawnSync();
    const report = runPreflight({ env: sb.baseEnv(), cwd: sb.cwd, projectStopAt: sb.root, platform: "darwin", username: "osuser", fs: hostile.fs, spawnSync: claude.spawnSync });
    expect(report.verdict).toBe("ambiguous");
    expect(hostile.probedOutside).toContain("/Library/Managed Preferences/osuser/com.anthropic.claudecode.plist");
    expect(hostile.probedOutside.join("\n")).not.toContain("/Library/Managed Preferences/home/");
    expect(claude.calls).toEqual([]);
    expect(sentinelsIn(JSON.stringify(report))).toEqual([]);
  });
});

describe("helpers", () => {
  it.each([
    ["https://api.anthropic.com", "anthropic"],
    ["https://api.anthropic.com:443/", "anthropic"],
    ["http://api.anthropic.com", "non-anthropic-remote"],
    ["https://api.anthropic.com.evil.example", "non-anthropic-remote"],
    ["https://sentinel-gateway.example.invalid/v1", "non-anthropic-remote"],
    ["http://127.0.0.1:4000", "non-anthropic-loopback"],
    ["http://localhost:9", "non-anthropic-loopback"],
    ["http://[::1]:4000", "non-anthropic-loopback"],
    ["not a url", "unparseable"],
    ["", "unparseable"],
  ])("classifyBaseUrl(%j) is %s, never the URL", (url, cls) => {
    expect(classifyBaseUrl(url)).toBe(cls);
  });

  it("parseAuthStatus keeps non-identity fields only", () => {
    const p = parseAuthStatus(JSON.stringify(SUBSCRIPTION_STATUS));
    expect(sentinelsIn(JSON.stringify(p))).toEqual([]);
    expect(p).toMatchObject({ parsed: true, loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" });
    for (const bad of ["[]", "null", "42", "not json", '"string"']) expect(parseAuthStatus(bad), bad).toEqual({ parsed: false });
  });

  it("managedPathsFor derives the documented locations per platform", () => {
    const mac = managedPathsFor("darwin", "/Users/u/.claude", "u");
    expect(mac.files).toContain("/Library/Application Support/ClaudeCode/managed-settings.json");
    expect(mac.opaque).toContain("/Library/Managed Preferences/u/com.anthropic.claudecode.plist");
    expect(managedPathsFor("linux", "/home/u/.claude", "u").files).toContain("/etc/claude-code/managed-settings.json");
    expect(managedPathsFor("win32", "C:/x", "u").unsupported).toBe(true);
  });
});

// The direct profile (launchProfile.ts runDirectPreflight): a fresh job dir and an allowlisted
// env around runPreflight. Overrides in settings, managed state or the CLI's answer must still
// block, whatever the profile drops from the parent env.
describe("runDirectPreflight: overrides cannot be laundered into a pass", () => {
  const GATEWAY = { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000/sentinel-gateway.example.invalid" } };
  function direct(sb: Sandbox, { fake = {}, parentEnv = gatewayParentEnv(sb.home), ...extra }: { fake?: FakeClaudeOptions; parentEnv?: Record<string, string> } & Record<string, unknown> = {}) {
    const claude = fakeSpawnSync(fake);
    const report = runDirectPreflight({
      parentEnv,
      claudePath: sb.claudePath,
      model: "claude-sonnet-5-5",
      jobsRoot: sb.jobsRoot,
      managedPaths: sb.managedPaths,
      projectStopAt: sb.root,
      username: "someone",
      spawnSync: claude.spawnSync,
      ...extra,
    });
    return { report, calls: claude.calls };
  }

  it("a synthetic Max login passes through the gateway-shaped parent env with only allowlisted names", () => {
    const sb = makeSandbox();
    const r = direct(sb);
    expect(r.report.verdict, JSON.stringify(r.report.reasons)).toBe("subscription");
    expect(r.calls.every((c) => c.envNames.every((n) => FORWARD_KEYS.includes(n)))).toBe(true);
  });

  it.each([
    ["user settings gateway", (sb: Sandbox) => sb.writeUserSettings(GATEWAY), /user settings .*ANTHROPIC_BASE_URL is non-anthropic-loopback/],
    ["user settings provider flag", (sb: Sandbox) => sb.writeUserSettings({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }, "settings.local.json"), /CLAUDE_CODE_USE_BEDROCK/],
    ["user settings apiKeyHelper", (sb: Sandbox) => sb.writeUserSettings({ apiKeyHelper: "SENTINEL-HELPER-CMD-44d0" }), /apiKeyHelper/],
    ["managed settings API key", (sb: Sandbox) => sb.writeFile("managed/managed-settings.json", JSON.stringify({ env: { ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" } })), /managed settings .*ANTHROPIC_API_KEY/],
    ["managed drop-in", (sb: Sandbox) => sb.writeFile("managed/managed-settings.d/x.json", JSON.stringify(GATEWAY)), /managed settings .*x\.json/],
    ["unparsed MDM plist", (sb: Sandbox) => sb.writeFile("managed/com.anthropic.claudecode.plist", "SENTINEL-FILE-CONTENT-8b8b"), /not inspected/],
    ["project settings above the jobs root", (sb: Sandbox) => sb.writeFile(".claude/settings.json", JSON.stringify(GATEWAY)), /project settings/],
  ])("%s still blocks and claude is never run", (_label, arrange, reason) => {
    const sb = makeSandbox();
    arrange(sb);
    const r = direct(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(reason);
    expect(r.calls).toEqual([]);
    expect(sentinelsIn(JSON.stringify(r.report))).toEqual([]);
    expect(readdirSync(sb.jobsRoot)).toEqual([]);
  });

  it("a preserved CLAUDE_CONFIG_DIR is inspected, not bypassed", () => {
    const sb = makeSandbox();
    const cfg = join(sb.root, "cfg");
    sb.writeFile("cfg/settings.json", JSON.stringify({ apiKeyHelper: "SENTINEL-HELPER-CMD-44d0" }));
    const r = direct(sb, { parentEnv: gatewayParentEnv(sb.home, { CLAUDE_CONFIG_DIR: cfg }) });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/cfg\/settings\.json: apiKeyHelper present/);
  });

  it.each([
    ["bedrock provider", { ...SUBSCRIPTION_STATUS, apiProvider: "bedrock" }, /api provider is bedrock/],
    ["API key login", { ...SUBSCRIPTION_STATUS, authMethod: "api_key" }, /login method is api_key/],
    ["gateway login", { ...SUBSCRIPTION_STATUS, authMethod: "gateway" }, /login method is gateway/],
    ["no subscription", { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }, /subscription type is absent/],
    ["other config dir", { ...SUBSCRIPTION_STATUS, configDirectory: "/elsewhere" }, /different config directory/],
  ])("the CLI reporting %s is ambiguous", (_label, status, reason) => {
    const sb = makeSandbox();
    const r = direct(sb, { fake: { status } });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(reason);
    expect(sentinelsIn(JSON.stringify(r.report))).toEqual([]);
  });

  it("host managed state cannot affect the synthetic pass", () => {
    const sb = makeSandbox();
    const hostile = hostileOutside(sb.root);
    const r = direct(sb, { fs: hostile.fs });
    expect(r.report.verdict).toBe("subscription");
    expect(hostile.probedOutside).toEqual([]);
  });

  it("leaves the parent env, process.env and every settings file unchanged", () => {
    const sb = makeSandbox();
    sb.writeUserSettings({ theme: "dark" });
    const project = sb.writeFile("work/.claude/settings.local.json", JSON.stringify({ theme: "light" }));
    const files = [join(sb.home, ".claude/settings.json"), project];
    const before = files.map((f) => readFileSync(f, "utf8"));
    const parentEnv = gatewayParentEnv(sb.home);
    const envBefore = JSON.stringify(parentEnv);
    const procBefore = JSON.stringify(process.env);
    direct(sb, { parentEnv });
    expect(files.map((f) => readFileSync(f, "utf8"))).toEqual(before);
    expect(JSON.stringify(parentEnv)).toBe(envBefore);
    expect(JSON.stringify(process.env)).toBe(procBefore);
  });

  it("removes the job dir even when the preflight throws, and fails closed without echoing the error", () => {
    const sb = makeSandbox();
    let seenCwd = "";
    const r = direct(sb, {
      preflight: (deps: PreflightDeps) => {
        seenCwd = deps.cwd;
        throw new Error("SENTINEL-FILE-CONTENT-8b8b");
      },
    });
    expect(r.report).toMatchObject({ verdict: "ambiguous", reasons: ["internal: preflight failed unexpectedly"] });
    expect(seenCwd.startsWith(sb.jobsRoot)).toBe(true);
    expect(readdirSync(sb.jobsRoot)).toEqual([]);
    expect(sentinelsIn(JSON.stringify(r.report))).toEqual([]);
  });
});
