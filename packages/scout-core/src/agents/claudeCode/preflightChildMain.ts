// Child-process entrypoint for preflightWorker.ts: wait for the profile input on the IPC
// channel, run the blocking direct preflight, send the report (verdict, reasons, CLI version)
// back, and leave. Plain data only crosses the channel; the adapter redacts the reasons.
//
// The parent kills this process's whole group (SIGKILL) on cancel, timeout or shutdown, so the
// `claude` calls spawnSync is blocked on go with it. If the parent goes away first, the closed
// channel ends this process once spawnSync returns.

import { runDirectPreflight } from "./launchProfile.js";

type Input = Parameters<typeof runDirectPreflight>[0];

process.once("disconnect", () => process.exit(0));
process.once("message", (msg: unknown) => {
  let out: { verdict: string; reasons: readonly string[]; cliVersion?: string };
  try {
    const input = msg as Input;
    const report = runDirectPreflight({
      parentEnv: input.parentEnv,
      claudePath: input.claudePath,
      model: input.model,
      jobsRoot: input.jobsRoot,
      ...(input.workspaceRoots !== undefined ? { workspaceRoots: input.workspaceRoots } : {}),
    });
    out = { verdict: report.verdict, reasons: report.reasons, ...(report.cliVersion !== undefined ? { cliVersion: report.cliVersion } : {}) };
  } catch {
    out = { verdict: "ambiguous", reasons: ["internal: preflight failed unexpectedly"] };
  }
  process.send?.(out, () => process.disconnect?.());
});
