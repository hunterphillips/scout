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
// absolute executable file and its environment bindings must resolve (toolProfile.ts). The
// resolution here is a dry run: the values are checked and discarded. The bridge's job file
// carries the bindings (`{file, pointer}`), never the values, plus the definition's
// non-secret `literalEnv` verbatim; the bridge resolves them again
// in memory just before it starts each backend. A connection that cannot be prepared, or
// that carries the setup CLI's `unavailable` mark (an auth prompt at its last inspection), makes
// its tools unavailable: a required one blocks the job (`tool_unavailable`), an optional one
// is reported unavailable in the job details and left out of the bridge. At startup the
// bridge drops a tool whose connection's bindings no longer resolve, that is missing, or
// whose schema changed; the init check (initCheck.ts) applies the same required/optional
// rule to what the CLI then lists. Scout's own tools alone are a supported baseline. A job
// file larger than the bridge accepts (BRIDGE_JOB_MAX_BYTES) refuses the job before launch
// (`unsupported_configuration`).
//
// checkManagedPolicy reads the managed settings Claude Code applies on top of every other
// source (managedPathsFor below;
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
//   - `permissions.defaultMode` other than `dontAsk`: unattended denial is not assured;
//   - `allowedMcpServers` (an array) without a `{serverName}` entry for each of `scout` and
//     `scout_bridge` (`managed_mcp_allowlist`). Observed: entries carry exactly one of
//     `serverName` (letters, digits, `-`, `_`), `serverCommand` ([command, ...args], exact)
//     or `serverUrl`; undefined allows all; an empty array allows none; an invalid value is
//     enforced as an empty allowlist. Inferred: a `serverCommand` entry cannot be relied on
//     to admit Scout's servers (their argv names per-job paths), so only names count, and
//     both names are required even for a job without the bridge (the check runs before the
//     plan). Any malformed entry refuses;
//   - `deniedMcpServers` (an array) with a `{serverName}` entry naming `scout` or
//     `scout_bridge`, or any `serverCommand` entry (`managed_mcp_denylist`). Observed: names
//     are compared verbatim; the denylist wins over the allowlist; an invalid list is
//     dropped. Inferred: a command entry may match Scout's node argv, which this check
//     does not compare, so it refuses; `serverUrl` entries cannot match a stdio server.
// The managed MCP config `managed-mcp.json` (macOS: /Library/Application Support/ClaudeCode/,
// Linux: /etc/claude-code/; observed next to managed-settings.json in the CLI's managed
// config list) "has exclusive control over MCP servers" while it exists, so the job's
// servers are ignored: its presence refuses (`managed_mcp_file`), whatever it contains.
// A managed file that is unreadable or malformed, an MDM plist (not parsed), or a platform
// without known locations also refuses: fail closed. Absent files are fine. Managed
// `permissions.allow` rules are accepted: built-in tools are off (`--tools ""`) and every
// MCP tool the job can see is already on its exact list.

import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { isExecutableFile } from "./authPreflight.js";
import { isMissing, readPrivateFile } from "../privateFile.js";
import { BRIDGE_DEFAULT_LIMITS, BRIDGE_JOB_MAX_BYTES, type BridgeJob } from "../contextToolBridge.js";
import { mcpToolName, SCOUT_SERVER_NAME, SCOUT_TOOL_NAMES, scoutServerSpec, type JobServerSpec, type JobSurfaceSpec, type ScoutServerOptions } from "./jobSurface.js";
import { resolveEnvBindings, type Connection, type EnvBinding, type ToolsProfile } from "../toolProfile.js";

export const BRIDGE_SERVER_NAME = "scout_bridge";

export interface ManagedPaths {
  files: string[];
  dropInDirs: string[];
  opaque: string[];
  unsupported?: boolean;
}

/** Managed-settings locations for the installed Claude CLI. */
export function managedPathsFor(platform: string, configDir: string, user: string): ManagedPaths {
  const remote = join(configDir, "remote-settings.json");
  if (platform === "darwin") {
    const base = "/Library/Application Support/ClaudeCode";
    return {
      files: [join(base, "managed-settings.json"), remote],
      dropInDirs: [join(base, "managed-settings.d")],
      opaque: [
        "/Library/Managed Preferences/com.anthropic.claudecode.plist",
        join("/Library/Managed Preferences", user, "com.anthropic.claudecode.plist"),
      ],
    };
  }
  if (platform === "linux") {
    return {
      files: ["/etc/claude-code/managed-settings.json", remote],
      dropInDirs: ["/etc/claude-code/managed-settings.d"],
      opaque: [],
    };
  }
  return { files: [remote], dropInDirs: [], opaque: [], unsupported: true };
}

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
  /** Test seam: the dry-run resolution. */
  resolveEnv?: (env: Readonly<Record<string, EnvBinding>>) => Record<string, string>;
  /** Test seam: the bridge's job file cap. */
  maxBridgeJobBytes?: number;
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
      /** The bridge's private job file content (bindings, never values); absent without selected tools. */
      bridgeJob?: BridgeJob;
      /** Optional selected tools left out before launch. */
      unavailable: UnavailableTool[];
    }
  | { ok: false; reason: "tool_unavailable"; detail: "required_connection_unavailable" }
  | { ok: false; reason: "unsupported_configuration"; detail: "bridge_job_too_large" };

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
        if (isExecutableFile(c.command)) {
          resolve(c.env); // dry run: the values are discarded here
          entry = { id: c.id, command: c.command, args: [...c.args], env: Object.fromEntries(Object.entries(c.env).map(([k, b]) => [k, { file: b.file, pointer: b.pointer }])) };
          if (c.literalEnv) entry.literalEnv = { ...c.literalEnv }; // non-secret, carried verbatim
          if (c.cwd !== undefined) entry.cwd = c.cwd;
        }
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
    if (conn && !conn.unavailable && prepare(conn)) offered.push(s);
    else if (s.required) return { ok: false, reason: "tool_unavailable", detail: "required_connection_unavailable" };
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
  // The profile's caps allow a job file larger than the bridge reads: refuse it here, not at the bridge.
  if (Buffer.byteLength(JSON.stringify(bridgeJob), "utf8") > (o.maxBridgeJobBytes ?? BRIDGE_JOB_MAX_BYTES)) {
    return { ok: false, reason: "unsupported_configuration", detail: "bridge_job_too_large" };
  }
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
  | "managed_mcp_allowlist"
  | "managed_mcp_denylist"
  | "managed_mcp_file"
  | "managed_permission_mode"
  | "managed_unreadable"
  | "managed_not_inspected"
  | "managed_unknown_platform"
  | "managed_user_unknown";

export type ManagedPolicyResult = { ok: true } | { ok: false; detail: ManagedPolicyDetail };

const MANAGED_MAX_BYTES = 1024 * 1024;
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * One managed JSON file: undefined when absent; throws when it cannot be read (a symlink, a
 * FIFO or anything not a regular file included) or parsed as an object.
 */
function readManaged(path: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readPrivateFile(path, MANAGED_MAX_BYTES, { private: false }).toString("utf8");
  } catch (e) {
    if ((e as { code?: unknown }).code === "missing") return undefined;
    throw new Error("unreadable");
  }
  const j: unknown = JSON.parse(text);
  if (!isRec(j)) throw new Error("unreadable");
  return j;
}

/** The MCP server names a job may register; managed allow/deny lists must admit both. */
const JOB_SERVER_NAMES: readonly string[] = [SCOUT_SERVER_NAME, BRIDGE_SERVER_NAME];
const SERVER_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Whether exactly one of serverName / serverCommand / serverUrl is set and well formed (the CLI's allowlist entry shape). */
function mcpListEntryValid(e: unknown): e is Record<string, unknown> {
  if (!isRec(e)) return false;
  const set = ["serverName", "serverCommand", "serverUrl"].filter((k) => e[k] !== undefined);
  if (set.length !== 1) return false;
  if (e.serverName !== undefined) return typeof e.serverName === "string" && SERVER_NAME_RE.test(e.serverName);
  if (e.serverCommand !== undefined) return Array.isArray(e.serverCommand) && e.serverCommand.length > 0 && e.serverCommand.every((x) => typeof x === "string");
  return typeof e.serverUrl === "string";
}

function mcpAllowlistExcludes(list: unknown): boolean {
  if (!Array.isArray(list) || !list.every(mcpListEntryValid)) return true; // the CLI enforces an invalid allowlist as empty
  const named = new Set(list.flatMap((e) => (typeof e.serverName === "string" ? [e.serverName] : [])));
  return !JOB_SERVER_NAMES.every((n) => named.has(n));
}

function mcpDenylistExcludes(list: unknown): boolean {
  if (!Array.isArray(list)) return false; // the CLI drops an invalid denylist
  return list.some((e) => isRec(e) && ((typeof e.serverName === "string" && JOB_SERVER_NAMES.includes(e.serverName)) || e.serverCommand !== undefined));
}

/** Why one managed settings object defeats a job's restrictions, if it does. */
export function managedSettingsConflict(s: Record<string, unknown>): ManagedPolicyDetail | undefined {
  if (s.hooks !== undefined && (!isRec(s.hooks) || Object.keys(s.hooks).length > 0)) return "managed_hooks";
  if (s.disableAllHooks === false) return "managed_hooks_enabled";
  if (s.enabledPlugins !== undefined && (!isRec(s.enabledPlugins) || Object.values(s.enabledPlugins).some((v) => v !== false))) return "managed_plugins";
  if (s.strictPluginOnlyCustomization !== undefined && s.strictPluginOnlyCustomization !== false) return "managed_plugin_only";
  if (s.allowManagedPermissionRulesOnly === true) return "managed_permission_rules_only";
  if (s.allowManagedMcpServersOnly === true) return "managed_mcp_servers_only";
  if (s.allowedMcpServers !== undefined && mcpAllowlistExcludes(s.allowedMcpServers)) return "managed_mcp_allowlist";
  if (s.deniedMcpServers !== undefined && mcpDenylistExcludes(s.deniedMcpServers)) return "managed_mcp_denylist";
  const mode = isRec(s.permissions) ? s.permissions.defaultMode : undefined;
  if (mode !== undefined && mode !== "dontAsk") return "managed_permission_mode";
  return undefined;
}

/**
 * Managed-settings locations for a job: the readiness path's (ManagedPaths) plus
 * `mcpFiles`, the managed MCP configs whose presence refuses; `userUnknown` when the OS user
 * (which keys per-user MDM policy) could not be determined.
 */
export type JobManagedPaths = ManagedPaths & { mcpFiles?: string[]; userUnknown?: boolean };

/** The managed MCP config locations (`managed-mcp.json` in the managed settings dir). */
export function managedMcpFilesFor(platform: string): string[] {
  if (platform === "darwin") return ["/Library/Application Support/ClaudeCode/managed-mcp.json"];
  if (platform === "linux") return ["/etc/claude-code/managed-mcp.json"];
  return [];
}

/** Check every managed settings location; the first conflict wins. Never throws. */
export function checkManagedPolicy(paths: JobManagedPaths): ManagedPolicyResult {
  if (paths.userUnknown) return { ok: false, detail: "managed_user_unknown" };
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
  const present = (p: string): boolean | "unreadable" => {
    try {
      statSync(p);
      return true;
    } catch (e) {
      return isMissing(e) ? false : "unreadable";
    }
  };
  for (const [list, detail] of [
    [paths.mcpFiles ?? [], "managed_mcp_file"],
    [paths.opaque, "managed_not_inspected"],
  ] as const) {
    for (const p of list) {
      const r = present(p);
      if (r === "unreadable") return { ok: false, detail: "managed_unreadable" };
      if (r) return { ok: false, detail };
    }
  }
  return { ok: true };
}
