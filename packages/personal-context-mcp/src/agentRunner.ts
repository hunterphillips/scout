// The agent runner: one `claude -p` run per rank request, over a fresh private run dir.
//
// Per run it builds a direct launch profile (launchProfile.ts: allowlisted child env,
// absolute claude path, fresh 0700 cwd outside the workspace) and uses that cwd as the run
// dir. It writes snapshot.json, sources.json, mcp.json (one stdio server `sources`:
// `<nodePath> <sourceToolsPath> --run-dir <runDir>`), system.md and schema.json (0600),
// then spawns claude with the Phase 0B flag set, argv only, detached, with the prompt on
// stdin.
//
// Output format: the plan text says `--output-format json`. Per the Phase 0B engineering
// default this runs `--output-format stream-json --verbose` instead, so the per-run
// capability check can run on the streamed `init` event (auth source `none`, exactly the
// `sources` MCP server connected, only the source tools plus the StructuredOutput
// formatter). The final `result` envelope's `structured_output` is then extracted and
// validated (validateResponse.ts). A JSON-only envelope proves compatibility, not
// capabilities.
//
// Billing gate: refreshPreflight() runs the direct preflight (blocking; call it at service
// start and after a config change, never on the request path) and caches the verdict.
// Unless the cached verdict is `subscription`, every run returns
// `unavailable: "billing route unverified"` and nothing is spawned. A run captures the
// config when it passes the gate and re-checks the verdict and a config generation after
// it gets a slot, so a setConfig while it waits also ends it as unverified.
//
// Aborts: each run has one abort path. The deadline (min(req.deadlineMs,
// config.maxRankMs), counted from run()), the caller's AbortSignal (one
// `controller.abort(reason)` per HTTP-level trigger), and abortAll() all end there. Abort
// sends SIGTERM to the CLI's process group (directly, without ps, while the CLI is
// unreaped), SIGKILL 2 s later, then SIGKILL to any PID still alive from the tree recorded
// since spawn. The wait for exit is capped at grace + 2 s (logged as `reap_timeout`), then
// the run dir is removed.
// A counting semaphore allows 2 concurrent runs; a queued run that is aborted leaves the
// queue as `cancelled` without spawning.
//
// Logging: `<home>/runs.jsonl` (0600) gets one line per run with timings, turns, token
// counts, tool-call count, source ids, droppedCount, status and fixed reason codes. The
// request id is hashed. Never prompts, snippets, candidate text, titles or paths. The
// `log` callback gets fixed codes only.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants as fsc, fchmodSync, fstatSync, openSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_OUTPUT_JSON_SCHEMA, type RankRequest } from "./api.js";
import { readAuditIndex, EMPTY_AUDIT, type AuditIndex } from "./auditIndex.js";
import type { Env, Verdict } from "./authPreflight.js";
import { systemClock, type Clock } from "./clock.js";
import type { PcmConfig, SourceConfig } from "./config.js";
import {
  createLaunchProfile,
  runDirectPreflight,
  type DirectPreflightOptions,
  type LaunchProfile,
  type LaunchProfileOptions,
} from "./launchProfile.js";
import type { ObservationSnapshot } from "./observationStore.js";
import { OwnedTree, psSnapshot, type PsSnapshot } from "./processTree.js";
import { buildPrompt, buildSystemMd } from "./prompt.js";
import {
  AUDIT_FILE,
  MAX_RUN_BYTES,
  MAX_RUN_CALLS,
  MAX_SNAPSHOT_OBSERVATIONS,
  parseRunSources,
  RunSnapshotSchema,
  SNAPSHOT_FILE,
  SOURCES_FILE,
  type RunSnapshot,
} from "./sourceTools/runFiles.js";
import type { EvidenceLocation } from "./sourceTools/evidence.js";
import { INVALID_OUTPUT, validateResponse, type LabelFor, type RankResult } from "./validateResponse.js";

// ---------- fixed values ----------

export const MAX_CONCURRENT_RUNS = 2;
export const KILL_GRACE_MS = 2000;
/** The source-tools run budget (MAX_RUN_CALLS = 20 calls), the final structured output, and slack. */
export const MAX_TURNS = 24;
export const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
export const RUNS_FILE = "runs.jsonl";

/** The source tools the `sources` server registers, as the CLI names them. */
export const SOURCE_TOOLS: readonly string[] = Object.freeze(
  ["list_sources", "read_recent_activity", "search_source", "read_source", "get_focus"].map((t) => `mcp__sources__${t}`),
);
/** The CLI's internal formatter for --json-schema. Allowed by exact name only. */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
const ALLOWED_TOOLS: ReadonlySet<string> = new Set([...SOURCE_TOOLS, STRUCTURED_OUTPUT_TOOL]);

/** Why a run was cancelled. Each HTTP-level trigger (Task 4) maps to one of these. */
export type AbortReason =
  | "deadline"
  | "notifications_cancelled"
  | "supersedes"
  | "session_closed"
  | "response_closed"
  | "grant_changed"
  | "sigterm"
  | "sigint"
  | "aborted";

const ABORT_REASONS: ReadonlySet<string> = new Set<AbortReason>([
  "deadline",
  "notifications_cancelled",
  "supersedes",
  "session_closed",
  "response_closed",
  "grant_changed",
  "sigterm",
  "sigint",
  "aborted",
]);

/** Fixed failure reasons the runner sets (validation adds invalid_output / validation_failed). */
export const REASONS = Object.freeze({
  billing: "billing route unverified",
  authOrQuota: "auth or quota",
  profile: "launch profile unavailable",
  sourceTools: "source tools unavailable",
  sources: "sources unavailable",
  claude: "claude unavailable",
  setup: "run setup failed",
  capability: "capability check failed",
  outputTooLarge: "output too large",
  noResult: "no result",
  agentError: "agent error",
  maxTurns: "max turns",
});

// ---------- public types ----------

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface PreflightState {
  verdict: Verdict | "unchecked";
  /** Fixed reason codes only. */
  reasons: readonly string[];
  at?: number;
}

export type PreflightFn = (opts: DirectPreflightOptions) => { verdict: Verdict; reasons: readonly string[] };

export interface AgentRunnerDeps {
  config: PcmConfig;
  /** The service home; runs.jsonl lives here. */
  home: string;
  /** The service's own environment; the launch profile picks the allowlisted keys from it. */
  parentEnv: Env;
  /** Where run dirs go; must be outside every workspace root (the launch profile checks). */
  scratchRoot: string;
  workspaceRoots: readonly string[];
  clock?: Clock;
  spawn?: SpawnFn;
  /** Absolute path of the built `sourceTools.js`. Defaults to the sibling of this module. */
  sourceToolsPath?: string;
  preflight?: PreflightFn;
  log?: (line: string) => void;
  /** Debugging only: leave run dirs in place. */
  keepRunDir?: boolean;
  maxConcurrent?: number;
  killGraceMs?: number;
  maxStdoutBytes?: number;
  psSnapshot?: () => PsSnapshot;
  /** Test seam for the prompt delimiter nonce. */
  nonce?: () => string;
}

export interface RunContext {
  /** The observation store's snapshot, taken when the request arrived. */
  snapshot: ObservationSnapshot;
  /** The configured sources; only enabled ones reach the run. */
  sources: readonly SourceConfig[];
  sourceGrantRevision: string;
  signal?: AbortSignal;
}

export interface RunStats {
  ms: number;
  turns?: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolCalls: number;
  sourceIds: readonly string[];
}

export interface RunOutcome {
  /** The response without ContextStatus; the server adds those fields. */
  result: RankResult;
  /** Present once a CLI was spawned. */
  stats?: RunStats;
  /** The evidence the run's tools issued (empty when nothing ran). */
  audit: AuditIndex;
}

export interface AgentRunner {
  /** Blocking (spawnSync, up to minutes): only at service start and after a config change. */
  refreshPreflight(): PreflightState;
  readonly preflight: PreflightState;
  /** Replace the config; the cached verdict resets to `unchecked` until refreshPreflight(). */
  setConfig(config: PcmConfig): void;
  run(req: RankRequest, ctx: RunContext): Promise<RunOutcome>;
  /** Abort every queued and running run; resolves once all have finished cleaning up. */
  abortAll(reason: AbortReason): Promise<void>;
  /** Runs holding a slot. */
  readonly active: number;
  /** Runs waiting for a slot. */
  readonly queued: number;
}

// ---------- helpers ----------

export function hashRequestId(requestId: string): string {
  return createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 16);
}

/**
 * A preflight reason without local paths: the settings reasons name the file they came
 * from (`user settings /Users/x/.claude/settings.json: apiKeyHelper present`), which would
 * reveal the username and layout. Keeps the scope and the code.
 */
export function redactReason(reason: string): string {
  return reason.replace(/^(\w+ settings) .*?(: [^:]*)$/u, "$1$2").replace(/(?:^|(?<=\s))\/\S+/gu, "<path>");
}

function toAbortReason(v: unknown): AbortReason {
  return typeof v === "string" && ABORT_REASONS.has(v) ? (v as AbortReason) : "aborted";
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600, flag: "wx" });
}

/** argv after the claude path: exactly the Phase 0B flag set, streamed. */
export function buildArgv(modelArgs: readonly string[], runDir: string): string[] {
  return [
    ...modelArgs,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    JSON.stringify(AGENT_OUTPUT_JSON_SCHEMA),
    "--strict-mcp-config",
    "--mcp-config",
    join(runDir, "mcp.json"),
    "--tools",
    "",
    "--allowedTools",
    "mcp__sources__*",
    "--permission-mode",
    "dontAsk",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt-file",
    join(runDir, "system.md"),
    "--max-turns",
    String(MAX_TURNS),
  ];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);

/** Whether the streamed init event shows exactly the granted capabilities. Returns fixed codes. */
export function checkInit(init: Rec): string[] {
  const reasons: string[] = [];
  const tools = Array.isArray(init.tools) ? init.tools : [];
  if (tools.some((t) => typeof t !== "string" || !ALLOWED_TOOLS.has(t))) reasons.push("init: unexpected tools");
  if (!SOURCE_TOOLS.every((t) => tools.includes(t))) reasons.push("init: source tools missing");
  const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
  if (servers.length !== 1 || !isRec(servers[0]) || servers[0].name !== "sources" || servers[0].status !== "connected") {
    reasons.push("init: mcp servers are not exactly sources/connected");
  }
  if (init.permissionMode !== "dontAsk") reasons.push("init: permission mode is not dontAsk");
  // apiProvider is optional in the init event; when present it must be first-party.
  // Absence is accepted because the cached direct preflight already proved the provider
  // route for this launch profile (no provider env keys forwarded, no provider settings,
  // CLI logged in to a subscription). The window left is a change to settings or login
  // between that preflight and this run, on a CLI build that omits apiProvider; the
  // apiKeySource check below still catches an API-key route inside that window.
  if (init.apiKeySource !== "none" || (init.apiProvider !== undefined && init.apiProvider !== "firstParty")) {
    reasons.push("init: unexpected auth route");
  }
  return reasons;
}

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

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The run's snapshot.json content. */
export function toRunSnapshot(snap: ObservationSnapshot, candidateCount: number): RunSnapshot {
  return {
    observations: snap.observations.slice(0, MAX_SNAPSHOT_OBSERVATIONS).map((o) => {
      const out: RunSnapshot["observations"][number] = {
        observationId: o.observationId,
        sensor: o.sensor,
        kind: o.kind,
        observedAt: o.observedAt,
        url: o.url,
        title: o.title,
        truncated: o.truncated,
      };
      if (o.text !== undefined) out.text = o.text;
      return out;
    }),
    candidateCount,
    budgets: { maxCalls: MAX_RUN_CALLS, maxTotalBytes: MAX_RUN_BYTES },
  };
}

/**
 * Labels from the run's own snapshot: `recent page: <title>` for activity. The title is
 * Hunter's own browsing history, shown only in his native panel, which the site cannot read.
 */
function labelsFrom(snap: RunSnapshot): LabelFor {
  const titles = new Map(snap.observations.map((o) => [o.observationId, o.title]));
  return (loc: EvidenceLocation) => {
    if (loc.kind === "activity") {
      const title = loc.path === undefined ? undefined : titles.get(loc.path);
      return title ? `recent page: ${title}` : "recent page";
    }
    if (loc.kind === "focus") return "focus item";
    return loc.path === undefined ? loc.sourceId : `${loc.sourceId}: ${loc.path}`;
  };
}

// ---------- abort plumbing ----------

class RunHandle {
  reason: AbortReason | undefined;
  private readonly listeners = new Set<(r: AbortReason) => void>();
  abort(r: AbortReason): void {
    if (this.reason !== undefined) return;
    this.reason = r;
    for (const l of [...this.listeners]) l(r);
  }
  onAbort(fn: (r: AbortReason) => void): () => void {
    if (this.reason !== undefined) {
      fn(this.reason);
      return () => {};
    }
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

class Semaphore {
  private readonly waiters: Array<(ok: boolean) => void> = [];
  held = 0;
  constructor(private readonly size: number) {}
  get waiting(): number {
    return this.waiters.length;
  }
  /** Resolves true with a slot, or false if `handle` aborts first (then no slot is held). */
  acquire(handle: RunHandle): Promise<boolean> {
    if (handle.reason !== undefined) return Promise.resolve(false);
    if (this.held < this.size) {
      this.held++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter = (ok: boolean): void => {
        off();
        resolve(ok);
      };
      const off = handle.onAbort(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        waiter(false);
      });
      this.waiters.push(waiter);
    });
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next(true); // the slot passes straight on
    else this.held--;
  }
}

// ---------- the runner ----------

interface CliOutcome {
  result: RankResult;
  stats: RunStats;
  audit: AuditIndex;
}

export function createAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  const clock = deps.clock ?? systemClock;
  const spawn: SpawnFn = deps.spawn ?? ((c, a, o) => nodeSpawn(c, [...a], o));
  const rawLog = deps.log ?? (() => {});
  // A throwing logger must never break a run (the stdout handler calls this).
  const log = (line: string): void => {
    try {
      rawLog(line);
    } catch {
      // ignored
    }
  };
  const preflightFn: PreflightFn = deps.preflight ?? runDirectPreflight;
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  const maxStdout = deps.maxStdoutBytes ?? MAX_STDOUT_BYTES;
  const snapshotFn = deps.psSnapshot ?? psSnapshot;
  const sourceToolsPath = deps.sourceToolsPath ?? join(fileURLToPath(new URL(".", import.meta.url)), "sourceTools.js");
  const sem = new Semaphore(deps.maxConcurrent ?? MAX_CONCURRENT_RUNS);
  const handles = new Set<RunHandle>();
  const inflight = new Set<Promise<unknown>>();
  let config = deps.config;
  /** Bumped by setConfig; a queued run whose config generation moved never spawns. */
  let configGen = 0;
  let preflight: PreflightState = { verdict: "unchecked", reasons: [] };

  function profileOptions(cfg: PcmConfig = config): LaunchProfileOptions {
    const o: LaunchProfileOptions = { parentEnv: deps.parentEnv, scratchRoot: deps.scratchRoot, workspaceRoots: deps.workspaceRoots };
    if (cfg.model !== null) o.model = cfg.model;
    if (cfg.claudePath !== undefined) o.claudePath = cfg.claudePath;
    return o;
  }

  function refreshPreflight(): PreflightState {
    let verdict: Verdict = "ambiguous";
    let reasons: readonly string[] = ["internal: preflight failed unexpectedly"];
    try {
      const r = preflightFn(profileOptions());
      verdict = r.verdict === "subscription" ? "subscription" : "ambiguous";
      reasons = Object.freeze(r.reasons.map(redactReason));
    } catch {
      // never echo the error
    }
    preflight = Object.freeze({ verdict, reasons, at: clock.now() });
    log(`preflight: ${verdict}${reasons.length ? ` (${reasons.join("; ")})` : ""}`);
    return preflight;
  }

  function appendRunLine(line: Record<string, unknown>): void {
    try {
      const fd = openSync(join(deps.home, RUNS_FILE), fsc.O_WRONLY | fsc.O_APPEND | fsc.O_CREAT | fsc.O_NOFOLLOW, 0o600);
      try {
        // A pre-existing file keeps its mode on open; narrow it before writing.
        if ((fstatSync(fd).mode & 0o077) !== 0) fchmodSync(fd, 0o600);
        writeSync(fd, JSON.stringify(line) + "\n");
      } finally {
        closeSync(fd);
      }
    } catch {
      log("runs-log: write failed");
    }
  }

  function record(req: RankRequest, ctx: RunContext, t0: number, out: RunOutcome, cancelReason?: AbortReason): void {
    const r = out.result;
    const line: Record<string, unknown> = {
      t: new Date(clock.now()).toISOString(),
      req: hashRequestId(req.requestId),
      grant: ctx.sourceGrantRevision,
      status: r.status,
      ms: clock.now() - t0,
    };
    if (r.status !== "ok" && r.status !== "empty" && r.status !== "cancelled") line.reason = r.reason;
    if (cancelReason !== undefined) line.cancelReason = cancelReason;
    const s = out.stats;
    if (s) {
      line.cliMs = s.ms;
      for (const k of ["turns", "tokensIn", "tokensOut", "cacheReadTokens", "cacheWriteTokens"] as const) if (s[k] !== undefined) line[k] = s[k];
      line.toolCalls = s.toolCalls;
      line.sourceIds = s.sourceIds;
    }
    if ("droppedCount" in r && r.droppedCount !== undefined) line.droppedCount = r.droppedCount;
    appendRunLine(line);
  }

  async function run(req: RankRequest, ctx: RunContext): Promise<RunOutcome> {
    const t0 = clock.now();
    const handle = new RunHandle();
    handles.add(handle);
    const cleanups: Array<() => void> = [];
    let holdsSlot = false;
    const finish = (out: RunOutcome): RunOutcome => {
      record(req, ctx, t0, out, out.result.status === "cancelled" ? handle.reason : undefined);
      return out;
    };
    const cancelled = (): RunOutcome => finish({ result: { status: "cancelled", reason: handle.reason ?? "aborted" }, audit: EMPTY_AUDIT });
    const unverified = (): RunOutcome => finish({ result: { status: "unavailable", reason: REASONS.billing }, audit: EMPTY_AUDIT });
    try {
      if (preflight.verdict !== "subscription") return unverified();
      // The config the verdict covers, captured now: a setConfig while this run waits for a
      // slot must not hand it an unverified claude path, model or node path.
      const gen = configGen;
      const cfg = config;
      const deadlineMs = Math.min(req.deadlineMs, cfg.maxRankMs);
      const timer = setTimeout(() => handle.abort("deadline"), deadlineMs);
      cleanups.push(() => clearTimeout(timer));
      if (ctx.signal) {
        const signal = ctx.signal;
        const onSignal = (): void => handle.abort(toAbortReason(signal.reason));
        if (signal.aborted) onSignal();
        else {
          signal.addEventListener("abort", onSignal, { once: true });
          cleanups.push(() => signal.removeEventListener("abort", onSignal));
        }
      }
      holdsSlot = await sem.acquire(handle);
      if (!holdsSlot || handle.reason !== undefined) return cancelled();
      if (preflight.verdict !== "subscription" || configGen !== gen) return unverified();
      return finish(await execute(req, ctx, handle, cfg));
    } finally {
      for (const c of cleanups) c();
      if (holdsSlot) sem.release();
      handles.delete(handle);
    }
  }

  async function execute(req: RankRequest, ctx: RunContext, handle: RunHandle, cfg: PcmConfig): Promise<RunOutcome> {
    let profile: LaunchProfile;
    try {
      profile = createLaunchProfile(profileOptions(cfg));
    } catch {
      return { result: { status: "unavailable", reason: REASONS.profile }, audit: EMPTY_AUDIT };
    }
    const runDir = profile.cwd;
    try {
      let toolsOk = false;
      try {
        toolsOk = statSync(sourceToolsPath).isFile();
      } catch {
        // missing
      }
      if (!toolsOk) return { result: { status: "unavailable", reason: REASONS.sourceTools }, audit: EMPTY_AUDIT };

      let sources: SourceConfig[];
      try {
        sources = parseRunSources({ sources: ctx.sources.filter((s) => s.enabled) });
      } catch {
        return { result: { status: "unavailable", reason: REASONS.sources }, audit: EMPTY_AUDIT };
      }
      const parsedSnap = RunSnapshotSchema.safeParse(toRunSnapshot(ctx.snapshot, req.candidates.length));
      if (!parsedSnap.success) return { result: { status: "error", reason: REASONS.setup }, audit: EMPTY_AUDIT };
      const snap = parsedSnap.data;

      try {
        const server: Rec = { type: "stdio", command: cfg.nodePath ?? process.execPath, args: [sourceToolsPath, "--run-dir", runDir] };
        // The default home is excluded by path already; an override has to be passed on.
        const parentHome = deps.parentEnv.HOME;
        if (parentHome === undefined || deps.home !== join(parentHome, ".personal-context-mcp")) server.env = { PERSONAL_CONTEXT_HOME: deps.home };
        writePrivate(join(runDir, SNAPSHOT_FILE), JSON.stringify(snap));
        writePrivate(join(runDir, SOURCES_FILE), JSON.stringify({ sources }));
        writePrivate(join(runDir, "mcp.json"), JSON.stringify({ mcpServers: { sources: server } }, null, 2));
        writePrivate(join(runDir, "system.md"), buildSystemMd(req.maxResults));
        // A debugging copy only: --json-schema gets the schema inline (buildArgv), never this file.
        writePrivate(join(runDir, "schema.json"), JSON.stringify(AGENT_OUTPUT_JSON_SCHEMA, null, 2));
      } catch {
        return { result: { status: "error", reason: REASONS.setup }, audit: EMPTY_AUDIT };
      }
      if (handle.reason !== undefined) return { result: { status: "cancelled", reason: handle.reason }, audit: EMPTY_AUDIT };

      return await runCli(profile, runDir, buildPrompt(req, deps.nonce?.()), handle, labelsFrom(snap));
    } finally {
      if (!deps.keepRunDir) {
        try {
          profile.cleanup();
        } catch {
          log("run-dir: removal failed");
        }
      }
    }

    async function runCli(profile: LaunchProfile, runDir: string, prompt: string, handle: RunHandle, labelFor: LabelFor): Promise<CliOutcome> {
      const t0 = clock.now();
      let child: ChildProcess;
      try {
        child = spawn(profile.claudePath, buildArgv(profile.modelArgs, runDir), {
          cwd: runDir,
          env: { ...profile.env },
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });
      } catch {
        return { result: { status: "unavailable", reason: REASONS.claude }, stats: { ms: 0, toolCalls: 0, sourceIds: [] }, audit: EMPTY_AUDIT };
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
      let failure: string | undefined; // internal abort: a fixed REASONS value
      let cancelReason: AbortReason | undefined;
      let terminating = false;
      let killTimer: NodeJS.Timeout | undefined;
      let capTimer: NodeJS.Timeout | undefined;
      let resolveCap: (v: "reap_timeout") => void = () => {};
      const capped = new Promise<"reap_timeout">((r) => (resolveCap = r));
      // The CLI's own group, signalled without ps. Safe only while the child is unreaped:
      // until then its pid (and so its group id) cannot have been reused.
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
        // The ps-based tree covers stragglers and processes that left the group.
        tree?.poll();
        tree?.signalAll("SIGTERM");
        killTimer = setTimeout(() => {
          signalGroup("SIGKILL");
          tree?.poll();
          if (tree && tree.alive().length) tree.signalAll("SIGKILL");
        }, killGraceMs);
        // However the signals went, the wait for exit is bounded.
        capTimer = setTimeout(() => resolveCap("reap_timeout"), killGraceMs + 2000);
      };
      const fail = (reason: string): void => {
        if (failure === undefined && cancelReason === undefined) failure = reason;
        terminate();
      };
      const offAbort = handle.onAbort((r) => {
        // A result that already arrived stands; the tree is cleaned up either way.
        if (resultEv === undefined && failure === undefined) cancelReason = r;
        terminate();
      });

      const onEvent = (ev: Rec): void => {
        if (init === undefined && (ev.type === "assistant" || ev.type === "user")) return fail(REASONS.capability);
        if (ev.type === "system" && ev.subtype === "init") {
          init = ev;
          const reasons = checkInit(ev);
          if (reasons.length) {
            log(`capability check failed: ${reasons.join("; ")}`);
            fail(REASONS.capability);
          }
        } else if (ev.type === "assistant") {
          const content = isRec(ev.message) && Array.isArray(ev.message.content) ? ev.message.content : [];
          for (const c of content) {
            if (isRec(c) && c.type === "tool_use" && (typeof c.name !== "string" || !ALLOWED_TOOLS.has(c.name))) {
              log("capability check failed: unexpected tool use");
              fail(REASONS.capability);
            }
          }
        } else if (ev.type === "result" && resultEv === undefined) {
          resultEv = ev;
        }
        if (ev.type !== "result" && isAuthOrQuota(ev)) fail(REASONS.authOrQuota);
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
      let lineBuf = "";
      // Decoded as a stream, so a character split across chunks survives.
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (failure === REASONS.outputTooLarge) return;
        stdoutBytes += Buffer.byteLength(chunk, "utf8");
        if (stdoutBytes > maxStdout) return fail(REASONS.outputTooLarge);
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
      if (raced === "reap_timeout") log("reap_timeout");
      const exit = raced === "reap_timeout" ? { spawnError: false } : raced;
      offAbort();
      // Let stdout drain briefly; a descendant holding it open must not stall us.
      const stdout = child.stdout;
      if (stdout) await Promise.race([new Promise<void>((r) => (stdout.readableEnded ? r() : stdout.once("end", () => r()))), sleep(500)]);
      child.stdout?.destroy();
      child.stderr?.destroy();
      // A last line without a trailing newline still counts.
      if (lineBuf && failure !== REASONS.outputTooLarge) {
        const rest = lineBuf;
        lineBuf = "";
        parseLine(rest);
      }
      const ms = clock.now() - t0;

      // Reap the rest of the tree: wait briefly, then SIGTERM, then SIGKILL what is left.
      await reap(tree, terminating);
      clearInterval(poller);
      clearTimeout(killTimer);
      clearTimeout(capTimer);

      const audit = readAuditIndex(join(runDir, AUDIT_FILE));
      const usage = isRec(resultEv?.usage) ? resultEv.usage : {};
      const stats: RunStats = { ms, toolCalls: audit.toolCalls, sourceIds: audit.sourceIds };
      const turns = num(resultEv?.num_turns);
      if (turns !== undefined) stats.turns = turns;
      const tIn = num(usage.input_tokens);
      if (tIn !== undefined) stats.tokensIn = tIn;
      const tOut = num(usage.output_tokens);
      if (tOut !== undefined) stats.tokensOut = tOut;
      const cRead = num(usage.cache_read_input_tokens);
      if (cRead !== undefined) stats.cacheReadTokens = cRead;
      const cWrite = num(usage.cache_creation_input_tokens);
      if (cWrite !== undefined) stats.cacheWriteTokens = cWrite;

      const done = (result: RankResult): CliOutcome => ({ result, stats, audit });
      if (exit.spawnError) return done({ status: "unavailable", reason: REASONS.claude });
      if (cancelReason !== undefined) return done({ status: "cancelled", reason: cancelReason });
      if (failure === REASONS.authOrQuota) return done({ status: "unavailable", reason: failure });
      if (failure !== undefined) return done({ status: "error", reason: failure });
      // Every streamed run must prove its capabilities before its result counts.
      if (init === undefined) {
        if (resultEv && isAuthOrQuota(resultEv)) return done({ status: "unavailable", reason: REASONS.authOrQuota });
        return done({ status: "error", reason: REASONS.capability });
      }
      if (resultEv === undefined) return done({ status: "error", reason: REASONS.noResult });
      if (resultEv.subtype === "error_max_turns") return done({ status: "error", reason: REASONS.maxTurns });
      if (resultEv.is_error !== false) {
        if (isAuthOrQuota(resultEv)) return done({ status: "unavailable", reason: REASONS.authOrQuota });
        return done({ status: "error", reason: REASONS.agentError });
      }
      if (resultEv.subtype !== "success") return done({ status: "error", reason: REASONS.agentError });
      if (resultEv.structured_output === undefined) return done({ status: "error", reason: INVALID_OUTPUT });
      return done(validateResponse({ output: resultEv.structured_output, req, audit, labelFor }));
    }
  }

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

  function track<T>(p: Promise<T>): Promise<T> {
    inflight.add(p);
    const drop = (): void => void inflight.delete(p);
    p.then(drop, drop);
    return p;
  }

  return {
    refreshPreflight,
    get preflight() {
      return preflight;
    },
    setConfig(next) {
      config = next;
      configGen++;
      preflight = { verdict: "unchecked", reasons: [] };
    },
    run: (req, ctx) => track(run(req, ctx)),
    async abortAll(reason) {
      for (const h of [...handles]) h.abort(reason);
      await Promise.allSettled([...inflight]);
    },
    get active() {
      return sem.held;
    },
    get queued() {
      return sem.waiting;
    },
  };
}
