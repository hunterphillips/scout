// The billing preflight off the core's event loop. `runDirectPreflight` blocks (spawnSync, up
// to four `claude` calls at up to 20 s each), so the core never calls it directly: each run
// happens in a fresh child process (`child_process.fork` of preflightChildMain.ts) that gets
// the input over IPC, calls it, and sends the report back. The main thread keeps handling
// focus, pause and grant frames meanwhile.
//
// A child process, not a worker thread: a worker blocked in spawnSync cannot be terminated, and
// Node joins it on exit, so quitting could hold the core until the CLI call returned. The child
// leads its own process group; cancel, timeout and shutdown SIGKILL that group, which takes the
// `claude` call it is blocked on with it. Nothing waits for the child to exit.
//
// `createPreflightFacade` caches the verdict for the core's lifetime per (environment
// fingerprint, CLI version): the same profile input reuses the last report unless a job saw
// another CLI version (`knownCliVersion`), which re-runs it. Concurrent calls for the same
// key share one run. A child that fails, exits without a report, or overruns
// PREFLIGHT_CHILD_MAX_MS is killed and reported `ambiguous` (never `subscription`), with a
// fixed reason only. `cancelAll()` kills every running child (each resolves `ambiguous`) and
// refuses further runs: the core calls it first thing on shutdown.
// A report without a CLI version (the CLI could not be read, the child failed or was killed)
// is never cached: the adapter arms one retry for it (claudeJob.ts), and the next job's call
// here runs fresh instead of leaving `ambiguous` in place until the core restarts.

import { type ChildProcess, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Verdict } from "./authPreflight.js";
import type { AsyncPreflightFn, PreflightInput } from "./claudeJob.js";

/** Upper bound on one off-thread preflight (four CLI calls at up to 20 s each, plus slack). */
export const PREFLIGHT_CHILD_MAX_MS = 90_000;

export interface PreflightReportLike {
  verdict: Verdict;
  reasons: readonly string[];
  cliVersion?: string;
}

/** The child's built entrypoint (dist), resolved through the package export as the bridge's is. */
export function defaultPreflightChildEntrypoint(): string {
  return createRequire(import.meta.url).resolve("@scout/scout-core/agents/preflight-child");
}

const failed = (reason: string): PreflightReportLike => ({ verdict: "ambiguous", reasons: [reason] });

export interface PreflightChildOptions {
  entrypoint?: string;
  maxMs?: number;
  /** Aborting kills the child at once; the run resolves `ambiguous`. */
  signal?: AbortSignal;
}

/** SIGKILL the child's process group (it leads one), else the child alone. */
function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // not a group leader yet, or already gone
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // gone
  }
}

/** Run `runDirectPreflight(input)` in a fresh child process. Never rejects. */
export function runPreflightInChild(input: PreflightInput, options: PreflightChildOptions = {}): Promise<PreflightReportLike> {
  return new Promise((resolve) => {
    const { signal } = options;
    if (signal?.aborted) {
      resolve(failed("internal: preflight cancelled"));
      return;
    }
    let child: ChildProcess;
    try {
      child = fork(options.entrypoint ?? defaultPreflightChildEntrypoint(), [], {
        execArgv: [],
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "json",
      });
    } catch {
      resolve(failed("internal: preflight child failed to start"));
      return;
    }
    let done = false;
    const onAbort = (): void => finish(failed("internal: preflight cancelled"), true);
    const finish = (report: PreflightReportLike, kill: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (kill) killGroup(child);
      resolve(report);
    };
    const timer = setTimeout(() => finish(failed("internal: preflight child timed out"), true), options.maxMs ?? PREFLIGHT_CHILD_MAX_MS);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("message", (msg: unknown) => finish(toReport(msg), false));
    child.once("error", () => finish(failed("internal: preflight child failed"), true));
    // `close` comes after the exit and the IPC channel's end, so a report sent just before exiting is read first.
    child.once("close", () => finish(failed("internal: preflight child exited without a report"), true));
    child.unref();
    (child.channel as { unref?: () => void } | null | undefined)?.unref?.();
    try {
      child.send(input, (err) => {
        if (err) finish(failed("internal: preflight child failed"), true);
      });
    } catch {
      finish(failed("internal: preflight child failed"), true);
    }
  });
}

/** The child's message as a report; anything malformed is `ambiguous`. */
function toReport(msg: unknown): PreflightReportLike {
  if (msg === null || typeof msg !== "object") return failed("internal: preflight child sent no report");
  const m = msg as Record<string, unknown>;
  if (m.verdict !== "subscription" && m.verdict !== "ambiguous") return failed("internal: preflight child sent no report");
  if (!Array.isArray(m.reasons) || !m.reasons.every((r) => typeof r === "string")) return failed("internal: preflight child sent no report");
  const report: PreflightReportLike = { verdict: m.verdict, reasons: m.reasons as string[] };
  if (typeof m.cliVersion === "string") report.cliVersion = m.cliVersion;
  return report;
}

/** A hash of everything the preflight's verdict depends on that the core passes in. */
export function preflightFingerprint(input: PreflightInput): string {
  const env = Object.entries(input.parentEnv)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = JSON.stringify([env, input.claudePath, input.model, input.jobsRoot, input.workspaceRoots ?? null]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface PreflightFacadeOptions {
  /** One run; defaults to runPreflightInChild. It must resolve promptly once `signal` aborts. */
  run?: (input: PreflightInput, signal: AbortSignal) => Promise<PreflightReportLike>;
}

/** The facade: the adapter's async preflight, plus what the core needs at shutdown. */
export type PreflightFacade = AsyncPreflightFn & {
  readonly runs: number;
  /** Kill every running preflight (each resolves `ambiguous`) and refuse further runs. */
  cancelAll(): void;
};

/**
 * The async preflight the core gives its adapter (ClaudeJobDeps.preflightAsync): cached per
 * environment fingerprint and CLI version, one run per key at a time.
 */
export function createPreflightFacade(options: PreflightFacadeOptions = {}): PreflightFacade {
  const run = options.run ?? ((input: PreflightInput, signal: AbortSignal) => runPreflightInChild(input, { signal }));
  const cache = new Map<string, PreflightReportLike>();
  const inflight = new Map<string, Promise<PreflightReportLike>>();
  const controllers = new Set<AbortController>();
  let runs = 0;
  let closed = false;
  const facade = (async (input: PreflightInput, knownCliVersion?: string): Promise<PreflightReportLike> => {
    if (closed) return failed("internal: preflight cancelled");
    const key = preflightFingerprint(input);
    const cached = cache.get(key);
    if (cached !== undefined && (knownCliVersion === undefined || cached.cliVersion === knownCliVersion)) return cached;
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;
    runs += 1;
    const controller = new AbortController();
    controllers.add(controller);
    const p = run(input, controller.signal)
      .catch(() => failed("internal: preflight failed unexpectedly"))
      .then((report) => {
        // Only a verdict that names the CLI version it saw is worth keeping: an unreachable CLI is asked again.
        if (report.cliVersion !== undefined && !controller.signal.aborted) cache.set(key, report);
        else cache.delete(key);
        return report;
      })
      .finally(() => {
        inflight.delete(key);
        controllers.delete(controller);
      });
    inflight.set(key, p);
    return p;
  }) as PreflightFacade;
  Object.defineProperty(facade, "runs", { get: () => runs });
  Object.defineProperty(facade, "cancelAll", {
    value: () => {
      closed = true;
      for (const c of controllers) c.abort();
    },
  });
  return facade;
}
