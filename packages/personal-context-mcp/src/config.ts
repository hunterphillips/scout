// Service configuration: <home>/config.json, where <home> is ~/.personal-context-mcp or
// PERSONAL_CONTEXT_HOME.
//
// The service owns this file. Scout's setup only merges `nodePath`, `claudePath` and
// `x_scout_marker` into it, so the loader keeps unknown keys and fills defaults for every
// missing one. Sources are grants: every default source ships disabled, and the
// always-excluded list below applies whatever the config says.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { MAX_DEADLINE_MS } from "./api.js";
import { MODEL_RE } from "./launchProfile.js";

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** ~/.personal-context-mcp, or PERSONAL_CONTEXT_HOME when set (same convention as SCOUT_HOME). */
export function resolveHome(env: EnvLike = process.env): string {
  return env.PERSONAL_CONTEXT_HOME || join(env.HOME || homedir(), ".personal-context-mcp");
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

export type ConfigErrorCode =
  | "config-unreadable"
  | "config-malformed"
  | "config-invalid"
  | "config-duplicate-source-id"
  | "config-relative-source-path"
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

const MarkdownDirSourceSchema = z.looseObject({
  id: z.string().min(1),
  kind: z.literal("markdown_dir"),
  enabled: z.boolean(),
  root: pathString,
  exclude: z.array(z.string()).default([]),
  /** `task_recall` marks recall material (saved lists), not stated priorities. */
  purpose: z.literal("task_recall").optional(),
});

const RegistryProjectsSourceSchema = z.looseObject({
  id: z.string().min(1),
  kind: z.literal("registry_projects"),
  enabled: z.boolean(),
  /** Directory of notes whose `repo:` frontmatter maps projects. A map only: not itself readable. */
  registry: pathString,
  /** Path inside each enabled project that becomes readable. */
  subpath: z.string().min(1),
  /** A project is readable only once it is named here. */
  enabledProjects: z.array(z.string().min(1)).default([]),
});

const FocusHttpSourceSchema = z.looseObject({
  id: z.string().min(1),
  kind: z.literal("focus_http"),
  enabled: z.boolean(),
  url: z.url({ protocol: /^https?$/ }),
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

/** Validate a parsed JSON value as a config file, filling defaults. Throws ConfigError. */
export function parseConfigFile(value: unknown): ConfigFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ConfigError("config-malformed");
  const input = value as Record<string, unknown>;
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
 * Read <home>/config.json. A missing file means all defaults. A present file that is
 * unreadable, not JSON, or has a malformed known field is a ConfigError, not a fallback.
 */
export function readConfigFile(home: string): ConfigFile {
  let raw: string;
  try {
    raw = readFileSync(configPath(home), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return defaultConfigFile();
    throw new ConfigError("config-unreadable");
  }
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
 * <home> as 0700 if needed. The file is validated first; unknown keys are written back.
 */
export function writeConfig(home: string, file: ConfigFile): void {
  const valid = parseConfigFile(file);
  const text = JSON.stringify(valid, null, 2) + "\n";
  const target = configPath(home);
  const tmp = join(home, `.config.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
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

export function resolveConfig(file: ConfigFile, env: EnvLike = process.env): PcmConfig {
  const sources = file.sources.map((s): ResolvedSource => {
    if (s.kind === "markdown_dir") return { ...s, root: expandHomePath(s.root, env) };
    if (s.kind === "registry_projects") return { ...s, registry: expandHomePath(s.registry, env) };
    return { ...s };
  });
  const out: PcmConfig = { port: file.port, model: file.model, maxRankMs: file.maxRankMs, sources };
  if (file.nodePath !== undefined) out.nodePath = file.nodePath;
  if (file.claudePath !== undefined) out.claudePath = file.claudePath;
  return out;
}

/** readConfigFile then resolveConfig. */
export function loadConfig(home: string, env: EnvLike = process.env): PcmConfig {
  return resolveConfig(readConfigFile(home), env);
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

/** Path segments excluded wherever they appear. */
const EXCLUDED_SEGMENTS = new Set([".git", "node_modules"]);

/** Name patterns excluded wherever they appear (any segment, case-insensitive). */
const EXCLUDED_NAME_PATTERNS: readonly RegExp[] = [
  /^\.env/i, // .env, .env.local, ...
  /\.pem$/i,
  /\.key$/i,
  /secret/i,
  /token/i,
  /credential/i,
];

/** Top-level directories excluded under a second-brain root. */
const SECOND_BRAIN_EXCLUDED = new Set(["inbox", "log"]);

function isSecondBrainRoot(root: string): boolean {
  const parts = root.split(sep).filter(Boolean);
  const last = parts.at(-1);
  const prev = parts.at(-2);
  return last === "second-brain" || (last === "notes" && prev === "second-brain");
}

export interface ExclusionOptions {
  /** Defaults to HOME from the environment. */
  home?: string;
  /** Defaults to <home>/workspace/personal-context. */
  personalContextDir?: string;
}

/**
 * Whether a path is excluded whatever the config says. Callers pass physical paths
 * (realpath of both). Excluded:
 * - anything not inside `sourceRoot` (fails closed);
 * - everything under ~/workspace/personal-context/ (the private profile store);
 * - everything under ~/workspace/second-brain/inbox/ and ~/workspace/second-brain/log/,
 *   by absolute path, whatever the source root;
 * - any path segment named `.git` or `node_modules`;
 * - any segment matching `.env*`, `*.pem`, `*.key`, `*secret*`, `*token*`, `*credential*`
 *   (case-insensitive, so a `secrets/` directory hides its whole subtree);
 * - when the source root is a second-brain root (its last segments are `second-brain` or
 *   `second-brain/notes`), a first segment under it named `inbox` or `log` (covers a second
 *   brain living somewhere other than ~/workspace/second-brain).
 */
export function isAlwaysExcluded(absPath: string, sourceRoot: string, opts: ExclusionOptions = {}): boolean {
  const home = opts.home ?? (process.env.HOME || homedir());
  const pcDir = resolve(opts.personalContextDir ?? join(home, "workspace", "personal-context"));
  const path = resolve(absPath);
  const root = resolve(sourceRoot);
  if (path === pcDir || path.startsWith(pcDir + sep)) return true;
  const brainDir = join(resolve(home), "workspace", "second-brain");
  for (const name of SECOND_BRAIN_EXCLUDED) {
    const dir = join(brainDir, name);
    if (path === dir || path.startsWith(dir + sep)) return true;
  }

  const rel = relative(root, path);
  if (rel === "") return false;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return true;

  const segments = rel.split(sep);
  for (const seg of segments) {
    if (EXCLUDED_SEGMENTS.has(seg)) return true;
    if (EXCLUDED_NAME_PATTERNS.some((re) => re.test(seg))) return true;
  }
  const first = segments[0];
  return first !== undefined && SECOND_BRAIN_EXCLUDED.has(first) && isSecondBrainRoot(root);
}
