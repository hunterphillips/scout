// `cli.js capability ...`: a thin developer front end to the capability store, for Phase 2
// checks before the native window exists. It is a dev tool writing to stdout, not to
// diagnostics: `list` prints source URLs, and `list --json` prints the whole stored state,
// including source URLs and website-provided skill names and descriptions. It never prints
// resource text, and it never exports wrappers: the skills root comes from the installer's
// record (P2.6), not from a command-line path.
//
// `list` opens the store read-only. Every other command takes the store's writer lock, so
// while the Scout core runs (and holds the lock) they refuse with exit 2. The CLI has no
// `onRevoked` consumer: a CLI revoke cannot invalidate job tokens or cancel jobs, which is
// one more reason it only runs when the core does not.
//
// `unexport-all [--home <dir>] [--json]` (P4.3, run by `npm run uninstall` before it drops the
// recorded skills root): holding `capabilities/store.lock`, it removes every runtime skill
// wrapper `exports.json` owns whose files still hash to the recorded ownership hash, and
// rewrites `exports.json` without them; a changed wrapper, a symlink, or an I/O refusal is kept,
// listed, and stays in the manifest. It is the exporter's own sync against an empty desired
// set, so ownership comes only from the manifest, never from a `scout-` prefix. The skills root
// comes from `installed.json`, as for the core. Exit 0 when every owned wrapper is gone, 3 when
// some were kept, 2 while the core holds the lock (quit Scout first), 1 on an unusable
// record, root, or manifest (nothing removed).

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isHttpsOrigin } from "@scout/contracts";
import { systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import { type Diagnostics, scoutHome } from "../diagnostics.js";
import { InstalledRecordError, readInstalledRecord } from "../installedRecord.js";
import { emptyState } from "./decisions.js";
import type { DiscoveryResult } from "./discovery.js";
import { createSkillExporter, ExportError } from "./exports.js";
import { type CapabilityStore, createCapabilityStore } from "./store.js";
import { acquireStoreLock, StoreLockedError } from "./storeLock.js";

const EXIT_LOCKED = 2;
const EXIT_KEPT = 3;

export const CAPABILITY_USAGE = `  cli.js capability list [--json]
  cli.js capability ingest <https-origin> [--chrome-permitted]
  cli.js capability approve <resourceId> <version> --rev <n>
  cli.js capability decline <resourceId> <version> --rev <n>
  cli.js capability revoke <resourceId>
  cli.js capability policy <https-origin> --auto-acquire on|off [--ack]
  cli.js capability unexport-all [--home <dir>] [--json]
                                    (exit 3 when a changed wrapper was kept; 2 while the core runs)
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
  const p = parse(rest, ["--rev", "--auto-acquire", "--home"]);
  if (!p) return usage();
  const { positional, options } = p;
  if (sub === "unexport-all") {
    if (positional.length !== 0 || ![...options.keys()].every((k) => k === "--home" || k === "--json")) return usage();
    const home = options.get("--home");
    if (home !== undefined && (typeof home !== "string" || !isAbsolute(home))) return usage();
    return unexportAll(typeof home === "string" ? resolve(home) : scoutHome(io.env ?? process.env), options.has("--json"), io);
  }
  if (options.has("--home")) return usage();
  if (!["list", "ingest", "approve", "decline", "revoke", "policy"].includes(sub ?? "")) return usage();
  let store: CapabilityStore;
  try {
    store = await createCapabilityStore({
      scoutHome: scoutHome(io.env ?? process.env),
      clock: io.deps?.clock ?? systemClock,
      diagnostics: io.diagnostics,
      readOnly: sub === "list",
    });
  } catch (error) {
    if (!(error instanceof StoreLockedError)) throw error;
    io.stderr("the Scout core holds the capability store; use the app\n");
    return EXIT_LOCKED;
  }
  try {
    return await run(store, sub, positional, options, io, usage);
  } finally {
    await store.close();
  }
}

async function run(
  store: CapabilityStore,
  sub: string | undefined,
  positional: string[],
  options: Map<string, string | true>,
  io: CapabilityCliIo,
  usage: () => number,
): Promise<number> {
  const allowed = (names: string[]) => [...options.keys()].every((k) => names.includes(k));
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
      io.stdout(`revoked ${result.revokedVersions.length} readable version(s); approvalRevision ${result.approvalRevision}\n`);
      io.stdout("note: the CLI path does not invalidate job tokens, cancel jobs, or clean up exported wrappers (the core's revoke does)\n");
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

interface UnexportOutcome {
  removed: string[];
  kept: { name: string; code: string }[];
  note?: string;
}

/** `capability unexport-all`: see the header. */
async function unexportAll(home: string, json: boolean, io: CapabilityCliIo): Promise<number> {
  const print = (outcome: UnexportOutcome): void => {
    if (json) {
      io.stdout(`${JSON.stringify(outcome)}\n`);
      return;
    }
    if (outcome.note) io.stdout(`${outcome.note}\n`);
    for (const name of outcome.removed) io.stdout(`removed ${name}\n`);
    for (const k of outcome.kept) io.stdout(`kept ${k.name} (${k.code})\n`);
  };
  const fail = (message: string): number => {
    io.stderr(`unexport-all: ${message}; nothing was removed\n`);
    return 1;
  };
  const capDir = join(home, "capabilities");
  if (!existsSync(join(capDir, "exports.json"))) {
    print({ removed: [], kept: [], note: "no exports manifest: Scout exported no skill wrappers" });
    return 0;
  }
  let lock;
  try {
    lock = acquireStoreLock(capDir, { now: () => (io.deps?.clock ?? systemClock).now() });
  } catch (error) {
    if (!(error instanceof StoreLockedError)) throw error;
    io.stderr("unexport-all: the Scout core holds the capability store; quit Scout first\n");
    return EXIT_LOCKED;
  }
  try {
    let skillsRoot: string | undefined;
    try {
      skillsRoot = readInstalledRecord(home).skillsRoot;
    } catch (error) {
      if (error instanceof InstalledRecordError) return fail(error.code);
      throw error;
    }
    if (skillsRoot === undefined) return fail("installed.json records no skillsRoot, so the wrappers cannot be located");
    let exporter;
    try {
      exporter = createSkillExporter({ scoutHome: home, skillsRoot, diagnostics: io.diagnostics });
    } catch (error) {
      if (error instanceof ExportError && error.code === "root_missing") {
        print({ removed: [], kept: [], note: "the recorded skills root is gone, so no wrapper is on disk; exports.json left as is" });
        return 0;
      }
      if (error instanceof ExportError) return fail(error.message);
      throw error;
    }
    let before: string[];
    try {
      before = exporter.manifest().entries.map((e) => e.name);
      await exporter.sync(emptyState());
    } catch (error) {
      if (error instanceof ExportError) return fail(error.message);
      throw error;
    }
    const after = exporter.manifest();
    const left = new Set(after.entries.map((e) => e.name));
    const kept = after.entries.map((e) => ({ name: e.name, code: after.conflicts.find((c) => c.name === e.name)?.code ?? "left_modified" }));
    print({ removed: before.filter((n) => !left.has(n)), kept });
    return kept.length > 0 ? EXIT_KEPT : 0;
  } finally {
    lock.release();
  }
}
