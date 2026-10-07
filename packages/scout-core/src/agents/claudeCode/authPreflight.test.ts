// Hermetic readiness checks with a fake Claude CLI and temporary homes.

import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOWED_CLAUDE_ARGS, CHILD_ENV_STRATEGY, parseAuthStatus, runPreflight, type PreflightDeps } from "./authPreflight.js";
import { cleanupSandboxes, fakeSpawnSync, type FakeClaudeOptions, makeSandbox, type Sandbox, sentinelsIn, LOGGED_IN_STATUS } from "./testing/preflightSandbox.js";

afterEach(() => cleanupSandboxes());

/** Inherited-env preflight with a fake Claude CLI. */
function run(sb: Sandbox, { env = {}, fake = {}, ...deps }: { env?: Record<string, string>; fake?: FakeClaudeOptions } & Partial<PreflightDeps> = {}) {
  const claude = fakeSpawnSync(fake);
  const report = runPreflight({ env: sb.baseEnv(env), cwd: sb.cwd, spawnSync: claude.spawnSync, ...deps });
  return { report, text: JSON.stringify(report), calls: claude.calls };
}

describe("runPreflight: CLI readiness", () => {
  it("reports ready for a clean env and a claude.ai Max login", () => {
    const r = run(makeSandbox());
    expect(r.report.verdict, r.text).toBe("ready");
    expect(r.report.inference).toBe("none");
    expect(r.report.cli.status).toEqual({ loggedIn: true });
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

  it("does not report parent environment values", () => {
    const r = run(makeSandbox(), { env: { ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" } });
    expect(r.report.verdict).toBe("ready");
    expect(sentinelsIn(r.text)).toEqual([]);
  });

});

describe("runPreflight: login methods", () => {
  it.each(["api_key", "console", "claude.ai"])("%s is ready when logged in", (authMethod) => {
    const r = run(makeSandbox(), { fake: { status: { ...LOGGED_IN_STATUS, authMethod } }, env: { ANTHROPIC_API_KEY: "SENTINEL-API-KEY" } });
    expect(r.report.verdict).toBe("ready");
    expect(r.calls).toHaveLength(4);
  });
});

describe("runPreflight: auth status fails closed", () => {
  it.each([
    ["non-JSON output", { status: "Logged in as SENTINEL-FILE-CONTENT-8b8b" }, /not a JSON object/],
    ["nonzero exit", { statusExit: 3 }, /exited unsuccessfully/],
    ["logged out", { status: { loggedIn: false, authMethod: "none" } }, /not logged in/],
    ["status missing from help", { helpAuth: "Commands:\n  login  Sign in\n" }, /not confirmed by --help/],
    ["hung auth status", { statusTimeout: true }, /exited unsuccessfully/],
  ] as [string, FakeClaudeOptions, RegExp][])("%s is ambiguous with no identity in the report", (_label, fake, reason) => {
    const r = run(makeSandbox(), { fake });
    expect(r.report.verdict).toBe("unavailable");
    expect(r.report.reasons.join("\n")).toMatch(reason);
    expect(sentinelsIn(r.text)).toEqual([]);
  });

  it("reports a timed-out auth status as a timeout", () => {
    const r = run(makeSandbox(), { fake: { statusTimeout: true } });
    expect(r.report.cli.statusExit).toBe("timeout");
  });

  it("does not run auth status --json when help does not confirm it", () => {
    const r = run(makeSandbox(), { fake: { helpStatus: "Options:\n  --text\n" } });
    expect(r.report.verdict).toBe("unavailable");
    expect(r.calls.map((c) => c.args.join(" "))).not.toContain("auth status --json");
  });

  it("is ambiguous when claude is not on PATH", () => {
    const sb = makeSandbox();
    const r = run(sb, { env: { PATH: sb.cwd } });
    expect(r.report.verdict).toBe("unavailable");
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
      spawnSync: claude.spawnSync,
      child: { env: { HOME: sb.home, PATH: "/usr/bin" }, claudePath: sb.claudePath, strategy: "test-profile" },
    });
    expect(report.verdict).toBe("ready");
    expect(report.childEnvStrategy).toBe("test-profile");
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
      spawnSync: (c, a, o) => {
        paths.push(o.env.PATH);
        return claude.spawnSync(c, a, o);
      },
      child: { env: childEnv, claudePath: sb.claudePath, strategy: "test-profile" },
    });
    expect(report.verdict).toBe("ready");
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
        spawnSync: claude.spawnSync,
        child: { env: { HOME: sb.home }, claudePath, strategy: "x" },
      });
      expect(report.verdict, claudePath).toBe("unavailable");
      expect(claude.calls).toEqual([]);
    }
  });
});

describe("parseAuthStatus", () => {
  it("keeps only the login state", () => {
    expect(parseAuthStatus(JSON.stringify(LOGGED_IN_STATUS))).toEqual({ parsed: true, loggedIn: true });
    for (const bad of ["[]", "null", "42", "not json", '"string"']) expect(parseAuthStatus(bad), bad).toEqual({ parsed: false });
  });
});
