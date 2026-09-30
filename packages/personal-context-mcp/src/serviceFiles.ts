// The service's own files under <home>: the bearer token and run/server.json. Shared by
// the server and the `pcm` CLI.
//
// <home>/token: 32 random bytes as hex, a regular file owned by us, mode exactly 0600.
// Created on the server's first start; an existing file that is anything else is refused,
// never repaired. Its content never appears in a log, message or output.
//
// <home>/run/server.json: {pid, port, serviceInstanceId, startedAt}, written after the
// server listens (dir 0700, file 0600) and removed on a clean exit.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsc,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const TOKEN_FILE = "token";
export const RUN_DIR = "run";
export const SERVER_FILE = "server.json";
const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Fixed messages; none carries a path or a value. */
export const MESSAGES = Object.freeze({
  tokenUnsafe: "token file is not a regular 0600 file owned by this user; remove it and restart",
  tokenUnreadable: "token file is unreadable or malformed; remove it and restart",
  alreadyRunning: "another personal-context server is already running (run/server.json names a live pid)",
  privateDir: "a service directory is not a private directory owned by this user",
});

export class ServiceFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceFileError";
  }
}

const uid = (): number => process.getuid?.() ?? -1;

/**
 * Create `dir` 0700 when missing, then require a real directory owned by us with no
 * group/other bits. An existing directory is never chmod'ed.
 */
export function ensurePrivateDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    throw new ServiceFileError(MESSAGES.privateDir);
  }
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw new ServiceFileError(MESSAGES.privateDir);
  }
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid() || (st.mode & 0o077) !== 0) {
    throw new ServiceFileError(MESSAGES.privateDir);
  }
}

/** Read a small file without following a symlink. Returns undefined when it does not exist. */
function readSmall(path: string, max: number): { text: string; mode: number; uid: number; isFile: boolean } | undefined {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    // ELOOP: a symlink. Anything else: unreadable. Both are "not a regular file of ours".
    return { text: "", mode: 0, uid: -2, isFile: false };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { text: "", mode: st.mode, uid: st.uid, isFile: false };
    const buf = Buffer.alloc(max + 1);
    let len = 0;
    for (;;) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
      if (len > max) break;
    }
    return { text: buf.subarray(0, len).toString("utf8"), mode: st.mode, uid: st.uid, isFile: true };
  } finally {
    closeSync(fd);
  }
}

/** The token, creating it (0600, exclusive) when missing. Throws ServiceFileError with a fixed message. */
export function ensureToken(home: string): string {
  const path = join(home, TOKEN_FILE);
  const existing = readSmall(path, 256);
  if (existing === undefined) {
    const token = randomBytes(32).toString("hex");
    let fd: number;
    try {
      fd = openSync(path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
    } catch (e) {
      // A concurrent first start created it between our read and our open: use theirs.
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return readConcurrentToken(home);
      throw new ServiceFileError(MESSAGES.tokenUnreadable);
    }
    try {
      writeSync(fd, token + "\n");
    } finally {
      closeSync(fd);
    }
    return readToken(home);
  }
  return checkToken(existing);
}

/** readToken, retried for up to ~0.5 s while another process finishes writing the file. */
function readConcurrentToken(home: string): string {
  for (let attempt = 0; ; attempt++) {
    try {
      return readToken(home);
    } catch (e) {
      if (attempt >= 25 || !(e instanceof ServiceFileError) || e.message !== MESSAGES.tokenUnreadable) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

function checkToken(f: { text: string; mode: number; uid: number; isFile: boolean }): string {
  if (!f.isFile || f.uid !== uid() || (f.mode & 0o777) !== 0o600) throw new ServiceFileError(MESSAGES.tokenUnsafe);
  const token = f.text.trim();
  if (!TOKEN_RE.test(token)) throw new ServiceFileError(MESSAGES.tokenUnreadable);
  return token;
}

/** Read an existing token with the same checks. Throws ServiceFileError when missing or unsafe. */
export function readToken(home: string): string {
  const f = readSmall(join(home, TOKEN_FILE), 256);
  if (f === undefined) throw new ServiceFileError(MESSAGES.tokenUnreadable);
  return checkToken(f);
}

export interface ServerInfo {
  pid: number;
  port: number;
  serviceInstanceId: string;
  startedAt: string;
}

export function serverFilePath(home: string): string {
  return join(home, RUN_DIR, SERVER_FILE);
}

/** run/server.json when present and well-formed; undefined otherwise. */
export function readServerInfo(home: string): ServerInfo | undefined {
  let f;
  try {
    f = readSmall(serverFilePath(home), 4096);
  } catch {
    return undefined;
  }
  if (f === undefined || !f.isFile) return undefined;
  try {
    const v = JSON.parse(f.text) as Record<string, unknown>;
    const { pid, port, serviceInstanceId, startedAt } = v;
    if (!Number.isInteger(pid) || (pid as number) <= 0 || !Number.isInteger(port) || typeof serviceInstanceId !== "string" || typeof startedAt !== "string") {
      return undefined;
    }
    return { pid: pid as number, port: port as number, serviceInstanceId, startedAt };
  } catch {
    return undefined;
  }
}

/** Whether a pid names a live process (EPERM counts as alive). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Atomically write run/server.json (dir 0700, file 0600). */
export function writeServerInfo(home: string, info: ServerInfo): void {
  const dir = join(home, RUN_DIR);
  ensurePrivateDir(dir);
  const tmp = join(dir, `.${SERVER_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, JSON.stringify(info) + "\n");
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, serverFilePath(home));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Remove run/server.json only when it still names `pid`. */
export function removeServerInfo(home: string, pid: number): void {
  const cur = readServerInfo(home);
  if (cur !== undefined && cur.pid !== pid) return;
  rmSync(serverFilePath(home), { force: true });
}
