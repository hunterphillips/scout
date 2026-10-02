// The capability store's advisory cross-process lock: `capabilities/store.lock`, created with
// O_CREAT | O_EXCL (0600) and holding `{pid, instanceId, startedAt}`. One writer at a time:
// the running core holds it, so the dev CLI cannot change decisions behind the core's back.
// The agent profile reuses it as `<SCOUT_HOME>/agent-profile.lock` (`options.file`).
//
// A lock is stale, and reclaimed, when its process is gone (`kill(pid, 0)` → ESRCH) or is not
// ours to signal (EPERM: another user's process reusing the pid). A file that does not parse
// is stale only once it is older than LOCK_PARSE_GRACE_MS, so a holder caught between create
// and write is not robbed. Reclaim re-reads the file and removes it only if it is unchanged;
// two reclaimers racing on the same stale lock remain a narrow window (no compare-and-unlink
// exists on POSIX), and the O_EXCL create after it still lets only one of them win.
//
// Release removes the file only while it is still ours: the same inode we created and our
// instanceId in it. Every lock this process holds is also registered, so a shutdown that ran out of
// time can release them synchronously (`releaseHeldLocks(dir)`) without waiting for their owners.

import { randomBytes } from "node:crypto";
import { closeSync, constants as fsc, fstatSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join, sep } from "node:path";

export const LOCK_FILE = "store.lock";
export const LOCK_PARSE_GRACE_MS = 5000;

export interface LockRecord {
  pid: number;
  instanceId: string;
  startedAt: number;
}

/** Another live process of this user holds the store. */
export class StoreLockedError extends Error {
  readonly code = "store_locked";
  constructor(readonly holderPid: number | undefined) {
    super("capability store: locked by another process");
    this.name = "StoreLockedError";
  }
}

export interface StoreLock {
  readonly instanceId: string;
  /** Remove the lock file if it is still ours. Idempotent. */
  release(): void;
}

export interface LockOptions {
  now: () => number;
  /** The lock file's name in `dir`; LOCK_FILE by default. The agent profile uses `agent-profile.lock`. */
  file?: string;
  pid?: number;
  /** Test seam: `process.kill(pid, 0)`. */
  probe?: (pid: number) => void;
}

/** Every lock this process holds, by path. */
const held = new Map<string, StoreLock>();

/**
 * Release, synchronously, every lock this process holds in `dir` or below it (each only if it is
 * still ours). For a shutdown out of time; returns how many were held.
 */
export function releaseHeldLocks(dir: string): number {
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  let n = 0;
  for (const [path, lock] of [...held]) {
    if (!path.startsWith(prefix)) continue;
    lock.release();
    n++;
  }
  return n;
}

function readLock(path: string): { text: string; record?: LockRecord; mtimeMs: number } | undefined {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    const text = st.isFile() && st.size <= 4096 ? readFileSync(fd, "utf8") : "";
    let record: LockRecord | undefined;
    try {
      const j = JSON.parse(text) as Partial<LockRecord>;
      if (Number.isInteger(j.pid) && (j.pid as number) > 0 && typeof j.instanceId === "string" && typeof j.startedAt === "number") record = j as LockRecord;
    } catch {
      // Unparseable: judged by age below.
    }
    return { text, ...(record ? { record } : {}), mtimeMs: st.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

function alive(pid: number, probe: (pid: number) => void): boolean {
  try {
    probe(pid);
    return true;
  } catch {
    // ESRCH: gone. EPERM: a process we may not signal, so not ours.
    return false;
  }
}

/** Take the lock in `dir`, reclaiming a stale one once. Throws StoreLockedError when a live holder has it. */
export function acquireStoreLock(dir: string, options: LockOptions): StoreLock {
  const path = join(dir, options.file ?? LOCK_FILE);
  const pid = options.pid ?? process.pid;
  const probe = options.probe ?? ((p: number) => void process.kill(p, 0));
  const record: LockRecord = { pid, instanceId: randomBytes(16).toString("hex"), startedAt: options.now() };
  const text = JSON.stringify(record);

  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      const held = readLock(path);
      if (!held) continue; // vanished meanwhile: try again
      const stale = held.record ? !alive(held.record.pid, probe) : options.now() - held.mtimeMs > LOCK_PARSE_GRACE_MS;
      if (!stale) throw new StoreLockedError(held.record?.pid);
      if (readLock(path)?.text === held.text) {
        try {
          unlinkSync(path);
        } catch {
          // Someone else reclaimed it first.
        }
      }
      continue;
    }
    let ino: number;
    try {
      ino = fstatSync(fd).ino;
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    let released = false;
    const lock: StoreLock = {
      instanceId: record.instanceId,
      release() {
        if (released) return;
        released = true;
        if (held.get(path) === lock) held.delete(path);
        if (readLock(path)?.record?.instanceId !== record.instanceId) return;
        try {
          if (lstatSync(path).ino === ino) unlinkSync(path);
        } catch {
          // Already gone.
        }
      },
    };
    held.set(path, lock);
    return lock;
  }
  throw new StoreLockedError(undefined);
}
