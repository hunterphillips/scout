// Prepare the private Pi agent directory for a job or readiness check. The user's auth.json
// remains the credential source, linked only after its ownership and 0600 mode are checked.
// models.json is linked when present. settings.json is copied through an explicit allowlist;
// extensions, skills, context files, hooks and every other user setting stay outside the job.

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Env } from "../executables.js";

/** The user's Pi agent dir, from an absolute override or `$HOME/.pi/agent`. */
export function userPiAgentDir(parentEnv: Env): string | undefined {
  const override = parentEnv.PI_CODING_AGENT_DIR;
  if (typeof override === "string" && isAbsolute(override)) return override;
  const home = parentEnv.HOME;
  return typeof home === "string" && isAbsolute(home) ? join(home, ".pi", "agent") : undefined;
}

/** Require a user-owned, regular, 0600 auth target before creating a job symlink. */
export function piAuthValid(userAgentDir: string): boolean {
  try {
    const st = lstatSync(join(userAgentDir, "auth.json"));
    const owned = process.getuid === undefined || st.uid === process.getuid();
    return st.isFile() && owned && (st.mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

/** Read at most 64 KiB from a regular, user-owned settings file without following links. */
function readSettings(path: string): Record<string, unknown> {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const st = fstatSync(fd);
    const owned = process.getuid === undefined || st.uid === process.getuid();
    if (!st.isFile() || st.size > 64 * 1024 || !owned) return {};
    const raw: unknown = JSON.parse(readFileSync(fd, "utf8"));
    return raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Create a 0700 directory with auth/models links and a 0600 allowlisted settings file. */
export function ensurePiAgentDir(dir: string, userAgentDir: string): void {
  if (!piAuthValid(userAgentDir)) throw new Error("auth_link_invalid");
  mkdirSync(dir, { mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || (st.mode & 0o777) !== 0o700) {
    throw new Error("agent dir is not private");
  }
  symlinkSync(join(userAgentDir, "auth.json"), join(dir, "auth.json"));

  const models = join(userAgentDir, "models.json");
  try {
    if (statSync(models).isFile()) symlinkSync(models, join(dir, "models.json"));
  } catch {
    // A custom models file is optional.
  }

  const source = readSettings(join(userAgentDir, "settings.json"));
  const settings: Record<string, unknown> = { quietStartup: true };
  if (typeof source.deviceId === "string") settings.deviceId = source.deviceId;
  if (typeof source.defaultProvider === "string") settings.defaultProvider = source.defaultProvider;
  if (typeof source.defaultModel === "string") settings.defaultModel = source.defaultModel;
  if (Array.isArray(source.enabledModels) && source.enabledModels.every((value) => typeof value === "string")) {
    settings.enabledModels = source.enabledModels;
  }
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings), { mode: 0o600, flag: "wx" });
}
