// Scout's native skill wrappers in the user's skills root, and the manifest that proves which
// of them Scout owns (`<scoutHome>/capabilities/exports.json`).
//
// Only `skill` resources with an unblocked approved default get a wrapper. Each is
// `<skillsRoot>/<wrapperName>/SKILL.md`, rendered by wrapper.ts (Scout's text; no website
// text beyond the bounded description). Nothing else is ever written: no CLAUDE.md, hooks,
// settings, permissions, or MCP configuration. `llms.txt` and `AGENTS.md` stay on-demand
// resources behind the static integration skill.
//
// Ownership comes only from the manifest, never from a `scout-` prefix. A manifest entry
// records the exact files and their ownership hash (identity.ts). Scout replaces or removes
// a wrapper only when the directory is a real directory (not a symlink) holding exactly the
// recorded files, every file opens with O_NOFOLLOW, the content hashes to a recorded value,
// and the directory's inode is unchanged when it acts. Anything else is a conflict, left in
// place and reported:
//   foreign_collision  a directory with the wrapper's name that the manifest does not own
//   left_modified      an owned wrapper whose files or content changed
//   left_symlink       an owned wrapper path that is now a symlink
//   name_collision     two resources mapping to one name (or a name owned by another resource)
//   io_error           the file system refused an operation
//
// Crash safety: the manifest entry (or its `pendingHash`) is written before the file, so an
// interrupted write is still recognized as Scout's on the next sync. Before inspecting a
// manifest-owned wrapper, the sync deletes atomicWrite temp files (`.scout-tmp-SKILL.md.<hex>`)
// a crash left in it, so they never become a permanent `left_modified`. Nothing else is swept.

import { closeSync, constants as fsc, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ResourceIdSchema, SHA256_HEX_PATTERN } from "@scout/contracts";
import { z } from "zod";
import { PrivateFileError, readPrivateFile } from "../agents/privateFile.js";
import type { Diagnostics } from "../diagnostics.js";
import { checkPrivateDir } from "../privateCacheFile.js";
import { fsyncDir, tempNamePattern, writeFileAtomic } from "./atomicWrite.js";
import type { StoreState } from "./decisions.js";
import { ownershipHash, wrapperName } from "./identity.js";
import { DEFAULT_SERVER_NAME, renderSkillWrapper, WRAPPER_FILE } from "./wrapper.js";

export const EXPORTS_SCHEMA_VERSION = 1;
export const EXPORTS_FILE_MAX_BYTES = 4 * 1024 * 1024;
/** A wrapper file larger than this is not Scout's. */
const OWNED_FILE_MAX_BYTES = 64 * 1024;
/** Exactly the names wrapperName produces. */
export const MANAGED_NAME_RE = /^scout-(?:llms|agents|skill)-[0-9a-f]{16}$/;

export type ConflictCode = "foreign_collision" | "left_modified" | "left_symlink" | "name_collision" | "io_error";

export interface ExportConflict {
  name: string;
  resourceId: string;
  code: ConflictCode;
}

export interface ManifestEntry {
  name: string;
  resourceId: string;
  version: string;
  /** Relative paths inside the wrapper directory; today always [SKILL.md]. */
  files: string[];
  ownershipHash: string;
  /** Set while a replacement is being written: either hash is Scout's. */
  pendingHash?: string;
}

export interface ExportManifest {
  schemaVersion: typeof EXPORTS_SCHEMA_VERSION;
  skillsRoot: string;
  entries: ManifestEntry[];
  conflicts: ExportConflict[];
}

const ManifestSchema = z.strictObject({
  schemaVersion: z.literal(EXPORTS_SCHEMA_VERSION),
  skillsRoot: z.string().min(1),
  entries: z.array(
    z.strictObject({
      name: z.string().regex(MANAGED_NAME_RE),
      resourceId: ResourceIdSchema,
      version: z.string().regex(SHA256_HEX_PATTERN),
      files: z.array(z.literal(WRAPPER_FILE)).length(1),
      ownershipHash: z.string().regex(SHA256_HEX_PATTERN),
      pendingHash: z.string().regex(SHA256_HEX_PATTERN).optional(),
    }),
  ),
  conflicts: z.array(
    z.strictObject({
      name: z.string().regex(MANAGED_NAME_RE),
      resourceId: ResourceIdSchema,
      code: z.enum(["foreign_collision", "left_modified", "left_symlink", "name_collision", "io_error"]),
    }),
  ),
});

export type ExportErrorCode =
  | "root_not_absolute"
  | "root_missing"
  | "root_symlink"
  | "root_not_directory"
  | "root_not_real"
  | "root_mismatch"
  | "manifest_unreadable"
  | "manifest_not_private"
  | "manifest_parse"
  | "manifest_schema"
  | "manifest_invariant"
  | "dir_unsafe";

/** The skills root or the manifest cannot be trusted; nothing was written or removed. */
export class ExportError extends Error {
  constructor(readonly code: ExportErrorCode) {
    super(`skill export: ${code}`);
    this.name = "ExportError";
  }
}

/** Where the installed CLI reads user skills: `$CLAUDE_CONFIG_DIR/skills`, else `~/.claude/skills`. The installer records this. */
export function resolveSkillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, "skills") : join(env.HOME || homedir(), ".claude", "skills");
}

/** Refuse anything but an existing, absolute, real directory (no symlink anywhere in the path). */
export function checkSkillsRoot(root: string): void {
  if (typeof root !== "string" || !isAbsolute(root)) throw new ExportError("root_not_absolute");
  let st;
  try {
    st = lstatSync(root);
  } catch {
    throw new ExportError("root_missing");
  }
  if (st.isSymbolicLink()) throw new ExportError("root_symlink");
  if (!st.isDirectory()) throw new ExportError("root_not_directory");
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    throw new ExportError("root_missing");
  }
  if (real !== resolve(root)) throw new ExportError("root_not_real");
}

export interface ExportReport {
  written: number;
  removed: number;
  unchanged: number;
  conflicts: ExportConflict[];
}

export interface SkillExporter {
  readonly skillsRoot: string;
  /** Bring the skills root in line with `state`. Serialized; throws ExportError before touching anything when unsafe. */
  sync(state: StoreState): Promise<ExportReport>;
  /** The persisted manifest (throws ExportError when corrupt). */
  manifest(): ExportManifest;
}

export interface SkillExporterOptions {
  scoutHome: string;
  /** From the installer's record (P2.6), checked by `checkSkillsRoot`; never an arbitrary caller path. */
  skillsRoot: string;
  /** The MCP server name wrappers call. Defaults to `scout`. */
  serverName?: string;
  diagnostics?: Diagnostics;
}

type Inspection =
  | { state: "absent" }
  | { state: "empty"; ino: number; dev: number }
  | { state: "match"; hash: string; ino: number; dev: number }
  | { state: "left_modified" }
  | { state: "left_symlink" }
  | { state: "io_error" };

const WRAPPER_TEMP_RE = tempNamePattern(WRAPPER_FILE.replaceAll(".", "\\."));

/** Delete writeFileAtomic leftovers inside a manifest-owned wrapper directory; never inside a symlink. */
function sweepWrapperTemps(dir: string): void {
  let names: string[];
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return;
    names = readdirSync(dir);
  } catch {
    return; // Absent or unreadable: the inspection reports it.
  }
  let removed = 0;
  for (const name of names) {
    if (!WRAPPER_TEMP_RE.test(name)) continue;
    try {
      unlinkSync(join(dir, name));
      removed++;
    } catch {
      // Gone, or not a file: the inspection reports what is left.
    }
  }
  if (removed > 0) fsyncDir(dir);
}

/** Port of agent-check's removeOwnedSkill checks, generalized to a file list. */
function inspectOwned(dir: string, files: readonly string[], accepted: readonly string[]): Inspection {
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? { state: "absent" } : { state: "io_error" };
  }
  if (st.isSymbolicLink()) return { state: "left_symlink" };
  if (!st.isDirectory()) return { state: "left_modified" };
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { state: "io_error" };
  }
  if (entries.length === 0) return { state: "empty", ino: st.ino, dev: st.dev };
  if (entries.length !== files.length || [...entries].sort().join("\0") !== [...files].sort().join("\0")) return { state: "left_modified" };
  const contents: Record<string, string> = {};
  for (const f of files) {
    let fd: number;
    try {
      fd = openNoFollow(join(dir, f));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ELOOP") return { state: "left_symlink" };
      return code === "ENOENT" ? { state: "left_modified" } : { state: "io_error" };
    }
    try {
      const fst = fstatSync(fd);
      if (!fst.isFile() || fst.size > OWNED_FILE_MAX_BYTES) return { state: "left_modified" };
      contents[f] = readFileSync(fd, "utf8");
    } catch {
      return { state: "io_error" };
    } finally {
      closeSync(fd);
    }
  }
  const hash = ownershipHash(contents);
  if (!accepted.includes(hash)) return { state: "left_modified" };
  return { state: "match", hash, ino: st.ino, dev: st.dev };
}

function openNoFollow(path: string): number {
  // O_NONBLOCK: a FIFO planted under the name must not block the sync.
  return openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
}

/** The directory is still the one inspected: not swapped for a symlink or another directory. */
function sameDir(dir: string, ino: number, dev: number): boolean {
  try {
    const again = lstatSync(dir);
    return !again.isSymbolicLink() && again.isDirectory() && again.ino === ino && again.dev === dev;
  } catch {
    return false;
  }
}

export function createSkillExporter(options: SkillExporterOptions): SkillExporter {
  const root = resolve(options.skillsRoot);
  checkSkillsRoot(options.skillsRoot);
  const serverName = options.serverName ?? DEFAULT_SERVER_NAME;
  const capDir = join(options.scoutHome, "capabilities");
  const manifestPath = join(capDir, "exports.json");
  const { diagnostics } = options;

  function invalid(code: ExportErrorCode): never {
    diagnostics?.event("capability_store_invalid", { code });
    throw new ExportError(code);
  }

  function load(): ExportManifest {
    let raw: Buffer;
    try {
      raw = readPrivateFile(manifestPath, EXPORTS_FILE_MAX_BYTES, { private: true });
    } catch (error) {
      if (error instanceof PrivateFileError && error.code === "missing") return { schemaVersion: EXPORTS_SCHEMA_VERSION, skillsRoot: root, entries: [], conflicts: [] };
      if (error instanceof PrivateFileError && (error.code === "not_private" || error.code === "not_regular")) invalid("manifest_not_private");
      invalid("manifest_unreadable");
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      invalid("manifest_parse");
    }
    const parsed = ManifestSchema.safeParse(json);
    if (!parsed.success) invalid("manifest_schema");
    const m = parsed.data as ExportManifest;
    const names = new Set(m.entries.map((e) => e.name));
    if (names.size !== m.entries.length) invalid("manifest_invariant");
    if (m.skillsRoot !== root) invalid("root_mismatch");
    return m;
  }

  function save(m: ExportManifest): void {
    writeFileAtomic(manifestPath, JSON.stringify(m));
  }

  function ensureCapDir(): void {
    try {
      mkdirSync(capDir, { recursive: true, mode: 0o700 });
      if (checkPrivateDir(capDir)) invalid("dir_unsafe");
    } catch (error) {
      if (error instanceof ExportError) throw error;
      invalid("dir_unsafe");
    }
  }

  /** `<root>/<name>`, refusing anything that is not exactly one managed component below the root. */
  function wrapperDir(name: string): string {
    if (!MANAGED_NAME_RE.test(name)) throw new ExportError("manifest_invariant");
    const dir = join(root, name);
    if (dirname(dir) !== root) throw new ExportError("manifest_invariant");
    return dir;
  }

  /** Write SKILL.md into an existing, inspected directory via temp + rename. */
  function writeWrapper(dir: string, text: string, ino: number, dev: number): boolean {
    if (!sameDir(dir, ino, dev)) return false;
    writeFileAtomic(join(dir, WRAPPER_FILE), text);
    return sameDir(dir, ino, dev);
  }

  function remove(dir: string, entry: ManifestEntry): "removed" | "absent" | ConflictCode {
    const accepted = [entry.ownershipHash, ...(entry.pendingHash ? [entry.pendingHash] : [])];
    sweepWrapperTemps(dir);
    const ins = inspectOwned(dir, entry.files, accepted);
    if (ins.state === "absent") return "absent";
    if (ins.state === "left_modified" || ins.state === "left_symlink" || ins.state === "io_error") return ins.state;
    if (!sameDir(dir, ins.ino, ins.dev)) return "left_modified";
    // Known window: between this inode recheck and the unlinks below, the directory could be
    // swapped for a symlink. Node has no unlinkat/openat to unlink relative to a held
    // directory handle, so the recheck narrows the race but cannot close it.
    try {
      if (ins.state === "match") for (const f of entry.files) unlinkSync(join(dir, f));
      rmdirSync(dir);
      fsyncDir(root);
      return "removed";
    } catch {
      return "io_error";
    }
  }

  let tail: Promise<unknown> = Promise.resolve();

  async function syncNow(state: StoreState): Promise<ExportReport> {
    checkSkillsRoot(root);
    ensureCapDir();
    const manifest = load();
    const conflicts: ExportConflict[] = [];
    let written = 0;
    let removed = 0;
    let unchanged = 0;

    // What should exist: one wrapper per unblocked skill with an approved default.
    const desired = new Map<string, { resourceId: string; version: string; text: string; hash: string }>();
    const ownerOf = new Map(manifest.entries.map((e) => [e.name, e.resourceId]));
    for (const r of state.resources) {
      const res = r.resource;
      if (res.kind !== "skill" || res.blocked || res.defaultVersion === undefined) continue;
      const name = wrapperName(res.kind, res.id);
      const owner = desired.get(name)?.resourceId ?? ownerOf.get(name);
      if (owner !== undefined && owner !== res.id) {
        conflicts.push({ name, resourceId: res.id, code: "name_collision" });
        continue;
      }
      const description = r.meta[res.defaultVersion]?.skill?.description;
      const text = renderSkillWrapper({
        resource: { resourceId: res.id, kind: res.kind },
        version: res.defaultVersion,
        publisherOrigin: res.publisherOrigin,
        serverName,
        ...(description !== undefined ? { siteDescription: description } : {}),
      });
      desired.set(name, { resourceId: res.id, version: res.defaultVersion, text, hash: ownershipHash({ [WRAPPER_FILE]: text }) });
    }

    // Removals: owned wrappers whose resource no longer has an exportable default.
    for (const entry of [...manifest.entries]) {
      if (desired.get(entry.name)?.resourceId === entry.resourceId) continue;
      const outcome = remove(wrapperDir(entry.name), entry);
      if (outcome === "removed" || outcome === "absent") {
        manifest.entries = manifest.entries.filter((e) => e !== entry);
        if (outcome === "removed") removed++;
        save(manifest);
      } else conflicts.push({ name: entry.name, resourceId: entry.resourceId, code: outcome });
    }

    // Writes: new wrappers and newer approved versions.
    for (const [name, d] of desired) {
      const dir = wrapperDir(name);
      let entry = manifest.entries.find((e) => e.name === name);
      try {
        if (!entry) {
          if (inspectOwned(dir, [WRAPPER_FILE], []).state !== "absent") {
            conflicts.push({ name, resourceId: d.resourceId, code: "foreign_collision" });
            continue;
          }
          entry = { name, resourceId: d.resourceId, version: d.version, files: [WRAPPER_FILE], ownershipHash: d.hash };
          manifest.entries.push(entry);
          save(manifest);
          try {
            mkdirSync(dir, { mode: 0o700 });
          } catch {
            // Someone created it between the check and now: theirs.
            manifest.entries = manifest.entries.filter((e) => e !== entry);
            save(manifest);
            conflicts.push({ name, resourceId: d.resourceId, code: "foreign_collision" });
            continue;
          }
        }
        const accepted = [entry.ownershipHash, ...(entry.pendingHash ? [entry.pendingHash] : [])];
        sweepWrapperTemps(dir);
        const ins = inspectOwned(dir, entry.files, accepted);
        if (ins.state === "left_modified" || ins.state === "left_symlink" || ins.state === "io_error") {
          conflicts.push({ name, resourceId: d.resourceId, code: ins.state });
          continue;
        }
        if (ins.state === "match" && ins.hash === d.hash) {
          if (entry.pendingHash !== undefined || entry.ownershipHash !== d.hash || entry.version !== d.version) {
            entry.ownershipHash = d.hash;
            entry.version = d.version;
            delete entry.pendingHash;
            save(manifest);
          }
          unchanged++;
          continue;
        }
        let ino: number;
        let dev: number;
        if (ins.state === "absent") {
          mkdirSync(dir, { mode: 0o700 });
          const st = lstatSync(dir);
          ino = st.ino;
          dev = st.dev;
        } else {
          ino = ins.ino;
          dev = ins.dev;
        }
        entry.pendingHash = d.hash;
        save(manifest);
        if (!writeWrapper(dir, d.text, ino, dev)) {
          conflicts.push({ name, resourceId: d.resourceId, code: "left_modified" });
          continue;
        }
        entry.ownershipHash = d.hash;
        entry.version = d.version;
        delete entry.pendingHash;
        save(manifest);
        written++;
      } catch (error) {
        if (error instanceof ExportError) throw error;
        conflicts.push({ name, resourceId: d.resourceId, code: "io_error" });
      }
    }

    manifest.conflicts = conflicts;
    save(manifest);
    diagnostics?.event("capability_export", { written, removed, unchanged, conflicts: conflicts.length });
    return { written, removed, unchanged, conflicts };
  }

  return {
    skillsRoot: root,
    sync(state) {
      const run = tail.then(() => syncNow(state));
      tail = run.catch(() => undefined);
      return run;
    },
    manifest: () => load(),
  };
}
