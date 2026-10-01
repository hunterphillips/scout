// One bounded read of a local file that must be a regular file, shared by the env-binding
// resolver (toolProfile.ts), the bridge's job file (contextToolBridge.ts) and the managed
// settings check (toolPolicy.ts).
//
// The file is opened with O_NOFOLLOW (a symlink is refused) and O_NONBLOCK (opening a FIFO
// or device returns at once instead of blocking the caller), then fstat'd and read on the
// same descriptor, so what is checked is what is read. At most `cap` bytes are accepted,
// whatever the size said: the file may grow meanwhile.

import { closeSync, constants as fsc, fstatSync, openSync, readSync } from "node:fs";

export type PrivateFileErrorCode = "missing" | "unreadable" | "not_regular" | "not_private" | "too_large";

export class PrivateFileError extends Error {
  constructor(readonly code: PrivateFileErrorCode) {
    super(`file: ${code}`); // fixed code only: never a path
    this.name = "PrivateFileError";
  }
}

export interface ReadPrivateFileOptions {
  /** Require ownership by this user and no group/other permission bits. */
  private: boolean;
  /** Test seam. */
  getuid?: () => number;
}

/** Whether an fs error means the path is absent. */
export const isMissing = (e: unknown): boolean => ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException | null)?.code ?? "");

/** Read `path` as described above; throws PrivateFileError. */
export function readPrivateFile(path: string, cap: number, opts: ReadPrivateFileOptions): Buffer {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch (e) {
    throw new PrivateFileError(isMissing(e) ? "missing" : "unreadable");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new PrivateFileError("not_regular");
    if (opts.private) {
      const uid = opts.getuid ?? process.getuid;
      const owned = typeof uid !== "function" || st.uid === uid();
      if (!owned || (st.mode & 0o077) !== 0) throw new PrivateFileError("not_private");
    }
    if (st.size > cap) throw new PrivateFileError("too_large");
    const buf = Buffer.alloc(cap + 1);
    let n = 0;
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
      if (n > cap) throw new PrivateFileError("too_large");
    }
    return buf.subarray(0, n);
  } catch (e) {
    throw e instanceof PrivateFileError ? e : new PrivateFileError("unreadable");
  } finally {
    closeSync(fd);
  }
}
