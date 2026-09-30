// Service configuration: <home>/config.json, where <home> is ~/.personal-context-mcp or
// PERSONAL_CONTEXT_HOME.
//
// The service owns this file. Scout's setup only merges `nodePath`, `claudePath` and
// `x_scout_marker` into it, so the loader keeps unknown keys and fills defaults for every
// missing one. Sources are grants: every default source ships disabled, and the
// always-excluded list below applies whatever the config says.
//
// <home> follows the private-directory house style (scout-core's ensurePrivateRunDir): a
// real directory, owned by us, mode 0700 or tighter. It is created 0700 when missing and
// an existing one is never chmod'ed; anything else is refused with a fixed code.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsc,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { MAX_DEADLINE_MS } from "./api.js";
import { MODEL_RE } from "./model.js";
import { isInside } from "./paths.js";

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Largest config file the loader reads. */
export const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * ~/.personal-context-mcp, or PERSONAL_CONTEXT_HOME when set (same convention as
 * SCOUT_HOME). A relative PERSONAL_CONTEXT_HOME (or HOME) is refused: it would depend
 * on the cwd.
 */
export function resolveHome(env: EnvLike = process.env): string {
  const home = env.PERSONAL_CONTEXT_HOME || join(env.HOME || homedir(), ".personal-context-mcp");
  if (!isAbsolute(home)) throw new ConfigError("config-relative-home");
  return home;
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

export type ConfigErrorCode =
  | "config-relative-home"
  | "config-home-symlink"
  | "config-home-not-directory"
  | "config-home-wrong-owner"
  | "config-home-not-private"
  | "config-home-unusable"
  | "config-unreadable"
  | "config-too-large"
  | "config-malformed"
  | "config-invalid"
  | "config-duplicate-source-id"
  | "config-relative-source-path"
  | "config-source-root-too-broad"
  | "config-write-failed";

/** Carries a fixed code and, for `config-invalid`, the top-level key at fault. Never a path or value. */
export class ConfigError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    readonly field?: string,
  ) {
    super(field === undefined ? code : `${code}: ${field}`);
    this.name = "ConfigError";
  }
}

// ---------- on-disk schema ----------

const pathString = z.string().min(1);

/** Source ids: lowercase, digits and `-`, starting with a letter or digit, at most 64 chars. */
export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const sourceId = z.string().regex(SOURCE_ID_RE);

/** A path inside a project: relative, no leading `/`, and no empty, `.` or `..` segment. */
export function isSafeSubpath(p: string): boolean {
  if (p.length === 0 || p.includes("\0") || isAbsolute(p) || p.startsWith("/") || p.startsWith("\\")) return false;
  return !p.split(/[\\/]/).some((seg) => seg === "" || seg === "." || seg === "..");
}

/** One plain directory name: letters, digits, `.`, `_`, `-`; never `.` or `..`. */
const PROJECT_NAME_RE = /^[A-Za-z0-9._-]+$/;
const projectName = z.string().regex(PROJECT_NAME_RE).refine((n) => n !== "." && n !== "..");

/** `http://127.0.0.1:<port>/...` or `http://localhost:<port>/...`, explicit port, no credentials. */
export function isLoopbackFocusUrl(v: string): boolean {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  return (
    u.protocol === "http:" &&
    (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
    u.port !== "" &&
    u.username === "" &&
    u.password === ""
  );
}

const MarkdownDirSourceSchema = z.looseObject({
  id: sourceId,
  kind: z.literal("markdown_dir"),
  enabled: z.boolean(),
  root: pathString,
  exclude: z.array(z.string()).default([]),
  /** `task_recall` marks recall material (saved lists), not stated priorities. */
  purpose: z.literal("task_recall").optional(),
});

const RegistryProjectsSourceSchema = z.looseObject({
  id: sourceId,
  kind: z.literal("registry_projects"),
  enabled: z.boolean(),
  /** Directory of notes whose `repo:` frontmatter maps projects. A map only: not itself readable. */
  registry: pathString,
  /** Path inside each enabled project that becomes readable. */
  subpath: z.string().min(1).refine(isSafeSubpath),
  /** A project is readable only once it is named here. Each entry is one plain directory name. */
  enabledProjects: z.array(projectName).default([]),
});

const FocusHttpSourceSchema = z.looseObject({
  id: sourceId,
  kind: z.literal("focus_http"),
  enabled: z.boolean(),
  /** Loopback only: see isLoopbackFocusUrl. */
  url: z.string().max(2048).refine(isLoopbackFocusUrl),
});

export const SourceConfigSchema = z.discriminatedUnion("kind", [
  MarkdownDirSourceSchema,
  RegistryProjectsSourceSchema,
  FocusHttpSourceSchema,
]);

export type SourceConfig = z.infer<typeof SourceConfigSchema>;
export type MarkdownDirSource = z.infer<typeof MarkdownDirSourceSchema>;
export type RegistryProjectsSource = z.infer<typeof RegistryProjectsSourceSchema>;
export type FocusHttpSource = z.infer<typeof FocusHttpSourceSchema>;

export const DEFAULT_PORT = 47821;

/** Every default source ships disabled; setup never enables anything. */
export const DEFAULT_SOURCES: readonly SourceConfig[] = Object.freeze([
  { id: "second-brain-notes", kind: "markdown_dir", enabled: false, root: "~/workspace/second-brain/notes", exclude: [] },
  {
    id: "project-thoughts",
    kind: "registry_projects",
    enabled: false,
    registry: "~/workspace/second-brain/notes",
    subpath: "thoughts/shared",
    enabledProjects: [],
  },
  { id: "focus", kind: "focus_http", enabled: false, url: "http://127.0.0.1:4242/api/focus" },
]);

const absolutePath = z.string().refine((p) => isAbsolute(p));

/** Field-by-field so an error can name the top-level key. Unknown top-level keys are kept. */
const FIELD_SCHEMAS = {
  port: z.int().min(1).max(65_535),
  /** `null`: no `--model` flag, so Hunter's normal Claude Code choice applies. */
  model: z.string().regex(MODEL_RE).nullable(),
  maxRankMs: z.int().min(1).max(MAX_DEADLINE_MS),
  nodePath: absolutePath,
  claudePath: absolutePath,
  sources: z.array(SourceConfigSchema),
} as const;

/** The file as stored: defaults filled, `~` left unexpanded, unknown keys kept. */
export interface ConfigFile {
  port: number;
  model: string | null;
  maxRankMs: number;
  nodePath?: string;
  claudePath?: string;
  sources: SourceConfig[];
  [unknownKey: string]: unknown;
}

function defaultConfigFile(): ConfigFile {
  return {
    port: DEFAULT_PORT,
    model: null,
    maxRankMs: MAX_DEADLINE_MS,
    sources: structuredClone(DEFAULT_SOURCES) as SourceConfig[],
  };
}

/** Keys that could reach an object's prototype when assigned. Dropped at every depth. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_JSON_DEPTH = 64;

/**
 * A copy of a JSON-shaped value made only of own enumerable data, with `__proto__`,
 * `constructor` and `prototype` keys dropped at every depth. Too deep: config-malformed.
 */
function sanitizeJson(v: unknown, depth = 0): unknown {
  if (depth > MAX_JSON_DEPTH) throw new ConfigError("config-malformed");
  if (Array.isArray(v)) return v.map((x) => sanitizeJson(x, depth + 1));
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (!UNSAFE_KEYS.has(k)) out[k] = sanitizeJson(x, depth + 1);
    }
    return out;
  }
  return v;
}

/** Validate a parsed JSON value as a config file, filling defaults. Throws ConfigError. */
export function parseConfigFile(value: unknown): ConfigFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ConfigError("config-malformed");
  const input = sanitizeJson(value) as Record<string, unknown>;
  const out: ConfigFile = { ...defaultConfigFile() };
  for (const [key, v] of Object.entries(input)) {
    if (!Object.hasOwn(FIELD_SCHEMAS, key)) {
      out[key] = v; // unknown keys (x_scout_marker, ...) are kept as-is
      continue;
    }
    const r = FIELD_SCHEMAS[key as keyof typeof FIELD_SCHEMAS].safeParse(v);
    if (!r.success) throw new ConfigError("config-invalid", key);
    out[key] = r.data;
  }
  const ids = out.sources.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw new ConfigError("config-duplicate-source-id");
  return out;
}

/**
 * Check <home> against the house style. Returns false when it does not exist; throws
 * ConfigError when it exists but is a symlink, not a directory, not ours, or has any
 * group/other mode bit. Never changes it.
 */
function checkPrivateHome(home: string, uid: number): boolean {
  let st;
  try {
    st = lstatSync(home);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ConfigError("config-home-unusable");
  }
  if (st.isSymbolicLink()) throw new ConfigError("config-home-symlink");
  if (!st.isDirectory()) throw new ConfigError("config-home-not-directory");
  if (st.uid !== uid) throw new ConfigError("config-home-wrong-owner");
  if ((st.mode & 0o077) !== 0) throw new ConfigError("config-home-not-private");
  return true;
}

/** Create <home> 0700 when missing, then check it. An existing directory is never chmod'ed. */
function ensurePrivateHome(home: string, uid: number): void {
  if (checkPrivateHome(home, uid)) return;
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  } catch {
    throw new ConfigError("config-home-unusable");
  }
  if (!checkPrivateHome(home, uid)) throw new ConfigError("config-home-unusable");
}

/** Read the file without following a symlink, refusing anything over MAX_CONFIG_BYTES. `undefined`: no file. */
function readBoundedConfig(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError("config-unreadable");
  }
  try {
    let size: number;
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new Error();
      size = st.size;
    } catch {
      throw new ConfigError("config-unreadable");
    }
    if (size > MAX_CONFIG_BYTES) throw new ConfigError("config-too-large");
    // Read one byte past the cap so a file that grew after fstat is still caught.
    const buf = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let len = 0;
    try {
      for (;;) {
        const n = readSync(fd, buf, len, buf.length - len, null);
        if (n === 0) break;
        len += n;
        if (len > MAX_CONFIG_BYTES) throw new ConfigError("config-too-large");
      }
    } catch (e) {
      throw e instanceof ConfigError ? e : new ConfigError("config-unreadable");
    }
    return buf.subarray(0, len).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Read <home>/config.json. A missing home or file means all defaults. A home that fails
 * the house-style check, or a file that is a symlink, unreadable, over 1 MiB, not JSON,
 * or has a malformed known field is a ConfigError, not a fallback.
 */
export function readConfigFile(home: string, uid: number = process.getuid?.() ?? -1): ConfigFile {
  if (!checkPrivateHome(home, uid)) return defaultConfigFile();
  const raw = readBoundedConfig(configPath(home));
  if (raw === undefined) return defaultConfigFile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("config-malformed"); // the parse error may quote content: dropped
  }
  return parseConfigFile(parsed);
}

/**
 * Write <home>/config.json atomically (temp file, fsync, rename) with mode 0600, creating
 * <home> as 0700 if needed. The file is validated and resolved first, so it never saves
 * a config loadConfig would reject; unknown keys are written back.
 */
export function writeConfig(
  home: string,
  file: ConfigFile,
  env: EnvLike = process.env,
  uid: number = process.getuid?.() ?? -1,
): void {
  const valid = parseConfigFile(file);
  resolveConfig(valid, env);
  const text = JSON.stringify(valid, null, 2) + "\n";
  const target = configPath(home);
  const tmp = join(home, `.config.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  ensurePrivateHome(home, uid);
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch {
    rmSync(tmp, { force: true });
    throw new ConfigError("config-write-failed");
  }
}

// ---------- resolved config ----------

/** A source with `root` / `registry` expanded to an absolute path. */
export type ResolvedSource = SourceConfig;

/** The config the service runs on: `~` expanded, every source path absolute. */
export interface PcmConfig {
  port: number;
  /** `null`: no `--model` flag. */
  model: string | null;
  maxRankMs: number;
  nodePath?: string;
  claudePath?: string;
  sources: ResolvedSource[];
}

/** Expand a leading `~` against HOME. Returns an absolute, normalized path or throws. */
export function expandHomePath(p: string, env: EnvLike = process.env): string {
  const home = env.HOME || homedir();
  const expanded = p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
  if (!isAbsolute(expanded)) throw new ConfigError("config-relative-source-path");
  return resolve(expanded);
}

/** Case-folded, NFC-normalized form for comparisons that must hold on a case-insensitive disk. */
function fold(p: string): string {
  return p.normalize("NFC").toLowerCase();
}

/**
 * A source root (or registry) must lie strictly inside $HOME or elsewhere below `/`:
 * never `/`, never $HOME itself, never an ancestor of $HOME. Compared case-insensitively.
 */
function sourceLocation(p: string, env: EnvLike): string {
  const abs = expandHomePath(p, env);
  if (isTooBroadRoot(abs, env.HOME || homedir())) throw new ConfigError("config-source-root-too-broad");
  return abs;
}

/**
 * The too-broad rule on an absolute path: true for `/`, for `home` itself, and for any
 * ancestor of `home`. Compared case-insensitively after NFC normalization. A relative
 * path or home fails closed (too broad).
 */
export function isTooBroadRoot(absPath: string, home: string): boolean {
  if (!isAbsolute(absPath) || !isAbsolute(home)) return true;
  const abs = resolve(absPath);
  return abs === resolve("/") || isInside(fold(resolve(home)), fold(abs));
}

export function resolveConfig(file: ConfigFile, env: EnvLike = process.env): PcmConfig {
  const sources = file.sources.map((s): ResolvedSource => {
    if (s.kind === "markdown_dir") return { ...s, root: sourceLocation(s.root, env) };
    if (s.kind === "registry_projects") return { ...s, registry: sourceLocation(s.registry, env) };
    return { ...s };
  });
  const out: PcmConfig = { port: file.port, model: file.model, maxRankMs: file.maxRankMs, sources };
  if (file.nodePath !== undefined) out.nodePath = file.nodePath;
  if (file.claudePath !== undefined) out.claudePath = file.claudePath;
  return out;
}

/** readConfigFile then resolveConfig. */
export function loadConfig(home: string, env: EnvLike = process.env, uid: number = process.getuid?.() ?? -1): PcmConfig {
  return resolveConfig(readConfigFile(home, uid), env);
}

// ---------- grants ----------

/**
 * A short hash of the enabled sources only: ids, kinds, locations (root, registry +
 * subpath, url), excludes, enabled projects and purpose. Disabled sources, the port, the
 * model and unknown keys do not change it. Order-insensitive.
 */
export function sourceGrantRevision(config: Pick<PcmConfig, "sources">): string {
  const grants = config.sources
    .filter((s) => s.enabled)
    .map((s) => {
      if (s.kind === "markdown_dir") {
        return { id: s.id, kind: s.kind, root: s.root, exclude: [...s.exclude].sort(), purpose: s.purpose ?? null };
      }
      if (s.kind === "registry_projects") {
        return { id: s.id, kind: s.kind, registry: s.registry, subpath: s.subpath, enabledProjects: [...s.enabledProjects].sort() };
      }
      return { id: s.id, kind: s.kind, url: s.url };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash("sha256").update(canonicalJson(grants)).digest("hex").slice(0, 16);
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

// ---------- always excluded ----------
//
// Task 2's source tools must gate every read with checkReadable, never with
// isAlwaysExcluded alone: only checkReadable resolves symlinks and on-disk spelling.

/** Directory names excluded wherever they appear as a path segment (compared case-folded). */
const EXCLUDED_SEGMENTS = new Set([".git", "node_modules", ".ssh", ".gnupg", "keychains", ".netrc", ".npmrc"]);

/** Name patterns excluded wherever they appear (any segment, case-insensitive). */
const EXCLUDED_NAME_PATTERNS: readonly RegExp[] = [
  /^\.env/i, // .env, .env.local, ...
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /secret/i,
  /token/i,
  /credential/i,
];

/** Name patterns excluded on the final segment only (files such as SSH keys). */
const EXCLUDED_FILE_PATTERNS: readonly RegExp[] = [/^id_/i];

/** Top-level directories excluded under a second-brain root (compared case-folded). */
const SECOND_BRAIN_EXCLUDED = new Set(["inbox", "log"]);

function isExcludedName(seg: string, isLast: boolean): boolean {
  const f = fold(seg);
  if (EXCLUDED_SEGMENTS.has(f)) return true;
  if (EXCLUDED_NAME_PATTERNS.some((re) => re.test(f))) return true;
  return isLast && EXCLUDED_FILE_PATTERNS.some((re) => re.test(f));
}

function isSecondBrainRoot(root: string): boolean {
  const parts = fold(root).split(sep).filter(Boolean);
  const last = parts.at(-1);
  const prev = parts.at(-2);
  return last === "second-brain" || (last === "notes" && prev === "second-brain");
}

export interface ExclusionOptions {
  /** Defaults to HOME from the environment. */
  home?: string;
  /** Defaults to <home>/workspace/personal-context. */
  personalContextDir?: string;
  /** This service's own home when it is not <home>/.personal-context-mcp (e.g. PERSONAL_CONTEXT_HOME). */
  serviceHome?: string;
}

/** Directories excluded by absolute path, whatever the source root. */
function absoluteExcludedDirs(home: string, opts: ExclusionOptions): string[] {
  const brain = join(home, "workspace", "second-brain");
  const dirs = [
    opts.personalContextDir ?? join(home, "workspace", "personal-context"),
    ...[...SECOND_BRAIN_EXCLUDED].map((n) => join(brain, n)),
    join(home, ".personal-context-mcp"),
  ];
  if (opts.serviceHome !== undefined) dirs.push(opts.serviceHome);
  return dirs.map((d) => resolve(d));
}

/**
 * Whether a path is excluded whatever the config says. Lexical only: callers reading
 * files must use checkReadable. Fails closed (excluded) when either path or HOME is not
 * absolute. Excluded:
 * - anything not inside `sourceRoot`;
 * - everything under ~/workspace/personal-context/ (the private profile store), under
 *   ~/workspace/second-brain/inbox/ and ~/workspace/second-brain/log/, and under
 *   ~/.personal-context-mcp/ (this service's own home), by absolute path whatever the
 *   source root, compared case-insensitively after NFC normalization;
 * - any segment named `.git`, `node_modules`, `.ssh`, `.gnupg`, `Keychains`, `.netrc`,
 *   `.npmrc`, or matching `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*secret*`,
 *   `*token*`, `*credential*`, and a final segment matching `id_*` (all case-insensitive,
 *   so a `secrets/` directory hides its whole subtree). The source root's own last
 *   segment counts too, so a root named `secrets` is excluded entirely;
 * - when the source root is a second-brain root (its last segments are `second-brain` or
 *   `second-brain/notes`), a first segment under it named `inbox` or `log` (covers a second
 *   brain living somewhere other than ~/workspace/second-brain).
 */
export function isAlwaysExcluded(absPath: string, sourceRoot: string, opts: ExclusionOptions = {}): boolean {
  const home = opts.home ?? (process.env.HOME || homedir());
  if (!isAbsolute(absPath) || !isAbsolute(sourceRoot) || !isAbsolute(home)) return true;
  const path = resolve(absPath);
  const root = resolve(sourceRoot);
  const folded = fold(path);
  if (absoluteExcludedDirs(home, opts).some((d) => isInside(folded, fold(d)))) return true;

  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return true;
  if (isExcludedName(basename(root), rel === "")) return true;
  if (rel === "") return false;

  const segments = rel.split(sep);
  if (segments.some((seg, i) => isExcludedName(seg, i === segments.length - 1))) return true;
  const first = segments[0];
  return first !== undefined && SECOND_BRAIN_EXCLUDED.has(fold(first)) && isSecondBrainRoot(root);
}

/**
 * Whether any directory on the way to `root` carries an always-excluded name: every
 * segment of `root` measured from `home` (or from `/` when `root` is outside it) is
 * checked against the segment and name rules, and an `inbox` or `log` right after a
 * `second-brain` segment counts too. So a root inside `~/.ssh`, a `.git` directory or a
 * `secrets/` tree is excluded whole, not only below it. Case-insensitive; `home`'s own
 * segments never count. Fails closed on a relative path.
 */
export function isExcludedAncestry(root: string, home: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(home)) return true;
  const r = fold(resolve(root));
  const h = fold(resolve(home));
  const rel = isInside(r, h) ? relative(h, r) : r;
  const segs = rel.split(sep).filter(Boolean);
  return segs.some((s, i) => isExcludedName(s, false) || (SECOND_BRAIN_EXCLUDED.has(s) && segs[i - 1] === "second-brain"));
}

export type ReadableRefusal = "not-absolute" | "unresolvable" | "outside-root" | "excluded" | "too-broad";
export type ReadableResult = { ok: true; realPath: string } | { ok: false; code: ReadableRefusal };

/** A source root resolved once, so a walk does not re-resolve it for every entry. */
export interface PreparedRoot {
  /** The root as given; checkReadable uses this only for the same spelling. */
  sourceRoot: string;
  realRoot: string;
  home: string;
  realHome: string;
  /** The absolute exclusions that exist, by real path. */
  realExcludedDirs: readonly string[];
}

export interface CheckReadableOptions extends ExclusionOptions {
  /** Test seam: replaces realpathSync.native. */
  realpath?: (p: string) => string;
  /** From prepareRoot for the same `sourceRoot`: skips resolving the root, home and exclusions again. */
  prepared?: PreparedRoot;
}

/**
 * The root half of checkReadable: resolve the root, $HOME and the absolute exclusions,
 * and refuse a root that is too broad (never `/`, $HOME or an ancestor of it, lexically
 * or through a symlink) or that lies inside an always-excluded area (isExcludedAncestry,
 * on both the given and the real spelling). Fails closed on any fs error.
 */
export function prepareRoot(
  sourceRoot: string,
  opts: CheckReadableOptions = {},
): { ok: true; root: PreparedRoot } | { ok: false; code: ReadableRefusal } {
  const { realpath = realpathSync.native, ...excl } = opts;
  if (typeof sourceRoot !== "string" || !isAbsolute(sourceRoot)) return { ok: false, code: "not-absolute" };
  let realRoot: string;
  try {
    realRoot = realpath(sourceRoot);
  } catch {
    return { ok: false, code: "unresolvable" };
  }
  if (!isAbsolute(realRoot)) return { ok: false, code: "unresolvable" };
  const home = excl.home ?? (process.env.HOME || homedir());
  let realHome = home;
  try {
    realHome = realpath(home);
  } catch {
    // no real home to compare against: the lexical form is checked below
  }
  if (isTooBroadRoot(sourceRoot, home) || isTooBroadRoot(realRoot, home) || isTooBroadRoot(realRoot, realHome)) {
    return { ok: false, code: "too-broad" };
  }
  if (isExcludedAncestry(sourceRoot, home) || isExcludedAncestry(realRoot, realHome)) return { ok: false, code: "excluded" };
  const realExcludedDirs: string[] = [];
  for (const dir of absoluteExcludedDirs(home, excl)) {
    try {
      realExcludedDirs.push(fold(realpath(dir)));
    } catch {
      // missing: its lexical form is checked by isAlwaysExcluded
    }
  }
  return { ok: true, root: { sourceRoot, realRoot, home, realHome, realExcludedDirs } };
}

/**
 * The gate every source read goes through. Resolves both paths with realpath (symlinks
 * and on-disk spelling), fails closed on any fs error, requires the real path inside the
 * real root, then applies isAlwaysExcluded to both the real and the given spelling. The
 * absolute exclusions are matched against their real paths too, so a symlinked
 * ~/workspace can't route around them. The root itself must pass prepareRoot: not too
 * broad, and not inside an excluded area (`~/.ssh/thoughts`, `repo/.git/notes`,
 * `work/secrets/notes` are refused whole). Open the returned `realPath` with `O_NOFOLLOW`,
 * so a symlink swapped in after this check fails the open instead of being followed.
 */
export function checkReadable(absPath: string, sourceRoot: string, opts: CheckReadableOptions = {}): ReadableResult {
  const { realpath = realpathSync.native, prepared, ...excl } = opts;
  if (typeof absPath !== "string" || typeof sourceRoot !== "string" || !isAbsolute(absPath) || !isAbsolute(sourceRoot)) {
    return { ok: false, code: "not-absolute" };
  }
  let realPath: string;
  try {
    realPath = realpath(absPath);
  } catch {
    return { ok: false, code: "unresolvable" };
  }
  if (!isAbsolute(realPath)) return { ok: false, code: "unresolvable" };
  let root: PreparedRoot;
  if (prepared !== undefined && prepared.sourceRoot === sourceRoot) {
    root = prepared;
  } else {
    const p = prepareRoot(sourceRoot, { ...excl, realpath });
    if (!p.ok) return p;
    root = p.root;
  }
  if (!isInside(realPath, root.realRoot)) return { ok: false, code: "outside-root" };
  if (isAlwaysExcluded(absPath, sourceRoot, excl) || isAlwaysExcluded(realPath, root.realRoot, excl)) {
    return { ok: false, code: "excluded" };
  }
  const foldedReal = fold(realPath);
  if (root.realExcludedDirs.some((d) => isInside(foldedReal, d))) return { ok: false, code: "excluded" };
  return { ok: true, realPath };
}
