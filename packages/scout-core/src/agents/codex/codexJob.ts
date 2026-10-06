// Codex as an agent-job adapter: one fresh, unattended, read-only `codex exec --ephemeral` per job.
//
// Per job (launch.ts): the private Codex home `SCOUT_HOME/run/codex-home` (created when the
// adapter is built and checked before each job), a 0700 job dir `SCOUT_HOME/run/jobs/<request-id>/`
// with `agent-token`, `schema.json`, `bridge.json` when the profile selects user tools, and
// `state/` (Codex's SQLite home), plus `tree.json` from the spawn on (processTree.ts). The CLI
// runs argv-only, detached, from `SCOUT_HOME/run/agent-cwd`, with the prompt on stdin; the job
// dir is removed when the job ends, however it ends.
//
// The prompt: Codex has no system-prompt flag, so Scout's instructions (prompt.ts
// buildJobInstructions) go first under an `Instructions` line, then a blank line, then the
// request (buildJobPrompt). The final answer is the last agent message, shaped by the strict
// output schema (outputSchema.ts).
//
// Tool surface: the same plan as Claude's (claudeCode/toolPolicy.ts planJobTools, jobSurface.ts):
// Scout's server, plus the forwarding bridge for the profile's selected tools. Claude's
// managed-policy check does not apply. The event monitor (eventMonitor.ts) halts on any tool
// outside that surface and on any shell, web or file item.
//
// Lifecycle, shared with Claude's adapter by import: jsonLineStream.ts parses stdout (4 MiB cap,
// `output_too_large`); jobStop.ts holds the one stop decision; childSupervisor.ts spawns,
// terminates (group SIGTERM, SIGKILL after the grace) and reaps the tree; mapOutcome.ts turns the
// finished run into an outcome. The run gates are Claude's, in the same order: request, closed,
// busy, deadline, readiness (wait for a check in flight within the deadline; start one when
// none ran yet or the last could not read the CLI version), `subscription` only, profile
// fingerprint, tool surface, signal, the launch floor.
//
// Readiness (readiness.ts): `codex login status` must say ChatGPT, no API key variable may be
// set, and the private home's auth link must be intact. `readinessAsync` (the core passes
// readinessWorker.ts's child-process facade) keeps the core's event loop free; without it the
// check runs in-process (blocking).
//
// Diagnostics (`agent_job`, `agent_preflight`, both with `adapter: "codex"`): hashed request
// ID, origin, status, reason, termination, timings, usage counts, tool-use count, CLI version,
// model. Never prompts, candidate text, tokens or URLs beyond the origin.

import { spawn as nodeSpawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { AgentTokenSchema, JobRequestSchema, type HostJobResult, type JobRequest } from "@scout/contracts";
import { systemClock, type Clock } from "../../clock.js";
import type { Diagnostics } from "../../diagnostics.js";
import { ensureAgentCwd } from "../../localSocketFiles.js";
import { hashRequestId, MIN_LAUNCH_MS, toCancelReason, type AgentJobAdapter, type AgentReadiness, type JobDetails, type JobOutcome, type JobRunOptions, type JobTermination } from "../adapter.js";
import { startChild, type SnapshotFn, type SpawnFn, type SupervisedChild } from "../childSupervisor.js";
import type { BridgeJob } from "../contextToolBridge.js";
import type { Env } from "../executables.js";
import { JobStop, type Ending, type Out } from "../jobStop.js";
import { createJsonLineStream } from "../jsonLineStream.js";
import { writeTreeRecord, type ProcessTracker } from "../processTree.js";
import { profileFingerprint } from "../profile.js";
import { buildJobInstructions, buildJobPrompt } from "../prompt.js";
import { createCodexEventMonitor } from "./eventMonitor.js";
import { createCodexLaunch, ensureCodexHome, type CodexLaunch } from "./launch.js";
import { mapCodexOutcome, recordCodexUsage } from "./mapOutcome.js";
import { CODEX_ADAPTER_ID, CODEX_MODEL_RE, type CodexProfile } from "./profile.js";
import { runCodexReadinessFor, type CodexReadinessInput, type CodexReadinessReport } from "./readiness.js";
import type { AsyncCodexReadinessFn } from "./readinessWorker.js";

export const VERIFIED_CODEX_VERSION = "0.155.1";
export const JOB_MAX_TURNS = 16;
export const KILL_GRACE_MS = 2000;
export const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

/** The stdin prompt: Scout's instructions first, then the request. */
export function buildCodexPrompt(request: string, maxTurns = JOB_MAX_TURNS): string {
  return `Instructions\n${buildJobInstructions(maxTurns)}\n${request}`;
}

export type CodexReadinessFn = (input: CodexReadinessInput) => CodexReadinessReport;

/** The readiness verdict: `ok` only for `subscription`; `version` is the CLI version it saw. */
export interface CodexReadiness extends AgentReadiness {
  readonly verdict: "subscription" | "ambiguous" | "unchecked";
}

export interface CodexJobDeps {
  /** SCOUT_HOME; job dirs go under `run/jobs/`. */
  home: string;
  profile: CodexProfile;
  /** The core's environment; the launch picks the allowlisted keys from it. */
  parentEnv: Env;
  workspaceRoots?: readonly string[];
  nodePath?: string;
  scoutMcpEntrypoint?: string;
  bridgeEntrypoint?: string;
  bridgeLimits?: BridgeJob["limits"];
  clock?: Clock;
  diagnostics?: Diagnostics;
  spawn?: SpawnFn;
  /** The in-process readiness check (blocking). Default runCodexReadinessFor. */
  readiness?: CodexReadinessFn;
  /** The off-thread check refreshReadiness uses. Defaults to `readiness`. */
  readinessAsync?: AsyncCodexReadinessFn;
  psSnapshot?: SnapshotFn;
  processTracker?: ProcessTracker;
  killGraceMs?: number;
  maxStdoutBytes?: number;
  minLaunchMs?: number;
  /** Test seam for the prompt delimiter nonce. */
  nonce?: () => string;
}

export interface CodexJobAdapter extends AgentJobAdapter {
  refreshReadiness(knownVersion?: string): Promise<CodexReadiness>;
  readonly readiness: CodexReadiness;
  readonly active: boolean;
}

export class JobRequestError extends Error {
  constructor() {
    super("invalid job request");
    this.name = "JobRequestError";
  }
}

const READINESS_REASON_RE = /^[a-z_]{1,40}$|^internal: [a-z ]{1,80}$/;

export function createCodexJobAdapter(deps: CodexJobDeps): CodexJobAdapter {
  const spawn: SpawnFn = deps.spawn ?? ((c, a, o) => nodeSpawn(c, [...a], o));
  const readinessFn: CodexReadinessFn = deps.readiness ?? ((i) => runCodexReadinessFor(i));
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  const maxStdout = deps.maxStdoutBytes ?? MAX_STDOUT_BYTES;
  const minLaunchMs = deps.minLaunchMs ?? MIN_LAUNCH_MS;
  try {
    ensureAgentCwd(deps.home);
  } catch {
    deps.diagnostics?.event("agent_cwd_unusable", {}); // each job checks again before its spawn
  }
  if (!ensureCodexHome(deps.home, deps.parentEnv).ok) deps.diagnostics?.event("agent_home_unusable", { adapter: CODEX_ADAPTER_ID }); // readiness reports why
  const profile = deps.profile;
  const fingerprint = profileFingerprint(profile);
  let readiness: CodexReadiness = Object.freeze({ ok: false, verdict: "unchecked", reasons: [] });
  let current: { stop: JobStop; done: Promise<unknown> } | undefined;
  let closed = false;
  let refreshing: Promise<CodexReadiness> | undefined;
  /** The last check could not read the CLI version and was not subscription: the next job re-runs it. */
  let retryReadiness = false;

  const input = (): CodexReadinessInput => ({ home: deps.home, parentEnv: deps.parentEnv, codexPath: profile.codexPath, model: profile.model });

  function settle(r: CodexReadinessReport | undefined): CodexReadiness {
    const verdict = r?.verdict === "subscription" ? "subscription" : "ambiguous";
    const reasons = r === undefined ? ["internal: readiness failed unexpectedly"] : r.reasons.map((x) => (READINESS_REASON_RE.test(x) ? x : "internal: unrecognized reason"));
    readiness = Object.freeze({
      ok: verdict === "subscription",
      verdict,
      reasons: Object.freeze(reasons),
      ...(r?.version !== undefined ? { version: r.version } : {}),
      at: (deps.clock ?? systemClock).now(),
    });
    retryReadiness = !readiness.ok && readiness.version === undefined;
    deps.diagnostics?.event("agent_preflight", { adapter: CODEX_ADAPTER_ID, verdict: readiness.verdict, reasons: readiness.reasons.length, ...(readiness.version ? { cliVersion: readiness.version } : {}) });
    return readiness;
  }

  function refreshReadiness(knownVersion?: string): Promise<CodexReadiness> {
    if (refreshing) return refreshing;
    const fn: AsyncCodexReadinessFn = deps.readinessAsync ?? (async (i) => readinessFn(i));
    const p = (async () => {
      let r: CodexReadinessReport | undefined;
      try {
        r = await fn(input(), knownVersion);
      } catch {
        // never echo the error
      }
      return settle(r);
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

  async function run(request: JobRequest, options: JobRunOptions): Promise<JobOutcome> {
    const parsed = JobRequestSchema.safeParse(request);
    if (!parsed.success) throw new JobRequestError();
    const req = parsed.data;
    const clock = options.clock ?? deps.clock ?? systemClock;
    const t0 = clock.now();
    const details: JobDetails = {
      adapter: CODEX_ADAPTER_ID,
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
    if (!refreshing && retryReadiness) {
      retryReadiness = false;
      deps.diagnostics?.event("agent_preflight_retry", { adapter: CODEX_ADAPTER_ID });
      void refreshReadiness();
    } else if (!refreshing && readiness.verdict === "unchecked") {
      void refreshReadiness();
    }
    if (refreshing) {
      const settled = await waitBounded(refreshing, deadlineAt, clock, options.signal);
      if (settled === undefined) {
        if (options.signal?.aborted) return finish({ status: "cancelled", reason: toCancelReason(options.signal.reason) }, "cancelled");
        return finish({ status: "error", reason: "preflight_failed" }, "preflight_failed", "preflight_pending");
      }
      if (closed) return finish({ status: "unavailable", reason: "agent_unavailable" }, "agent_unavailable", "closed");
      if (current) return finish({ status: "unavailable", reason: "busy" }, "busy");
    }
    if (!readiness.ok) return finish({ status: "error", reason: "preflight_failed" }, "preflight_failed", "unverified");
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
      const out = await execute(req, scout, options, details, clock, stop);
      return finish(out.result, out.termination, out.detail);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onSignal);
      current = undefined;
      resolveDone();
    }
  }

  async function execute(req: JobRequest, scout: { socketPath: string; token: string }, options: JobRunOptions, details: JobDetails, clock: Clock, stop: JobStop): Promise<Out> {
    const home = ensureCodexHome(deps.home, deps.parentEnv);
    if (!home.ok) return { result: { status: "error", reason: "agent_failed" }, termination: "process_error", detail: home.reason };
    const made = createCodexLaunch({
      home: deps.home,
      profile,
      parentEnv: deps.parentEnv,
      requestId: req.requestId,
      surface: { scout },
      codexHome: home.codexHome,
      ...(deps.workspaceRoots ? { workspaceRoots: deps.workspaceRoots } : {}),
      ...(deps.nodePath ? { nodePath: deps.nodePath } : {}),
      ...(deps.scoutMcpEntrypoint ? { scoutMcpEntrypoint: deps.scoutMcpEntrypoint } : {}),
      ...(deps.bridgeEntrypoint ? { bridgeEntrypoint: deps.bridgeEntrypoint } : {}),
      ...(deps.bridgeLimits ? { bridgeLimits: deps.bridgeLimits } : {}),
    });
    if (!made.ok) return made.out;
    const launch = made.launch;
    try {
      for (const u of launch.unavailable) details.optionalTools.push({ ...u, status: "unavailable" });
      if (details.optionalTools.length > 0) details.optionalToolFailed = true;
      details.model = profile.model;
      if (readiness.version !== undefined) details.cliVersion = readiness.version;
      const promptOpts: Parameters<typeof buildJobPrompt>[1] = {};
      if (options.activity !== undefined) promptOpts.activity = options.activity;
      const nonce = deps.nonce?.();
      if (nonce !== undefined) promptOpts.nonce = nonce;
      const prompt = buildCodexPrompt(buildJobPrompt(req, promptOpts));
      if (stop.decision) return stop.decision; // stopped during setup: never spawn
      return await runCli(launch, prompt, req, details, clock, stop);
    } finally {
      try {
        launch.cleanup();
      } catch {
        deps.diagnostics?.event("agent_job_cleanup_failed", { adapter: CODEX_ADAPTER_ID });
      }
    }
  }

  async function runCli(launch: CodexLaunch, prompt: string, req: JobRequest, details: JobDetails, clock: Clock, stop: JobStop): Promise<Out> {
    const startedAt = clock.now();
    try {
      ensureAgentCwd(deps.home);
    } catch {
      return { result: { status: "error", reason: "agent_failed" }, termination: "process_error", detail: "setup_failed" };
    }
    let sup: SupervisedChild;
    try {
      sup = startChild({
        spawn,
        command: profile.codexPath,
        args: launch.argv,
        options: { cwd: launch.cwd, env: { ...launch.env }, stdio: ["pipe", "pipe", "pipe"] },
        killGraceMs,
        ...(deps.psSnapshot ? { snapshot: deps.psSnapshot } : {}),
        ...(deps.processTracker ? { tracker: deps.processTracker } : {}),
        onTree: (record) => writeTreeRecord(launch.jobDir, record),
      });
    } catch {
      return { result: { status: "unavailable", reason: "agent_unavailable" }, termination: "agent_unavailable", detail: "spawn_failed" };
    }
    try {
      const streamFailed: Out = { result: { status: "error", reason: "agent_failed" }, termination: "process_error", detail: "stream_failed" };
      stop.onHalt(() => sup.terminate());
      const monitor = createCodexEventMonitor({ expected: launch.toolSurface.expected, details, stop });
      let firstEventAt: number | undefined;
      const stream = createJsonLineStream({
        maxBytes: maxStdout,
        onEvent: (ev) => {
          firstEventAt ??= clock.now();
          monitor.onEvent(ev);
        },
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
      if (raced === "reap_timeout") deps.diagnostics?.event("agent_job_reap_timeout", { adapter: CODEX_ADAPTER_ID });
      const exit = raced === "reap_timeout" ? { spawnError: false } : raced;
      stop.seal();
      await sup.drainOutput();
      stream.end();
      details.timings.cliMs = clock.now() - startedAt;
      if (firstEventAt !== undefined) details.timings.initMs = firstEventAt - startedAt;
      await sup.reap();

      recordCodexUsage(monitor.completed, monitor.turns, details);
      return mapCodexOutcome(
        {
          spawnError: exit.spawnError,
          exitCode: child.exitCode,
          stop: stop.decision,
          completed: monitor.completed,
          lastMessage: monitor.lastMessage,
          authOrQuota: monitor.authOrQuota,
          requiredToolFailed: monitor.requiredToolFailed(),
        },
        req,
        details,
      );
    } finally {
      sup.dispose();
    }
  }

  function record(req: JobRequest, result: HostJobResult, details: JobDetails): void {
    if (!deps.diagnostics) return;
    const f: Record<string, number | string | boolean> = {
      adapter: CODEX_ADAPTER_ID,
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
    const toolErrors = Object.values(details.toolErrors).reduce((a, b) => a + b, 0);
    if (toolErrors > 0) f.toolErrors = toolErrors;
    if (details.optionalToolFailed) f.optionalToolFailed = true;
    if (details.model !== undefined && CODEX_MODEL_RE.test(details.model)) f.model = details.model;
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
    id: CODEX_ADAPTER_ID,
    refreshReadiness,
    get readiness() {
      return readiness;
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
