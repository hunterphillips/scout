// A backend's environment, built only from its reviewed definition: the setup CLI's view of
// the bindings toolProfile.ts stores. Used by `agent inspect` / `refresh` (resolve before the
// one permitted launch) and `agent status` (check each binding, report why one fails).
//
// - The environment is exactly the connection's `literalEnv` plus its resolved bindings, the
//   same composition the per-job bridge uses (contextToolBridge.ts). Nothing comes from this
//   process's environment: what a terminal, a login shell or Finder would have inherited
//   makes no difference, and nothing reads `process.env` here.
// - Resolution is toolProfile.ts's resolveEnvBindings: each file a regular file owned by this
//   user, mode 0600 or stricter, at most 4 MiB, JSON, an RFC 6901 pointer to a string of at
//   most MAX_BINDING_VALUE_CHARS. Values stay in memory, handed only to the spawn.
// - A check reports, per binding, a fixed status code: never the value. The codes name what
//   the user can fix (missing file, wrong mode or owner, too large, not JSON, bad pointer,
//   not a string).

import { BindingError, type BindingErrorCode, type BindingFs, type Connection, resolveEnvBindings } from "./toolProfile.js";

export type BindingStatus = "ok" | "file_missing" | "file_unreadable" | "file_not_private" | "file_too_large" | "file_not_json" | "pointer_not_found" | "value_not_string" | "name_refused";

const STATUS_BY_CODE: Record<BindingErrorCode, Exclude<BindingStatus, "ok">> = {
  "binding: file missing": "file_missing",
  "binding: file unreadable": "file_unreadable",
  "binding: file not a private regular file owned by this user": "file_not_private",
  "binding: file too large": "file_too_large",
  "binding: file not JSON": "file_not_json",
  "binding: pointer not found": "pointer_not_found",
  "binding: value not a usable string": "value_not_string",
  "binding: name refused": "name_refused",
};

/** What each status means, for the CLI (no paths, pointers or values). */
export const BINDING_STATUS_TEXT: Record<BindingStatus, string> = {
  ok: "ok",
  file_missing: "file missing",
  file_unreadable: "file unreadable",
  file_not_private: "file is not a regular file owned by you with mode 0600",
  file_too_large: "file larger than 4 MiB",
  file_not_json: "file is not JSON",
  pointer_not_found: "pointer not found in the file",
  value_not_string: "value is not a string (or is too long)",
  name_refused: "variable name refused",
};

export interface BindingCheck {
  name: string;
  file: string;
  pointer: string;
  status: BindingStatus;
}

type EnvSource = Pick<Connection, "env" | "literalEnv">;

const statusOf = (e: unknown): Exclude<BindingStatus, "ok"> => (e instanceof BindingError ? STATUS_BY_CODE[e.code] : "file_unreadable");

/** Dry-run each binding on its own and report its status; the values are discarded. */
export function checkEnvBindings(env: EnvSource["env"], fs: BindingFs = {}): BindingCheck[] {
  return Object.entries(env).map(([name, b]) => {
    let status: BindingStatus = "ok";
    try {
      resolveEnvBindings({ [name]: b }, fs);
    } catch (e) {
      status = statusOf(e);
    }
    return { name, file: b.file, pointer: b.pointer, status };
  });
}

export type BackendEnvResult = { ok: true; env: Record<string, string> } | { ok: false; failures: BindingCheck[] };

/**
 * The backend's exact environment: `literalEnv` plus the resolved bindings (the schema keeps
 * the names disjoint). On any failure, every binding's status instead, so the caller can
 * report all of them; the values resolved meanwhile are dropped.
 */
export function resolveBackendEnv(source: EnvSource, fs: BindingFs = {}): BackendEnvResult {
  try {
    return { ok: true, env: { ...source.literalEnv, ...resolveEnvBindings(source.env, fs) } };
  } catch {
    return { ok: false, failures: checkEnvBindings(source.env, fs).filter((c) => c.status !== "ok") };
  }
}
