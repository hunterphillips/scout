// A read-only view of one markdown directory: walk, search and read, every path gated by
// checkReadable.
//
// Walking: readdir with file types (lstat semantics). A symlinked directory is never
// entered. A symlinked file is kept only when checkReadable puts its real path inside the
// real root and it is a regular file. Every directory and file goes through checkReadable,
// which also applies the always-excluded list, so an excluded directory is pruned whole.
// The root is resolved once per walk (prepareRoot). Only `.md`, `.markdown` and `.txt`
// files count. Search lives in search.ts.
//
// Opening: the real path from checkReadable is opened with O_NOFOLLOW | O_NONBLOCK, the
// descriptor must be a regular file with one link, and the real path must still resolve to
// itself after the open. A file swapped for a symlink after the check fails the open; a
// FIFO can't block the server.
//
// Read: a relative path (no absolute, `~`, `..`, `.`, empty segment, backslash or NUL),
// at most 200 lines and 16 KiB of text, from the first 256 KiB of the file. No directory
// on the way may be a symlink, the same rule the walker follows.
//
// User `exclude` entries are matched case-insensitively: an entry with a `/` excludes that
// relative path and everything under it; an entry without one excludes any path segment of
// that name. They apply to the path as asked and to the file's real path under the real
// root, so a symlink can't route around them.

import { type Dirent, constants as fsc, closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { checkReadable, prepareRoot, type CheckReadableOptions, type ExclusionOptions, type ReadableRefusal } from "../config.js";

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

/** Wall-clock time one search call may spend walking and reading before it stops as `truncated`. */
export const SEARCH_DEADLINE_MS = 2_000;

/** A point in time past which a walk or search stops. `now` is injectable for tests. */
export interface Deadline {
  now(): number;
  at: number;
}

export function deadlineIn(ms: number = SEARCH_DEADLINE_MS, now: () => number = Date.now): Deadline {
  return { now, at: now() + ms };
}

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
  fstat(fd: number): { isFile(): boolean; size: number; dev: number; ino: number; nlink: number };
  read(fd: number, buf: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
  stat(path: string): { isFile(): boolean; dev: number; ino: number };
  lstat(path: string): { isSymbolicLink(): boolean };
  realpath(path: string): string;
}

export const nodeFs: FsOps = {
  readdir: (dir) => readdirSync(dir, { withFileTypes: true }),
  open: (p, flags) => openSync(p, flags),
  fstat: (fd) => fstatSync(fd),
  read: (fd, buf, off, len, pos) => readSync(fd, buf, off, len, pos),
  close: (fd) => closeSync(fd),
  stat: (p) => statSync(p),
  lstat: (p) => lstatSync(p),
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

/** Why a read was denied. Audit only: the model sees `denied`. */
export type DenyDetail = ReadableRefusal | "user-excluded" | "not-text" | "symlinked-dir" | VerifyFailure;

export interface FileEntry {
  /** Relative path with `/` separators. */
  rel: string;
  realPath: string;
}

export interface WalkResult {
  files: FileEntry[];
  truncated: boolean;
}

export interface ReadOk {
  ok: true;
  path: string;
  lines: [number, number];
  /** Lines in the part of the file that was read (its first 256 KiB). */
  totalLines: number;
  /** Set when the file is longer than 256 KiB: totalLines is a lower bound, later lines are unreachable. */
  totalLinesAtLeast?: true;
  text: string;
  /** The 200-line or 16 KiB cap cut the range asked for. */
  truncated: boolean;
  /** `endLine` was past the last readable line and was clamped to it. */
  endClamped?: true;
}

export type ReadResult = ReadOk | { ok: false; code: TreeCode; detail?: DenyDetail };

const fold = (s: string): string => s.normalize("NFC").toLowerCase();

function checkOpts(opts: TreeOptions): CheckReadableOptions {
  const { realpath } = opts.fs ?? nodeFs;
  return { ...opts.exclusion, realpath };
}

/** `realPath` relative to `realRoot`, with `/` separators. */
function realRel(realRoot: string, realPath: string): string {
  return relative(realRoot, realPath).split(sep).join("/");
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
 * Regular text files under the root, sorted by relative path. Stops at `maxFiles`, at
 * SEARCH_LIMITS.maxEntries or maxDepth, or at `deadline`, and marks `truncated`.
 */
export function walkFiles(opts: TreeOptions, maxFiles: number = SEARCH_LIMITS.maxFiles, deadline?: Deadline): WalkResult {
  const fs = opts.fs ?? nodeFs;
  const files: FileEntry[] = [];
  let entries = 0;
  let truncated = false;
  const prep = prepareRoot(opts.root, checkOpts(opts));
  if (!prep.ok) return { files, truncated };
  const copts: CheckReadableOptions = { ...checkOpts(opts), prepared: prep.root };
  const { realRoot } = prep.root;

  const walk = (segs: string[], depth: number): void => {
    if (truncated) return;
    if (depth > SEARCH_LIMITS.maxDepth || (deadline !== undefined && deadline.now() >= deadline.at)) {
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
        if (userExcluded(realRel(realRoot, c.realPath), opts.exclude)) continue;
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

export type VerifyFailure = "open-failed" | "not-regular" | "hard-link" | "moved" | "read-failed";

/**
 * Open a checked real path and read at most `maxBytes`. Fails when the path is now a
 * symlink, is not a regular file, has more than one hard link (a hard link can pull in a
 * file from anywhere on the volume, including excluded ones), or no longer resolves to
 * itself. One race is accepted: a parent directory swapped for a symlink and back between
 * the realpath recheck and the open. Node on macOS can't map a descriptor back to its path
 * to close that window, and pulling it off takes a concurrent process running as the same
 * user.
 */
export function readVerifiedDetailed(
  fs: FsOps,
  realPath: string,
  maxBytes: number,
): { ok: true; text: string; cut: boolean } | { ok: false; reason: VerifyFailure } {
  let fd: number;
  try {
    fd = fs.open(realPath, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch {
    return { ok: false, reason: "open-failed" };
  }
  try {
    const st = fs.fstat(fd);
    if (!st.isFile()) return { ok: false, reason: "not-regular" };
    if (st.nlink > 1) return { ok: false, reason: "hard-link" };
    // Parent directories were symlink-free at check time; make sure they still are and
    // that the name still names the file we opened.
    if (fs.realpath(realPath) !== realPath) return { ok: false, reason: "moved" };
    const now = fs.stat(realPath);
    if (now.dev !== st.dev || now.ino !== st.ino) return { ok: false, reason: "moved" };
    const want = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(want);
    let len = 0;
    while (len < want) {
      const n = fs.read(fd, buf, len, want - len, len);
      if (n === 0) break;
      len += n;
    }
    // StringDecoder holds back a character split at the cut instead of emitting U+FFFD.
    return { ok: true, text: new StringDecoder("utf8").write(buf.subarray(0, len)), cut: st.size > maxBytes };
  } catch {
    return { ok: false, reason: "read-failed" };
  } finally {
    try {
      fs.close(fd);
    } catch {
      // nothing to do
    }
  }
}

/** readVerifiedDetailed without the reason: undefined on any failure. */
export function readVerified(fs: FsOps, realPath: string, maxBytes: number): { text: string; cut: boolean } | undefined {
  const r = readVerifiedDetailed(fs, realPath, maxBytes);
  return r.ok ? { text: r.text, cut: r.cut } : undefined;
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
  const denied = (detail: DenyDetail): ReadResult => ({ ok: false, code: "denied", detail });
  if (userExcluded(rel, opts.exclude)) return denied("user-excluded");
  if (!isTextFile(rel)) return denied("not-text");
  const segs = rel.split("/");
  // The walker never enters a symlinked directory; a read must not either.
  for (let i = 1; i < segs.length; i++) {
    try {
      if (fs.lstat(join(opts.root, ...segs.slice(0, i))).isSymbolicLink()) return denied("symlinked-dir");
    } catch {
      return denied("unresolvable");
    }
  }
  const prep = prepareRoot(opts.root, checkOpts(opts));
  if (!prep.ok) return denied(prep.code);
  const c = checkReadable(join(opts.root, ...segs), opts.root, { ...checkOpts(opts), prepared: prep.root });
  if (!c.ok) return denied(c.code);
  if (userExcluded(realRel(prep.root.realRoot, c.realPath), opts.exclude)) return denied("user-excluded");
  const r = readVerifiedDetailed(fs, c.realPath, SEARCH_LIMITS.maxFileBytes);
  if (!r.ok) return denied(r.reason);
  const lines = r.text.split(/\r?\n/);
  if (start > lines.length) return { ok: false, code: "invalid-range" };
  const capEnd = start + READ_LIMITS.maxLines - 1;
  const askedEnd = endLine ?? capEnd;
  const endClamped = endLine !== undefined && endLine > lines.length;
  const wantEnd = Math.min(askedEnd, capEnd, lines.length);
  let truncated = Math.min(askedEnd, lines.length) > capEnd;
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
  const last = start + kept.length - 1;
  // The last line of a file cut at 256 KiB may itself be cut.
  if (r.cut && last === lines.length) truncated = true;
  const out: ReadOk = { ok: true, path: rel, lines: [start, last], totalLines: lines.length, text: kept.join("\n"), truncated };
  if (r.cut) out.totalLinesAtLeast = true;
  if (endClamped) out.endClamped = true;
  return out;
}
