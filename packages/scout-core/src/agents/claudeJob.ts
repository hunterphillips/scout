// Claude Code as an agent-job adapter: one fresh, unattended, read-only `claude -p` per job.
//
// Per job: a direct launch profile (launchProfile.ts: allowlisted child env, the agent
// profile's absolute claude path and explicit model) whose private 0700 cwd is
// `SCOUT_HOME/run/jobs/<request-id>/`. Four 0600 files go there (mcp.json, settings.json,
// instructions.md, agent-token), plus bridge.json when the profile selects user tools (the
// bridge's job file, holding the backend environment bindings but never their values, which
// only the bridge resolves, in memory, at spawn); the CLI is spawned argv-only, detached, with the request on
// stdin; the job dir is removed when the job ends, however it ends.
//
// Tool surface (toolPolicy.ts): Scout's server, plus the forwarding bridge for the
// profile's selected tools. Before anything is written, managed policy is checked; a policy
// that would defeat the job's restrictions is `unsupported_configuration`.
//
// Lifecycle (adapted from packages/personal-context-mcp/src/agentRunner.ts, temporary
// duplicate until Phase 4), one unit each: jsonLineStream.ts parses stdout; streamMonitor.ts
// checks each event as it arrives (init, tools, hooks, auth); childSupervisor.ts spawns,
// terminates and reaps the process tree; mapOutcome.ts turns the finished run into an
// outcome; jobStop.ts holds the one stop decision. This file wires them per job and owns the
// adapter: gates, job files, the deadline and cancellation.
// Differences from the legacy runner: no personal sources, evidence IDs or audit map; one
// job at a time (a second is `unavailable: busy`; the coordinator runs one job anyway); the
// instructions are appended to the default system prompt, not a replacement; settings come
// from the user scope only, with hooks disabled; termination reasons map onto the fixed
// HostJobResult codes plus a finer `termination` in job details; abortAll() closes the
// adapter, so a later job is `unavailable: agent_unavailable`.
//
// Billing gate: refreshPreflight() runs the direct preflight (blocking; call it when the
// agent profile is loaded or edited, never on the job path) and caches the verdict with the
// CLI version it saw. An adapter is bound to one profile (an edited profile means a new
// adapter and a new preflight). A job runs only when the verdict is `subscription` and the
// request names this profile's fingerprint, and its init event must report the same CLI
// version and model.
//
// Nothing a model writes can become `ok` after the job was cancelled or timed out: once a
// stop is decided, later result events are ignored. A result that arrived before the stop
// stands.
//
// Diagnostics (`agent_job`): hashed request ID, origin, status, reason, termination,
// timings, usage counts, tool-use count, CLI version, model. Never prompts, candidate text,
// tokens or URLs beyond the origin.

import { spawn as nodeSpawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { AgentTokenSchema, JOB_AGENT_OUTPUT_JSON_SCHEMA, JobRequestSchema, type HostJobResult, type JobRequest } from "@scout/contracts";
import { systemClock, type Clock } from "../clock.js";
import type { Diagnostics } from "../diagnostics.js";
import { hashRequestId, toCancelReason, type AgentJobAdapter, type JobDetails, type JobOutcome, type JobRunOptions, type JobTermination } from "./adapter.js";
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
import { createStreamMonitor } from "./streamMonitor.js";
import { checkManagedPolicy, defaultBridgeEntrypoint, planJobTools, type JobManagedPaths, type ToolPlanOptions } from "./toolPolicy.js";

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
/** Do not launch inference with less than this left (plan: common limits). */
export const MIN_LAUNCH_MS = 5000;

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

export interface PreflightState {
  verdict: Verdict | "unchecked";
  /** Fixed reason codes with local paths removed. */
  reasons: readonly string[];
  cliVersion?: string;
  at?: number;
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
  /** Test seam for the ps query (default: psSnapshotAsync). */
  psSnapshot?: SnapshotFn;
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
  /** Blocking (spawnSync, up to minutes): only when the profile is loaded or edited. */
  refreshPreflight(): PreflightState;
  readonly preflight: PreflightState;
  readonly profileFingerprint: string;
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

/** A preflight reason without local paths (verbatim from the legacy agentRunner). */
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

/** The managed-settings locations for the job's environment: this platform, its CLI config dir, the OS user. */
export function defaultManagedPaths(env: Readonly<Record<string, string>>, username: () => string = () => userInfo().username): JobManagedPaths {
  const configDir = env.CLAUDE_CONFIG_DIR ?? join(env.HOME!, ".claude");
  let user: string | undefined;
  try {
    user = username();
  } catch {
    // below
  }
  // Per-user MDM policy is keyed by the OS account; without one, fail closed.
  if (!user || user.includes("/")) return { files: [], dropInDirs: [], opaque: [], userUnknown: true };
  return managedPathsFor(process.platform, configDir, user);
}

// ---------- the adapter ----------

export function createClaudeJobAdapter(deps: ClaudeJobDeps): ClaudeJobAdapter {
  const spawn: SpawnFn = deps.spawn ?? ((c, a, o) => nodeSpawn(c, [...a], o));
  const preflightFn: PreflightFn = deps.preflight ?? runDirectPreflight;
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  const maxStdout = deps.maxStdoutBytes ?? MAX_STDOUT_BYTES;
  const minLaunchMs = deps.minLaunchMs ?? MIN_LAUNCH_MS;
  const jobsRoot = join(deps.home, "run", "jobs");
  const profile = deps.profile;
  const fingerprint = profileFingerprint(profile);
  let preflight: PreflightState = { verdict: "unchecked", reasons: [] };
  let current: { stop: JobStop; done: Promise<unknown> } | undefined;
  /** Set by abortAll: the adapter runs no further jobs. */
  let closed = false;

  function refreshPreflight(): PreflightState {
    const clock = deps.clock ?? systemClock;
    let next: PreflightState = { verdict: "ambiguous", reasons: ["internal: preflight failed unexpectedly"] };
    try {
      const opts: DirectPreflightOptions = { parentEnv: deps.parentEnv, claudePath: profile.claudePath, model: profile.model, jobsRoot };
      if (deps.workspaceRoots) opts.workspaceRoots = deps.workspaceRoots;
      const r = preflightFn(opts);
      next = { verdict: r.verdict === "subscription" ? "subscription" : "ambiguous", reasons: Object.freeze(r.reasons.map(redactReason)) };
      if (r.cliVersion !== undefined) next.cliVersion = r.cliVersion;
    } catch {
      // never echo the error
    }
    next.at = clock.now();
    preflight = Object.freeze(next);
    deps.diagnostics?.event("agent_preflight", { verdict: preflight.verdict, reasons: preflight.reasons.length, ...(preflight.cliVersion ? { cliVersion: preflight.cliVersion } : {}) });
    return preflight;
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
    if (preflight.verdict !== "subscription") return finish({ status: "error", reason: "preflight_failed" }, "preflight_failed", "unverified");
    if (req.profileFingerprint !== fingerprint) return finish({ status: "error", reason: "unsupported_configuration" }, "unsupported_configuration", "profile_mismatch");
    const scout = options.toolSurface.scout;
    if (!isAbsolute(scout.socketPath) || scout.socketPath.includes("\0") || !AgentTokenSchema.safeParse(scout.token).success) {
      return finish({ status: "error", reason: "unsupported_configuration" }, "unsupported_configuration", "tool_surface");
    }
    const deadlineAt = Math.min(options.deadline ?? Number.POSITIVE_INFINITY, t0 + req.deadlineMs);
    if (options.signal?.aborted) return finish({ status: "cancelled", reason: toCancelReason(options.signal.reason) }, "cancelled");
    if (deadlineAt - clock.now() < minLaunchMs) return finish({ status: "unavailable", reason: "no_time_left" }, "no_time_left");

    const stop = new JobStop();
    let resolveDone: () => void = () => {};
    current = { stop, done: new Promise<void>((r) => (resolveDone = r)) };
    const timer = setTimeout(() => stop.external({ result: { status: "error", reason: "timeout" }, termination: "timeout" }), Math.max(0, deadlineAt - clock.now()));
    const onSignal = (): void => stop.external({ result: { status: "cancelled", reason: toCancelReason(options.signal?.reason) }, termination: "cancelled" });
    options.signal?.addEventListener("abort", onSignal, { once: true });
    try {
      const out = await execute(req, scout, options, details, clock, stop);
      return finish(out.result, out.termination, out.detail);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onSignal);
      current = undefined;
      resolveDone();
    }
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
      const policy = checkManagedPolicy(deps.managedPaths ?? defaultManagedPaths(launch.env));
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
      if (preflight.cliVersion !== undefined) expected.cliVersion = preflight.cliVersion;
      const promptOpts: Parameters<typeof buildJobPrompt>[1] = { instructionMarkerProbe: options.instructionMarker !== undefined };
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
    let sup: SupervisedChild;
    try {
      sup = startChild({
        spawn,
        command: launch.claudePath,
        args: buildJobArgv(launch.model, jobDir, surface.allowedToolsArg),
        options: { cwd: jobDir, env: { ...launch.env }, stdio: ["pipe", "pipe", "pipe"] },
        killGraceMs,
        ...(deps.psSnapshot ? { snapshot: deps.psSnapshot } : {}),
      });
    } catch {
      return { result: { status: "unavailable", reason: "agent_unavailable" }, termination: "agent_unavailable", detail: "spawn_failed" };
    }
    try {
      const streamFailed: Out = { result: { status: "error", reason: "agent_failed" }, termination: "process_error", detail: "stream_failed" };
      stop.onHalt(() => sup.terminate());
      const monitor = createStreamMonitor({ expected, allowedTools: surface.allowedTools, details, stop, clock, startedAt });
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
      return mapOutcome({ spawnError: exit.spawnError, stop: stop.decision, init: monitor.init, result: monitor.result }, req, details, options.instructionMarker);
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
    get preflight() {
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
