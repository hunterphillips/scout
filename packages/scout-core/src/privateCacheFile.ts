import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";

/**
 * File-system rules shared by Scout's on-disk caches (the catalog cache and the resource
 * discovery cache): one JSON file per origin in a private directory Scout owns.
 */

/**
 * Longest a cached answer may stand in for the site when a refresh fails: a catalog older
 * than this is no longer served stale, and discovered text older than this is no longer
 * kept as the last good copy.
 */
export const CACHE_STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** Longest readable host prefix in a cache file name; the hash suffix keeps names unique. */
const FILE_PREFIX_MAX = 100;

/**
 * File name for an origin: a readable prefix (host lowercased, `:` and any other unsafe
 * character turned into `_`, at most 100 characters) then `-` and the first 16 hex digits
 * of the SHA-256 of the origin. The hash keeps names unique where the prefix collides
 * (`a_8443` vs `a:8443`) or is cut short, and the length bound keeps the temp name under
 * the file-system limit for any host.
 */
export function cacheFileName(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:") throw new TypeError("cache origin must be https");
  const name = url.host.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
  if (!name || /^\.+$/.test(name)) throw new TypeError("cache origin has no usable host");
  const hash = createHash("sha256").update(url.origin).digest("hex").slice(0, 16);
  return `${name.slice(0, FILE_PREFIX_MAX)}-${hash}.json`;
}

export type DirRefusal = "symlink" | "not_directory" | "wrong_owner" | "not_private";

/** Why `dir` is unsafe to use for a cache, or null if it is a private directory we own. Mirrors `ensurePrivateRunDir`. Throws if lstat fails. */
export function checkPrivateDir(dir: string, uid: number = process.getuid?.() ?? -1): DirRefusal | null {
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) return "symlink";
  if (!st.isDirectory()) return "not_directory";
  if (st.uid !== uid) return "wrong_owner";
  if ((st.mode & 0o077) !== 0) return "not_private";
  return null;
}

/** A short code for a file-system error, safe for diagnostics. */
export function fsErrorCode(error: unknown): string {
  switch ((error as NodeJS.ErrnoException | null)?.code) {
    case "ENOTDIR":
      return "enotdir";
    case "EEXIST":
      // mkdir hit an existing non-directory: most likely the cache dir path is a regular file.
      return "not_directory";
    case "ENAMETOOLONG":
      return "enametoolong";
    case "EACCES":
    case "EPERM":
      return "eacces";
    default:
      return "other";
  }
}
