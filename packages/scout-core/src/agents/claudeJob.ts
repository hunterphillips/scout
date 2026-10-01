// Claude Code as an agent-job adapter: one fresh, unattended, read-only `claude -p` per job.
//
// Per job: a direct launch profile (launchProfile.ts: allowlisted child env, the agent
// profile's absolute claude path and explicit model) whose private 0700 cwd is
// `SCOUT_HOME/run/jobs/<request-id>/`. Four 0600 files go there (mcp.json, settings.json,
// instructions.md, agent-token); the CLI is spawned argv-only, detached, with the request on
// stdin; the job dir is removed when the job ends, however it ends.
//
// Lifecycle (adapted from packages/personal-context-mcp/src/agentRunner.ts, temporary
// duplicate until Phase 4): stream-json events are parsed line by line (UTF-8 safe, last
// line without newline counted); the init event is checked (initCheck.ts); stop = SIGTERM to
// the CLI's process group (directly, while it is unreaped), SIGKILL after the grace period,
// then any straggler from the ps-recorded tree; the exit wait is capped at grace + 2 s.
// Differences from the legacy runner: no personal sources, evidence IDs or audit map; one
// job at a time (a second is `unavailable: busy`; the coordinator runs one job anyway); the
// instructions are appended to the default system prompt, not a replacement; settings come
// from the user scope only, with hooks disabled; termination reasons map onto the fixed
// HostJobResult codes plus a finer `termination` in job details.
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

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  AgentTokenSchema,
  JOB_AGENT_OUTPUT_JSON_SCHEMA,
  JobRequestSchema,
  type AgentPick,
  type HostJobResult,
  type JOB_ERROR_REASONS,
  type JobRequest,
} from "@scout/contracts";
import { systemClock, type Clock } from "../clock.js";
import type { Diagnostics } from "../diagnostics.js";
import {
  hashRequestId,
  toCancelReason,
  type AgentJobAdapter,
  type JobCancelReason,
  type JobDetails,
  type JobOutcome,
  type JobRunOptions,
  type JobTermination,
} from "./adapter.js";
import type { Env, Verdict } from "./authPreflight.js";
import { checkInit, type ExpectedInit } from "./initCheck.js";
import { buildJobSurface, defaultScoutMcpEntrypoint, scoutOnlySurface, STRUCTURED_OUTPUT_TOOL, type JobSurface } from "./jobSurface.js";
import { createLaunchProfile, runDirectPreflight, type DirectPreflightOptions, type LaunchProfile } from "./launchProfile.js";
import { OwnedTree, psSnapshot, type PsSnapshot } from "./processTree.js";
import { MODEL_RE, profileFingerprint, type AgentProfile } from "./profile.js";
import { buildJobInstructions, buildJobPrompt, takeInstructionMarker } from "./prompt.js";
import { validateJobOutput } from "./outputValidation.js";

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
 * Managed-policy hooks are not covered by --settings; P1.3 checks managed policy.
 */
export const VERIFIED_CLI_VERSION = "2.1.286";
export const JOB_MAX_TURNS = 16;
export const JOB_SETTINGS = Object.freeze({ disableAllHooks: true });
export const KILL_GRACE_MS = 2000;
export const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
/** Do not launch inference with less than this left (plan: common limits). */
export const MIN_LAUNCH_MS = 5000;
const MAX_TOOL_USES_RECORDED = 64;

export const JOB_FILES = Object.freeze({ mcp: "mcp.json", settings: "settings.json", instructions: "instructions.md", token: "agent-token" });

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

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
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
  clock?: Clock;
  diagnostics?: Diagnostics;
  spawn?: SpawnFn;
  preflight?: PreflightFn;
  psSnapshot?: () => PsSnapshot;
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

// ---------- stream helpers ----------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Verbatim from the legacy agentRunner.
const AUTH_QUOTA_STATUS = [401, 403, 429];
const AUTH_QUOTA_TEXT = /(\/login|log ?in|auth|api key|rate.?limit|usage limit|quota|credit|billing|overloaded)/i;
function isAuthOrQuota(ev: Rec): boolean {
  if (ev.type === "system" && ev.subtype === "api_retry") {
    return AUTH_QUOTA_STATUS.includes(ev.error_status as number) || /auth|rate_limit|billing/i.test(String(ev.error ?? ""));
  }
  if (ev.type === "result" && ev.is_error === true) {
    return AUTH_QUOTA_STATUS.includes(ev.api_error_status as number) || AUTH_QUOTA_TEXT.test(String(ev.result ?? ""));
  }
  return false;
}

type Ending =
  | { status: "ok"; items: AgentPick[] }
  | { status: "empty" }
  | { status: "cancelled"; reason: JobCancelReason }
  | { status: "unavailable"; reason: "agent_unavailable" | "busy" | "no_time_left" }
  | { status: "error"; reason: (typeof JOB_ERROR_REASONS)[number] };

/** How a job ends, with its local termination code. */
interface Out {
  result: Ending;
  termination: JobTermination;
  detail?: string;
}

/** One job's stop channel (cancel, timeout or a failed check): the first stop is kept; the CLI watcher listens once it is running. */
interface StopControl {
  stop?: Out;
  listener?: (s: Out) => void;
}

// ---------- the adapter ----------

export function createClaudeJobAdapter(deps: ClaudeJobDeps): ClaudeJobAdapter {
  const spawn: SpawnFn = deps.spawn ?? ((c, a, o) => nodeSpawn(c, [...a], o));
  const preflightFn: PreflightFn = deps.preflight ?? runDirectPreflight;
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  const maxStdout = deps.maxStdoutBytes ?? MAX_STDOUT_BYTES;
  const minLaunchMs = deps.minLaunchMs ?? MIN_LAUNCH_MS;
  const snapshotFn = deps.psSnapshot ?? psSnapshot;
  const jobsRoot = join(deps.home, "run", "jobs");
  const profile = deps.profile;
  const fingerprint = profileFingerprint(profile);
  let preflight: PreflightState = { verdict: "unchecked", reasons: [] };
  let current: { stop: (s: Out) => void; done: Promise<unknown> } | undefined;

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

    const ctl: StopControl = {};
    let resolveDone: () => void = () => {};
    const job = {
      stop: (s: Out): void => {
        ctl.stop ??= s;
        ctl.listener?.(s);
      },
      done: new Promise<void>((r) => (resolveDone = r)),
    };
    current = job;
    const timer = setTimeout(() => job.stop({ result: { status: "error", reason: "timeout" }, termination: "timeout" }), Math.max(0, deadlineAt - clock.now()));
    const onSignal = (): void => job.stop({ result: { status: "cancelled", reason: toCancelReason(options.signal?.reason) }, termination: "cancelled" });
    options.signal?.addEventListener("abort", onSignal, { once: true });
    try {
      const out = await execute(req, scout, options, details, clock, ctl);
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
    ctl: StopControl,
  ): Promise<Out> {
    let launch: LaunchProfile;
    try {
      const o = { parentEnv: deps.parentEnv, claudePath: profile.claudePath, model: profile.model, jobsRoot, jobId: req.requestId };
      launch = createLaunchProfile(deps.workspaceRoots ? { ...o, workspaceRoots: deps.workspaceRoots } : o);
    } catch {
      return { result: { status: "error", reason: "unsupported_configuration" }, termination: "unsupported_configuration", detail: "launch_profile" };
    }
    const jobDir = launch.cwd;
    try {
      let surface: JobSurface;
      try {
        surface = buildJobSurface(
          scoutOnlySurface({
            nodePath: deps.nodePath ?? process.execPath,
            entrypoint: deps.scoutMcpEntrypoint ?? defaultScoutMcpEntrypoint(),
            socketPath: scout.socketPath,
            tokenFile: join(jobDir, JOB_FILES.token),
          }),
        );
        const write = (name: string, text: string): void => writeFileSync(join(jobDir, name), text, { mode: 0o600, flag: "wx" });
        write(JOB_FILES.token, `${scout.token}\n`);
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
      if (ctl.stop) return ctl.stop; // stopped during setup: never spawn
      return await runCli(launch, jobDir, surface, expected, prompt, req, options, details, clock, ctl);
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
    ctl: StopControl,
  ): Promise<Out> {
    const t0 = clock.now();
    let child: ChildProcess;
    try {
      child = spawn(launch.claudePath, buildJobArgv(launch.model, jobDir, surface.allowedToolsArg), {
        cwd: jobDir,
        env: { ...launch.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch {
      return { result: { status: "unavailable", reason: "agent_unavailable" }, termination: "agent_unavailable", detail: "spawn_failed" };
    }
    const exited = new Promise<{ spawnError: boolean }>((resolve) => {
      child.once("exit", () => resolve({ spawnError: false }));
      child.once("error", () => resolve({ spawnError: true }));
    });
    const tree = child.pid === undefined ? undefined : new OwnedTree(child.pid, snapshotFn);
    tree?.poll();
    const poller = setInterval(() => tree?.poll(), 150);

    let init: Rec | undefined;
    let resultEv: Rec | undefined;
    let stop: Out | undefined;
    let terminating = false;
    let killTimer: NodeJS.Timeout | undefined;
    let capTimer: NodeJS.Timeout | undefined;
    let resolveCap: (v: "reap_timeout") => void = () => {};
    const capped = new Promise<"reap_timeout">((r) => (resolveCap = r));
    // The CLI's own group, signalled without ps; safe only while the child is unreaped.
    const signalGroup = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // group gone
      }
    };
    const terminate = (): void => {
      if (terminating) return;
      terminating = true;
      signalGroup("SIGTERM");
      tree?.poll();
      tree?.signalAll("SIGTERM");
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        tree?.poll();
        if (tree && tree.alive().length) tree.signalAll("SIGKILL");
      }, killGraceMs);
      capTimer = setTimeout(() => resolveCap("reap_timeout"), killGraceMs + 2000);
    };
    /** First decision wins; a result that already arrived stands against a later cancel or timeout. */
    const halt = (s: Out): void => {
      if (stop === undefined && resultEv === undefined) stop = s;
      terminate();
    };
    const unsupported = (detail: string): void => halt({ result: { status: "error", reason: "unsupported_configuration" }, termination: "unsupported_configuration", detail });
    ctl.listener = halt;

    const onEvent = (ev: Rec): void => {
      if (stop !== undefined) return; // nothing after a stop counts, a late result least of all
      if (ev.type === "system" && typeof ev.subtype === "string" && ev.subtype.startsWith("hook")) return unsupported("hook_ran");
      if (init === undefined && ev.type !== "system" && ev.type !== "result") return halt({ result: { status: "error", reason: "unsupported_configuration" }, termination: "malformed_startup" });
      if (ev.type === "system" && ev.subtype === "init") {
        if (init !== undefined) return halt({ result: { status: "error", reason: "unsupported_configuration" }, termination: "malformed_startup", detail: "second_init" });
        init = ev;
        details.timings.initMs = clock.now() - t0;
        const check = checkInit(ev, expected);
        if (!check.ok) {
          const termination: JobTermination = check.reason === "tool_unavailable" ? "tool_unavailable" : check.reason === "preflight_failed" ? "preflight_failed" : "unsupported_configuration";
          return halt({ result: { status: "error", reason: check.reason }, termination, detail: check.detail });
        }
        details.model = check.model;
        if (check.cliVersion !== undefined) details.cliVersion = check.cliVersion;
        details.optionalTools = expected.servers.filter((s) => !s.required).map((s) => ({ server: s.name, status: check.optionalUnavailable.includes(s.name) ? "unavailable" : "available" }));
      } else if (ev.type === "assistant") {
        const content = isRec(ev.message) && Array.isArray(ev.message.content) ? ev.message.content : [];
        for (const c of content) {
          if (!isRec(c) || c.type !== "tool_use") continue;
          const name = typeof c.name === "string" ? c.name : "";
          if (details.toolUses.length < MAX_TOOL_USES_RECORDED && /^[A-Za-z0-9_-]{1,128}$/.test(name)) details.toolUses.push(name);
          if (name !== STRUCTURED_OUTPUT_TOOL && !surface.allowedTools.has(name)) return unsupported("unexpected_tool_use");
        }
      } else if (ev.type === "result" && resultEv === undefined) {
        resultEv = ev;
      }
      if (ev.type !== "result" && isAuthOrQuota(ev)) halt({ result: { status: "unavailable", reason: "agent_unavailable" }, termination: "auth_or_quota" });
    };

    const parseLine = (raw: string): void => {
      const line = raw.trim();
      if (!line) return;
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (isRec(ev)) onEvent(ev);
    };
    let stdoutBytes = 0;
    let tooLarge = false;
    let lineBuf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (tooLarge) return;
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > maxStdout) {
        tooLarge = true;
        return halt({ result: { status: "error", reason: "agent_failed" }, termination: "output_too_large" });
      }
      lineBuf += chunk;
      let nl: number;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        parseLine(line);
      }
    });
    child.stderr?.resume(); // never read: it may quote config or content
    child.stdin?.on("error", () => {}); // EPIPE if the CLI exits early
    child.stdin?.end(prompt);

    const raced = await Promise.race([exited, capped]);
    if (raced === "reap_timeout") deps.diagnostics?.event("agent_job_reap_timeout", {});
    const exit = raced === "reap_timeout" ? { spawnError: false } : raced;
    delete ctl.listener; // a stop now changes nothing; the tree is reaped below either way
    const stdout = child.stdout;
    if (stdout) await Promise.race([new Promise<void>((r) => (stdout.readableEnded ? r() : stdout.once("end", () => r()))), sleep(500)]);
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (lineBuf && !tooLarge) {
      const rest = lineBuf;
      lineBuf = "";
      parseLine(rest);
    }
    details.timings.cliMs = clock.now() - t0;

    await reap(tree, terminating);
    clearInterval(poller);
    clearTimeout(killTimer);
    clearTimeout(capTimer);

    const usage = isRec(resultEv?.usage) ? resultEv.usage : {};
    const setUsage = (k: keyof JobDetails["usage"], v: unknown): void => {
      const n = num(v);
      if (n !== undefined) details.usage[k] = n;
    };
    setUsage("turns", resultEv?.num_turns);
    setUsage("inputTokens", usage.input_tokens);
    setUsage("outputTokens", usage.output_tokens);
    setUsage("cacheReadTokens", usage.cache_read_input_tokens);
    setUsage("cacheWriteTokens", usage.cache_creation_input_tokens);

    const agentFailed = (termination: JobTermination): Out => ({ result: { status: "error", reason: "agent_failed" }, termination });
    const authOrQuota: Out = { result: { status: "unavailable", reason: "agent_unavailable" }, termination: "auth_or_quota" };

    if (exit.spawnError) return { result: { status: "unavailable", reason: "agent_unavailable" }, termination: "agent_unavailable", detail: "spawn_failed" };
    if (stop !== undefined) return stop;
    if (init === undefined) {
      if (resultEv && isAuthOrQuota(resultEv)) return authOrQuota;
      return { result: { status: "error", reason: "unsupported_configuration" }, termination: "malformed_startup", detail: "no_init" };
    }
    if (resultEv === undefined) return agentFailed("no_result");
    if (resultEv.subtype === "error_max_turns") return agentFailed("max_turns");
    if (resultEv.is_error !== false) return isAuthOrQuota(resultEv) ? authOrQuota : agentFailed("process_error");
    if (resultEv.subtype !== "success") return agentFailed("process_error");
    if (resultEv.structured_output === undefined) return { result: { status: "error", reason: "invalid_output" }, termination: "invalid_output", detail: "no_structured_output" };

    const v = validateJobOutput(resultEv.structured_output, req);
    if (v.status === "invalid") {
      details.droppedPicks = v.droppedPicks;
      return { result: { status: "error", reason: "invalid_output" }, termination: "invalid_output" };
    }
    if (v.status === "empty") {
      if (options.instructionMarker !== undefined) details.instructionMarker = "missing";
      return { result: { status: "empty" }, termination: "completed" };
    }
    details.droppedPicks = v.droppedPicks;
    details.cutPicks = v.cutPicks;
    const items = v.items.map((i) => ({ ...i }));
    if (options.instructionMarker !== undefined) {
      const first = items[0]!;
      const taken = takeInstructionMarker(first.reason, options.instructionMarker);
      details.instructionMarker = taken.reached ? "reached" : "missing";
      if (taken.reason !== "") first.reason = taken.reason;
    }
    return { result: { status: "ok", items }, termination: "completed" };
  }

  // Verbatim from the legacy agentRunner.
  async function reap(tree: OwnedTree | undefined, alreadySignalled: boolean): Promise<void> {
    if (!tree) return;
    const waitGone = async (ms: number): Promise<boolean> => {
      const until = Date.now() + ms;
      for (;;) {
        tree.poll();
        if (tree.alive().length === 0) return true;
        if (Date.now() >= until) return false;
        await sleep(100);
      }
    };
    if (await waitGone(alreadySignalled ? killGraceMs : 1000)) return;
    if (!alreadySignalled) {
      tree.signalAll("SIGTERM");
      if (await waitGone(killGraceMs)) return;
    }
    tree.signalAll("SIGKILL");
    await waitGone(1000);
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
      const c = current;
      if (!c) return;
      c.stop({ result: { status: "cancelled", reason: "shutdown" }, termination: "cancelled" });
      await c.done;
    },
  };
}
