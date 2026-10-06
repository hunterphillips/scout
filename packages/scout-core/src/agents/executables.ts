// Executable lookup without a shell: whether a path is runnable, and a PATH search.

import { accessSync, constants as fsc, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** An environment as a child process gets it. */
export type Env = Readonly<Record<string, string | undefined>>;

/** Resolve a command to an absolute executable path from a PATH value. No config writes. */
export function resolveOnPath(cmd: string, pathValue: string | undefined): string | undefined {
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, cmd);
    try {
      if (statSync(p).isFile()) {
        accessSync(p, fsc.X_OK);
        return p;
      }
    } catch {
      // not here
    }
  }
  return undefined;
}

/** Whether `p` is an existing file the current user may execute. */
export function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsc.X_OK);
    return true;
  } catch {
    return false;
  }
}
