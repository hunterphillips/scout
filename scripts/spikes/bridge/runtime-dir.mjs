// Scout Phase 0 bridge spike: private runtime directory and socket checks.
//
// The runtime directory must be a real directory (not a symlink) owned by the
// current user with mode 0700. It is created with 0700 when missing and is
// refused, never loosened or tightened in place, when it already exists with
// other permissions. The socket inside it is bound and connected by relative
// basename with the process cwd set to the directory, so the macOS sun_path
// limit (104 bytes) never applies to the long absolute path.

import { lstatSync, mkdirSync } from "node:fs";

export const SOCKET_NAME = "bridge.sock";

export class RuntimeDirError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** Create (0700) or verify a private runtime dir. Returns its lstat. */
export function ensurePrivateRuntimeDir(dir) {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if (e.code !== "EEXIST") throw new RuntimeDirError("runtime-dir-create-failed");
  }
  return checkPrivateRuntimeDir(dir);
}

export function checkPrivateRuntimeDir(dir) {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw new RuntimeDirError("runtime-dir-missing");
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new RuntimeDirError("runtime-dir-not-directory");
  if (st.uid !== process.getuid()) throw new RuntimeDirError("runtime-dir-wrong-owner");
  if ((st.mode & 0o777) !== 0o700) throw new RuntimeDirError("runtime-dir-not-private");
  return st;
}

/** Verify the socket file (relative to cwd) is ours. Returns lstat or null. */
export function checkOwnSocket(name = SOCKET_NAME) {
  let st;
  try {
    st = lstatSync(name);
  } catch {
    return null;
  }
  if (!st.isSocket()) throw new RuntimeDirError("socket-not-socket");
  if (st.uid !== process.getuid()) throw new RuntimeDirError("socket-wrong-owner");
  if ((st.mode & 0o077) !== 0) throw new RuntimeDirError("socket-not-private");
  return st;
}
