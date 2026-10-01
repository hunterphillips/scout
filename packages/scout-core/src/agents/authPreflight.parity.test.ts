// The copied preflight must decide exactly as the legacy one does, over the same synthetic
// settings, env and CLI answers.

import { runPreflight as legacyRunPreflight } from "personal-context-mcp";
import { afterEach, describe, expect, it } from "vitest";
import { runPreflight } from "./authPreflight.js";
import { cleanupSandboxes, fakeSpawnSync, gatewayParentEnv, makeSandbox, SUBSCRIPTION_STATUS, type Sandbox } from "./testing/preflightSandbox.js";

afterEach(() => cleanupSandboxes());

const CASES: [string, (sb: Sandbox) => void, Parameters<typeof fakeSpawnSync>[0]?][] = [
  ["clean", () => {}],
  ["api key", (sb) => sb.writeUserSettings({ env: { ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" } })],
  ["apiKeyHelper", (sb) => sb.writeUserSettings({ apiKeyHelper: "SENTINEL-HELPER-CMD-44d0" })],
  ["provider flag", (sb) => sb.writeUserSettings({ env: { CLAUDE_CODE_USE_VERTEX: "1" } }, "settings.local.json")],
  ["loopback gateway", (sb) => sb.writeUserSettings({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" } })],
  ["malformed settings", (sb) => sb.writeUserSettings("{not json")],
  ["unknown ANTHROPIC name", (sb) => sb.writeUserSettings({ env: { ANTHROPIC_CUSTOM_HEADERS: "x" } })],
  ["managed drop-in", (sb) => sb.writeFile("managed/managed-settings.d/10.json", JSON.stringify({ apiKeyHelper: "x" }))],
  ["managed plist present", (sb) => sb.writeFile("managed/com.anthropic.claudecode.plist", "")],
  ["console login", () => {}, { status: { ...SUBSCRIPTION_STATUS, authMethod: "console" } }],
  ["no subscription type", () => {}, { status: { ...SUBSCRIPTION_STATUS, subscriptionType: null } }],
];

describe("authPreflight parity", () => {
  it.each(CASES)("%s: same verdict and reasons as the legacy copy", (_label, arrange, cli) => {
    const sb = makeSandbox();
    arrange(sb);
    const run = (fn: typeof runPreflight) => {
      const fake = fakeSpawnSync(cli);
      const report = fn({
        env: gatewayParentEnv(sb.home),
        cwd: sb.root,
        managedPaths: sb.managedPaths,
        projectStopAt: sb.root,
        username: "someone",
        spawnSync: fake.spawnSync,
        child: { env: { HOME: sb.home, PATH: "/usr/bin:/bin" }, claudePath: sb.claudePath, strategy: "parity" },
      });
      return { report, calls: fake.calls.map((c) => c.args.join(" ")) };
    };
    const ours = run(runPreflight);
    const legacy = run(legacyRunPreflight as typeof runPreflight);
    expect(ours.report).toEqual(legacy.report);
    expect(ours.calls).toEqual(legacy.calls);
  });
});
