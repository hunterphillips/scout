// Child-process entrypoint for readinessWorker.ts: wait for the readiness input on the IPC
// channel, run the blocking readiness check (readiness.ts), send the report (verdict, reasons,
// version) back, and leave. Plain data only crosses the channel.
//
// The parent kills this process's whole group (SIGKILL) on cancel, timeout or shutdown, so the
// `pi` call spawnSync is blocked on goes with it. If the parent goes away first, the closed
// channel ends this process once spawnSync returns.

import { runPiReadinessFor, type PiReadinessInput } from "./readiness.js";

process.once("disconnect", () => process.exit(0));
process.once("message", (msg: unknown) => {
  let out: { verdict: string; reasons: readonly string[]; version?: string };
  try {
    const input = msg as PiReadinessInput;
    const report = runPiReadinessFor({
      home: input.home,
      parentEnv: input.parentEnv,
      piPath: input.piPath,
      profile: input.profile,
    });
    out = { verdict: report.verdict, reasons: report.reasons, ...(report.version !== undefined ? { version: report.version } : {}) };
  } catch {
    out = { verdict: "unavailable", reasons: ["internal: readiness failed unexpectedly"] };
  }
  process.send?.(out, () => process.disconnect?.());
});
