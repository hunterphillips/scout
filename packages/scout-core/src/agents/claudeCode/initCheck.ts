// Check a job's streamed `system/init` event against what the job was launched with.
//
// The init event describes what the CLI loaded: MCP servers and their status, the tool
// list, permission mode, model and CLI version. It is an additional reason to stop, never
// the primary enforcement (that is the launch flags plus the exact allowed-tool list).
// How the CLI authenticates is the user's business; the stream is still watched for
// auth/quota failures afterwards.
//
// Outcomes map onto HostJobResult reasons:
//   - unsupported_configuration: an unexpected server or tool (a built-in tool means
//     `--tools ""` did not hold), permission mode not dontAsk, another model, or a malformed
//     event.
//   - tool_unavailable: a required server missing or not connected, or a required tool
//     missing. Availability is per tool: an optional tool that did not load (its server
//     failed, or the server connected without it, e.g. the bridge dropped it for a changed
//     schema) is reported unavailable by its full name and the job goes on; the tools of a
//     partially loaded optional server that did load stay usable and are reported available.
//
// Another CLI version than the readiness check saw (the CLI auto-updated) is advisory, not a
// failure: the result says `cliVersionChanged` and the adapter re-runs readiness before the
// job's answer counts (claudeJob.ts). VERIFIED_CLI_VERSION is a record of what the flag set
// was checked against, not an allowlist.

import { STRUCTURED_OUTPUT_TOOL, type ExpectedServer } from "./jobSurface.js";

export interface ExpectedInit {
  servers: readonly ExpectedServer[];
  model: string;
  /** The CLI version the preflight saw; absent if it could not tell. */
  cliVersion?: string;
}

export type InitFailureDetail =
  | "malformed_init"
  | "extra_server"
  | "extra_tool"
  | "permission_mode"
  | "model_mismatch"
  | "required_server_unavailable"
  | "required_tool_missing";

export type InitCheckResult =
  | {
      ok: true;
      /** Full names of optional tools that did not load. */
      optionalUnavailable: string[];
      model: string;
      cliVersion?: string;
      /** The init reported another CLI version than the preflight saw (or none). Advisory. */
      cliVersionChanged?: true;
    }
  | { ok: false; reason: "unsupported_configuration" | "tool_unavailable"; detail: InitFailureDetail };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);

export function checkInit(init: Rec, expected: ExpectedInit): InitCheckResult {
  const fail = (reason: "unsupported_configuration" | "tool_unavailable", detail: InitFailureDetail): InitCheckResult => ({
    ok: false,
    reason,
    detail,
  });
  const tools = init.tools;
  const servers = init.mcp_servers;
  if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string") || !Array.isArray(servers)) return fail("unsupported_configuration", "malformed_init");
  if (!servers.every((s) => isRec(s) && typeof s.name === "string" && typeof s.status === "string")) return fail("unsupported_configuration", "malformed_init");
  if (typeof init.model !== "string" || typeof init.permissionMode !== "string") return fail("unsupported_configuration", "malformed_init");

  const loaded = new Map((servers as { name: string; status: string }[]).map((s) => [s.name, s.status]));
  const byName = new Map(expected.servers.map((s) => [s.name, s]));
  if ([...loaded.keys()].some((n) => !byName.has(n)) || loaded.size !== servers.length) return fail("unsupported_configuration", "extra_server");

  const allowedTools = new Set<string>([STRUCTURED_OUTPUT_TOOL, ...expected.servers.flatMap((s) => s.tools)]);
  if ((tools as string[]).some((t) => !allowedTools.has(t))) return fail("unsupported_configuration", "extra_tool");
  if (init.permissionMode !== "dontAsk") return fail("unsupported_configuration", "permission_mode");
  if (init.model !== expected.model) return fail("unsupported_configuration", "model_mismatch");
  const version = typeof init.claude_code_version === "string" ? init.claude_code_version : undefined;
  const cliVersionChanged = expected.cliVersion !== undefined && version !== expected.cliVersion;

  const optionalUnavailable: string[] = [];
  const listed = new Set(tools as string[]);
  for (const s of expected.servers) {
    const connected = loaded.get(s.name) === "connected";
    if (!connected && s.required) return fail("tool_unavailable", "required_server_unavailable");
    const optional = new Set(s.optionalTools);
    for (const t of s.tools) {
      if (connected && listed.has(t)) continue;
      if (!optional.has(t)) return fail("tool_unavailable", "required_tool_missing");
      optionalUnavailable.push(t);
    }
  }
  const ok: InitCheckResult = { ok: true, optionalUnavailable, model: init.model };
  if (version !== undefined) ok.cliVersion = version;
  if (cliVersionChanged) ok.cliVersionChanged = true;
  return ok;
}
