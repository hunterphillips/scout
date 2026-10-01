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
// - `literalEnv` (optional) holds non-secret values stored in the definition itself, such
//   as PATH, HOME or LANG. Secrets belong in bindings; Scout does not judge a literal's
//   content, which is the user's declaration. A name may not be both a literal and a binding.
// - Names that inject code into a process (NODE_OPTIONS, DYLD_*, LD_*, interpreter startup
//   and library paths, ...) are refused as binding and literal names. The list is defence in
//   depth, not a complete inventory: the user's review of the definition is the control.
// - A selection is one tool on one connection: its name, the reviewed description and
//   input schema frozen at selection time with the schema's hash, whether the job needs it
//   (`required`), the user's declaration that it is suitable for unattended retrieval
//   (`unattendedReadDeclared: true`, required; Scout does not sandbox a server's internals),
//   and when it was selected. Tool names are unique across selections: the bridge
//   advertises each under its own name on one server.
//
// Errors carry fixed codes only: never a path, pointer or value.

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { PrivateFileError, readPrivateFile } from "./privateFile.js";

export const MAX_CONNECTIONS = 8;
export const MAX_SELECTIONS = 32;
export const MAX_ARGS = 32;
export const MAX_ARG_CHARS = 1024;
export const MAX_ENV_BINDINGS = 16;
export const MAX_LITERAL_ENV = 16;
export const MAX_LITERAL_ENV_CHARS = 4096;
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

/**
 * Exact names (compared upper-cased) that load code or options into a process, or point an
 * interpreter, loader or tool at other code. Defence in depth, not a complete inventory.
 */
const INJECTION_NAMES = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_EXTRA_CA_CERTS",
  "ELECTRON_RUN_AS_NODE",
  "PERL5LIB",
  "PERL5OPT",
  "PERLLIB",
  "PERL5DB",
  "RUBYOPT",
  "RUBYLIB",
  "GEM_HOME",
  "GEM_PATH",
  "BUNDLE_GEMFILE",
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
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
  "GLIBC_TUNABLES",
  "MALLOC_CHECK_",
  "GIT_CONFIG",
  "GIT_SSH_COMMAND",
  "GIT_EXEC_PATH",
]);
/**
 * Prefixes for the same: the dynamic loaders (macOS and Linux), bash exported functions, git
 * config injection (GIT_CONFIG_COUNT/KEY_n/VALUE_n, GIT_CONFIG_GLOBAL, ...), npm config
 * (npm reads `npm_config_*` in any case), and Python's startup variables.
 */
const INJECTION_PREFIXES = ["DYLD_", "LD_", "BASH_FUNC_", "GIT_CONFIG_", "NPM_CONFIG_", "PYTHON"];
/** PYTHON* names that only change output buffering or encoding. */
const PYTHON_ALLOWED = new Set(["PYTHONUNBUFFERED", "PYTHONIOENCODING", "PYTHONDONTWRITEBYTECODE"]);

/** Whether `name` may be a backend environment variable (bound or literal). */
export function isAllowedEnvName(name: string): boolean {
  if (!ENV_NAME_RE.test(name)) return false;
  const upper = name.toUpperCase();
  if (PYTHON_ALLOWED.has(upper)) return true;
  return !INJECTION_NAMES.has(upper) && !INJECTION_PREFIXES.some((p) => upper.startsWith(p));
}

export const absolutePath = z
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

const envNamesOk = (env: Record<string, unknown>, max: number): boolean => Object.keys(env).length <= max && Object.keys(env).every(isAllowedEnvName);

/** A connection's environment bindings: `{file, pointer}` per name, never values. */
export const EnvBindingsSchema = z.record(z.string(), EnvBindingSchema).refine((env) => envNamesOk(env, MAX_ENV_BINDINGS), { message: "env binding name refused" });

/** Non-secret literal values stored in the definition (PATH, HOME, LANG, ...). */
export const LiteralEnvSchema = z
  .record(
    z.string(),
    z
      .string()
      .max(MAX_LITERAL_ENV_CHARS)
      .refine((v) => !v.includes("\0")),
  )
  .refine((env) => envNamesOk(env, MAX_LITERAL_ENV), { message: "literal env name refused" });

/** The connection fields, without the cross-field check (zod refuses omit/pick on a refined object). */
export const ConnectionFields = z.strictObject({
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
  env: EnvBindingsSchema,
  literalEnv: LiteralEnvSchema.optional(),
});

/** A name may not be both bound and literal. */
export const envNamesDisjoint = (c: { env: Record<string, unknown>; literalEnv?: Record<string, string> | undefined }): boolean =>
  Object.keys(c.literalEnv ?? {}).every((n) => !Object.hasOwn(c.env, n));

export const ConnectionSchema = ConnectionFields.refine(envNamesDisjoint, { message: "env name both bound and literal" });
export type Connection = z.infer<typeof ConnectionSchema>;

/** Compare two strings by Unicode code point, not UTF-16 code unit. */
function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
    const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (d !== 0) return d;
  }
}

/**
 * Canonical JSON in the style of RFC 8785 (JCS): no whitespace; object keys sorted by Unicode
 * code point at every depth; numbers serialized as ES Number.prototype.toString (JCS's rule,
 * which JSON.stringify applies to finite numbers, -0 included); strings as JSON.stringify
 * escapes them. Non-finite numbers and values JSON cannot represent are refused (throws).
 * Undefined object members are omitted, as JSON.stringify does.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
      const o = value as Record<string, unknown>;
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort(compareCodePoints);
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError("canonicalJson: value not representable");
  }
}

/**
 * sha256 hex of a tool input schema's canonical JSON (canonicalJson). File-format
 * commitment: stored schema hashes depend on this exact serialization (RFC 8785 style), so
 * changing it invalidates every selection in every profile.
 */
export function schemaHash(inputSchema: unknown): string {
  return createHash("sha256").update(canonicalJson(inputSchema), "utf8").digest("hex");
}

const canonicalBytes = (v: unknown): number => {
  try {
    return Buffer.byteLength(canonicalJson(v), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const InputSchemaSchema = z
  .looseObject({ type: z.literal("object") })
  .refine((s) => canonicalBytes(s) <= MAX_SCHEMA_BYTES, { message: "input schema too large" });

/** The selection fields, without the hash check (zod refuses omit/pick on a refined object). */
export const ToolSelectionFields = z.strictObject({
  connectionId: z.string().regex(CONNECTION_ID_RE),
  toolName: z.string().regex(SELECTED_TOOL_RE),
  description: z.string().max(MAX_DESCRIPTION_CHARS),
  inputSchema: InputSchemaSchema,
  schemaHash: z.string().regex(/^[0-9a-f]{64}$/),
  required: z.boolean(),
  /** The user declared this operation suitable for unattended retrieval. Scout does not verify it. */
  unattendedReadDeclared: z.literal(true),
  selectedAt: z.iso.datetime(),
});

export const ToolSelectionSchema = ToolSelectionFields.refine((s) => schemaHash(s.inputSchema) === s.schemaHash, { message: "schemaHash does not match inputSchema" });
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

const BINDING_FILE_CODES = {
  missing: "binding: file missing",
  unreadable: "binding: file unreadable",
  not_regular: "binding: file not a private regular file owned by this user",
  not_private: "binding: file not a private regular file owned by this user",
  too_large: "binding: file too large",
} as const satisfies Record<string, BindingErrorCode>;

function readPrivateJson(path: string, fs: BindingFs): unknown {
  let buf: Buffer;
  try {
    buf = readPrivateFile(path, BINDING_FILE_MAX_BYTES, fs.getuid ? { private: true, getuid: fs.getuid } : { private: true });
  } catch (e) {
    throw new BindingError(e instanceof PrivateFileError ? BINDING_FILE_CODES[e.code] : "binding: file unreadable");
  }
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new BindingError("binding: file not JSON"); // the parse error may quote content
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
 * holds secret values: it may go only into the backend's environment at spawn, never to
 * disk (job files included), a profile, report, log, or the Claude process's environment.
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
