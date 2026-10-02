// Worker-thread entrypoint for preflightWorker.ts: run the blocking direct preflight on the
// profile input it was started with and post the report (verdict, reasons, CLI version) back.
// Plain data only crosses the thread; the report's reasons are redacted by the adapter.

import { parentPort, workerData } from "node:worker_threads";
import { runDirectPreflight } from "./launchProfile.js";

const input = workerData as Parameters<typeof runDirectPreflight>[0];
const report = runDirectPreflight({
  parentEnv: input.parentEnv,
  claudePath: input.claudePath,
  model: input.model,
  jobsRoot: input.jobsRoot,
  ...(input.workspaceRoots !== undefined ? { workspaceRoots: input.workspaceRoots } : {}),
});
parentPort?.postMessage({ verdict: report.verdict, reasons: report.reasons, ...(report.cliVersion !== undefined ? { cliVersion: report.cliVersion } : {}) });
