// Durable, atomic file replacement for the capability store and the skill exporter.
//
// The new content goes to a fresh temp file in the same directory (O_EXCL | O_NOFOLLOW,
// mode 0600), is fsynced, then renamed over the target, and the directory is fsynced so
// the rename itself survives a crash. A rename replaces a symlink at the target name
// rather than following it, so a planted link never redirects the write.

import { randomBytes } from "node:crypto";
import { closeSync, constants as fsc, fsyncSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Temp files start with this, so a reader never mistakes one for a target. */
export const TEMP_PREFIX = ".scout-tmp-";

/** The temp names writeFileAtomic creates for targets matching `target` (a regex source), for crash-leftover sweeps. */
export function tempNamePattern(target: string): RegExp {
  return new RegExp(`^${TEMP_PREFIX.replaceAll(".", "\\.")}(?:${target})\\.[0-9a-f]{12}$`);
}

/**
 * Unlink the entries of `dir` that `match` accepts (a regex, e.g. from tempNamePattern, or a
 * predicate) and fsync `dir` if anything went. `beforeUnlink` runs once, after the listing and
 * before the first unlink; returning false skips every unlink. Throws only if `dir` cannot be
 * listed. Returns how many entries were removed.
 */
export function sweepTempFiles(dir: string, match: RegExp | ((name: string) => boolean), options: { beforeUnlink?: () => boolean } = {}): number {
  const accept = typeof match === "function" ? match : (name: string) => match.test(name);
  const names = readdirSync(dir).filter(accept);
  if (names.length === 0) return 0;
  if (options.beforeUnlink && !options.beforeUnlink()) return 0;
  let removed = 0;
  for (const name of names) {
    try {
      unlinkSync(join(dir, name));
      removed++;
    } catch {
      // Gone already, or not a file.
    }
  }
  if (removed > 0) fsyncDir(dir);
  return removed;
}

/** Fsync a directory so a rename or unlink in it is durable. Best effort: some file systems refuse. */
export function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, fsc.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Durability only; the rename already happened.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Write `data` to a new 0600 temp file beside `path`, fsync it, and rename it over `path`. */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  const dir = dirname(path);
  const temp = join(dir, `${TEMP_PREFIX}${basename(path)}.${randomBytes(6).toString("hex")}`);
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const fd = openSync(temp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  try {
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // Already gone.
    }
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Already gone.
    }
    throw error;
  }
  fsyncDir(dir);
}
