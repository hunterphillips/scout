// Durable, atomic file replacement for the capability store and the skill exporter.
//
// The new content goes to a fresh temp file in the same directory (O_EXCL | O_NOFOLLOW,
// mode 0600), is fsynced, then renamed over the target, and the directory is fsynced so
// the rename itself survives a crash. A rename replaces a symlink at the target name
// rather than following it, so a planted link never redirects the write.

import { randomBytes } from "node:crypto";
import { closeSync, constants as fsc, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Temp files start with this, so a reader never mistakes one for a target. */
export const TEMP_PREFIX = ".scout-tmp-";

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
