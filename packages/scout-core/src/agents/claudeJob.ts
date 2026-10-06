// Claude Code as an agent-job adapter: one fresh, unattended, read-only `claude -p` per job.
//
// Per job: a direct launch profile (launchProfile.ts: allowlisted child env, the agent
// profile's absolute claude path and explicit model) whose private 0700 cwd is
// `SCOUT_HOME/run/jobs/<request-id>/`. Four 0600 files go there (mcp.json, settings.json,
// instructions.md, agent-token), plus bridge.json when the profile selects user tools (the
// bridge's job file, holding the backend environment bindings but never their values, which
// only the bridge resolves, in memory, at spawn); the CLI is spawned argv-only, detached, with the request on
// stdin; the job dir is removed when the job ends, however it ends. The CLI itself runs from one
// stable cwd, `SCOUT_HOME/run/agent-cwd` (localSocketFiles.ts ensureAgentCwd: 0700, created when the adapter is built
// and checked before each spawn, never swept), so the real CLI's per-cwd `~/.claude/projects`
// folder appears once, not once per job; every path in its argv still names the job dir. From the spawn on, the job dir
// also holds `tree.json` (0600, written atomically: the CLI's pid and group, its spawn time, and
// every owned process ps has shown, pid and start time only): a core hard-killed mid-job cannot
// stop the tree, so the next start kills what still matches it (main.ts sweepJobDirs).
//
// Tool surface (toolPolicy.ts): Scout's server, plus the forwarding bridge for the
// profile's selected tools. Before anything is written, managed policy is checked; a policy
// that would defeat the job's restrictions is `unsupported_configuration`.
//
// Lifecycle (adapted from the removed personal-context package; see git history before
// 2026-10-02), one unit each: jsonLineStream.ts parses stdout; streamMonitor.ts
// checks each event as it arrives (init, tools, hooks, auth); childSupervisor.ts spawns,
// terminates and reaps the process tree; mapOutcome.ts turns the finished run into an
// outcome; jobStop.ts holds the one stop decision. This file wires them per job and owns the
// adapter: gates, job files, the deadline and cancellation.
// Differences from the legacy runner: no personal sources, evidence IDs or audit map; one
// job at a time (a second is `unavailable: busy`; the coordinator runs one job anyway); the
// instructions are appended to the default system prompt, not a replacement; settings come
// from the user scope only, with hooks disabled; termination reasons map onto the fixed
// HostJobResult codes plus a finer `termination` in job details; abortAll() closes the
// adapter, so a later job is `unavailable: agent_unavailable`. The job's process tree is its
// CLI's process group: Scout's MCP server, the per-job bridge and every backend the bridge
// starts are spawned into it (none detaches), so a cancel's group signal reaches them all,
// whether or not the model ever sent a final response; a descendant that left the group is
// still tracked by ps and signalled on its own, and with `processTracker` the core's shutdown
// waits for any the reap left behind.
//
// Billing gate (the adapter's readiness): refreshPreflight() runs the direct preflight (blocking;
// the dev CLI and the compatibility checks use it) and refreshReadiness() runs it through `preflightAsync`
// (the core passes preflightWorker.ts's child-process facade, so its event loop never blocks);
// either caches the verdict with the CLI version it saw. An adapter is bound to one profile
// (an edited profile means a new adapter and a new preflight). A job waits for a refresh in
// flight (within its deadline), then runs only when the verdict is `subscription` and the
// request names this profile's fingerprint, and its init event must report the same model.
// A job that finds no verdict yet (the core starts the preflight eagerly only when some host
// is recommendation-enabled) starts one and waits for it. A verdict that does not arrive within
// the job's deadline is `preflight_failed` (detail `preflight_pending`): the job never ran, so
// it did not time out; billing was never verified.
//
// CLI auto-update policy: VERIFIED_CLI_VERSION records what the flag set was checked
// against; it is not an allowlist. An init reporting another CLI version than the preflight
// saw is advisory (`cliVersionChanged` in job details, `cli_version_changed` in diagnostics):
// the adapter starts one async re-preflight at once, and the job's answer counts only if that
// verdict is `subscription` (otherwise `preflight_failed`, detail `cli_version_changed`);
// later jobs wait for it. The init's auth-route check still stops any job outright.
// A preflight that could not read the CLI version and is not `subscription` (an unreachable or
// broken CLI, a failed or killed preflight child) is not sticky: it arms one retry, and the next job starts a
// fresh async preflight and waits for it (the facade never caches a report without a
// version). Each such result arms one more retry, so a broken CLI costs one preflight per job,
// never a loop.
//
// Nothing a model writes can become `ok` after the job was cancelled or timed out: once a
// stop is decided, later result events are ignored. A result that arrived before the stop
// stands.
//
// Diagnostics (`agent_job`): hashed request ID, origin, status, reason, termination,
// timings, usage counts, tool-use count, CLI version, model. Never prompts, candidate text,
// tokens or URLs beyond the origin.

import { spawn as nodeSpawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { AgentTokenSchema, JOB_AGENT_OUTPUT_JSON_SCHEMA, JobRequestSchema, type HostJobResult, type JobRequest } from "@scout/contracts";
import { systemClock, type Clock } from "../clock.js";
import type { Diagnostics } from "../diagnostics.js";
import { hashRequestId, MIN_LAUNCH_MS, toCancelReason, type AgentJobAdapter, type AgentReadiness, type JobDetails, type JobOutcome, type JobRunOptions, type JobTermination } from "./adapter.js";
import { managedPathsFor, type Env, type ManagedPaths, type Verdict } from "./authPreflight.js";
import type { BridgeJob } from "./contextToolBridge.js";
import { startChild, type SnapshotFn, type SpawnFn, type SupervisedChild } from "./childSupervisor.js";
import type { ExpectedInit } from "./initCheck.js";
import { buildJobSurface, defaultScoutMcpEntrypoint, type JobSurface } from "./jobSurface.js";
import { JobStop, type Ending, type Out } from "./jobStop.js";
import { createJsonLineStream } from "./jsonLineStream.js";
import { createLaunchProfile, LaunchProfileError, runDirectPreflight, type DirectPreflightOptions, type LaunchProfile } from "./launchProfile.js";
import { mapOutcome, recordUsage } from "./mapOutcome.js";
import { MODEL_RE, profileFingerprint, type AgentProfile } from "./profile.js";
import { buildJobInstructions, buildJobPrompt } from "./prompt.js";
import { JOB_TREE_FILE, type JobTreeRecord, type ProcessTracker } from "./processTree.js";
import { createStreamMonitor } from "./streamMonitor.js";
import { ensureAgentCwd } from "../localSocketFiles.js";
import { checkManagedPolicy, defaultBridgeEntrypoint, managedMcpFilesFor, planJobTools, type JobManagedPaths, type ManagedPolicyResult, type ToolPlanOptions } from "./toolPolicy.js";

export type { SpawnFn, SnapshotFn } from "./childSupervisor.js";

// ---------- the verified flag set ----------

/**
 * The launch flags, verified against the installed CLI 2.1.286 on 2026-10-01 (`claude
 * --help`, plus the option table in the binary for flags the help hides). P1.3 and P1.5
 * build on this record; a newer CLI needs these rechecked before jobs are enabled.
 *
 *   --model <m>                    shown   explicit profile model, never inherited
 *   -p                             shown   non-interactive
 *   --output-format stream-json    shown   events streamed, so init can be checked
 *   --verbose                      shown   required by stream-json in -p
 *   --json-schema <schema>         shown   structured output (StructuredOutput tool)
 *   --strict-mcp-config            shown   only servers from --mcp-config load
 *   --mcp-config <file>            shown   the per-job surface (jobSurface.ts)
 *   --tools ""                     shown   no built-in tools
 *   --allowedTools <a,b,...>       shown   exact mcp__server__tool names, no wildcards
 *   --permission-mode dontAsk      shown   unattended: anything not pre-allowed is denied
 *   --disable-slash-commands       shown   "Disable all skills": no skill invocation
 *   --no-session-persistence       shown   nothing saved, nothing resumable
 *   --setting-sources user         shown   user settings only; no project/local settings
 *                                          from an unrelated working directory
 *   --settings <file>              shown   {"disableAllHooks":true}: user hooks off
 *                                          (`disableAllHooks` is a settings key in 2.1.286)
 *   --append-system-prompt-file    hidden  Scout's instructions appended to the default
 *                                          system prompt; never a replacement
 *   --max-turns <n>                hidden  bounded agent loop (`error_max_turns` result)
 *
 * Never passed: --resume, --continue, --session-id, --fork-session (no existing chat is
 * resumed), --system-prompt[-file] (replaces the default prompt), --fallback-model,
 * --dangerously-skip-permissions, --bare (its auth is API-key only), --add-dir.
 * Not used yet: --permission-prompts none (new in this version; dontAsk already denies).
 * Managed-policy hooks are not covered by --settings; checkManagedPolicy (toolPolicy.ts)
 * refuses a job when managed policy defines hooks or otherwise overrides these flags.
 */
export const VERIFIED_CLI_VERSION = "2.1.286";
export const JOB_MAX_TURNS = 16;
export const JOB_SETTINGS = Object.freeze({ disableAllHooks: true });
export const KILL_GRACE_MS = 2000;
export const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
export { MIN_LAUNCH_MS } from "./adapter.js";

export const JOB_FILES = Object.freeze({ mcp: "mcp.json", settings: "settings.json", instructions: "instructions.md", token: "agent-token", bridge: "bridge.json" });

/** argv after the claude path. */
export function buildJobArgv(model: string, jobDir: string, allowedToolsArg: string, maxTurns = JOB_MAX_TURNS): string[] {
  return [
    "--model",
    model,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    JSON.stringify(JOB_AGENT_OUTPUT_JSON_SCHEMA),
    "--strict-mcp-config",
    "--mcp-config",
    join(jobDir, JOB_FILES.mcp),
    "--tools",
    "",
    "--allowedTools",
    allowedToolsArg,
    "--permission-mode",
    "dontAsk",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--setting-sources",
    "user",
    "--settings",
    join(jobDir, JOB_FILES.settings),
    "--append-system-prompt-file",
    join(jobDir, JOB_FILES.instructions),
    "--max-turns",
    String(maxTurns),
  ];
}

// ---------- public types ----------

export type PreflightFn = (opts: DirectPreflightOptions) => { verdict: Verdict; reasons: readonly string[]; cliVersion?: string };

/** What the async preflight receives: only plain data (it may cross a thread). */
export type PreflightInput = Pick<DirectPreflightOptions, "parentEnv" | "claudePath" | "model" | "jobsRoot" | "workspaceRoots">;

/**
 * An off-thread preflight (preflightWorker.ts). `knownCliVersion`, when given, is a version a
 * job's init reported: a cached verdict for another version is not reused.
 */
export type AsyncPreflightFn = (
  opts: PreflightInput,
  knownCliVersion?: string,
) => Promise<{ verdict: Verdict; reasons: readonly string[]; cliVersion?: string }>;

/** The billing preflight's verdict as readiness: `ok` only for `subscription`; `version` is the CLI version it saw. */
export interface PreflightReadiness extends AgentReadiness {
  readonly verdict: Verdict | "unchecked";
}

export interface ClaudeJobDeps {
  /** SCOUT_HOME; job dirs go under `run/jobs/`. */
  home: string;
  profile: AgentProfile;
  /** The core's environment; the launch profile picks the allowlisted keys from it. */
  parentEnv: Env;
  workspaceRoots?: readonly string[];
  /** Node binary for Scout's MCP server. Defaults to this process's. */
  nodePath?: string;
  /** scout-mcp's built entrypoint. Defaults to the package export. */
  scoutMcpEntrypoint?: string;
  /** The bridge's built entrypoint. Defaults to the package export. */
  bridgeEntrypoint?: string;
  /** Bridge limits (tests). */
  bridgeLimits?: BridgeJob["limits"];
  /** Managed-settings locations (tests). Default: managedPathsFor this platform, the job's config dir and OS user. */
  managedPaths?: ManagedPaths;
  clock?: Clock;
  diagnostics?: Diagnostics;
  spawn?: SpawnFn;
  preflight?: PreflightFn;
  /** The off-thread preflight refreshReadiness uses. Defaults to `preflight` (which blocks). */
  preflightAsync?: AsyncPreflightFn;
  /** Test seam for the ps query (default: psSnapshotAsync). */
  psSnapshot?: SnapshotFn;
  /** The core's registry of job process trees: its shutdown waits for (and kills) what a job's reap left. */
  processTracker?: ProcessTracker;
  killGraceMs?: number;
  maxStdoutBytes?: number;
  minLaunchMs?: number;
  /** Test seam for the prompt delimiter nonce. */
  nonce?: () => string;
}

export interface ClaudeJobRunOptions extends JobRunOptions {
  /** Compatibility checks only: the marker a user-level instructions file defines. */
  instructionMarker?: string;
}

export interface ClaudeJobAdapter extends AgentJobAdapter {
  /** Blocking (spawnSync, up to minutes): only when the profile is loaded or edited, never in the core. */
  refreshPreflight(): PreflightReadiness;
  /** The same through `preflightAsync`, off the caller's event loop. A job waits for one in flight. */
  refreshReadiness(knownCliVersion?: string): Promise<PreflightReadiness>;
  readonly readiness: PreflightReadiness;
  /** Whether a job is running. */
  readonly active: boolean;
  run(request: JobRequest, options: ClaudeJobRunOptions): Promise<JobOutcome>;
}

export class JobRequestError extends Error {
  constructor() {
    super("invalid job request");
    this.name = "JobRequestError";
  }
}

/** A preflight reason without local paths (verbatim from the removed personal-context package). */
export function redactReason(reason: string): string {
  return reason.replace(/^(\w+ settings) .*?(: [^:]*)$/u, "$1$2").replace(/(?:^|(?<=\s))\/\S+/gu, "<path>");
}

/**
 * A launch-profile failure by cause: the CLI binary missing or not executable is
 * `agent_unavailable`; the job dir or jobs root unusable (an existing dir, EACCES, wrong
 * mode) is `agent_failed`; a profile or environment Scout cannot run with is
 * `unsupported_configuration`.
 */
export function launchProfileFailure(e: unknown): Out {
  const detail = "launch_profile";
  const code = e instanceof LaunchProfileError ? e.code : undefined;
  switch (code) {
    case "profile: claude path is not an absolute executable file":
      return { result: { status: "unavailable", reason: "agent_unavailable" }, termination: "agent_unavailable", detail };
    case "profile: jobs root is not a private directory owned by this user":
    case "profile: job dir could not be created":
    case "profile: job dir is not private and owned":
    case undefined:
      return { result: { status: "error", reason: "agent_failed" }, termination: "process_error", detail };
    default:
      return { result: { status: "error", reason: "unsupported_configuration" }, termination: "unsupported_configuration", detail };
  }
}

/**
 * The managed-settings locations for the job's environment: this platform, its CLI config
 * dir, the OS user. Without a config dir (no CLAUDE_CONFIG_DIR and no HOME) the server-managed
 * cache cannot be located: `userUnknown`, so the check fails closed.
 */
export function defaultManagedPaths(env: Readonly<Record<string, string>>, username: () => string = () => userInfo().username): JobManagedPaths {
  const unknown: JobManagedPaths = { files: [], dropInDirs: [], opaque: [], userUnknown: true };
  const configDir = env.CLAUDE_CONFIG_DIR ?? (env.HOME ? join(env.HOME, ".claude") : undefined);
  if (!configDir) return unknown;
  let user: string | undefined;
  try {
    user = username();
  } catch {
    // below
  }
  // Per-user MDM policy is keyed by the OS account; without one, fail closed.
  if (!user || user.includes("/")) return unknown;
  return { ...managedPathsFor(process.platform, configDir, user), mcpFiles: managedMcpFilesFor(process.platform) };
}

/** `tree.json` in the job dir, replaced atomically (0600). Best effort: a failure is ignored. */
export function writeTreeRecord(jobDir: string, record: JobTreeRecord): void {
  const tmp = join(jobDir, `.${JOB_TREE_FILE}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, join(jobDir, JOB_TREE_FILE));
  } catch {
    // the job dir is gone or unwritable: nothing to record into
  }
}

// ---------- the adapter ----------

export function createClaudeJobAdapter(deps: ClaudeJobDeps): ClaudeJobAdapter {
  const spawn: SpawnFn = deps.spawn ?? ((c, a, o) => nodeSpawn(c, [...a], o));
  const preflightFn: PreflightFn = deps.preflight ?? runDirectPreflight;
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  const maxStdout = deps.maxStdoutBytes ?? MAX_STDOUT_BYTES;
  const minLaunchMs = deps.minLaunchMs ?? MIN_LAUNCH_MS;
  const jobsRoot = join(deps.home, "run", "jobs");
  try {
    ensureAgentCwd(deps.home);
  } catch {
    deps.diagnostics?.event("agent_cwd_unusable", {}); // each job checks again before its spawn
  }
  const profile = deps.profile;
  const fingerprint = profileFingerprint(profile);
  let preflight: PreflightReadiness = Object.freeze({ ok: false, verdict: "unchecked", reasons: [] });
  let current: { stop: JobStop; done: Promise<unknown> } | undefined;
  /** Set by abortAll: the adapter runs no further jobs. */
  let closed = false;

  /** In flight from refreshReadiness; jobs wait for it. */
  let refreshing: Promise<PreflightReadiness> | undefined;
  /** The last verdict could not read the CLI version and was not subscription: the next job re-runs the preflight. */
  let retryPreflight = false;

  const preflightInput = (): PreflightInput => {
    const opts: PreflightInput = { parentEnv: deps.parentEnv, claudePath: profile.claudePath, model: profile.model, jobsRoot };
    if (deps.workspaceRoots) opts.workspaceRoots = deps.workspaceRoots;
    return opts;
  };

  /** Cache a preflight report (or a failure to get one) as the adapter's verdict. */
  function settlePreflight(r: { verdict: Verdict; reasons: readonly string[]; cliVersion?: string } | undefined): PreflightReadiness {
    const verdict = r?.verdict === "subscription" ? "subscription" : "ambiguous";
    const reasons = r === undefined ? ["internal: preflight failed unexpectedly"] : r.reasons.map(redactReason);
    preflight = Object.freeze({
      ok: verdict === "subscription",
      verdict,
      reasons: Object.freeze(reasons),
      ...(r?.cliVersion !== undefined ? { version: r.cliVersion } : {}),
      at: (deps.clock ?? systemClock).now(),
    });
    retryPreflight = !preflight.ok && preflight.version === undefined;
    deps.diagnostics?.event("agent_preflight", { verdict: preflight.verdict, reasons: preflight.reasons.length, ...(preflight.version ? { cliVersion: preflight.version } : {}) });
    return preflight;
  }

  function refreshPreflight(): PreflightReadiness {
    let r: ReturnType<PreflightFn> | undefined;
    try {
      r = preflightFn(preflightInput());
    } catch {
      // never echo the error
    }
    return settlePreflight(r);
  }

  function refreshReadiness(knownCliVersion?: string): Promise<PreflightReadiness> {
    if (refreshing) return refreshing;
    const fn: AsyncPreflightFn = deps.preflightAsync ?? (async (o) => preflightFn(o));
    const p = (async () => {
      let r: Awaited<ReturnType<AsyncPreflightFn>> | undefined;
      try {
        r = await fn(preflightInput(), knownCliVersion);
      } catch {
        // never echo the error
      }
      return settlePreflight(r);
    })();
    refreshing = p;
    void p.finally(() => {
      if (refreshing === p) refreshing = undefined;
    });
    return p;
  }

  /** Wait for `p` until the deadline or the signal; undefined when either came first. */
  async function waitBounded<T>(p: Promise<T>, deadlineAt: number, clock: Clock, signal: AbortSignal | undefined): Promise<T | undefined> {
    if (signal?.aborted) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), Math.max(0, deadlineAt - clock.now()));
      onAbort = () => resolve(undefined);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([p, stopped]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  async function run(request: JobRequest, options: ClaudeJobRunOptions): Promise<JobOutcome> {
    const parsed = JobRequestSchema.safeParse(request);
    if (!parsed.success) throw new JobRequestError();
    const req = parsed.data;
    const clock = options.clock ?? deps.clock ?? systemClock;
    const t0 = clock.now();
    const details: JobDetails = {
      adapter: "claude-code",
      termination: "completed",
      toolUses: [],
      optionalTools: [],
      droppedPicks: 0,
      cutPicks: 0,
      toolErrors: {},
      optionalToolFailed: false,
      timings: { totalMs: 0 },
      usage: {},
    };
    const identity = { requestId: req.requestId, coreInstanceId: req.coreInstanceId, visitEpoch: req.visitEpoch };
    const finish = (ending: Ending, termination: JobTermination = details.termination, detail?: string): JobOutcome => {
      details.termination = termination;
      if (detail !== undefined) details.detail = detail;
      details.timings.totalMs = clock.now() - t0;
      const result = { ...identity, ...ending } as HostJobResult;
      record(req, result, details);
      return { result, details };
    };

    if (closed) return finish({ status: "unavailable", reason: "agent_unavailable" }, "agent_unavailable", "closed");
    if (current) return finish({ status: "unavailable", reason: "busy" }, "busy");
    const deadlineAt = Math.min(options.deadline ?? Number.POSITIVE_INFINITY, t0 + req.deadlineMs);
    if (!refreshing && retryPreflight) {
      // The last preflight could not read the CLI version: this job runs one fresh one and waits for it.
      retryPreflight = false;
      deps.diagnostics?.event("agent_preflight_retry", {});
      void refreshReadiness();
    } else if (!refreshing && preflight.verdict === "unchecked") {
      // No preflight has run yet (the core starts none while no host is enabled): this job starts it.
      void refreshReadiness();
    }
    if (refreshing) {
      // A preflight is in flight (the core's start, or a CLI update another job saw): wait for its verdict.
      const settled = await waitBounded(refreshing, deadlineAt, clock, options.signal);
      if (settled === undefined) {
        if (options.signal?.aborted) return finish({ status: "cancelled", reason: toCancelReason(options.signal.reason) }, "cancelled");
        return finish({ status: "error", reason: "preflight_failed" }, "preflight_failed", "preflight_pending");
      }
      if (closed) return finish({ status: "unavailable", reason: "agent_unavailable" }, "agent_unavailable", "closed");
      if (current) return finish({ status: "unavailable", reason: "busy" }, "busy");
    }
    if (!preflight.ok) return finish({ status: "error", reason: "preflight_failed" }, "preflight_failed", "unverified");
    if (req.profileFingerprint !== fingerprint) return finish({ status: "error", reason: "unsupported_configuration" }, "unsupported_configuration", "profile_mismatch");
    const scout = options.toolSurface.scout;
    if (!isAbsolute(scout.socketPath) || scout.socketPath.includes("\0") || !AgentTokenSchema.safeParse(scout.token).success) {
      return finish({ status: "error", reason: "unsupported_configuration" }, "unsupported_configuration", "tool_surface");
    }
    if (options.signal?.aborted) return finish({ status: "cancelled", reason: toCancelReason(options.signal.reason) }, "cancelled");
    if (deadlineAt - clock.now() < minLaunchMs) return finish({ status: "unavailable", reason: "no_time_left" }, "no_time_left");

    const stop = new JobStop();
    let resolveDone: () => void = () => {};
    current = { stop, done: new Promise<void>((r) => (resolveDone = r)) };
    const timer = setTimeout(() => stop.external({ result: { status: "error", reason: "timeout" }, termination: "timeout" }), Math.max(0, deadlineAt - clock.now()));
    const onSignal = (): void => stop.external({ result: { status: "cancelled", reason: toCancelReason(options.signal?.reason) }, termination: "cancelled" });
    options.signal?.addEventListener("abort", onSignal, { once: true });
    try {
      let out = await execute(req, scout, options, details, clock, stop);
      if (details.cliVersionChanged && (out.result.status === "ok" || out.result.status === "empty")) out = await recheckAfterCliChange(out, deadlineAt, clock, options.signal);
      return finish(out.result, out.termination, out.detail);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onSignal);
      current = undefined;
      resolveDone();
    }
  }

  /**
   * The job's CLI reported another version than the preflight saw: its answer counts only once
   * the re-preflight it started (on init) says `subscription`, within the job's deadline.
   */
  async function recheckAfterCliChange(out: Out, deadlineAt: number, clock: Clock, signal: AbortSignal | undefined): Promise<Out> {
    const settled = await waitBounded(refreshing ?? Promise.resolve(preflight), deadlineAt, clock, signal);
    if (settled === undefined) {
      if (signal?.aborted) return { result: { status: "cancelled", reason: toCancelReason(signal.reason) }, termination: "cancelled" };
      return { result: { status: "error", reason: "timeout" }, termination: "timeout", detail: "cli_version_changed" };
    }
    if (!settled.ok) return { result: { status: "error", reason: "preflight_failed" }, termination: "preflight_failed", detail: "cli_version_changed" };
    return out;
  }

  async function execute(
    req: JobRequest,
    scout: { socketPath: string; token: string },
    options: ClaudeJobRunOptions,
    details: JobDetails,
    clock: Clock,
    stop: JobStop,
  ): Promise<Out> {
    let launch: LaunchProfile;
    try {
      const o = { parentEnv: deps.parentEnv, claudePath: profile.claudePath, model: profile.model, jobsRoot, jobId: req.requestId };
      launch = createLaunchProfile(deps.workspaceRoots ? { ...o, workspaceRoots: deps.workspaceRoots } : o);
    } catch (e) {
      return launchProfileFailure(e);
    }
    const jobDir = launch.cwd;
    try {
      let policy: ManagedPolicyResult;
      try {
        policy = checkManagedPolicy(deps.managedPaths ?? defaultManagedPaths(launch.env));
      } catch {
        policy = { ok: false, detail: "managed_user_unknown" }; // locating the managed files failed: fail closed
      }
      if (!policy.ok) return { result: { status: "error", reason: "unsupported_configuration" }, termination: "unsupported_configuration", detail: policy.detail };
      let surface: JobSurface;
      try {
        const nodePath = deps.nodePath ?? process.execPath;
        const planOpts: ToolPlanOptions = {
          tools: profile.tools,
          scout: { nodePath, entrypoint: deps.scoutMcpEntrypoint ?? defaultScoutMcpEntrypoint(), socketPath: scout.socketPath, tokenFile: join(jobDir, JOB_FILES.token) },
          bridge: { nodePath, entrypoint: deps.bridgeEntrypoint ?? defaultBridgeEntrypoint(), jobFile: join(jobDir, JOB_FILES.bridge) },
        };
        if (deps.bridgeLimits) planOpts.limits = deps.bridgeLimits;
        const plan = planJobTools(planOpts);
        if (!plan.ok) return { result: { status: "error", reason: plan.reason }, termination: plan.reason, detail: plan.detail };
        for (const u of plan.unavailable) details.optionalTools.push({ ...u, status: "unavailable" });
        surface = buildJobSurface(plan.spec);
        const write = (name: string, text: string): void => writeFileSync(join(jobDir, name), text, { mode: 0o600, flag: "wx" });
        write(JOB_FILES.token, `${scout.token}\n`);
        if (plan.bridgeJob) write(JOB_FILES.bridge, JSON.stringify(plan.bridgeJob));
        write(JOB_FILES.mcp, JSON.stringify(surface.mcpConfig, null, 2));
        write(JOB_FILES.settings, JSON.stringify(JOB_SETTINGS));
        write(JOB_FILES.instructions, buildJobInstructions(JOB_MAX_TURNS));
      } catch {
        return { result: { status: "error", reason: "agent_failed" }, termination: "process_error", detail: "setup_failed" };
      }
      const expected: ExpectedInit = { servers: surface.expected, model: profile.model };
      if (preflight.version !== undefined) expected.cliVersion = preflight.version;
      const promptOpts: Parameters<typeof buildJobPrompt>[1] = { instructionMarkerProbe: options.instructionMarker !== undefined };
      if (options.activity !== undefined) promptOpts.activity = options.activity;
      const nonce = deps.nonce?.();
      if (nonce !== undefined) promptOpts.nonce = nonce;
      const prompt = buildJobPrompt(req, promptOpts);
      if (stop.decision) return stop.decision; // stopped during setup: never spawn
      return await runCli(launch, jobDir, surface, expected, prompt, req, options, details, clock, stop);
    } finally {
      try {
        launch.cleanup();
      } catch {
        deps.diagnostics?.event("agent_job_cleanup_failed", {});
      }
    }
  }

  async function runCli(
    launch: LaunchProfile,
    jobDir: string,
    surface: JobSurface,
    expected: ExpectedInit,
    prompt: string,
    req: JobRequest,
    options: ClaudeJobRunOptions,
    details: JobDetails,
    clock: Clock,
    stop: JobStop,
  ): Promise<Out> {
    const startedAt = clock.now();
    let cwd: string;
    try {
      cwd = ensureAgentCwd(deps.home);
    } catch {
      return { result: { status: "error", reason: "agent_failed" }, termination: "process_error", detail: "setup_failed" };
    }
    let sup: SupervisedChild;
    try {
      sup = startChild({
        spawn,
        command: launch.claudePath,
        args: buildJobArgv(launch.model, jobDir, surface.allowedToolsArg),
        options: { cwd, env: { ...launch.env }, stdio: ["pipe", "pipe", "pipe"] },
        killGraceMs,
        ...(deps.psSnapshot ? { snapshot: deps.psSnapshot } : {}),
        ...(deps.processTracker ? { tracker: deps.processTracker } : {}),
        onTree: (record) => writeTreeRecord(jobDir, record),
      });
    } catch {
      return { result: { status: "unavailable", reason: "agent_unavailable" }, termination: "agent_unavailable", detail: "spawn_failed" };
    }
    try {
      const streamFailed: Out = { result: { status: "error", reason: "agent_failed" }, termination: "process_error", detail: "stream_failed" };
      stop.onHalt(() => sup.terminate());
      const monitor = createStreamMonitor({
        expected,
        allowedTools: surface.allowedTools,
        details,
        stop,
        clock,
        startedAt,
        onCliVersionChanged: (version) => {
          deps.diagnostics?.event("cli_version_changed", { ...(version !== undefined && /^[0-9][0-9A-Za-z.+-]{0,31}$/.test(version) ? { cliVersion: version } : {}) });
          void refreshReadiness(version);
        },
      });
      const stream = createJsonLineStream({
        maxBytes: maxStdout,
        onEvent: monitor.onEvent,
        onTooLarge: () => stop.halt({ result: { status: "error", reason: "agent_failed" }, termination: "output_too_large" }),
        onError: () => stop.halt(streamFailed),
      });
      const { child } = sup;
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        try {
          stream.push(chunk);
        } catch {
          stop.halt(streamFailed); // never throw from an event emitter
        }
      });
      child.stderr?.resume(); // never read: it may quote config or content
      child.stdin?.on("error", () => {}); // EPIPE if the CLI exits early
      child.stdin?.end(prompt);

      const raced = await sup.waitExit();
      if (raced === "reap_timeout") deps.diagnostics?.event("agent_job_reap_timeout", {});
      const exit = raced === "reap_timeout" ? { spawnError: false } : raced;
      stop.seal(); // a cancel or timeout now changes nothing; the tree is reaped below either way
      await sup.drainOutput();
      stream.end();
      details.timings.cliMs = clock.now() - startedAt;
      await sup.reap();

      recordUsage(monitor.result, details);
      return mapOutcome(
        { spawnError: exit.spawnError, stop: stop.decision, init: monitor.init, result: monitor.result, requiredToolFailed: monitor.requiredToolFailed() },
        req,
        details,
        options.instructionMarker,
      );
    } finally {
      sup.dispose();
    }
  }

  function record(req: JobRequest, result: HostJobResult, details: JobDetails): void {
    if (!deps.diagnostics) return;
    const f: Record<string, number | string | boolean> = {
      req: hashRequestId(req.requestId),
      origin: req.origin,
      epoch: req.visitEpoch,
      status: result.status,
      termination: details.termination,
      ms: details.timings.totalMs,
      toolUses: details.toolUses.length,
      droppedPicks: details.droppedPicks,
    };
    if ("reason" in result) f.reason = result.reason;
    if (result.status === "ok") f.picks = result.items.length;
    if (details.detail !== undefined) f.detail = details.detail;
    if (details.timings.cliMs !== undefined) f.cliMs = details.timings.cliMs;
    if (details.cliVersion !== undefined) f.cliVersion = details.cliVersion;
    if (details.cliVersionChanged) f.cliVersionChanged = true;
    if (details.timings.apiMs !== undefined) f.apiMs = details.timings.apiMs;
    if (details.permissionDenials !== undefined) f.permissionDenials = details.permissionDenials;
    const toolErrors = Object.values(details.toolErrors).reduce((a, b) => a + b, 0) + (details.unattributedToolErrors ?? 0);
    if (toolErrors > 0) f.toolErrors = toolErrors;
    if (details.optionalToolFailed) f.optionalToolFailed = true;
    if (details.model !== undefined && MODEL_RE.test(details.model)) f.model = details.model;
    // Diagnostics drop any field name containing "token", so usage counts are named usage*.
    const u = details.usage;
    if (u.turns !== undefined) f.turns = u.turns;
    if (u.inputTokens !== undefined) f.usageIn = u.inputTokens;
    if (u.outputTokens !== undefined) f.usageOut = u.outputTokens;
    if (u.cacheReadTokens !== undefined) f.usageCacheRead = u.cacheReadTokens;
    if (u.cacheWriteTokens !== undefined) f.usageCacheWrite = u.cacheWriteTokens;
    deps.diagnostics.event("agent_job", f);
  }

  return {
    id: "claude-code",
    refreshPreflight,
    refreshReadiness,
    get readiness() {
      return preflight;
    },
    profileFingerprint: fingerprint,
    get active() {
      return current !== undefined;
    },
    run,
    async abortAll() {
      closed = true;
      const c = current;
      if (!c) return;
      c.stop.external({ result: { status: "cancelled", reason: "shutdown" }, termination: "cancelled" });
      await c.done;
    },
  };
}
