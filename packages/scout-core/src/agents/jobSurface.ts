// The per-job tool surface: the strict MCP configuration a job's CLI loads, the exact
// allowed-tool list, and what its init event must therefore show.
//
// The input is a typed description, `{ servers, allowedTools }`: Scout's own server (`scout`:
// `node <scout-mcp dist/main.js> --socket <path> --token-file <path>`) and, when the user
// selected tools, the per-job forwarding bridge (toolPolicy.ts decides which).
//
// Availability is per tool. A `required` server must connect. Every tool of a required
// server must load unless it is listed in `optionalTools`; every tool of an optional server
// is optional. A missing optional tool is reported and the job goes on (initCheck.ts).
//
// Built-in tools, skill invocation and user hooks are off for jobs; claudeJob.ts sets the
// flags that do it (CLAUDE_JOB_FLAGS). This module only describes MCP tools.

import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { SERVER_NAME as SCOUT_SERVER_NAME, TOOL_NAMES as SCOUT_TOOL_NAMES } from "@scout/scout-mcp/tools";

export { SCOUT_SERVER_NAME, SCOUT_TOOL_NAMES };

/** The CLI's internal formatter for --json-schema; present whenever structured output is requested. */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const TOOL_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_SERVERS = 8;
const MAX_TOOLS_PER_SERVER = 64;

export interface JobServerSpec {
  /** The MCP server name the CLI registers (`mcp__<name>__<tool>`). */
  name: string;
  /** Absolute executable. */
  command: string;
  /** argv only; never interpolated into a shell. */
  args: readonly string[];
  /** Named environment bindings for the server, if any. */
  env?: Readonly<Record<string, string>>;
  /** Every tool the server advertises. The init event must list exactly these. */
  tools: readonly string[];
  /** A required server that fails to connect stops the job; an optional one is reported unavailable. */
  required: boolean;
  /** Tools of a required server that may be missing (reported, not fatal). Ignored for an optional server, whose tools all are. */
  optionalTools?: readonly string[];
}

export interface JobSurfaceSpec {
  servers: readonly JobServerSpec[];
  /** Exact `mcp__<server>__<tool>` names the job may call. No wildcards. */
  allowedTools: readonly string[];
}

export interface JobSurface {
  /** The `--mcp-config` document. */
  mcpConfig: { mcpServers: Record<string, { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }> };
  /** The `--allowedTools` value: exact names, comma-separated. */
  allowedToolsArg: string;
  allowedTools: ReadonlySet<string>;
  /** What the init event must show, per server, with full tool names. */
  expected: readonly ExpectedServer[];
}

export class JobSurfaceError extends Error {
  constructor(readonly code: "surface: invalid server" | "surface: invalid allowed tool" | "surface: too many servers") {
    super(code);
    this.name = "JobSurfaceError";
  }
}

export interface ExpectedServer {
  name: string;
  /** Full `mcp__<server>__<tool>` names. */
  tools: readonly string[];
  required: boolean;
  /** Full names of the tools that may be missing. */
  optionalTools: readonly string[];
}

export const mcpToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`;

export function buildJobSurface(spec: JobSurfaceSpec): JobSurface {
  if (spec.servers.length === 0 || spec.servers.length > MAX_SERVERS) throw new JobSurfaceError("surface: too many servers");
  const names = new Set<string>();
  const mcpServers: JobSurface["mcpConfig"]["mcpServers"] = {};
  const advertised = new Set<string>();
  const expected: ExpectedServer[] = [];
  for (const s of spec.servers) {
    const okShape =
      NAME_RE.test(s.name) &&
      !names.has(s.name) &&
      isAbsolute(s.command) &&
      s.args.every((a) => typeof a === "string" && !a.includes("\0")) &&
      s.tools.length > 0 &&
      s.tools.length <= MAX_TOOLS_PER_SERVER &&
      s.tools.every((t) => TOOL_RE.test(t)) &&
      new Set(s.tools).size === s.tools.length &&
      (s.optionalTools ?? []).every((t) => s.tools.includes(t));
    if (!okShape) throw new JobSurfaceError("surface: invalid server");
    names.add(s.name);
    const entry: JobSurface["mcpConfig"]["mcpServers"][string] = { type: "stdio", command: s.command, args: [...s.args] };
    if (s.env) entry.env = { ...s.env };
    mcpServers[s.name] = entry;
    const full = s.tools.map((t) => mcpToolName(s.name, t));
    for (const t of full) advertised.add(t);
    const optional = s.required ? (s.optionalTools ?? []).map((t) => mcpToolName(s.name, t)) : full;
    expected.push({ name: s.name, tools: full, required: s.required, optionalTools: optional });
  }
  const allowed = new Set<string>();
  for (const t of spec.allowedTools) {
    if (!advertised.has(t) || allowed.has(t)) throw new JobSurfaceError("surface: invalid allowed tool");
    allowed.add(t);
  }
  return { mcpConfig: { mcpServers }, allowedToolsArg: [...allowed].join(","), allowedTools: allowed, expected };
}

/** The built scout-mcp entrypoint (`dist/main.js`), resolved through the package export. */
export function defaultScoutMcpEntrypoint(): string {
  return createRequire(import.meta.url).resolve("@scout/scout-mcp/main");
}

export interface ScoutServerOptions {
  nodePath: string;
  entrypoint: string;
  socketPath: string;
  tokenFile: string;
}

/** Scout's own server for a job: required, all five read-only tools. */
export function scoutServerSpec(o: ScoutServerOptions): JobServerSpec {
  return {
    name: SCOUT_SERVER_NAME,
    command: o.nodePath,
    args: [o.entrypoint, "--socket", o.socketPath, "--token-file", o.tokenFile],
    tools: SCOUT_TOOL_NAMES,
    required: true,
  };
}
