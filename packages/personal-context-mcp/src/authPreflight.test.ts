import { chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOWED_CLAUDE_ARGS, classifyBaseUrl, managedPathsFor, parseAuthStatus, runPreflight, type PreflightDeps } from "./authPreflight.js";
import { cleanupSandboxes, expectNoSentinels, fakeClaude, makeSandbox, SUBSCRIPTION_STATUS, type FakeClaudeOptions, type Sandbox } from "./test-support/preflightSandbox.js";

afterEach(() => cleanupSandboxes());

/** Inherited-env preflight, hermetic: sandbox managed paths, walk stopped at the sandbox, fake claude. */
function run(sb: Sandbox, { env = {}, fake = {}, ...deps }: { env?: Record<string, string>; fake?: FakeClaudeOptions } & Partial<PreflightDeps> = {}) {
  const claude = fakeClaude(fake);
  const report = runPreflight({
    env: sb.baseEnv(env),
    cwd: sb.cwd,
    managedPaths: sb.managedPaths,
    projectStopAt: sb.root,
    spawnSync: claude.spawnSync,
    ...deps,
  });
  return { report, text: JSON.stringify(report), calls: claude.calls };
}

describe("runPreflight: clean subscription", () => {
  it("reports subscription for a clean env and a claude.ai Max login", () => {
    const sb = makeSandbox();
    const r = run(sb);
    expect(r.report.verdict, r.text).toBe("subscription");
    expect(r.report.inference).toBe("none");
    expect(r.report.cli.status).toMatchObject({ authMethod: "claude.ai", subscriptionType: "max" });
    expect(expectNoSentinels(r.text)).toEqual([]);
  });

  it("makes only the four allowlisted, non-inference claude invocations", () => {
    const sb = makeSandbox();
    const r = run(sb);
    expect(r.calls.map((c) => c.args)).toEqual(ALLOWED_CLAUDE_ARGS.map((a) => [...a]));
    expect(r.calls.every((c) => c.command === join(sb.root, "bin", "claude"))).toBe(true);
  });
});

describe("runPreflight: routes that block a subscription verdict", () => {
  it.each([
    ["api key", { ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" }, /ANTHROPIC_API_KEY/],
    ["auth token", { ANTHROPIC_AUTH_TOKEN: "SENTINEL-AUTH-TOKEN-91c2" }, /ANTHROPIC_AUTH_TOKEN/],
    ["provider flag", { CLAUDE_CODE_USE_BEDROCK: "1" }, /CLAUDE_CODE_USE_BEDROCK/],
    ["remote base url", { ANTHROPIC_BASE_URL: "https://sentinel-gateway.example.invalid/v1" }, /non-anthropic-remote/],
    ["loopback gateway", { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000/sentinel-gateway.example.invalid" }, /non-anthropic-loopback/],
    ["unparseable base url", { ANTHROPIC_BASE_URL: "SENTINEL-FILE-CONTENT-8b8b" }, /unparseable/],
  ])("child env with %s is ambiguous, claude never runs, no value leaks", (_label, env, reason) => {
    const sb = makeSandbox();
    const r = run(sb, { env });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(reason);
    expect(r.calls).toEqual([]);
    expect(expectNoSentinels(r.text)).toEqual([]);
  });

  it.each([
    ["apiKeyHelper", { apiKeyHelper: "/bin/echo SENTINEL-HELPER-CMD-44d0" }, /apiKeyHelper present/],
    ["api key in settings env", { env: { ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" } }, /user settings .*ANTHROPIC_API_KEY present/],
    ["provider flag in settings env", { env: { CLAUDE_CODE_USE_VERTEX: "1" } }, /provider flag CLAUDE_CODE_USE_VERTEX/],
    ["foreign base URL in settings env", { env: { ANTHROPIC_BASE_URL: "http://localhost:9/sentinel-gateway.example.invalid" } }, /non-anthropic-loopback/],
  ])("user settings with %s are ambiguous, claude never runs, no value leaks", (_label, settings, reason) => {
    const sb = makeSandbox();
    sb.writeUserSettings(settings);
    const r = run(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(reason);
    expect(r.report.cli.status).toBe("skipped");
    expect(r.calls).toEqual([]);
    expect(expectNoSentinels(r.text)).toEqual([]);
  });

  it("blocks on project settings in the child cwd or an ancestor", () => {
    const sb = makeSandbox();
    sb.writeFile(".claude/settings.local.json", JSON.stringify({ env: { ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" } }));
    const r = run(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/project settings .*ANTHROPIC_API_KEY/);
    expect(expectNoSentinels(r.text)).toEqual([]);
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
    expect(expectNoSentinels(r.text)).toEqual([]);
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
    expect(r.report.reasons.join("\n")).toMatch(/malformed/);
    expect(expectNoSentinels(r.text)).toEqual([]);
  });

  it("fails closed on an unreadable settings file", () => {
    const sb = makeSandbox();
    sb.writeUserSettings("{}");
    chmodSync(join(sb.home, ".claude", "settings.json"), 0o000);
    const r = run(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/unreadable/);
  });

  it("treats model-selection names as informational and reports them by name only", () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { ANTHROPIC_MODEL: "SENTINEL-FILE-CONTENT-8b8b", ANTHROPIC_BASE_URL: "https://api.anthropic.com" } });
    expect(r.report.verdict).toBe("subscription");
    expect(r.report.env.child.route.modelNames).toEqual(["ANTHROPIC_MODEL"]);
    expect(expectNoSentinels(r.text)).toEqual([]);
  });

  it("fails closed on unrecognized ANTHROPIC_* names", () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { ANTHROPIC_SOMETHING_NEW: "SENTINEL-FILE-CONTENT-8b8b" } });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/unrecognized ANTHROPIC_SOMETHING_NEW/);
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
    const sb = makeSandbox();
    const r = run(sb, { fake });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(reason);
    expect(expectNoSentinels(r.text)).toEqual([]);
  });

  it("reports a timed-out auth status as a timeout", () => {
    const sb = makeSandbox();
    const r = run(sb, { fake: { statusTimeout: true } });
    expect(r.report.cli.statusExit).toBe("timeout");
  });

  it("does not run auth status --json when help does not confirm it", () => {
    const sb = makeSandbox();
    const r = run(sb, { fake: { helpStatus: "Options:\n  --text\n" } });
    expect(r.calls.map((c) => c.args.join(" "))).not.toContain("auth status --json");
  });

  it("fails closed when auth status reports a different config directory, without printing it", () => {
    const sb = makeSandbox();
    const r = run(sb, { fake: { status: { ...SUBSCRIPTION_STATUS, configDirectory: "/somewhere/else-SENTINEL-FILE-CONTENT-8b8b" } } });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/config directory/);
    expect(expectNoSentinels(r.text)).toEqual([]);
  });

  it("is ambiguous when claude is not on PATH", () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { PATH: sb.root } });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/not found on PATH/);
    expect(r.calls).toEqual([]);
  });
});

describe("runPreflight: explicit child", () => {
  it("audits the child env and the pinned claude path, not the parent's", () => {
    const sb = makeSandbox();
    const claude = fakeClaude();
    const report = runPreflight({
      env: sb.baseEnv({ ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" }),
      cwd: sb.cwd,
      managedPaths: sb.managedPaths,
      projectStopAt: sb.root,
      spawnSync: claude.spawnSync,
      child: { env: { HOME: sb.home, PATH: "/usr/bin" }, claudePath: sb.claudePath, strategy: "test-profile" },
    });
    expect(report.verdict).toBe("subscription");
    expect(report.childEnvStrategy).toBe("test-profile");
    expect(report.env.parent.route.apiKey).toBe(true);
    expect(claude.calls.every((c) => c.command === sb.claudePath)).toBe(true);
    expect(claude.calls.every((c) => c.envNames.join() === "HOME,PATH")).toBe(true);
    expect(expectNoSentinels(JSON.stringify(report))).toEqual([]);
  });

  it("refuses a pinned claude path that is relative or not executable", () => {
    const sb = makeSandbox();
    for (const claudePath of ["claude", join(sb.root, "missing")]) {
      const claude = fakeClaude();
      const report = runPreflight({
        env: sb.baseEnv(),
        cwd: sb.cwd,
        managedPaths: sb.managedPaths,
        projectStopAt: sb.root,
        spawnSync: claude.spawnSync,
        child: { env: { HOME: sb.home }, claudePath, strategy: "x" },
      });
      expect(report.verdict).toBe("ambiguous");
      expect(claude.calls).toEqual([]);
    }
  });
});

describe("helpers", () => {
  it("classifies base URLs without returning them", () => {
    expect(classifyBaseUrl("https://api.anthropic.com")).toBe("anthropic");
    expect(classifyBaseUrl("https://api.anthropic.com:443/")).toBe("anthropic");
    expect(classifyBaseUrl("http://api.anthropic.com")).toBe("non-anthropic-remote");
    expect(classifyBaseUrl("http://[::1]:4000")).toBe("non-anthropic-loopback");
    expect(classifyBaseUrl("not a url")).toBe("unparseable");
  });

  it("parses auth status to non-identity fields only", () => {
    const p = parseAuthStatus(JSON.stringify(SUBSCRIPTION_STATUS));
    expect(expectNoSentinels(JSON.stringify(p))).toEqual([]);
    expect(p).toMatchObject({ parsed: true, loggedIn: true, subscriptionType: "max" });
    expect(parseAuthStatus("[]")).toEqual({ parsed: false });
  });

  it("derives documented managed paths per platform", () => {
    expect(managedPathsFor("darwin", "/Users/u/.claude", "u").opaque).toContain("/Library/Managed Preferences/u/com.anthropic.claudecode.plist");
    expect(managedPathsFor("linux", "/home/u/.claude", "u").files).toContain("/etc/claude-code/managed-settings.json");
    expect(managedPathsFor("win32", "C:/x", "u").unsupported).toBe(true);
  });
});
