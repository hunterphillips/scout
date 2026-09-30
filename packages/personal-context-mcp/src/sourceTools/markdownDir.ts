// A read-only view of one markdown directory: walk, search and read, every path gated by
// checkReadable.
//
// Walking: readdir with file types (lstat semantics). A symlinked directory is never
// entered. A symlinked file is kept only when checkReadable puts its real path inside the
// real root and it is a regular file. Every directory and file goes through checkReadable,
// which also applies the always-excluded list, so an excluded directory is pruned whole.
// Only `.md`, `.markdown` and `.txt` files count.
//
// Opening: the real path from checkReadable is opened with O_NOFOLLOW | O_NONBLOCK, the
// descriptor must be a regular file, and the real path must still resolve to itself after
// the open. A file swapped for a symlink after the check fails the open; a FIFO can't
// block the server.
//
// Search: the query is split on whitespace into terms (case-insensitive, at most 8, each
// at most 64 characters). A hit is a window of at most three lines holding every term: it
// ends on the first line by which every term has appeared, counting from a line with any
// term, and starts on the latest line that still keeps every term in the window. Hits are in
// path order, then line order, and never overlap. Each call is capped at 2,000 files,
// 256 KiB read per file, and 5 MiB read in all; hitting a cap sets `truncated`.
//
// Read: a relative path (no absolute, `~`, `..`, `.`, empty segment, backslash or NUL),
// at most 200 lines and 16 KiB of text.
//
// User `exclude` entries are matched case-insensitively: an entry with a `/` excludes that
// relative path and everything under it; an entry without one excludes any path segment of
// that name.

import { type Dirent, constants as fsc, closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { checkReadable, type ExclusionOptions } from "../config.js";

export const SEARCH_LIMITS = Object.freeze({
  maxFiles: 2_000,
  maxFileBytes: 256 * 1024,
  maxScanBytes: 5 * 1024 * 1024,
  maxHits: 10,
  maxSnippetChars: 300,
  maxQueryChars: 200,
  maxTerms: 8,
  maxTermChars: 64,
  /** A hit spans at most this many lines. */
  windowLines: 3,
  /** Directory entries looked at per walk, and directory depth, so a pathological tree ends. */
  maxEntries: 50_000,
  maxDepth: 32,
});

export const READ_LIMITS = Object.freeze({
  maxLines: 200,
  maxBytes: 16 * 1024,
  maxPathChars: 1024,
});

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

/** The fs calls this module makes. Tests inject a wrapper to simulate races. */
export interface FsOps {
  readdir(dir: string): Dirent[];
  open(path: string, flags: number): number;
  fstat(fd: number): { isFile(): boolean; size: number; dev: number; ino: number };
  read(fd: number, buf: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
  stat(path: string): { isFile(): boolean; dev: number; ino: number };
  realpath(path: string): string;
}

export const nodeFs: FsOps = {
  readdir: (dir) => readdirSync(dir, { withFileTypes: true }),
  open: (p, flags) => openSync(p, flags),
  fstat: (fd) => fstatSync(fd),
  read: (fd, buf, off, len, pos) => readSync(fd, buf, off, len, pos),
  close: (fd) => closeSync(fd),
  stat: (p) => statSync(p),
  realpath: (p) => realpathSync.native(p),
};

export interface TreeOptions {
  /** Absolute root as configured (it may itself be reached through a symlink). */
  root: string;
  /** User exclusions from the source config. */
  exclude?: readonly string[];
  exclusion?: ExclusionOptions;
  fs?: FsOps;
}

export type TreeCode = "denied" | "invalid-path" | "invalid-range" | "invalid-query";

export interface FileEntry {
  /** Relative path with `/` separators. */
  rel: string;
  realPath: string;
}

export interface WalkResult {
  files: FileEntry[];
  truncated: boolean;
}

export interface SearchHit {
  path: string;
  lines: [number, number];
  snippet: string;
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
}

/** Shared per-call search budget, so a registry search over several projects stays within one call's caps. */
export interface ScanBudget {
  files: number;
  bytes: number;
  truncated: boolean;
}

export function newScanBudget(): ScanBudget {
  return { files: 0, bytes: 0, truncated: false };
}

export type ReadResult =
  | { ok: true; path: string; lines: [number, number]; totalLines: number; text: string; truncated: boolean }
  | { ok: false; code: TreeCode };

const fold = (s: string): string => s.normalize("NFC").toLowerCase();

function checkOpts(opts: TreeOptions) {
  const { realpath } = opts.fs ?? nodeFs;
  return { ...opts.exclusion, realpath };
}

/** Whether the root itself is usable. Returns checkReadable's refusal code otherwise. */
export function rootAvailability(opts: TreeOptions): { ok: true } | { ok: false; code: string } {
  const r = checkReadable(opts.root, opts.root, checkOpts(opts));
  if (!r.ok) return r;
  try {
    const fs = opts.fs ?? nodeFs;
    fs.readdir(r.realPath);
  } catch {
    return { ok: false, code: "unresolvable" };
  }
  return { ok: true };
}

function userExcluded(rel: string, exclude: readonly string[] | undefined): boolean {
  if (!exclude || exclude.length === 0) return false;
  const f = fold(rel);
  const segs = f.split("/");
  for (const raw of exclude) {
    const e = fold(raw.replace(/^\/+|\/+$/g, ""));
    if (e === "") continue;
    if (e.includes("/")) {
      if (f === e || f.startsWith(e + "/")) return true;
    } else if (segs.includes(e)) {
      return true;
    }
  }
  return false;
}

function isTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.has(extname(name).toLowerCase());
}

/**
 * Regular text files under the root, sorted by relative path. Stops at `maxFiles` (from
 * the shared scan budget when given) and marks `truncated`.
 */
export function walkFiles(opts: TreeOptions, maxFiles: number = SEARCH_LIMITS.maxFiles): WalkResult {
  const fs = opts.fs ?? nodeFs;
  const copts = checkOpts(opts);
  const files: FileEntry[] = [];
  let entries = 0;
  let truncated = false;
  if (!checkReadable(opts.root, opts.root, copts).ok) return { files, truncated };

  const walk = (segs: string[], depth: number): void => {
    if (truncated) return;
    if (depth > SEARCH_LIMITS.maxDepth) {
      truncated = true;
      return;
    }
    let list: Dirent[];
    try {
      list = fs.readdir(join(opts.root, ...segs));
    } catch {
      return;
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of list) {
      if (truncated) return;
      if (++entries > SEARCH_LIMITS.maxEntries) {
        truncated = true;
        return;
      }
      const relSegs = [...segs, ent.name];
      const rel = relSegs.join("/");
      if (userExcluded(rel, opts.exclude)) continue;
      const abs = join(opts.root, ...relSegs);
      if (ent.isDirectory()) {
        if (checkReadable(abs, opts.root, copts).ok) walk(relSegs, depth + 1);
        continue;
      }
      if (!(ent.isFile() || ent.isSymbolicLink()) || !isTextFile(ent.name)) continue;
      const c = checkReadable(abs, opts.root, copts);
      if (!c.ok) continue;
      if (ent.isSymbolicLink()) {
        try {
          if (!fs.stat(c.realPath).isFile()) continue;
        } catch {
          continue;
        }
      }
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      files.push({ rel, realPath: c.realPath });
    }
  };
  walk([], 0);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, truncated };
}

/**
 * Open a checked real path and read at most `maxBytes`. Fails (undefined) when the path is
 * now a symlink, is not a regular file, or no longer resolves to itself.
 */
export function readVerified(fs: FsOps, realPath: string, maxBytes: number): { text: string; cut: boolean } | undefined {
  let fd: number;
  try {
    fd = fs.open(realPath, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fs.fstat(fd);
    if (!st.isFile()) return undefined;
    // Parent directories were symlink-free at check time; make sure they still are and
    // that the name still names the file we opened.
    if (fs.realpath(realPath) !== realPath) return undefined;
    const now = fs.stat(realPath);
    if (now.dev !== st.dev || now.ino !== st.ino) return undefined;
    const want = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(want);
    let len = 0;
    while (len < want) {
      const n = fs.read(fd, buf, len, want - len, len);
      if (n === 0) break;
      len += n;
    }
    // StringDecoder holds back a character split at the cut instead of emitting U+FFFD.
    return { text: new StringDecoder("utf8").write(buf.subarray(0, len)), cut: st.size > maxBytes };
  } catch {
    return undefined;
  } finally {
    try {
      fs.close(fd);
    } catch {
      // nothing to do
    }
  }
}

/** Split a query into lower-cased terms, or undefined when it is not a usable query. */
export function parseQuery(query: unknown): string[] | undefined {
  if (typeof query !== "string" || query.length === 0 || query.length > SEARCH_LIMITS.maxQueryChars || query.includes("\0")) {
    return undefined;
  }
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  if (terms.length === 0 || terms.length > SEARCH_LIMITS.maxTerms) return undefined;
  if (terms.some((t) => t.length > SEARCH_LIMITS.maxTermChars)) return undefined;
  return terms;
}

function cutChars(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join("");
}

function matchLines(lines: string[], terms: string[], limit: number, path: string, out: SearchHit[]): void {
  const lower = lines.map((l) => l.toLowerCase());
  for (let i = 0; i < lower.length && out.length < limit; i++) {
    const first = lower[i] ?? "";
    if (!terms.some((t) => first.includes(t))) continue;
    const seen = new Set<string>();
    let end = -1;
    for (let j = i; j < Math.min(i + SEARCH_LIMITS.windowLines, lower.length); j++) {
      const l = lower[j] ?? "";
      for (const t of terms) if (l.includes(t)) seen.add(t);
      if (seen.size === terms.length) {
        end = j;
        break;
      }
    }
    if (end < 0) continue;
    // Tighten the start: the latest line from which the window still holds every term.
    let start = i;
    for (let k = end; k > i; k--) {
      const win = lower.slice(k, end + 1);
      if (terms.every((t) => win.some((l) => l.includes(t)))) {
        start = k;
        break;
      }
    }
    const text = lines
      .slice(start, end + 1)
      .map((l) => l.trim())
      .join(" ")
      .replace(/\s+/g, " ");
    out.push({ path, lines: [start + 1, end + 1], snippet: cutChars(text, SEARCH_LIMITS.maxSnippetChars) });
    i = end;
  }
}

/**
 * Search the tree. `prefix` is prepended to returned paths (registry projects use
 * `<project>/`). `budget` is shared across trees searched in one call.
 */
export function searchTree(
  opts: TreeOptions,
  terms: string[],
  limit: number,
  budget: ScanBudget = newScanBudget(),
  prefix = "",
  out: SearchHit[] = [],
): SearchResult {
  const fs = opts.fs ?? nodeFs;
  const walked = walkFiles(opts, Math.max(0, SEARCH_LIMITS.maxFiles - budget.files));
  if (walked.truncated) budget.truncated = true;
  for (const f of walked.files) {
    if (out.length >= limit) break;
    if (budget.files >= SEARCH_LIMITS.maxFiles || budget.bytes >= SEARCH_LIMITS.maxScanBytes) {
      budget.truncated = true;
      break;
    }
    budget.files++;
    const room = Math.min(SEARCH_LIMITS.maxFileBytes, SEARCH_LIMITS.maxScanBytes - budget.bytes);
    const r = readVerified(fs, f.realPath, room);
    if (!r) continue;
    budget.bytes += Buffer.byteLength(r.text, "utf8");
    if (r.cut) budget.truncated = true;
    matchLines(r.text.split(/\r?\n/), terms, limit, prefix + f.rel, out);
  }
  return { hits: out, truncated: budget.truncated };
}

/** Normalize a model-supplied relative path, or undefined when it is not one. */
export function normalizeRelPath(p: unknown): string | undefined {
  if (typeof p !== "string" || p.length === 0 || p.length > READ_LIMITS.maxPathChars) return undefined;
  if (p.includes("\0") || p.includes("\\") || p.startsWith("~") || p.startsWith("/") || isAbsolute(p)) return undefined;
  const segs = p.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return undefined;
  return segs.join("/");
}

/** Read a line range from one file under the root. */
export function readTreeFile(opts: TreeOptions, relPath: string, startLine?: number, endLine?: number): ReadResult {
  const fs = opts.fs ?? nodeFs;
  const rel = normalizeRelPath(relPath);
  if (rel === undefined) return { ok: false, code: "invalid-path" };
  const start = startLine ?? 1;
  if (!Number.isInteger(start) || start < 1) return { ok: false, code: "invalid-range" };
  if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < start)) return { ok: false, code: "invalid-range" };
  if (userExcluded(rel, opts.exclude) || !isTextFile(rel)) return { ok: false, code: "denied" };
  const c = checkReadable(join(opts.root, ...rel.split("/")), opts.root, checkOpts(opts));
  if (!c.ok) return { ok: false, code: "denied" };
  const r = readVerified(fs, c.realPath, SEARCH_LIMITS.maxFileBytes);
  if (!r) return { ok: false, code: "denied" };
  const lines = r.text.split(/\r?\n/);
  if (start > lines.length) return { ok: false, code: "invalid-range" };
  const wantEnd = Math.min(endLine ?? start + READ_LIMITS.maxLines - 1, start + READ_LIMITS.maxLines - 1, lines.length);
  let truncated = r.cut || (endLine !== undefined && endLine > wantEnd);
  const kept: string[] = [];
  let bytes = 0;
  for (let n = start; n <= wantEnd; n++) {
    const line = lines[n - 1] ?? "";
    const add = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
    if (bytes + add > READ_LIMITS.maxBytes) {
      truncated = true;
      if (kept.length === 0) {
        // One line over 16 KiB: keep its first 16 KiB.
        const buf = Buffer.from(line, "utf8");
        let end = READ_LIMITS.maxBytes;
        while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
        kept.push(buf.subarray(0, end).toString("utf8"));
      }
      break;
    }
    kept.push(line);
    bytes += add;
  }
  if (kept.length < wantEnd - start + 1) truncated = true;
  return { ok: true, path: rel, lines: [start, start + kept.length - 1], totalLines: lines.length, text: kept.join("\n"), truncated };
}
