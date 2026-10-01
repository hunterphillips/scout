// The unattended tool policy for one job: which MCP servers and exact tools the job's CLI
// gets, and whether managed policy lets Scout enforce that at all.
//
// planJobTools turns the agent profile's selected tools (toolProfile.ts) into the job's
// surface (jobSurface.ts):
//   - `scout` (required, all Scout tools) always;
//   - when at least one selected tool can be offered, one forwarding bridge server
//     (`scout_bridge`, contextToolBridge.ts) whose tools are exactly the selected ones, under
//     their own names. It is required when any of its tools is required; its other tools
//     are optional.
//   - The allowed-tool list is exactly the Scout tools plus `mcp__scout_bridge__<tool>` for
//     each offered selection. Bridged names are separate grants: the user's allow rules for
//     the original server's names (`mcp__<original>__<tool>`) never match them, and the
//     bridge advertises nothing else, so no allow rule, hook decision or skill metadata can
//     widen what a job can call.
// Before launch each connection a selection uses is prepared: its command must still be an
// absolute executable file and its environment bindings must resolve (toolProfile.ts). A
// connection that cannot be prepared makes its tools unavailable: a required one blocks
// the job (`tool_unavailable`), an optional one is reported unavailable in the job details
// and left out of the bridge. At startup the bridge drops a tool that is missing or whose
// schema changed; the init check (initCheck.ts) applies the same required/optional rule to
// what the CLI then lists. Scout's own tools alone are a supported baseline.
//
// checkManagedPolicy reads the managed settings Claude Code applies on top of every other
// source (same locations as the billing preflight, managedPathsFor in authPreflight.ts;
// macOS: /Library/Application Support/ClaudeCode/managed-settings.json, its
// managed-settings.d/*.json drop-ins, the MDM plists under /Library/Managed Preferences, and
// the server-managed cache `remote-settings.json` in the CLI config dir). A job does not run
// (`unsupported_configuration`) when managed policy would defeat its restrictions. Verified
// against the strings of the installed CLI 2.1.286 on 2026-10-01:
//   - `hooks` with any entry: "Hooks configured in managed settings (they run even under a
//     non-managed disableAllHooks)";
//   - `disableAllHooks: false`: managed settings outrank the job's --settings file;
//   - `enabledPlugins` with an enabled plugin: managed plugins keep their hooks under
//     allowManagedHooksOnly / disableAllHooks;
//   - `strictPluginOnlyCustomization` (true, a list, or anything invalid, which the CLI
//     treats as true): MCP servers, hooks and skills load from managed settings and plugins
//     only, so the job's strict MCP config is not what loads;
//   - `allowManagedPermissionRulesOnly: true`: the job's exact --allowedTools list is ignored
//     and only managed rules apply;
//   - `allowManagedMcpServersOnly: true`: the job's servers are not what loads;
//   - `permissions.defaultMode` other than `dontAsk`: unattended denial is not assured.
// A managed file that is unreadable or malformed, an MDM plist (not parsed), or a platform
// without known locations also refuses: fail closed. Absent files are fine. Managed
// `permissions.allow` rules are accepted: built-in tools are off (`--tools ""`) and every
// MCP tool the job can see is already on its exact list.

import { constants as fsc, closeSync, fstatSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { isExecutableFile, type ManagedPaths } from "./authPreflight.js";
import { BRIDGE_DEFAULT_LIMITS, type BridgeJob } from "./contextToolBridge.js";
import { mcpToolName, SCOUT_SERVER_NAME, SCOUT_TOOL_NAMES, scoutServerSpec, type JobServerSpec, type JobSurfaceSpec, type ScoutServerOptions } from "./jobSurface.js";
import { resolveEnvBindings, type Connection, type EnvBinding, type ToolsProfile } from "./toolProfile.js";

export const BRIDGE_SERVER_NAME = "scout_bridge";

/** The built bridge entrypoint (`dist/agents/bridgeMain.js`), resolved through the package export. */
export function defaultBridgeEntrypoint(): string {
  return createRequire(import.meta.url).resolve("@scout/scout-core/agents/bridge");
}

export interface ToolPlanOptions {
  tools: ToolsProfile | undefined;
  scout: ScoutServerOptions;
  /** How the CLI starts the bridge: `<nodePath> <entrypoint> --job <jobFile>`. */
  bridge: { nodePath: string; entrypoint: string; jobFile: string };
  limits?: BridgeJob["limits"];
  /** Test seam. */
  resolveEnv?: (env: Readonly<Record<string, EnvBinding>>) => Record<string, string>;
}

export interface UnavailableTool {
  server: string;
  /** Full `mcp__<server>__<tool>` name. */
  tool: string;
}

export type ToolPlan =
  | {
      ok: true;
      spec: JobSurfaceSpec;
      /** The bridge's private job file content (holds resolved secrets); absent without selected tools. */
      bridgeJob?: BridgeJob;
      /** Optional selected tools left out before launch. */
      unavailable: UnavailableTool[];
    }
  | { ok: false; detail: "required_connection_unavailable" };

export function planJobTools(o: ToolPlanOptions): ToolPlan {
  const scout = scoutServerSpec(o.scout);
  const allowed = SCOUT_TOOL_NAMES.map((t) => mcpToolName(SCOUT_SERVER_NAME, t));
  const selections = o.tools?.selections ?? [];
  if (selections.length === 0) return { ok: true, spec: { servers: [scout], allowedTools: allowed }, unavailable: [] };

  const resolve = o.resolveEnv ?? ((env) => resolveEnvBindings(env));
  const byId = new Map((o.tools?.connections ?? []).map((c) => [c.id, c]));
  const prepared = new Map<string, BridgeJob["connections"][number] | undefined>();
  const prepare = (c: Connection): BridgeJob["connections"][number] | undefined => {
    if (!prepared.has(c.id)) {
      let entry: BridgeJob["connections"][number] | undefined;
      try {
        if (isExecutableFile(c.command)) entry = { id: c.id, command: c.command, args: [...c.args], env: resolve(c.env) };
      } catch {
        entry = undefined; // a binding that does not resolve: the codes stay out of the plan
      }
      prepared.set(c.id, entry);
    }
    return prepared.get(c.id);
  };

  const offered: ToolsProfile["selections"] = [];
  const unavailable: UnavailableTool[] = [];
  for (const s of selections) {
    const conn = byId.get(s.connectionId);
    if (conn && prepare(conn)) offered.push(s);
    else if (s.required) return { ok: false, detail: "required_connection_unavailable" };
    else unavailable.push({ server: BRIDGE_SERVER_NAME, tool: mcpToolName(BRIDGE_SERVER_NAME, s.toolName) });
  }
  if (offered.length === 0) return { ok: true, spec: { servers: [scout], allowedTools: allowed }, unavailable };

  const bridgeServer: JobServerSpec = {
    name: BRIDGE_SERVER_NAME,
    command: o.bridge.nodePath,
    args: [o.bridge.entrypoint, "--job", o.bridge.jobFile],
    tools: offered.map((s) => s.toolName),
    required: offered.some((s) => s.required),
    optionalTools: offered.filter((s) => !s.required).map((s) => s.toolName),
  };
  const usedIds = new Set(offered.map((s) => s.connectionId));
  const bridgeJob: BridgeJob = {
    version: 1,
    limits: { ...(o.limits ?? BRIDGE_DEFAULT_LIMITS) },
    connections: [...usedIds].map((id) => prepared.get(id)!),
    tools: offered.map((s) => ({ name: s.toolName, connectionId: s.connectionId, description: s.description, inputSchema: s.inputSchema, schemaHash: s.schemaHash })),
  };
  return {
    ok: true,
    spec: { servers: [scout, bridgeServer], allowedTools: [...allowed, ...offered.map((s) => mcpToolName(BRIDGE_SERVER_NAME, s.toolName))] },
    bridgeJob,
    unavailable,
  };
}

// ---------- managed policy ----------

export type ManagedPolicyDetail =
  | "managed_hooks"
  | "managed_hooks_enabled"
  | "managed_plugins"
  | "managed_plugin_only"
  | "managed_permission_rules_only"
  | "managed_mcp_servers_only"
  | "managed_permission_mode"
  | "managed_unreadable"
  | "managed_not_inspected"
  | "managed_unknown_platform";

export type ManagedPolicyResult = { ok: true } | { ok: false; detail: ManagedPolicyDetail };

const MANAGED_MAX_BYTES = 1024 * 1024;
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isMissing = (e: unknown): boolean => ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException | null)?.code ?? "");

/** One managed JSON file: undefined when absent; throws "unreadable" when it cannot be read or parsed as an object. */
function readManaged(path: string): Record<string, unknown> | undefined {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY);
  } catch (e) {
    if (isMissing(e)) return undefined;
    throw new Error("unreadable");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MANAGED_MAX_BYTES) throw new Error("unreadable");
    const j: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!isRec(j)) throw new Error("unreadable");
    return j;
  } finally {
    closeSync(fd);
  }
}

/** Why one managed settings object defeats a job's restrictions, if it does. */
export function managedSettingsConflict(s: Record<string, unknown>): ManagedPolicyDetail | undefined {
  if (s.hooks !== undefined && (!isRec(s.hooks) || Object.keys(s.hooks).length > 0)) return "managed_hooks";
  if (s.disableAllHooks === false) return "managed_hooks_enabled";
  if (s.enabledPlugins !== undefined && (!isRec(s.enabledPlugins) || Object.values(s.enabledPlugins).some((v) => v !== false))) return "managed_plugins";
  if (s.strictPluginOnlyCustomization !== undefined && s.strictPluginOnlyCustomization !== false) return "managed_plugin_only";
  if (s.allowManagedPermissionRulesOnly === true) return "managed_permission_rules_only";
  if (s.allowManagedMcpServersOnly === true) return "managed_mcp_servers_only";
  const mode = isRec(s.permissions) ? s.permissions.defaultMode : undefined;
  if (mode !== undefined && mode !== "dontAsk") return "managed_permission_mode";
  return undefined;
}

/** Check every managed settings location; the first conflict wins. Never throws. */
export function checkManagedPolicy(paths: ManagedPaths): ManagedPolicyResult {
  if (paths.unsupported) return { ok: false, detail: "managed_unknown_platform" };
  const files = [...paths.files];
  for (const dir of paths.dropInDirs) {
    try {
      files.push(
        ...readdirSync(dir)
          .filter((n) => n.endsWith(".json"))
          .sort()
          .map((n) => join(dir, n)),
      );
    } catch (e) {
      if (!isMissing(e)) return { ok: false, detail: "managed_unreadable" };
    }
  }
  for (const f of files) {
    let s: Record<string, unknown> | undefined;
    try {
      s = readManaged(f);
    } catch {
      return { ok: false, detail: "managed_unreadable" };
    }
    const conflict = s && managedSettingsConflict(s);
    if (conflict) return { ok: false, detail: conflict };
  }
  for (const p of paths.opaque) {
    try {
      statSync(p);
      return { ok: false, detail: "managed_not_inspected" };
    } catch (e) {
      if (!isMissing(e)) return { ok: false, detail: "managed_unreadable" };
    }
  }
  return { ok: true };
}
