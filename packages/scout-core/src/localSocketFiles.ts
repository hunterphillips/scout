// The filesystem lifecycle of a private Unix socket in <scoutHome>/run/, shared by the
// browser socket (core.sock) and the agent socket (agent.sock). Framing and protocol stay
// with each server; only the files are handled here.
//
// The run dir must be a real directory (not a symlink) owned by us with mode 0700. It is
// created 0700 when missing and refused, never chmod-ed, when it exists with other
// permissions. An existing socket file is removed only after a connect probe is refused
// (a stale socket); a live one means another core is running, and publishing refuses.
// The listener binds a temp name (<name>.<pid>.tmp), is chmod-ed 0600, and only then is
// hard-linked to the final name, so the final name never shows the umask mode. link (not
// rename) fails if another core claimed the name in the meantime, instead of replacing it.
// On close, the final name is removed only while it is still the inode we bound.

import { chmodSync, linkSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, type Server } from "node:net";
import { join } from "node:path";

/** A live-socket probe that neither connects nor fails by then counts as live. */
export const PROBE_TIMEOUT_MS = 1_000;

export type SocketServerErrorCode =
  | "runtime-dir-create-failed"
  | "runtime-dir-not-directory"
  | "runtime-dir-wrong-owner"
  | "runtime-dir-not-private"
  | "socket-not-socket"
  | "socket-wrong-owner"
  | "socket-probe-failed"
  | "already-running"
  | "listen-failed";

export class SocketServerError extends Error {
  constructor(readonly code: SocketServerErrorCode) {
    super(code);
    this.name = "SocketServerError";
  }
}

export interface PublishOptions {
  runDir: string;
  socketName: string;
  /** Not yet listening; it is bound here and closed again if publishing fails. */
  server: Server;
  /** Called when publishing fails after the bind, to drop connections accepted meanwhile. */
  dropConnections: () => void;
  /** Test seam for the post-listen chmod of the temp socket; defaults to fs.chmodSync. */
  chmod?: (path: string, mode: number) => void;
}

export interface PublishedSocket {
  readonly socketPath: string;
  /** Close the listener (connections are the caller's) and remove the socket if it is still ours. */
  close(): Promise<void>;
}

/** Bind `server` privately and publish it under `runDir/socketName`; see the file header. */
export async function publishPrivateSocket(options: PublishOptions): Promise<PublishedSocket> {
  const socketPath = join(options.runDir, options.socketName);
  const tempPath = `${socketPath}.${process.pid}.tmp`;
  const srv = options.server;
  ensurePrivateRunDir(options.runDir);
  await clearStaleSocket(socketPath);

  // A leftover temp name from an earlier core with our pid would fail the bind.
  unlinkQuietly(tempPath);

  // No umask here: it is process-wide and would also apply to anything else created
  // while listen is pending (e.g. the diagnostics log dir). The run dir is 0700 and
  // owner-checked, and the socket is only published under its final name after the
  // chmod below.
  try {
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen({ path: tempPath }, () => {
        srv.off("error", reject);
        resolve();
      });
    });
  } catch {
    unlinkQuietly(tempPath);
    throw new SocketServerError("listen-failed");
  }
  let published = false;
  let ino: number;
  try {
    (options.chmod ?? chmodSync)(tempPath, 0o600);
    ino = lstatSync(tempPath).ino;
    try {
      linkSync(tempPath, socketPath);
    } catch (e) {
      throw new SocketServerError((e as NodeJS.ErrnoException).code === "EEXIST" ? "already-running" : "listen-failed");
    }
    published = true;
    unlinkSync(tempPath);
  } catch (e) {
    // Don't leak a listener nobody will close, or its socket files.
    options.dropConnections();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    unlinkQuietly(tempPath);
    if (published) unlinkQuietly(socketPath);
    throw e instanceof SocketServerError ? e : new SocketServerError("listen-failed");
  }

  let open = true;
  return {
    socketPath,
    async close() {
      if (!open) return;
      open = false;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      unlinkIfSameInode(socketPath, ino);
    },
  };
}

/** Remove `path` only while it is still inode `ino`; a newer core may own the path by now. */
export function unlinkIfSameInode(path: string, ino: number): void {
  try {
    if (lstatSync(path).ino === ino) unlinkSync(path);
  } catch {
    // Already gone.
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/** Create (0700) or verify the run dir. Never loosens or tightens an existing one. */
export function ensurePrivateRunDir(dir: string, uid: number = process.getuid?.() ?? -1): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    throw new SocketServerError("runtime-dir-create-failed");
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new SocketServerError("runtime-dir-not-directory");
  if (st.uid !== uid) throw new SocketServerError("runtime-dir-wrong-owner");
  if ((st.mode & 0o777) !== 0o700) throw new SocketServerError("runtime-dir-not-private");
}

/** Remove an existing socket only when a connect probe is refused. */
async function clearStaleSocket(path: string, uid: number = process.getuid?.() ?? -1): Promise<void> {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (!st.isSocket()) throw new SocketServerError("socket-not-socket");
  if (st.uid !== uid) throw new SocketServerError("socket-wrong-owner");
  const probe = await probeSocket(path);
  if (probe === "live") throw new SocketServerError("already-running");
  if (probe === "gone") return;
  if (probe === "refused") {
    try {
      unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new SocketServerError("socket-probe-failed");
    }
    return;
  }
  throw new SocketServerError("socket-probe-failed");
}

function probeSocket(path: string): Promise<"live" | "refused" | "gone" | "error"> {
  return new Promise((resolve) => {
    const s = createConnection({ path });
    const done = (result: "live" | "refused" | "gone" | "error"): void => {
      clearTimeout(timer);
      s.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done("live"), PROBE_TIMEOUT_MS);
    s.once("connect", () => done("live"));
    s.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ECONNREFUSED") done("refused");
      else if (e.code === "ENOENT") done("gone");
      else done("error");
    });
  });
}
