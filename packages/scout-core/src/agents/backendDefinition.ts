// The user's stdio backend definition file and the one bounded inspection the setup CLI
// (profileCli.ts) may run against it.
//
// Definition file: user-owned JSON,
//   { "id": "<connection id>", "command": "/abs/exe", "args": [...],
//     "env": { NAME: "literal" | { "file": "/abs/config.json", "pointer": "/json/pointer" } },
//     "cwd"?: "/abs/dir" }
// validated strictly against toolProfile.ts's caps and name rules (process-injection names
// such as NODE_OPTIONS and DYLD_* are refused). It must be a regular file (not a symlink)
// owned by this user, not writable by group or others, at most 4 MiB. Literal values never
// reach the profile when the file is mode 0600: each becomes a
// `{file: <definition>, pointer: "/env/NAME"}` binding read at launch. A file readable by
// others may hold literals only for the names in LITERAL_ALLOWED_IN_READABLE_FILE (locale,
// paths, terminal and output settings); those are copied into the profile's non-secret
// `literalEnv`. Any other literal is refused with a request to chmod 600 the file.
//
// The command must be an absolute path to an executable file. Its real path, size and mtime
// are recorded (resolveCommand) so `status` can show when the binary behind the reviewed
// path changed (commandDrift).
//
// inspectBackend starts the backend once, with exactly the environment it is given, the
// definition's cwd (default `/`) and stderr discarded; runs MCP `initialize` (within
// `startupMs`) and `tools/list` (within `overallMs` from the start); then stops it the way a
// job's CLI is stopped: the backend is spawned detached, so it leads its own process
// group, under childSupervisor.ts; stop = stdin closed, SIGTERM to the group and to every
// tracked descendant that left it (ps-polled OwnedTree), SIGKILL to both after
// `stopGraceMs`, then a reap until nothing it owned is alive. So a backend that ignores
// SIGTERM and EOF, or starts helpers (in its group or escaped from it), cannot outlive the
// inspection. Only processes the backend owned are ever signalled. Being detached, the group
// misses the terminal's Ctrl-C: while it runs, SIGINT/SIGTERM/SIGHUP to this process SIGKILL
// the group and the escaped helpers a blocking ps pass finds, then the signal is re-raised.
//
// Decision (an auth prompt makes the connection unavailable; Scout never opens a hidden
// login flow): any request the backend makes of Scout during inspection (sampling,
// elicitation, roots, or any other server-to-client request) fails the whole inspection
// with the fixed code `auth_prompt`. The request is answered with an MCP error, never
// with data, the backend is stopped at once, and no tool it listed is returned: a backend
// that wants input to finish starting is not usable unattended, and its tool list cannot
// be trusted as the one it would serve after a login.
// Listed tools are kept as inspected-only records: names and descriptions with control
// characters are sanitized or skipped, and only a tool whose name and input schema fit the
// selection rules keeps its schema (and so can be selected later).
//
// Errors and outcomes carry field paths and fixed codes only: never a value.

import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, constants as fsc, fstatSync, readSync, openSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isExecutableFile } from "./executables.js";
import { BRIDGE_DEFAULT_LIMITS } from "./contextToolBridge.js";
import { startChild, type SupervisedChild } from "./childSupervisor.js";
import { ExactEnvStdioTransport } from "./exactEnvTransport.js";
import {
  absolutePath,
  BINDING_FILE_MAX_BYTES,
  CONNECTION_ID_RE,
  ENV_NAME_RE,
  EnvBindingSchema,
  InputSchemaSchema,
  isAllowedEnvName,
  MAX_ARG_CHARS,
  MAX_ARGS,
  MAX_BINDING_VALUE_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_ENV_BINDINGS,
  MAX_INSPECTED_NAME_CHARS,
  MAX_INSPECTED_TOOLS,
  MAX_LITERAL_ENV,
  MAX_LITERAL_ENV_CHARS,
  schemaHash,
  SELECTED_TOOL_RE,
  type Connection,
  type EnvBinding,
  type InspectedTool,
  type ResolvedCommand,
} from "./toolProfile.js";

/** Names that look like they hold a secret (used to warn about argv entries). */
export const SECRET_NAME_RE = /token|secret|key|pass|credential|auth/i;

const LITERAL_ALLOWED_NAMES = new Set(["LANG", "TZ", "PATH", "HOME", "TERM", "TMPDIR", "USER", "LOGNAME", "NO_COLOR", "PYTHONUNBUFFERED", "PYTHONIOENCODING"]);
const LITERAL_ALLOWED_PREFIXES = ["LC_", "XDG_"];

/** Whether a definition file readable by others may hold `name` as a literal (an allowlist, case-sensitive). */
export function literalAllowedInReadableFile(name: string): boolean {
  return LITERAL_ALLOWED_NAMES.has(name) || LITERAL_ALLOWED_PREFIXES.some((p) => name.startsWith(p) && name.length > p.length);
}

const noNul = (s: string): boolean => !s.includes("\0");

export const BackendDefinitionSchema = z.strictObject({
  id: z.string().regex(CONNECTION_ID_RE),
  command: absolutePath,
  args: z.array(z.string().max(MAX_ARG_CHARS).refine(noNul)).max(MAX_ARGS).optional(),
  env: z.record(z.string(), z.union([z.string().max(MAX_BINDING_VALUE_CHARS).refine(noNul), EnvBindingSchema])).optional(),
  cwd: absolutePath.optional(),
});

/** How one environment name is supplied, for review output (never a value). */
export type EnvEntry =
  | { name: string; kind: "literal_in_definition"; file: string; pointer: string }
  | { name: string; kind: "literal_in_profile" }
  | { name: string; kind: "binding"; file: string; pointer: string };

export interface BackendDefinition {
  /** The definition file's absolute path. */
  file: string;
  /** Whether the file is mode 0600 or stricter (literal values then stay in it). */
  private: boolean;
  /** The launch fields the profile stores: bindings and non-secret literals, never secret values. */
  connection: Pick<Connection, "id" | "transport" | "command" | "args" | "env" | "literalEnv" | "cwd">;
  envEntries: EnvEntry[];
  resolvedCommand: ResolvedCommand;
  /** Every file a launch reads (bindings' files, the definition file when it holds literals). */
  filesRead: string[];
}

export type DefinitionResult = { ok: true; definition: BackendDefinition } | { ok: false; errors: string[] };

export interface DefinitionFs {
  getuid?: () => number;
}

/** A path for messages: only word characters, dots and dashes of each zod path segment. */
const fieldPath = (path: readonly PropertyKey[]): string => path.map((p) => String(p).replace(/[^\w.-]/g, "?")).join(".") || "(root)";

function readOwnedFile(path: string, fs: DefinitionFs): { ok: true; text: string; mode: number } | { ok: false; error: string } {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, error: code === "ENOENT" || code === "ENOTDIR" ? "definition: file not found" : "definition: file unreadable (a symlink is refused)" };
  }
  try {
    const st = fstatSync(fd);
    const uid = fs.getuid ?? process.getuid;
    if (!st.isFile() || (typeof uid === "function" && st.uid !== uid())) return { ok: false, error: "definition: must be a regular file you own" };
    if ((st.mode & 0o022) !== 0) return { ok: false, error: "definition: writable by group or others (chmod go-w it, or chmod 600 it)" };
    if (st.size > BINDING_FILE_MAX_BYTES) return { ok: false, error: "definition: file larger than 4 MiB" };
    const buf = Buffer.alloc(BINDING_FILE_MAX_BYTES + 1);
    let n = 0;
    for (let r = readSync(fd, buf, 0, buf.length, null); r > 0; r = readSync(fd, buf, n, buf.length - n, null)) {
      n += r;
      if (n > BINDING_FILE_MAX_BYTES) return { ok: false, error: "definition: file larger than 4 MiB" };
    }
    return { ok: true, text: buf.subarray(0, n).toString("utf8"), mode: st.mode & 0o777 };
  } catch {
    return { ok: false, error: "definition: file unreadable" };
  } finally {
    closeSync(fd);
  }
}

/** The command's real path, size and mtime, when it is an executable regular file. */
export function resolveCommand(command: string): ResolvedCommand | undefined {
  try {
    const path = realpathSync(command);
    if (!isExecutableFile(path)) return undefined;
    const st = statSync(path);
    return { path, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

export type CommandDrift = "same" | "changed" | "missing" | "unrecorded";

/** Whether the binary behind `command` is still the one inspected. */
export function commandDrift(command: string, recorded: ResolvedCommand | undefined): CommandDrift {
  const now = resolveCommand(command);
  if (!now) return "missing";
  if (!recorded) return "unrecorded";
  return now.path === recorded.path && now.size === recorded.size && now.mtimeMs === recorded.mtimeMs ? "same" : "changed";
}

/** Read and validate a definition file. `path` must be absolute. */
export function loadBackendDefinition(path: string, fs: DefinitionFs = {}): DefinitionResult {
  if (!isAbsolute(path) || path.includes("\0")) return { ok: false, errors: ["definition: path must be absolute"] };
  const read = readOwnedFile(path, fs);
  if (!read.ok) return { ok: false, errors: [read.error] };
  let json: unknown;
  try {
    json = JSON.parse(read.text);
  } catch {
    return { ok: false, errors: ["definition: not JSON"] }; // the parse error may quote content
  }
  const parsed = BackendDefinitionSchema.safeParse(json);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `definition: ${fieldPath(i.path)}: invalid`) };
  const def = parsed.data;
  const isPrivate = (read.mode & 0o077) === 0;
  const errors: string[] = [];

  const env: Record<string, EnvBinding> = {};
  const literalEnv: Record<string, string> = {};
  const envEntries: EnvEntry[] = [];
  for (const [name, v] of Object.entries(def.env ?? {})) {
    if (!ENV_NAME_RE.test(name)) {
      errors.push("definition: env: invalid variable name");
      continue;
    }
    if (!isAllowedEnvName(name)) {
      errors.push(`definition: env.${name}: refused (it can inject code into the backend process)`);
      continue;
    }
    if (typeof v !== "string") {
      env[name] = { file: v.file, pointer: v.pointer };
      envEntries.push({ name, kind: "binding", file: v.file, pointer: v.pointer });
    } else if (isPrivate) {
      env[name] = { file: path, pointer: `/env/${name}` };
      envEntries.push({ name, kind: "literal_in_definition", file: path, pointer: `/env/${name}` });
    } else if (!literalAllowedInReadableFile(name)) {
      errors.push(`definition: env.${name}: a literal value is allowed in a file others can read only for locale, path and terminal settings; chmod 600 the definition file to keep it there`);
    } else if (v.length > MAX_LITERAL_ENV_CHARS) {
      errors.push(`definition: env.${name}: literal longer than ${MAX_LITERAL_ENV_CHARS} characters (chmod 600 the file to keep it there)`);
    } else {
      literalEnv[name] = v;
      envEntries.push({ name, kind: "literal_in_profile" });
    }
  }
  if (Object.keys(env).length > MAX_ENV_BINDINGS) errors.push(`definition: env: more than ${MAX_ENV_BINDINGS} values read from files`);
  if (Object.keys(literalEnv).length > MAX_LITERAL_ENV) errors.push(`definition: env: more than ${MAX_LITERAL_ENV} literals`);

  const resolvedCommand = resolveCommand(def.command);
  if (!resolvedCommand) errors.push("definition: command: not an executable file");
  if (def.cwd !== undefined) {
    let dir = false;
    try {
      dir = statSync(def.cwd).isDirectory();
    } catch {
      // reported below
    }
    if (!dir) errors.push("definition: cwd: not a directory");
  }
  if (errors.length > 0 || !resolvedCommand) return { ok: false, errors };

  const connection: BackendDefinition["connection"] = { id: def.id, transport: "stdio", command: def.command, args: def.args ?? [], env };
  if (Object.keys(literalEnv).length > 0) connection.literalEnv = literalEnv;
  if (def.cwd !== undefined) connection.cwd = def.cwd;
  const filesRead = [...new Set(Object.values(env).map((b) => b.file))];
  return { ok: true, definition: { file: path, private: isPrivate, connection, envEntries, resolvedCommand, filesRead } };
}

// ---------- inspection ----------

export interface InspectLimits {
  /** Spawn + MCP initialize. */
  startupMs: number;
  /** Start to the end of tools/list. */
  overallMs: number;
  /** SIGTERM to SIGKILL. */
  stopGraceMs: number;
}

export const INSPECT_DEFAULT_LIMITS: Readonly<InspectLimits> = Object.freeze({ startupMs: BRIDGE_DEFAULT_LIMITS.startupMs, overallMs: 10_000, stopGraceMs: 2000 });

const MAX_LISTED_PAGES = 8;

export type InspectOutcome =
  | {
      ok: true;
      tools: InspectedTool[];
      /** Tools not stored: unusable names, duplicates, or past MAX_INSPECTED_TOOLS. */
      skipped: number;
      /** Descriptions cut to MAX_DESCRIPTION_CHARS. */
      truncated: number;
    }
  /** `auth_prompt`: the backend made a request of Scout (sampling, elicitation, roots, ...). */
  | { ok: false; reason: InspectFailure };

export type InspectFailure = "did_not_start" | "timed_out" | "list_failed" | "auth_prompt";

/** Control characters out (newlines and tabs kept), for a stored description. */
const stripControls = (s: string): string => s.replace(/[^\P{Cc}\n\t]/gu, "");

/** One listed tool as an inspected-only record, or undefined when its name cannot be stored. */
export function toInspectedTool(t: Pick<Tool, "name" | "description" | "inputSchema">): { tool: InspectedTool; truncated: boolean } | undefined {
  const name = t.name;
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_INSPECTED_NAME_CHARS || /\p{Cc}/u.test(name)) return undefined;
  const full = stripControls(typeof t.description === "string" ? t.description : "");
  const description = full.slice(0, MAX_DESCRIPTION_CHARS);
  const truncated = full.length > description.length;
  if (!SELECTED_TOOL_RE.test(name)) return { tool: { name, description, unselectable: "name_not_supported" }, truncated };
  if (!InputSchemaSchema.safeParse(t.inputSchema).success) return { tool: { name, description, unselectable: "schema_not_supported" }, truncated };
  return { tool: { name, description, inputSchema: t.inputSchema, schemaHash: schemaHash(t.inputSchema) }, truncated };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), Math.max(ms, 1))))]).finally(() => clearTimeout(timer));
}

/**
 * Start the backend once with exactly `env`, list its tools, stop it. `env` holds resolved
 * values: it goes to the spawn only.
 */
export async function inspectBackend(launch: Pick<Connection, "command" | "args" | "cwd">, env: Readonly<Record<string, string>>, limits: InspectLimits = INSPECT_DEFAULT_LIMITS): Promise<InspectOutcome> {
  let supervised: SupervisedChild | undefined;
  const transport = new ExactEnvStdioTransport(launch.command, launch.args, env, launch.cwd ?? "/", {
    signalOnClose: false,
    spawn: (command, args, options) => (supervised = startChild({ spawn: nodeSpawn, command, args, options, killGraceMs: limits.stopGraceMs })).child,
  });
  // The backend's detached group no longer gets the terminal's Ctrl-C, so a signal that ends
  // this CLI first kills the backend's group and its escaped helpers, then is re-raised.
  const onSignal = (signal: NodeJS.Signals): void => {
    removeSignalHandlers();
    supervised?.killAllSync();
    process.kill(process.pid, signal);
  };
  const removeSignalHandlers = (): void => {
    for (const sig of INSPECT_SIGNALS) process.off(sig, onSignal);
  };
  for (const sig of INSPECT_SIGNALS) process.on(sig, onSignal);
  const client = new Client({ name: "scout-setup", version: "0" }, { capabilities: {} });
  // The first backend request fails the inspection (see the header): `prompted` rejects,
  // which ends whichever stage is waiting, and the request itself gets an error reply.
  let promptedReject: (e: Error) => void = () => {};
  const prompted = new Promise<never>((_, reject) => (promptedReject = reject));
  prompted.catch(() => {});
  let askedForInput = false;
  client.fallbackRequestHandler = async () => {
    askedForInput = true;
    promptedReject(new Error("auth_prompt"));
    throw new McpError(ErrorCode.MethodNotFound, "refused by Scout setup");
  };
  const unlessPrompted = <T>(p: Promise<T>): Promise<T> => Promise.race([p, prompted]);
  client.fallbackNotificationHandler = async () => {};
  client.onerror = () => {};
  const started = Date.now();
  let stage: "did_not_start" | "list_failed" = "did_not_start";
  try {
    await withTimeout(unlessPrompted(client.connect(transport)), limits.startupMs);
    stage = "list_failed";
    const listAll = async (): Promise<Tool[]> => {
      const out: Tool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LISTED_PAGES; page++) {
        const r = await client.listTools(cursor === undefined ? {} : { cursor });
        out.push(...r.tools);
        cursor = r.nextCursor;
        if (cursor === undefined) break;
      }
      return out;
    };
    const listed = await withTimeout(unlessPrompted(listAll()), limits.overallMs - (Date.now() - started));
    if (askedForInput) return { ok: false, reason: "auth_prompt" };
    const tools: InspectedTool[] = [];
    let skipped = 0;
    let truncated = 0;
    for (const t of listed) {
      const r = toInspectedTool(t);
      if (!r || tools.some((x) => x.name === r.tool.name) || tools.length >= MAX_INSPECTED_TOOLS) {
        skipped++;
        continue;
      }
      tools.push(r.tool);
      if (r.truncated) truncated++;
    }
    return { ok: true, tools, skipped, truncated };
  } catch (e) {
    if (askedForInput) return { ok: false, reason: "auth_prompt" };
    return { ok: false, reason: e instanceof Error && e.message === "timeout" ? "timed_out" : stage };
  } finally {
    try {
      await stopBackend(client, supervised);
    } finally {
      removeSignalHandlers();
    }
  }
}

/** Signals that end `agent inspect|refresh` while a backend is running (see inspectBackend). */
const INSPECT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Record the tree, end stdin, then the job stop: group + escaped descendants SIGTERM → grace →
 * SIGKILL, reap. The ps pass before stdin ends sees every helper while its parent is alive, so
 * one that escaped the group is still known after a backend that exits on EOF is gone.
 */
async function stopBackend(client: Client, supervised: SupervisedChild | undefined): Promise<void> {
  if (supervised) await supervised.observe();
  await client.close().catch(() => {}); // stdin end only (signalOnClose: false)
  if (!supervised) return;
  try {
    supervised.terminate();
    await supervised.waitExit();
    await supervised.reap();
  } finally {
    supervised.dispose();
  }
}
