// The selected-tools part of `agent-profile.json` (field `tools`): which existing MCP tools
// the user explicitly chose for Scout's unattended jobs, and the reviewed local stdio
// definitions that serve them. P2.7's setup CLI writes it; this module is the schema plus
// pure helpers, and the in-memory resolution of environment bindings before a launch.
//
// - A connection is a reviewed local stdio server definition: an absolute executable, an
//   argv array (never a shell string) and named environment bindings. Only stdio exists;
//   cloud connectors, HTTP/SSE servers and plugin-managed auth are not representable.
// - A binding names a JSON file and a JSON pointer (RFC 6901) to a string value. The value
//   may be a literal in the user-owned definition file or a field of another JSON config
//   file the user explicitly selected; either way only `{file, pointer}` is stored here,
//   never the value. resolveEnvBindings reads the values in memory just before a launch:
//   each file must be a regular file owned by this user, mode 0600 or stricter, and at
//   most 4 MiB.
// - Names that inject code into a process (NODE_OPTIONS, DYLD_*, LD_*, interpreter startup
//   and library paths, ...) are refused as binding names.
// - A selection is one tool on one connection: its name, the reviewed description and
//   input schema frozen at selection time with the schema's hash, whether the job needs it
//   (`required`), the user's declaration that it is suitable for unattended retrieval
//   (`unattendedReadDeclared: true`, required; Scout does not sandbox a server's internals),
//   and when it was selected. Tool names are unique across selections: the bridge
//   advertises each under its own name on one server.
//
// Errors carry fixed codes only: never a path, pointer or value.

import { createHash } from "node:crypto";
import { closeSync, constants as fsc, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const MAX_CONNECTIONS = 8;
export const MAX_SELECTIONS = 32;
export const MAX_ARGS = 32;
export const MAX_ARG_CHARS = 1024;
export const MAX_ENV_BINDINGS = 16;
export const MAX_SCHEMA_BYTES = 8 * 1024;
export const MAX_DESCRIPTION_CHARS = 1024;
/** Read cap for a binding file. */
export const BINDING_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_BINDING_VALUE_CHARS = 32 * 1024;

export const CONNECTION_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** Same shape jobSurface.ts accepts for a tool name. */
export const SELECTED_TOOL_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const POINTER_RE = /^(?:\/(?:[^~/]|~[01])*)+$/;

/** Exact names that load code or options into a process. */
const INJECTION_NAMES = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_EXTRA_CA_CERTS",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONINSPECT",
  "PERL5LIB",
  "PERL5OPT",
  "PERLLIB",
  "RUBYOPT",
  "RUBYLIB",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "IFS",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "CLASSPATH",
  "GCONV_PATH",
  "MALLOC_CHECK_",
]);
/** Prefixes for the same: the dynamic loaders (macOS and Linux), and bash exported functions. */
const INJECTION_PREFIXES = ["DYLD_", "LD_", "BASH_FUNC_"];

/** Whether `name` may be a backend environment binding. */
export function isAllowedEnvName(name: string): boolean {
  if (!ENV_NAME_RE.test(name)) return false;
  const upper = name.toUpperCase();
  return !INJECTION_NAMES.has(upper) && !INJECTION_PREFIXES.some((p) => upper.startsWith(p));
}

const absolutePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => isAbsolute(p) && !p.includes("\0"));

export const EnvBindingSchema = z.strictObject({
  /** The user-owned JSON file holding the value (the definition file itself, or a selected config file). */
  file: absolutePath,
  /** RFC 6901 pointer to a string value in that file. */
  pointer: z.string().max(512).regex(POINTER_RE),
});
export type EnvBinding = z.infer<typeof EnvBindingSchema>;

export const ConnectionSchema = z.strictObject({
  id: z.string().regex(CONNECTION_ID_RE),
  transport: z.literal("stdio"),
  command: absolutePath,
  args: z
    .array(
      z
        .string()
        .max(MAX_ARG_CHARS)
        .refine((a) => !a.includes("\0")),
    )
    .max(MAX_ARGS),
  env: z
    .record(z.string(), EnvBindingSchema)
    .refine((env) => Object.keys(env).length <= MAX_ENV_BINDINGS && Object.keys(env).every(isAllowedEnvName), { message: "env binding name refused" }),
});
export type Connection = z.infer<typeof ConnectionSchema>;

/** Canonical JSON: object keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** sha256 hex of a tool input schema's canonical JSON. */
export function schemaHash(inputSchema: unknown): string {
  return createHash("sha256").update(canonicalJson(inputSchema), "utf8").digest("hex");
}

const InputSchemaSchema = z
  .looseObject({ type: z.literal("object") })
  .refine((s) => Buffer.byteLength(canonicalJson(s), "utf8") <= MAX_SCHEMA_BYTES, { message: "input schema too large" });

export const ToolSelectionSchema = z
  .strictObject({
    connectionId: z.string().regex(CONNECTION_ID_RE),
    toolName: z.string().regex(SELECTED_TOOL_RE),
    description: z.string().max(MAX_DESCRIPTION_CHARS),
    inputSchema: InputSchemaSchema,
    schemaHash: z.string().regex(/^[0-9a-f]{64}$/),
    required: z.boolean(),
    /** The user declared this operation suitable for unattended retrieval. Scout does not verify it. */
    unattendedReadDeclared: z.literal(true),
    selectedAt: z.iso.datetime(),
  })
  .refine((s) => schemaHash(s.inputSchema) === s.schemaHash, { message: "schemaHash does not match inputSchema" });
export type ToolSelection = z.infer<typeof ToolSelectionSchema>;

export const ToolsProfileSchema = z
  .strictObject({
    connections: z.array(ConnectionSchema).max(MAX_CONNECTIONS),
    selections: z.array(ToolSelectionSchema).max(MAX_SELECTIONS),
  })
  .superRefine((t, ctx) => {
    const ids = new Set<string>();
    for (const c of t.connections) {
      if (ids.has(c.id)) ctx.addIssue({ code: "custom", message: "duplicate connection id" });
      ids.add(c.id);
    }
    const names = new Set<string>();
    for (const s of t.selections) {
      if (!ids.has(s.connectionId)) ctx.addIssue({ code: "custom", message: "selection names an unknown connection" });
      if (names.has(s.toolName)) ctx.addIssue({ code: "custom", message: "duplicate selected tool name" });
      names.add(s.toolName);
    }
  });
export type ToolsProfile = z.infer<typeof ToolsProfileSchema>;

// ---------- binding resolution ----------

export type BindingErrorCode =
  | "binding: file missing"
  | "binding: file unreadable"
  | "binding: file not a private regular file owned by this user"
  | "binding: file too large"
  | "binding: file not JSON"
  | "binding: pointer not found"
  | "binding: value not a usable string"
  | "binding: name refused";

export class BindingError extends Error {
  constructor(readonly code: BindingErrorCode) {
    super(code); // fixed code only: never a path, pointer or value
    this.name = "BindingError";
  }
}

/** Seams for tests. */
export interface BindingFs {
  getuid?: () => number;
}

function readPrivateJson(path: string, fs: BindingFs): unknown {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new BindingError(code === "ENOENT" || code === "ENOTDIR" ? "binding: file missing" : "binding: file unreadable");
  }
  try {
    const st = fstatSync(fd);
    const uid = fs.getuid ?? process.getuid;
    const owned = typeof uid !== "function" || st.uid === uid();
    if (!st.isFile() || !owned || (st.mode & 0o077) !== 0) throw new BindingError("binding: file not a private regular file owned by this user");
    if (st.size > BINDING_FILE_MAX_BYTES) throw new BindingError("binding: file too large");
    // Read at most cap + 1 bytes, whatever the size said: the file may grow meanwhile.
    const buf = Buffer.alloc(BINDING_FILE_MAX_BYTES + 1);
    let n = 0;
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
      if (n > BINDING_FILE_MAX_BYTES) throw new BindingError("binding: file too large");
    }
    try {
      return JSON.parse(buf.subarray(0, n).toString("utf8"));
    } catch {
      throw new BindingError("binding: file not JSON"); // the parse error may quote content
    }
  } catch (e) {
    throw e instanceof BindingError ? e : new BindingError("binding: file unreadable");
  } finally {
    closeSync(fd);
  }
}

/** RFC 6901 lookup; own properties only. */
export function resolvePointer(doc: unknown, pointer: string): unknown {
  let cur = doc;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) {
      if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= cur.length) return undefined;
      cur = cur[Number(key)];
    } else if (cur !== null && typeof cur === "object" && Object.hasOwn(cur, key)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Resolve a connection's environment bindings in memory. Each file is read once. The result
 * holds secret values: it may go only into the job's private bridge file, never into a
 * profile, report, log, or the Claude process's environment.
 */
export function resolveEnvBindings(env: Readonly<Record<string, EnvBinding>>, fs: BindingFs = {}): Record<string, string> {
  const docs = new Map<string, unknown>();
  const out: Record<string, string> = {};
  for (const [name, b] of Object.entries(env)) {
    if (!isAllowedEnvName(name)) throw new BindingError("binding: name refused");
    if (!docs.has(b.file)) docs.set(b.file, readPrivateJson(b.file, fs));
    const v = resolvePointer(docs.get(b.file), b.pointer);
    if (v === undefined) throw new BindingError("binding: pointer not found");
    if (typeof v !== "string" || v.length > MAX_BINDING_VALUE_CHARS || v.includes("\0")) throw new BindingError("binding: value not a usable string");
    out[name] = v;
  }
  return out;
}
