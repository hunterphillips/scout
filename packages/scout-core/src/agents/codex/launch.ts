// How one Codex job is launched: the private Codex home, the job dir and its files, the child
// env and the argv. Runs no model calls.
//
// Private Codex home (`SCOUT_HOME/run/codex-home`, 0700, kept across jobs and core starts):
// the job's CODEX_HOME, so Codex reads none of the user's config, rules, history or sessions.
// Its only link to the user's own Codex home is `auth.json`, a symlink to
// `<user CODEX_HOME>/auth.json` (parent env CODEX_HOME when absolute, else `$HOME/.codex`).
// Codex writes auth in place, so a token refresh goes through the link and the user's login
// stays current. ensureCodexHome creates the link when missing and re-points one Scout made
// at another target (the user's CODEX_HOME moved); anything else at that path (a regular
// file, a directory) is never removed: `auth_link_invalid`. readiness.ts checks the target.
// Codex adds its own caches there (models cache, installation id, plugin and skill dirs);
// sessions and history are off (`--ephemeral`, `history.persistence="none"`).
//
// Per job: `SCOUT_HOME/run/jobs/<request-id>/` (0700, exclusive) holds `agent-token`,
// `schema.json` (outputSchema.ts) and, with selected user tools, `bridge.json`, all 0600, plus
// `state/` (CODEX_SQLITE_HOME), so Codex's SQLite state dies with the job dir. Codex itself
// runs from the one stable `SCOUT_HOME/run/agent-cwd` with a read-only sandbox.
//
// Child env: the same allowlist as Claude's launch profile (FORWARD_KEYS: HOME, USER,
// LOGNAME, PATH, SHELL, LANG, LC_ALL, LC_CTYPE, TMPDIR, those present) plus CODEX_HOME and
// CODEX_SQLITE_HOME. CODEX_API_KEY, CODEX_ACCESS_TOKEN and OPENAI_API_KEY are never
// forwarded (readiness.ts refuses to run while any is set).
//
// The argv is the shape verified against Codex CLI 0.155.1 on 2026-10-06 (the Phase 0 probe):
//   exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check
//   --color never -C <agent-cwd> -s read-only -m <model> -c model_reasoning_effort="<e>"
//   -c features.hooks=false -c project_doc_max_bytes=0 -c history.persistence="none"
//   -c analytics.enabled=false -c check_for_update_on_startup=false -c web_search="disabled"
//   -c features.shell_tool=false --disable apps <server overrides> --output-schema <file> -
// with the prompt on stdin. Never passed: --yolo, --full-auto, --dangerously-*, a writable
// sandbox, --oss, --add-dir, resume, fork.
//
// Server overrides (renderCodexServerOverrides): five `-c` lines per job server (jobSurface.ts
// names `scout` and `scout_bridge`): `command` and `args` as JSON strings and a JSON string
// array (both valid TOML values: JSON.stringify escapes every control character), `required`,
// `startup_timeout_sec=10`, and `default_tools_approval_mode="approve"` (no approval prompt
// can stall an unattended job; the event monitor halts on any tool outside the surface).

import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AgentRequestIdSchema } from "@scout/contracts";
import { ensureAgentCwd, ensurePrivateRunDir } from "../../localSocketFiles.js";
import type { JobToolSurface } from "../adapter.js";
import type { BridgeJob } from "../contextToolBridge.js";
import { isExecutableFile, type Env } from "../executables.js";
import type { Out } from "../jobStop.js";
import { buildJobSurface, defaultScoutMcpEntrypoint, type JobSurface } from "../claudeCode/jobSurface.js";
import { ensureJobsRoot, FORWARD_KEYS } from "../claudeCode/launchProfile.js";
import { defaultBridgeEntrypoint, planJobTools, type ToolPlanOptions, type UnavailableTool } from "../claudeCode/toolPolicy.js";
import { CODEX_OUTPUT_SCHEMA } from "./outputSchema.js";
import { DEFAULT_CODEX_REASONING_EFFORT, type CodexProfile } from "./profile.js";

export const CODEX_HOME_DIR = "codex-home";
export const AUTH_FILE = "auth.json";
/** Never forwarded; any of them in the parent env makes readiness `ambiguous` (`env_api_key`). */
export const API_KEY_ENV: readonly string[] = Object.freeze(["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"]);
export const MCP_STARTUP_TIMEOUT_SEC = 10;

export const JOB_FILES = Object.freeze({ token: "agent-token", schema: "schema.json", bridge: "bridge.json", state: "state" });

// ---------- the private Codex home ----------

/** The user's own Codex home: parent env CODEX_HOME when absolute, else `$HOME/.codex`; undefined without either. */
export function userCodexHome(parentEnv: Env): string | undefined {
  const ch = parentEnv.CODEX_HOME;
  if (typeof ch === "string" && isAbsolute(ch)) return ch;
  const home = parentEnv.HOME;
  return typeof home === "string" && isAbsolute(home) ? join(home, ".codex") : undefined;
}

export type CodexHomeResult = { ok: true; codexHome: string; userAuthPath: string } | { ok: false; reason: "codex_home_unusable" | "auth_link_invalid" };

/**
 * Create (0700) or check `<home>/run/codex-home` and its `auth.json` link. Idempotent; never
 * throws; never removes anything but a symlink at `auth.json` that points elsewhere.
 */
export function ensureCodexHome(home: string, parentEnv: Env, uid: number = process.getuid?.() ?? -1): CodexHomeResult {
  const userHome = userCodexHome(parentEnv);
  if (userHome === undefined) return { ok: false, reason: "codex_home_unusable" };
  const userAuthPath = join(userHome, AUTH_FILE);
  const codexHome = join(home, "run", CODEX_HOME_DIR);
  try {
    ensurePrivateRunDir(join(home, "run"), uid);
    try {
      mkdirSync(codexHome, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const st = lstatSync(codexHome);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid) throw new Error("codex home is not a private directory");
    if ((st.mode & 0o077) !== 0) chmodSync(codexHome, 0o700);
  } catch {
    return { ok: false, reason: "codex_home_unusable" };
  }
  const link = join(codexHome, AUTH_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    let st;
    try {
      st = lstatSync(link);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, reason: "auth_link_invalid" };
      try {
        symlinkSync(userAuthPath, link);
        return { ok: true, codexHome, userAuthPath };
      } catch {
        continue; // another check made it meanwhile: look again
      }
    }
    if (!st.isSymbolicLink()) return { ok: false, reason: "auth_link_invalid" };
    try {
      if (readlinkSync(link) === userAuthPath) return { ok: true, codexHome, userAuthPath };
      unlinkSync(link); // Scout's own link to an older user Codex home
    } catch {
      return { ok: false, reason: "auth_link_invalid" };
    }
  }
  return { ok: false, reason: "auth_link_invalid" };
}

// ---------- env and argv ----------

/** The allowlisted child env plus CODEX_HOME and CODEX_SQLITE_HOME. */
export function codexChildEnv(parentEnv: Env, codexHome: string, sqliteHome: string): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const k of FORWARD_KEYS) {
    const v = parentEnv[k];
    if (typeof v === "string") env[k] = v;
  }
  env.CODEX_HOME = codexHome;
  env.CODEX_SQLITE_HOME = sqliteHome;
  return Object.freeze(env);
}

/** Five `-c` overrides per job server, in surface order. */
export function renderCodexServerOverrides(surface: Pick<JobSurface, "mcpConfig" | "expected">): string[] {
  const out: string[] = [];
  for (const s of surface.expected) {
    const entry = surface.mcpConfig.mcpServers[s.name];
    if (!entry || entry.env !== undefined) throw new Error("surface: unsupported server");
    const key = `mcp_servers.${s.name}`;
    out.push(
      "-c",
      `${key}.command=${JSON.stringify(entry.command)}`,
      "-c",
      `${key}.args=${JSON.stringify(entry.args)}`,
      "-c",
      `${key}.required=${s.required ? "true" : "false"}`,
      "-c",
      `${key}.startup_timeout_sec=${MCP_STARTUP_TIMEOUT_SEC}`,
      "-c",
      `${key}.default_tools_approval_mode="approve"`,
    );
  }
  return out;
}

export interface CodexArgvOptions {
  cwd: string;
  model: string;
  reasoningEffort: string;
  schemaFile: string;
  surface: Pick<JobSurface, "mcpConfig" | "expected">;
}

/** argv after the codex path. */
export function buildCodexArgv(o: CodexArgvOptions): string[] {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-C",
    o.cwd,
    "-s",
    "read-only",
    "-m",
    o.model,
    "-c",
    `model_reasoning_effort="${o.reasoningEffort}"`,
    "-c",
    "features.hooks=false",
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    'history.persistence="none"',
    "-c",
    "analytics.enabled=false",
    "-c",
    "check_for_update_on_startup=false",
    "-c",
    'web_search="disabled"',
    "-c",
    "features.shell_tool=false",
    "--disable",
    "apps",
    ...renderCodexServerOverrides(o.surface),
    "--output-schema",
    o.schemaFile,
    "-",
  ];
}

// ---------- one job's launch ----------

export interface CodexLaunchOptions {
  /** SCOUT_HOME. */
  home: string;
  profile: CodexProfile;
  parentEnv: Env;
  requestId: string;
  /** Scout's socket and this job's token. */
  surface: JobToolSurface;
  /** The private Codex home (ensureCodexHome). */
  codexHome: string;
  workspaceRoots?: readonly string[];
  nodePath?: string;
  scoutMcpEntrypoint?: string;
  bridgeEntrypoint?: string;
  bridgeLimits?: BridgeJob["limits"];
}

export interface CodexLaunch {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** The CLI's working directory (`run/agent-cwd`). */
  readonly cwd: string;
  /** `run/jobs/<request-id>`. */
  readonly jobDir: string;
  /** The servers and exact tools the job may use. */
  readonly toolSurface: JobSurface;
  /** Optional selected tools left out before launch. */
  readonly unavailable: readonly UnavailableTool[];
  /** Removes the job dir and everything in it. */
  cleanup(): void;
}

export type CodexLaunchResult = { ok: true; launch: CodexLaunch } | { ok: false; out: Out };

const failed = (result: Out["result"], termination: Out["termination"], detail: string): CodexLaunchResult => ({ ok: false, out: { result, termination, detail } });

/** Build the job dir, its files, the env and the argv. Never throws; a failure is an outcome. */
export function createCodexLaunch(o: CodexLaunchOptions): CodexLaunchResult {
  const { profile } = o;
  if (!AgentRequestIdSchema.safeParse(o.requestId).success) return failed({ status: "error", reason: "unsupported_configuration" }, "unsupported_configuration", "launch_profile");
  if (typeof o.parentEnv.HOME !== "string" || !isAbsolute(o.parentEnv.HOME)) return failed({ status: "error", reason: "unsupported_configuration" }, "unsupported_configuration", "launch_profile");
  if (!isAbsolute(profile.codexPath) || !isExecutableFile(profile.codexPath)) return failed({ status: "unavailable", reason: "agent_unavailable" }, "agent_unavailable", "launch_profile");

  let cwd: string;
  let jobDir: string;
  try {
    cwd = ensureAgentCwd(o.home);
    const root = ensureJobsRoot(join(o.home, "run", "jobs"), o.workspaceRoots);
    jobDir = join(root, o.requestId);
    mkdirSync(jobDir, { mode: 0o700 }); // exclusive: an existing dir is never reused or removed
  } catch {
    return failed({ status: "error", reason: "agent_failed" }, "process_error", "launch_profile");
  }
  const cleanup = (): void => rmSync(jobDir, { recursive: true, force: true });
  try {
    const st = lstatSync(jobDir);
    const owned = typeof process.getuid !== "function" || st.uid === process.getuid();
    if (!st.isDirectory() || !owned || (st.mode & 0o777) !== 0o700) throw new Error("job dir is not private");
    mkdirSync(join(jobDir, JOB_FILES.state), { mode: 0o700 });

    const nodePath = o.nodePath ?? process.execPath;
    const planOpts: ToolPlanOptions = {
      tools: profile.tools,
      scout: { nodePath, entrypoint: o.scoutMcpEntrypoint ?? defaultScoutMcpEntrypoint(), socketPath: o.surface.scout.socketPath, tokenFile: join(jobDir, JOB_FILES.token) },
      bridge: { nodePath, entrypoint: o.bridgeEntrypoint ?? defaultBridgeEntrypoint(), jobFile: join(jobDir, JOB_FILES.bridge) },
    };
    if (o.bridgeLimits) planOpts.limits = o.bridgeLimits;
    const plan = planJobTools(planOpts);
    if (!plan.ok) {
      cleanup();
      return failed({ status: "error", reason: plan.reason }, plan.reason, plan.detail);
    }
    const toolSurface = buildJobSurface(plan.spec);
    const write = (name: string, text: string): void => writeFileSync(join(jobDir, name), text, { mode: 0o600, flag: "wx" });
    write(JOB_FILES.token, `${o.surface.scout.token}\n`);
    write(JOB_FILES.schema, `${JSON.stringify(CODEX_OUTPUT_SCHEMA)}\n`);
    if (plan.bridgeJob) write(JOB_FILES.bridge, JSON.stringify(plan.bridgeJob));
    const argv = buildCodexArgv({
      cwd,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
      schemaFile: join(jobDir, JOB_FILES.schema),
      surface: toolSurface,
    });
    const env = codexChildEnv(o.parentEnv, o.codexHome, join(jobDir, JOB_FILES.state));
    return { ok: true, launch: Object.freeze({ argv: Object.freeze(argv), env, cwd, jobDir, toolSurface, unavailable: Object.freeze([...plan.unavailable]), cleanup }) };
  } catch {
    try {
      cleanup();
    } catch {
      // reported by the caller's own cleanup check
    }
    return failed({ status: "error", reason: "agent_failed" }, "process_error", "setup_failed");
  }
}
