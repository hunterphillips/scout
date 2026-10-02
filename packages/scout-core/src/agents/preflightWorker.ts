// The billing preflight off the core's event loop. `runDirectPreflight` blocks (spawnSync, up
// to four `claude` calls at up to 20 s each), so the core never calls it directly: each run
// happens in a fresh `worker_threads` Worker (preflightWorkerMain.ts) that calls it and posts
// the report back. The main thread keeps handling focus, pause and grant frames meanwhile.
//
// `createPreflightFacade` caches the verdict for the core's lifetime per (environment
// fingerprint, CLI version): the same profile input reuses the last report unless a job saw
// another CLI version (`knownCliVersion`), which re-runs it. Concurrent calls for the same
// key share one run. A worker that fails, exits early, or overruns PREFLIGHT_WORKER_MAX_MS is
// terminated and reported `ambiguous` (never `subscription`), with a fixed reason only.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { Verdict } from "./authPreflight.js";
import type { AsyncPreflightFn, PreflightInput } from "./claudeJob.js";

/** Upper bound on one off-thread preflight (four CLI calls at up to 20 s each, plus slack). */
export const PREFLIGHT_WORKER_MAX_MS = 90_000;

export interface PreflightReportLike {
  verdict: Verdict;
  reasons: readonly string[];
  cliVersion?: string;
}

/** The worker's built entrypoint (dist), resolved through the package export as the bridge's is. */
export function defaultPreflightWorkerEntrypoint(): string {
  return createRequire(import.meta.url).resolve("@scout/scout-core/agents/preflight-worker");
}

const failed = (reason: string): PreflightReportLike => ({ verdict: "ambiguous", reasons: [reason] });

/** Run `runDirectPreflight(input)` in a fresh worker thread. Never rejects. */
export function runPreflightInWorker(input: PreflightInput, options: { entrypoint?: string; maxMs?: number } = {}): Promise<PreflightReportLike> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(options.entrypoint ?? defaultPreflightWorkerEntrypoint(), { workerData: input, execArgv: [] });
    } catch {
      resolve(failed("internal: preflight worker failed to start"));
      return;
    }
    let done = false;
    const finish = (report: PreflightReportLike): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => {});
      resolve(report);
    };
    const timer = setTimeout(() => finish(failed("internal: preflight worker timed out")), options.maxMs ?? PREFLIGHT_WORKER_MAX_MS);
    timer.unref();
    worker.unref();
    worker.once("message", (msg: unknown) => finish(toReport(msg)));
    worker.once("error", () => finish(failed("internal: preflight worker failed")));
    worker.once("exit", () => finish(failed("internal: preflight worker exited without a report")));
  });
}

/** The worker's message as a report; anything malformed is `ambiguous`. */
function toReport(msg: unknown): PreflightReportLike {
  if (msg === null || typeof msg !== "object") return failed("internal: preflight worker sent no report");
  const m = msg as Record<string, unknown>;
  if (m.verdict !== "subscription" && m.verdict !== "ambiguous") return failed("internal: preflight worker sent no report");
  if (!Array.isArray(m.reasons) || !m.reasons.every((r) => typeof r === "string")) return failed("internal: preflight worker sent no report");
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
  /** One run; defaults to runPreflightInWorker. */
  run?: (input: PreflightInput) => Promise<PreflightReportLike>;
}

/**
 * The async preflight the core gives its adapter (ClaudeJobDeps.preflightAsync): cached per
 * environment fingerprint and CLI version, one run per key at a time.
 */
export function createPreflightFacade(options: PreflightFacadeOptions = {}): AsyncPreflightFn & { readonly runs: number } {
  const run = options.run ?? ((input: PreflightInput) => runPreflightInWorker(input));
  const cache = new Map<string, PreflightReportLike>();
  const inflight = new Map<string, Promise<PreflightReportLike>>();
  let runs = 0;
  const facade = (async (input: PreflightInput, knownCliVersion?: string): Promise<PreflightReportLike> => {
    const key = preflightFingerprint(input);
    const cached = cache.get(key);
    if (cached !== undefined && (knownCliVersion === undefined || cached.cliVersion === knownCliVersion)) return cached;
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;
    runs += 1;
    const p = run(input)
      .catch(() => failed("internal: preflight failed unexpectedly"))
      .then((report) => {
        // Only a verdict that names the CLI version it saw is worth keeping: an unreachable CLI is asked again.
        if (report.cliVersion !== undefined) cache.set(key, report);
        else cache.delete(key);
        return report;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }) as AsyncPreflightFn & { readonly runs: number };
  Object.defineProperty(facade, "runs", { get: () => runs });
  return facade;
}
