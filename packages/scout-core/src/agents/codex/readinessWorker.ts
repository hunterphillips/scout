// The Codex readiness check off the core's event loop, copied from Claude's
// preflightWorker.ts. `runCodexReadinessFor` blocks (spawnSync, two `codex` calls at up to
// 20 s each), so the core never calls it directly: each run happens in a fresh child process
// (`child_process.fork` of readinessChildMain.ts) that gets the input over IPC, runs it, and
// sends the report back.
//
// The child leads its own process group; cancel, timeout (READINESS_CHILD_MAX_MS) and
// shutdown SIGKILL that group, which takes the `codex` call it is blocked on with it. Nothing
// waits for the child to exit.
//
// `createCodexReadinessFacade` caches the report for the core's lifetime per input
// fingerprint (sorted parent env, codexPath, model, SCOUT_HOME); `knownVersion`, when given and
// different from the cached version, re-runs it. Concurrent calls for the same key share one
// run. A child that fails, exits without a report, or overruns is killed and reported
// `unavailable` with a fixed reason. A report without a version, or from an aborted run, is
// never cached. `cancelAll()` kills every running child and refuses further runs.

import { type ChildProcess, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { CodexReadinessInput, CodexReadinessReport } from "./readiness.js";

/** Upper bound on one off-thread readiness check (two CLI calls at up to 20 s each, plus slack). */
export const READINESS_CHILD_MAX_MS = 90_000;

/** The child's built entrypoint (dist), resolved through the package export. */
export function defaultReadinessChildEntrypoint(): string {
  return createRequire(import.meta.url).resolve("@scout/scout-core/agents/codex-readiness-child");
}

const failed = (reason: string): CodexReadinessReport => ({ verdict: "unavailable", reasons: [reason] });

export interface ReadinessChildOptions {
  entrypoint?: string;
  maxMs?: number;
  /** Aborting kills the child at once; the run resolves `unavailable`. */
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

/** Run `runCodexReadinessFor(input)` in a fresh child process. Never rejects. */
export function runReadinessInChild(input: CodexReadinessInput, options: ReadinessChildOptions = {}): Promise<CodexReadinessReport> {
  return new Promise((resolve) => {
    const { signal } = options;
    if (signal?.aborted) {
      resolve(failed("internal: readiness cancelled"));
      return;
    }
    let child: ChildProcess;
    try {
      child = fork(options.entrypoint ?? defaultReadinessChildEntrypoint(), [], {
        execArgv: [],
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "json",
      });
    } catch {
      resolve(failed("internal: readiness child failed to start"));
      return;
    }
    let done = false;
    const onAbort = (): void => finish(failed("internal: readiness cancelled"), true);
    const finish = (report: CodexReadinessReport, kill: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (kill) killGroup(child);
      resolve(report);
    };
    const timer = setTimeout(() => finish(failed("internal: readiness child timed out"), true), options.maxMs ?? READINESS_CHILD_MAX_MS);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("message", (msg: unknown) => finish(toReport(msg), false));
    child.once("error", () => finish(failed("internal: readiness child failed"), true));
    // `close` comes after the exit and the IPC channel's end, so a report sent just before exiting is read first.
    child.once("close", () => finish(failed("internal: readiness child exited without a report"), true));
    child.unref();
    (child.channel as { unref?: () => void } | null | undefined)?.unref?.();
    try {
      child.send(input, (err) => {
        if (err) finish(failed("internal: readiness child failed"), true);
      });
    } catch {
      finish(failed("internal: readiness child failed"), true);
    }
  });
}

/** The child's message as a report; anything malformed is `unavailable`. */
function toReport(msg: unknown): CodexReadinessReport {
  if (msg === null || typeof msg !== "object") return failed("internal: readiness child sent no report");
  const m = msg as Record<string, unknown>;
  if (m.verdict !== "ready" && m.verdict !== "unavailable") return failed("internal: readiness child sent no report");
  if (!Array.isArray(m.reasons) || !m.reasons.every((r) => typeof r === "string")) return failed("internal: readiness child sent no report");
  const report: CodexReadinessReport = { verdict: m.verdict, reasons: m.reasons as string[] };
  if (typeof m.version === "string") report.version = m.version;
  return report;
}

/** A hash of everything the report depends on that the core passes in. */
export function readinessFingerprint(input: CodexReadinessInput): string {
  const env = Object.entries(input.parentEnv)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify([env, input.codexPath, input.model, input.home]), "utf8").digest("hex");
}

/** An off-thread readiness check: `knownVersion`, when given, is a version a job saw. */
export type AsyncCodexReadinessFn = (input: CodexReadinessInput, knownVersion?: string) => Promise<CodexReadinessReport>;

export interface CodexReadinessFacadeOptions {
  /** One run; defaults to runReadinessInChild. It must resolve promptly once `signal` aborts. */
  run?: (input: CodexReadinessInput, signal: AbortSignal) => Promise<CodexReadinessReport>;
}

export type CodexReadinessFacade = AsyncCodexReadinessFn & {
  readonly runs: number;
  /** Kill every running check (each resolves `unavailable`) and refuse further runs. */
  cancelAll(): void;
};

export function createCodexReadinessFacade(options: CodexReadinessFacadeOptions = {}): CodexReadinessFacade {
  const run = options.run ?? ((input: CodexReadinessInput, signal: AbortSignal) => runReadinessInChild(input, { signal }));
  const cache = new Map<string, CodexReadinessReport>();
  const inflight = new Map<string, Promise<CodexReadinessReport>>();
  const controllers = new Set<AbortController>();
  let runs = 0;
  let closed = false;
  const facade = (async (input: CodexReadinessInput, knownVersion?: string): Promise<CodexReadinessReport> => {
    if (closed) return failed("internal: readiness cancelled");
    const key = readinessFingerprint(input);
    const cached = cache.get(key);
    if (cached !== undefined && (knownVersion === undefined || cached.version === knownVersion)) return cached;
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;
    runs += 1;
    const controller = new AbortController();
    controllers.add(controller);
    const p = run(input, controller.signal)
      .catch(() => failed("internal: readiness failed unexpectedly"))
      .then((report) => {
        if (report.version !== undefined && !controller.signal.aborted) cache.set(key, report);
        else cache.delete(key);
        return report;
      })
      .finally(() => {
        inflight.delete(key);
        controllers.delete(controller);
      });
    inflight.set(key, p);
    return p;
  }) as CodexReadinessFacade;
  Object.defineProperty(facade, "runs", { get: () => runs });
  Object.defineProperty(facade, "cancelAll", {
    value: () => {
      closed = true;
      for (const c of controllers) c.abort();
    },
  });
  return facade;
}
