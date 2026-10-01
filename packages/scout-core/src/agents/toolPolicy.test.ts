import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagedPaths } from "./authPreflight.js";
import { buildJobSurface, SCOUT_TOOL_NAMES } from "./jobSurface.js";
import { fakeBackend, selection } from "./testing/fakeBackend.js";
import { BRIDGE_SERVER_NAME, checkManagedPolicy, managedSettingsConflict, planJobTools, type ToolPlanOptions } from "./toolPolicy.js";
import type { ToolsProfile } from "./toolProfile.js";

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

  it("with selected tools: one bridge server, exact bridged grants, secrets only in the bridge job", () => {
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
    expect(plan.bridgeJob!.connections.find((c) => c.id === "notes")!.env).toEqual({ NOTES_TOKEN: SECRET });
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
    expect(planJobTools(opts({ connections: [a.connection], selections: [selection("notes", "lookup", true)] }))).toEqual({ ok: false, detail: "required_connection_unavailable" });
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
  function managed(files: Record<string, unknown>, extra: Partial<ManagedPaths> = {}): ManagedPaths {
    const d = dir();
    const paths: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const p = join(d, name);
      writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
      paths.push(p);
    }
    return { files: [...paths, join(d, "absent.json")], dropInDirs: [join(d, "absent.d")], opaque: [join(d, "absent.plist")], ...extra };
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
  ])("refuses %s", (_label, settings, detail) => {
    expect(checkManagedPolicy(managed({ "m.json": settings }))).toEqual({ ok: false, detail });
    expect(managedSettingsConflict(settings)).toBe(detail);
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
});
