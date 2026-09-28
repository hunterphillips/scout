import { chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { managedPathsFor, runPreflight } from "./auth-preflight.mjs";
import { makeSandbox, run, runEntrypoint, cleanupSandboxes, hostileOutside, expectNoSentinels, SUBSCRIPTION_STATUS } from "./test-helpers.mjs";

afterEach(() => cleanupSandboxes());

describe("auth-preflight entrypoint (real subprocess)", () => {
  it("prints a JSON report, exits nonzero when ambiguous, leaks nothing, and skips claude", () => {
    // An API key makes the verdict deterministic whatever host state exists.
    const sb = makeSandbox();
    const r = runEntrypoint(sb, { env: { ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" } });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.inference).toBe("none");
    expect(r.code).toBe(1);
    expect(sb.invocations()).toEqual([]);
    expectNoSentinels(expect, r.stdout, r.stderr);
  });
});

describe("auth-preflight (production API in-process, fake claude, temp HOME)", () => {
  it("reports subscription for a clean env and a claude.ai OAuth login", () => {
    const sb = makeSandbox();
    const r = run(sb);
    expect(r.report?.verdict, r.stdout + r.stderr).toBe("subscription");
    expect(r.code).toBe(0);
    expect(r.report.cli.status).toMatchObject({ authMethod: "claude.ai", subscriptionType: "max" });
    expectNoSentinels(expect, r.stdout, r.stderr);
  });

  it("runs only non-inference claude commands", () => {
    const sb = makeSandbox();
    run(sb);
    expect(sb.invocations()).toEqual(["--version", "auth --help", "auth status --help", "auth status --json"]);
  });

  it("runs auth status in the same (inherited) environment as the proposed child", () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { SCOUT_TEST_MARKER: "1" } });
    expect(r.report.childEnvStrategy).toBe("inherit-parent-env-unmodified");
    expect(sb.invocationsWithMarkerEnv()).toContain("auth status --json");
  });

  it.each([
    ["api key", { ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" }, /ANTHROPIC_API_KEY/],
    ["auth token", { ANTHROPIC_AUTH_TOKEN: "SENTINEL-AUTH-TOKEN-91c2" }, /ANTHROPIC_AUTH_TOKEN/],
    ["bedrock flag", { CLAUDE_CODE_USE_BEDROCK: "1" }, /CLAUDE_CODE_USE_BEDROCK/],
    ["unknown provider flag", { CLAUDE_CODE_USE_SOMETHING_NEW: "1" }, /CLAUDE_CODE_USE_SOMETHING_NEW/],
    ["remote base url", { ANTHROPIC_BASE_URL: "https://sentinel-gateway.example.invalid/v1" }, /non-anthropic-remote/],
    ["loopback gateway", { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000/sentinel-gateway.example.invalid" }, /non-anthropic-loopback/],
    ["unparseable base url", { ANTHROPIC_BASE_URL: "SENTINEL-FILE-CONTENT-8b8b" }, /unparseable/],
  ])("child env with %s is ambiguous, even with a subscription login", (_label, env, reason) => {
    const sb = makeSandbox();
    const r = run(sb, { env });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.code).not.toBe(0);
    expect(r.report.reasons.join("\n")).toMatch(reason);
    expectNoSentinels(expect, r.stdout, r.stderr);
  });

  it("treats model-selection names as informational, not as billing proof or failure", () => {
    const sb = makeSandbox();
    const r = run(sb, {
      env: { ANTHROPIC_MODEL: "claude-x", ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-y", ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
    });
    expect(r.report.verdict).toBe("subscription");
    expect(r.report.env.child.route.modelNames).toEqual(["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_MODEL"]);
    expect(r.stdout).not.toContain("claude-x");
  });

  it("reports nested-session markers by presence only", () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "SENTINEL-FILE-CONTENT-8b8b" } });
    expect(r.report.nestedSessionMarkers).toEqual({ CLAUDECODE: true, CLAUDE_CODE_ENTRYPOINT: true });
    expectNoSentinels(expect, r.stdout, r.stderr);
  });
});

describe("auth-preflight: auth status fails closed", () => {
  it("skips claude entirely when settings already block (no apiKeyHelper execution)", () => {
    const sb = makeSandbox();
    sb.writeUserSettings({ apiKeyHelper: "/bin/echo SENTINEL-HELPER-CMD-44d0" });
    const r = run(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.cli.status).toBe("skipped");
    expect(sb.invocations()).toEqual([]);
  });

  it("kills a hung auth status at the timeout and fails closed", () => {
    const sb = makeSandbox({ statusSleep: 30 });
    const t0 = Date.now();
    const r = run(sb, { timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.cli.statusExit).toBe("timeout");
  });

  it.each([
    ["non-JSON output", { status: "Logged in as SENTINEL-FILE-CONTENT-8b8b" }, /not a JSON object/],
    ["nonzero exit", { statusExit: 3 }, /exited unsuccessfully/],
    ["console (API) login", { status: { loggedIn: true, authMethod: "console", apiProvider: "firstParty" } }, /login method is console/],
    ["unknown login method", { status: { loggedIn: true, authMethod: "SENTINEL-AUTH-TOKEN-91c2", apiProvider: "firstParty", subscriptionType: "max" } }, /login method is other/],
    ["logged out", { status: { loggedIn: false, authMethod: "none" } }, /not logged in/],
    ["no subscription type", { status: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" } }, /subscription type is absent/],
    ["status subcommand missing from help", { helpAuth: "Commands:\n  login  Sign in\n" }, /not confirmed by --help/],
  ])("%s is ambiguous", (_label, opts, reason) => {
    const sb = makeSandbox(opts);
    const r = run(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.code).not.toBe(0);
    expect(r.report.reasons.join("\n")).toMatch(reason);
    expectNoSentinels(expect, r.stdout, r.stderr);
  });

  it("does not run auth status when help does not confirm it", () => {
    const sb = makeSandbox({ helpStatus: "Options:\n  --text\n" });
    run(sb);
    expect(sb.invocations()).not.toContain("auth status --json");
  });

  it("is ambiguous when claude is not on PATH", () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { PATH: sb.root } });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/not found on PATH/);
  });
});

describe("auth-preflight: settings files apply to the child", () => {
  it("blocks on an apiKeyHelper in user settings without printing the command", () => {
    const sb = makeSandbox();
    sb.writeUserSettings({ apiKeyHelper: "/bin/echo SENTINEL-HELPER-CMD-44d0" });
    const r = run(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/apiKeyHelper/);
    expectNoSentinels(expect, r.stdout, r.stderr);
  });

  it("blocks on a foreign base URL set only in settings env, reporting key names only", () => {
    const sb = makeSandbox();
    sb.writeUserSettings(
      { env: { ANTHROPIC_BASE_URL: "http://localhost:9/sentinel-gateway.example.invalid", OTHER_THING: "SENTINEL-FILE-CONTENT-8b8b" } },
      "settings.local.json",
    );
    const r = run(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/settings\.local\.json.*ANTHROPIC_BASE_URL is non-anthropic-loopback/);
    const local = r.report.settings.find((s) => s.path.endsWith("settings.local.json"));
    expect(local).toMatchObject({ status: "ok", apiKeyHelper: false, envKeys: ["ANTHROPIC_BASE_URL", "OTHER_THING"] });
    expectNoSentinels(expect, r.stdout, r.stderr);
  });

  it("blocks on project settings in the child cwd or any ancestor", () => {
    const sb = makeSandbox();
    sb.writeFile(".claude/settings.local.json", JSON.stringify({ env: { ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" } }));
    const r = run(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/project.*ANTHROPIC_API_KEY present/);
    expectNoSentinels(expect, r.stdout, r.stderr);
  });

  it.each([
    ["malformed JSON", "{ \"apiKeyHelper\": SENTINEL-FILE-CONTENT-8b8b"],
    ["non-object JSON", "[\"SENTINEL-FILE-CONTENT-8b8b\"]"],
    ["env not an object", JSON.stringify({ env: "SENTINEL-FILE-CONTENT-8b8b" })],
  ])("fails closed on %s without echoing content", (_label, text) => {
    const sb = makeSandbox();
    sb.writeUserSettings(text);
    const r = run(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/settings\.json.*(malformed|unreadable)/);
    expectNoSentinels(expect, r.stdout, r.stderr);
  });

  it("fails closed on an unreadable settings file", () => {
    const sb = makeSandbox();
    sb.writeUserSettings("{}");
    chmodSync(join(sb.home, ".claude", "settings.json"), 0o000);
    const r = run(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/settings\.json.*unreadable/);
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
    const sb = makeSandbox();
    const r = run(sb, { env: { CLAUDE_CONFIG_DIR: "relative/dir" } });
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/CLAUDE_CONFIG_DIR/);
  });

  it("fails closed when auth status reports a different config directory", () => {
    const sb = makeSandbox({ status: { ...SUBSCRIPTION_STATUS, configDirectory: "/somewhere/else" } });
    const r = run(sb);
    expect(r.report.verdict).toBe("ambiguous");
    expect(r.report.reasons.join("\n")).toMatch(/config directory/);
    expect(r.stdout).not.toContain("/somewhere/else");
  });
});

describe("auth-preflight: managed settings (in-process, injected paths)", () => {
  it("blocks on managed settings and drop-ins, and on unparsed MDM plists", () => {
    const sb = makeSandbox();
    const managed = sb.writeFile("managed/managed-settings.json", JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: "1" } }));
    sb.writeFile("managed/managed-settings.d/10-x.json", JSON.stringify({ apiKeyHelper: "SENTINEL-HELPER-CMD-44d0" }));
    const plist = sb.writeFile("managed/com.anthropic.claudecode.plist", "SENTINEL-FILE-CONTENT-8b8b");
    const report = runPreflight({
      env: sb.baseEnv(),
      cwd: sb.cwd,
      projectStopAt: sb.root,
      managedPaths: { files: [managed], dropInDirs: [join(sb.root, "managed/managed-settings.d")], opaque: [plist] },
    });
    const text = JSON.stringify(report);
    expect(report.verdict).toBe("ambiguous");
    expect(text).toMatch(/CLAUDE_CODE_USE_VERTEX/);
    expect(text).toMatch(/10-x\.json.*apiKeyHelper|apiKeyHelper.*10-x\.json/);
    expect(text).toMatch(/not inspected/);
    expectNoSentinels(expect, text);
  });

  it("host managed state cannot affect a synthetic pass", () => {
    const sb = makeSandbox();
    const hostile = hostileOutside(sb.root);
    const r = run(sb, { fs: hostile.fs });
    expect(r.report.verdict).toBe("subscription");
    expect(hostile.probedOutside).toEqual([]);
  });

  it("finds the per-user MDM plist by OS username, not by HOME", () => {
    const sb = makeSandbox(); // HOME basename is "home"
    const hostile = hostileOutside(sb.root);
    const report = runPreflight({
      env: sb.baseEnv(),
      cwd: sb.cwd,
      projectStopAt: sb.root,
      platform: "darwin",
      username: "osuser",
      fs: hostile.fs,
    });
    expect(report.verdict).toBe("ambiguous");
    expect(hostile.probedOutside).toContain("/Library/Managed Preferences/osuser/com.anthropic.claudecode.plist");
    expect(hostile.probedOutside.join("\n")).not.toContain("/Library/Managed Preferences/home/");
    expectNoSentinels(expect, JSON.stringify(report));
  });

  it("derives documented managed paths per platform", () => {
    expect(managedPathsFor("darwin", "/Users/u/.claude", "u").files).toContain(
      "/Library/Application Support/ClaudeCode/managed-settings.json",
    );
    expect(managedPathsFor("linux", "/home/u/.claude", "u").files).toContain("/etc/claude-code/managed-settings.json");
    expect(managedPathsFor("win32", "C:/x", "u").unsupported).toBe(true);
  });
});
