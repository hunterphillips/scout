// The copied preflight must decide exactly as the removed package's one did, over the same
// synthetic settings, env and CLI answers. Its verdicts, reasons and CLI calls were pinned
// from the removed personal-context package's copy (git history has it).

import { afterEach, describe, expect, it } from "vitest";
import { runPreflight } from "./authPreflight.js";
import { cleanupSandboxes, fakeSpawnSync, gatewayParentEnv, makeSandbox, SUBSCRIPTION_STATUS, type Sandbox } from "./testing/preflightSandbox.js";

afterEach(() => cleanupSandboxes());

const CLI_CALLS = ["--version", "auth --help", "auth status --help", "auth status --json"];
const USER = "<ROOT>/home/.claude";

/** label, arrange, CLI answers, legacy verdict, legacy reasons (`<ROOT>` = sandbox root), legacy CLI calls. */
const CASES: [string, (sb: Sandbox) => void, Parameters<typeof fakeSpawnSync>[0] | undefined, string, string[], string[]][] = [
  ["clean", () => {}, undefined, "subscription", [], CLI_CALLS],
  ["api key", (sb) => sb.writeUserSettings({ env: { ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" } }), undefined, "ambiguous", [`user settings ${USER}/settings.json: ANTHROPIC_API_KEY present`], []],
  ["apiKeyHelper", (sb) => sb.writeUserSettings({ apiKeyHelper: "SENTINEL-HELPER-CMD-44d0" }), undefined, "ambiguous", [`user settings ${USER}/settings.json: apiKeyHelper present`], []],
  [
    "provider flag",
    (sb) => sb.writeUserSettings({ env: { CLAUDE_CODE_USE_VERTEX: "1" } }, "settings.local.json"),
    undefined,
    "ambiguous",
    [`user settings ${USER}/settings.local.json: provider flag CLAUDE_CODE_USE_VERTEX present`],
    [],
  ],
  [
    "loopback gateway",
    (sb) => sb.writeUserSettings({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" } }),
    undefined,
    "ambiguous",
    [`user settings ${USER}/settings.json: ANTHROPIC_BASE_URL is non-anthropic-loopback`],
    [],
  ],
  ["malformed settings", (sb) => sb.writeUserSettings("{not json"), undefined, "ambiguous", [`user settings ${USER}/settings.json: malformed`], []],
  [
    "unknown ANTHROPIC name",
    (sb) => sb.writeUserSettings({ env: { ANTHROPIC_CUSTOM_HEADERS: "x" } }),
    undefined,
    "ambiguous",
    [`user settings ${USER}/settings.json: unrecognized ANTHROPIC_CUSTOM_HEADERS present`],
    [],
  ],
  [
    "managed drop-in",
    (sb) => sb.writeFile("managed/managed-settings.d/10.json", JSON.stringify({ apiKeyHelper: "x" })),
    undefined,
    "ambiguous",
    ["managed settings <ROOT>/managed/managed-settings.d/10.json: apiKeyHelper present"],
    [],
  ],
  [
    "managed plist present",
    (sb) => sb.writeFile("managed/com.anthropic.claudecode.plist", ""),
    undefined,
    "ambiguous",
    ["managed settings <ROOT>/managed/com.anthropic.claudecode.plist: present but not inspected"],
    [],
  ],
  ["console login", () => {}, { status: { ...SUBSCRIPTION_STATUS, authMethod: "console" } }, "ambiguous", ["cli: login method is console, not claude.ai"], CLI_CALLS],
  ["no subscription type", () => {}, { status: { ...SUBSCRIPTION_STATUS, subscriptionType: null } }, "ambiguous", ["cli: subscription type is other"], CLI_CALLS],
];

describe("authPreflight parity", () => {
  it.each(CASES)("%s: same verdict, reasons and CLI calls as the removed package's copy", (_label, arrange, cli, verdict, reasons, calls) => {
    const sb = makeSandbox();
    arrange(sb);
    const fake = fakeSpawnSync(cli);
    const report = runPreflight({
      env: gatewayParentEnv(sb.home),
      cwd: sb.root,
      managedPaths: sb.managedPaths,
      projectStopAt: sb.root,
      username: "someone",
      spawnSync: fake.spawnSync,
      child: { env: { HOME: sb.home, PATH: "/usr/bin:/bin" }, claudePath: sb.claudePath, strategy: "parity" },
    });
    expect(report.verdict).toBe(verdict);
    expect(report.reasons.map((r) => r.split(sb.root).join("<ROOT>"))).toEqual(reasons);
    expect(fake.calls.map((c) => c.args.join(" "))).toEqual(calls);
  });
});

describe("authPreflight parity: the whole report", () => {
  it("a clean subscription run reports exactly what the removed package's copy reported", () => {
    const sb = makeSandbox();
    const fake = fakeSpawnSync();
    const report = runPreflight({
      env: gatewayParentEnv(sb.home),
      cwd: sb.root,
      managedPaths: sb.managedPaths,
      projectStopAt: sb.root,
      username: "someone",
      spawnSync: fake.spawnSync,
      child: { env: { HOME: sb.home, PATH: "/usr/bin:/bin" }, claudePath: sb.claudePath, strategy: "parity" },
    });
    const route = (on: boolean) => ({
      apiKey: on,
      authToken: on,
      providerFlags: on ? ["CLAUDE_CODE_USE_BEDROCK"] : [],
      baseUrl: on ? "non-anthropic-loopback" : "unset",
      modelNames: on ? ["ANTHROPIC_MODEL"] : [],
      otherAnthropicNames: [],
    });
    expect(JSON.parse(JSON.stringify(report).split(sb.root).join("<ROOT>"))).toEqual({
      verdict: "subscription",
      reasons: [],
      inference: "none",
      childEnvStrategy: "parity",
      env: {
        parent: { names: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "CLAUDE_CODE_USE_BEDROCK"], route: route(true) },
        child: { names: [], route: route(false) },
      },
      nestedSessionMarkers: { CLAUDECODE: true, CLAUDE_CODE_ENTRYPOINT: true },
      nestedSessionMarkersInChild: { CLAUDECODE: false, CLAUDE_CODE_ENTRYPOINT: false },
      settings: [],
      cli: {
        resolved: true,
        path: "<ROOT>/bin/claude",
        version: "2.1.286",
        statusCommand: "auth status --json",
        status: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" },
      },
      configDir: "<ROOT>/home/.claude",
    });
  });
});
