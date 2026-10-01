import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildJobSurface, SCOUT_TOOL_NAMES } from "./jobSurface.js";
import { fakeBackend, selection } from "./testing/fakeBackend.js";
import { defaultManagedPaths } from "./claudeJob.js";
import { BRIDGE_JOB_MAX_BYTES, BridgeJobSchema } from "./contextToolBridge.js";
import { BRIDGE_SERVER_NAME, checkManagedPolicy, managedSettingsConflict, planJobTools, type JobManagedPaths, type ToolPlanOptions } from "./toolPolicy.js";
import { MAX_ARG_CHARS, MAX_ARGS, MAX_CONNECTIONS, MAX_DESCRIPTION_CHARS, MAX_SELECTIONS, ToolsProfileSchema, type ToolsProfile } from "./toolProfile.js";

const SECRET = "SENTINEL-PLAN-SECRET-9a0b";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "scout-policy-"));
  dirs.push(d);
  return d;
}

const scoutTools = SCOUT_TOOL_NAMES.map((t) => `mcp__scout__${t}`);
const opts = (tools: ToolsProfile | undefined): ToolPlanOptions => ({
  tools,
  scout: { nodePath: process.execPath, entrypoint: "/x/scout-mcp/main.js", socketPath: "/x/agent.sock", tokenFile: "/x/job/agent-token" },
  bridge: { nodePath: process.execPath, entrypoint: "/x/bridgeMain.js", jobFile: "/x/job/bridge.json" },
});

describe("planJobTools", () => {
  it("without selected tools: Scout's server only, every Scout tool allowed", () => {
    const plan = planJobTools(opts(undefined));
    expect(plan).toMatchObject({ ok: true, unavailable: [] });
    if (!plan.ok) return;
    expect(plan.bridgeJob).toBeUndefined();
    expect(plan.spec.servers.map((s) => s.name)).toEqual(["scout"]);
    expect(plan.spec.allowedTools).toEqual(scoutTools);
  });

  it("with selected tools: one bridge server, exact bridged grants, bindings (never values) in the bridge job", () => {
    const d = dir();
    const a = fakeBackend(d, "notes", "honest", { env: { NOTES_TOKEN: SECRET } });
    const b = fakeBackend(d, "tracker", "honest");
    const plan = planJobTools(
      opts({ connections: [a.connection, b.connection], selections: [selection("notes", "lookup", false), selection("tracker", "peek", true)] }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const surface = buildJobSurface(plan.spec);
    expect(surface.allowedToolsArg.split(",")).toEqual([...scoutTools, "mcp__scout_bridge__lookup", "mcp__scout_bridge__peek"]);
    expect(Object.keys(surface.mcpConfig.mcpServers)).toEqual(["scout", BRIDGE_SERVER_NAME]);
    expect(surface.mcpConfig.mcpServers[BRIDGE_SERVER_NAME]).toEqual({ type: "stdio", command: process.execPath, args: ["/x/bridgeMain.js", "--job", "/x/job/bridge.json"] });
    expect(JSON.stringify(surface.mcpConfig)).not.toContain(SECRET);
    expect(surface.expected[1]).toEqual({ name: BRIDGE_SERVER_NAME, tools: ["mcp__scout_bridge__lookup", "mcp__scout_bridge__peek"], required: true, optionalTools: ["mcp__scout_bridge__lookup"] });
    expect(plan.bridgeJob!.connections.find((c) => c.id === "notes")!.env).toEqual({ NOTES_TOKEN: { file: a.definitionFile, pointer: "/env/NOTES_TOKEN" } });
    expect(JSON.stringify(plan.bridgeJob)).not.toContain(SECRET);
    expect(plan.bridgeJob!.tools.map((t) => t.name)).toEqual(["lookup", "peek"]);
  });

  it("an all-optional bridge is an optional server", () => {
    const a = fakeBackend(dir(), "notes", "honest");
    const plan = planJobTools(opts({ connections: [a.connection], selections: [selection("notes", "lookup", false)] }));
    expect(plan.ok && buildJobSurface(plan.spec).expected[1]).toMatchObject({ required: false, optionalTools: ["mcp__scout_bridge__lookup"] });
  });

  it("a required tool whose bindings do not resolve blocks the job", () => {
    const a = fakeBackend(dir(), "notes", "honest", { env: { NOTES_TOKEN: SECRET } });
    chmodSync(a.definitionFile, 0o644);
    expect(planJobTools(opts({ connections: [a.connection], selections: [selection("notes", "lookup", true)] }))).toEqual({ ok: false, reason: "tool_unavailable", detail: "required_connection_unavailable" });
  });

  it("a profile within its own caps whose bridge job would exceed the bridge's cap: unsupported_configuration before launch", () => {
    const d = dir();
    // Arguments of control characters: each serializes as a six-byte JSON escape.
    const arg = "\u0001".repeat(MAX_ARG_CHARS);
    const connections = Array.from({ length: MAX_CONNECTIONS }, (_, i) => ({ ...fakeBackend(d, `c${i}`, "honest").connection, args: Array.from({ length: MAX_ARGS }, () => arg) }));
    const perConnection = MAX_SELECTIONS / MAX_CONNECTIONS;
    const selections = Array.from({ length: MAX_SELECTIONS }, (_, i) => ({
      ...selection(`c${Math.floor(i / perConnection)}`, `tool_${i}`, false),
      description: "\u0001".repeat(MAX_DESCRIPTION_CHARS),
    }));
    const tools = ToolsProfileSchema.parse({ connections, selections }); // the profile permits it
    expect(planJobTools(opts(tools))).toEqual({ ok: false, reason: "unsupported_configuration", detail: "bridge_job_too_large" });
    // The cap is the bridge's own: the same plan under a cap that fits is accepted.
    expect(planJobTools({ ...opts(tools), maxBridgeJobBytes: 64 * BRIDGE_JOB_MAX_BYTES }).ok).toBe(true);
  });

  it("carries a connection's literal env into the bridge job verbatim", () => {
    const a = fakeBackend(dir(), "notes", "honest", { env: { NOTES_TOKEN: SECRET }, literalEnv: { PATH: "/usr/bin:/bin" } });
    const plan = planJobTools(opts({ connections: [a.connection], selections: [selection("notes", "lookup", true)] }));
    expect(plan.ok && plan.bridgeJob!.connections[0]!.literalEnv).toEqual({ PATH: "/usr/bin:/bin" });
    expect(JSON.stringify(plan.ok && plan.bridgeJob)).not.toContain(SECRET);
  });

  it("never carries setup bookkeeping into the bridge job", () => {
    const a = fakeBackend(dir(), "notes", "honest");
    const withSetup = { ...a.connection, definitionFile: a.definitionFile, revision: 3, inspectedAt: "2026-10-01T12:00:00.000Z" };
    const plan = planJobTools(opts({ connections: [withSetup], selections: [selection("notes", "lookup", false)] }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const jobText = JSON.stringify(plan.bridgeJob);
    for (const field of ["definitionFile", "inspectedAt", "revision"]) expect(jobText).not.toContain(field);
    // The job schema has no field for the auth-prompt mark either.
    const conn0 = plan.bridgeJob!.connections[0]!;
    expect(BridgeJobSchema.safeParse({ ...plan.bridgeJob, connections: [{ ...conn0, unavailable: { reason: "auth_prompt", at: "2026-10-01T12:00:00.000Z" } }] }).success).toBe(false);
  });

  it("a connection marked unavailable (auth_prompt) is never offered: optional tools are listed unavailable, a required one blocks the job", () => {
    const a = fakeBackend(dir(), "notes", "honest");
    const marked = { ...a.connection, unavailable: { reason: "auth_prompt" as const, at: "2026-10-01T12:00:00.000Z" } };
    const optional = planJobTools(opts({ connections: [marked], selections: [selection("notes", "lookup", false)] }));
    expect(optional).toMatchObject({ ok: true, unavailable: [{ server: BRIDGE_SERVER_NAME, tool: "mcp__scout_bridge__lookup" }] });
    if (optional.ok) {
      expect(optional.bridgeJob).toBeUndefined();
      expect(optional.spec.servers.map((s) => s.name)).toEqual(["scout"]);
    }
    expect(planJobTools(opts({ connections: [marked], selections: [selection("notes", "lookup", true)] }))).toEqual({ ok: false, reason: "tool_unavailable", detail: "required_connection_unavailable" });
  });

  it("an optional tool whose command is gone is reported unavailable and left out; Scout alone still runs", () => {
    const a = fakeBackend(dir(), "notes", "honest");
    const plan = planJobTools(opts({ connections: [{ ...a.connection, command: "/nonexistent-scout-test/notes-mcp" }], selections: [selection("notes", "lookup", false)] }));
    expect(plan).toMatchObject({ ok: true, unavailable: [{ server: BRIDGE_SERVER_NAME, tool: "mcp__scout_bridge__lookup" }] });
    if (plan.ok) {
      expect(plan.bridgeJob).toBeUndefined();
      expect(plan.spec.servers.map((s) => s.name)).toEqual(["scout"]);
    }
  });
});

describe("checkManagedPolicy", () => {
  function managed(files: Record<string, unknown>, extra: Partial<JobManagedPaths> = {}): JobManagedPaths {
    const d = dir();
    const paths: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const p = join(d, name);
      writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
      paths.push(p);
    }
    return { files: [...paths, join(d, "absent.json")], dropInDirs: [join(d, "absent.d")], opaque: [join(d, "absent.plist")], mcpFiles: [join(d, "managed-mcp.json")], ...extra };
  }

  it("absent files are fine; harmless settings are fine", () => {
    expect(checkManagedPolicy(managed({}))).toEqual({ ok: true });
    expect(checkManagedPolicy(managed({ "m.json": { permissions: { allow: ["Bash(ls)"], defaultMode: "dontAsk" }, hooks: {}, disableAllHooks: true, allowManagedHooksOnly: true } }))).toEqual({ ok: true });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["managed hooks (they run under a non-managed disableAllHooks)", { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "x" }] }] } }, "managed_hooks"],
    ["hooks forced on", { disableAllHooks: false }, "managed_hooks_enabled"],
    ["a managed plugin", { enabledPlugins: { "p@m": true } }, "managed_plugins"],
    ["plugin-only customization", { strictPluginOnlyCustomization: ["mcp"] }, "managed_plugin_only"],
    ["managed permission rules only", { allowManagedPermissionRulesOnly: true }, "managed_permission_rules_only"],
    ["managed MCP servers only", { allowManagedMcpServersOnly: true }, "managed_mcp_servers_only"],
    ["a forced permission mode", { permissions: { defaultMode: "acceptEdits" } }, "managed_permission_mode"],
    ["an empty MCP allowlist", { allowedMcpServers: [] }, "managed_mcp_allowlist"],
    ["an MCP allowlist without the bridge", { allowedMcpServers: [{ serverName: "scout" }] }, "managed_mcp_allowlist"],
    ["an MCP allowlist admitting Scout by command only", { allowedMcpServers: [{ serverCommand: ["/usr/local/bin/node"] }, { serverName: "scout" }] }, "managed_mcp_allowlist"],
    ["an MCP allowlist with a malformed entry (the CLI enforces it as empty)", { allowedMcpServers: [{ serverName: "scout" }, { serverName: "scout_bridge" }, { serverName: "a b" }] }, "managed_mcp_allowlist"],
    ["an MCP allowlist that is not an array", { allowedMcpServers: { serverName: "scout" } }, "managed_mcp_allowlist"],
    ["an MCP denylist naming the bridge", { deniedMcpServers: [{ serverName: "scout_bridge" }] }, "managed_mcp_denylist"],
    ["an MCP denylist naming Scout's server", { deniedMcpServers: [{ serverName: "other" }, { serverName: "scout" }] }, "managed_mcp_denylist"],
    ["an MCP denylist by command (may match Scout's argv)", { deniedMcpServers: [{ serverCommand: ["/usr/local/bin/node", "x.js"] }] }, "managed_mcp_denylist"],
  ])("refuses %s", (_label, settings, detail) => {
    expect(checkManagedPolicy(managed({ "m.json": settings }))).toEqual({ ok: false, detail });
    expect(managedSettingsConflict(settings)).toBe(detail);
  });

  it("MCP allow and deny lists that leave Scout's servers alone are fine", () => {
    const ok = {
      allowedMcpServers: [{ serverName: "scout" }, { serverName: "scout_bridge" }, { serverUrl: "https://*.example.com/*" }],
      deniedMcpServers: [{ serverName: "other" }, { serverUrl: "https://evil.example/*" }],
    };
    expect(checkManagedPolicy(managed({ "m.json": ok }))).toEqual({ ok: true });
  });

  it("a managed MCP config (managed-mcp.json) refuses whenever it is present, whatever it holds", () => {
    const paths = managed({});
    writeFileSync(paths.mcpFiles![0]!, JSON.stringify({ mcpServers: {} }));
    expect(checkManagedPolicy(paths)).toEqual({ ok: false, detail: "managed_mcp_file" });
    writeFileSync(paths.mcpFiles![0]!, "");
    expect(checkManagedPolicy(paths)).toEqual({ ok: false, detail: "managed_mcp_file" });
  });

  it("the default locations include the managed MCP config on macOS and Linux", () => {
    const paths = defaultManagedPaths({ HOME: "/x/home" }, () => "someone");
    if (process.platform === "darwin") expect(paths.mcpFiles).toEqual(["/Library/Application Support/ClaudeCode/managed-mcp.json"]);
    if (process.platform === "linux") expect(paths.mcpFiles).toEqual(["/etc/claude-code/managed-mcp.json"]);
  });

  it("a managed settings path that is a FIFO fails closed without blocking", (ctx) => {
    const paths = managed({});
    const fifo = paths.files.at(-1)!; // the absent.json slot
    if (spawnSync("mkfifo", [fifo]).status !== 0) return ctx.skip();
    expect(checkManagedPolicy(paths)).toEqual({ ok: false, detail: "managed_unreadable" });
  });

  it("checks drop-in fragments like any managed file", () => {
    const d = dir();
    mkdirSync(join(d, "managed-settings.d"));
    writeFileSync(join(d, "managed-settings.d", "10-hooks.json"), JSON.stringify({ hooks: { Stop: [] } }));
    expect(checkManagedPolicy({ files: [], dropInDirs: [join(d, "managed-settings.d")], opaque: [] })).toEqual({ ok: false, detail: "managed_hooks" });
  });

  it("fails closed: malformed or unreadable files, an MDM plist, an unknown platform", () => {
    expect(checkManagedPolicy(managed({ "m.json": "{not json" }))).toEqual({ ok: false, detail: "managed_unreadable" });
    expect(checkManagedPolicy(managed({ "m.json": [1, 2] }))).toEqual({ ok: false, detail: "managed_unreadable" });
    const plist = managed({ "x.plist": "<plist/>" });
    expect(checkManagedPolicy({ files: [], dropInDirs: [], opaque: plist.files.slice(0, 1) })).toEqual({ ok: false, detail: "managed_not_inspected" });
    expect(checkManagedPolicy({ files: [], dropInDirs: [], opaque: [], unsupported: true })).toEqual({ ok: false, detail: "managed_unknown_platform" });
  });

  it("an OS user that cannot be determined is its own refusal, not an unknown platform", () => {
    const env = { HOME: "/x/home" };
    const throwing = (): string => {
      throw new Error("no passwd entry");
    };
    expect(checkManagedPolicy(defaultManagedPaths(env, throwing))).toEqual({ ok: false, detail: "managed_user_unknown" });
    expect(checkManagedPolicy(defaultManagedPaths(env, () => ""))).toEqual({ ok: false, detail: "managed_user_unknown" });
    expect(checkManagedPolicy(defaultManagedPaths(env, () => "a/b"))).toEqual({ ok: false, detail: "managed_user_unknown" });
    // No HOME and no CLAUDE_CONFIG_DIR: the config dir cannot be located either.
    expect(checkManagedPolicy(defaultManagedPaths({}, () => "someone"))).toEqual({ ok: false, detail: "managed_user_unknown" });
  });
});
