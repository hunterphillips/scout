// `cli.js capability ...`: a thin developer front end to the capability store, for Phase 2
// checks before the native window exists. It never prints resource text or source URLs
// beyond what `list` needs to tell resources apart, and it never exports wrappers: the
// skills root comes from the installer's record (P2.6), not from a command-line path.

import { isHttpsOrigin } from "@scout/contracts";
import { systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import { type Diagnostics, scoutHome } from "../diagnostics.js";
import type { DiscoveryResult } from "./discovery.js";
import { createCapabilityStore } from "./store.js";

export const CAPABILITY_USAGE = `  cli.js capability list [--json]
  cli.js capability ingest <https-origin> [--chrome-permitted]
  cli.js capability approve <resourceId> <version> --rev <n>
  cli.js capability decline <resourceId> <version> --rev <n>
  cli.js capability revoke <resourceId>
  cli.js capability policy <https-origin> --auto-acquire on|off [--ack]
`;

export interface CapabilityCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  deps?: { clock?: Clock };
  diagnostics: Diagnostics;
  discover: (origin: string) => Promise<DiscoveryResult>;
}

/** `--name value` pairs and bare flags; everything else positional. */
function parse(args: readonly string[], withValue: readonly string[]): { positional: string[]; options: Map<string, string | true> } | null {
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) positional.push(a);
    else if (withValue.includes(a)) {
      const v = args[++i];
      if (v === undefined) return null;
      options.set(a, v);
    } else options.set(a, true);
  }
  return { positional, options };
}

export async function capabilityCommand(args: readonly string[], io: CapabilityCliIo): Promise<number> {
  const usage = () => {
    io.stderr(CAPABILITY_USAGE);
    return 1;
  };
  const [sub, ...rest] = args;
  const p = parse(rest, ["--rev", "--auto-acquire"]);
  if (!p) return usage();
  const { positional, options } = p;
  const allowed = (names: string[]) => [...options.keys()].every((k) => names.includes(k));
  const store = await createCapabilityStore({ scoutHome: scoutHome(io.env ?? process.env), clock: io.deps?.clock ?? systemClock, diagnostics: io.diagnostics });

  switch (sub) {
    case "list": {
      if (positional.length !== 0 || !allowed(["--json"])) return usage();
      const state = store.snapshot();
      if (options.has("--json")) {
        io.stdout(`${JSON.stringify(state, null, 2)}\n`);
        return 0;
      }
      const lines = [`approvalRevision ${state.approvalRevision}`];
      for (const r of state.resources) {
        const res = r.resource;
        lines.push(`${res.id}  ${res.kind}  rev ${r.revision}${res.blocked ? "  BLOCKED" : ""}  ${res.sourceUrl}`);
        for (const v of res.versions) lines.push(`  ${v.hash}  ${v.state}${v.hash === res.defaultVersion ? " (default)" : ""}  ${v.byteLength} B${v.decision ? `  by ${v.decision.actor}` : ""}`);
      }
      for (const pol of state.policies) lines.push(`auto-acquire on  ${pol.origin}`);
      io.stdout(`${lines.join("\n")}\n`);
      return 0;
    }
    case "ingest": {
      if (positional.length !== 1 || !isHttpsOrigin(positional[0]!) || !allowed(["--chrome-permitted"])) return usage();
      const discovery = await io.discover(positional[0]!);
      const report = await store.ingest(discovery, { chromePermitted: options.has("--chrome-permitted") });
      for (const r of report.results) io.stdout(`${r.resourceId}  ${r.version}  ${r.outcome}${r.limit ? ` (${r.limit})` : ""}\n`);
      if (report.skipped > 0) io.stdout(`skipped ${report.skipped}\n`);
      return 0;
    }
    case "approve":
    case "decline": {
      const revRaw = options.get("--rev");
      if (positional.length !== 2 || typeof revRaw !== "string" || !/^\d+$/.test(revRaw) || !allowed(["--rev"])) return usage();
      const command = { resourceId: positional[0]!, version: positional[1]!, expectedRevision: Number(revRaw) };
      const result = sub === "approve" ? await store.approve(command) : await store.decline(command);
      io.stdout(`${sub} ${result.changed ? "applied" : "no change"}; resource rev ${result.revision}, approvalRevision ${result.approvalRevision}\n`);
      return 0;
    }
    case "revoke": {
      if (positional.length !== 1 || options.size > 0) return usage();
      const result = await store.revoke(positional[0]!);
      await result.cleanup;
      io.stdout(`revoked ${result.revokedVersions.length} readable version(s); approvalRevision ${result.approvalRevision} (exported wrappers are not cleaned up from the CLI)\n`);
      return 0;
    }
    case "policy": {
      const mode = options.get("--auto-acquire");
      if (positional.length !== 1 || (mode !== "on" && mode !== "off") || !allowed(["--auto-acquire", "--ack"])) return usage();
      const result = await store.setOriginPolicy({ origin: positional[0]!, autoAcquire: mode === "on", acknowledgeRisk: options.has("--ack") });
      io.stdout(`auto-acquire ${mode} ${result.changed ? "applied" : "no change"}; approvalRevision ${result.approvalRevision}\n`);
      return 0;
    }
    default:
      return usage();
  }
}
