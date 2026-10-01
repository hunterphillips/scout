#!/usr/bin/env node
// `npm run verify:agent -- --case <hotload|baseline|selected-tool|cancel> --home <throwaway> [options]`
//
// Separately authorized live compatibility checks against the installed Claude CLI. Each
// real run makes model calls on the user's subscription (after a successful billing
// preflight); --dry-run prints the plan and changes and launches nothing. See README.md.

import { resolve } from "node:path";
import { isMain } from "../lib/is-main.mjs";

export const CASES = Object.freeze(["hotload", "baseline", "selected-tool", "cancel"]);
const MAX_INFERENCE = 4;

const USAGE = `usage: npm run verify:agent -- --case <${CASES.join("|")}> --home <throwaway dir> [options]
  --dry-run               print the plan; create, register and launch nothing
  --max-inference <n>     inference requests this run may make (default 2; at most ${MAX_INFERENCE})
  --claude <path>         the claude binary (default: \`claude\` on PATH, resolved to an absolute path)
hotload only:
  --authorize-real-root   acceptance run: proof skill in the real user skills root and a user-scope
                          MCP registration, both scout-proof-<nonce>, removed afterwards
  --preliminary           preliminary run: project skills in a throwaway cwd and --mcp-config;
                          changes nothing installed; cannot pass the gate
  --with-revocation       after a successful use, revoke and read again (needs one more request)
  --two-session           if turn 2 fails, retry in a fresh session (needs one more request)`;

/** Parse argv; returns { opts } or { error }. */
export function parseArgs(argv) {
  const o = { maxInference: 2, dryRun: false, authorizeRealRoot: false, preliminary: false, withRevocation: false, twoSession: false };
  const bools = { "--dry-run": "dryRun", "--authorize-real-root": "authorizeRealRoot", "--preliminary": "preliminary", "--with-revocation": "withRevocation", "--two-session": "twoSession" };
  const values = { "--case": "case", "--home": "home", "--max-inference": "maxInference", "--claude": "claude" };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (seen.has(a)) return { error: `${a} given twice` };
    seen.add(a);
    if (a === "--help" || a === "-h") return { help: true };
    if (Object.hasOwn(bools, a)) o[bools[a]] = true;
    else if (Object.hasOwn(values, a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      o[values[a]] = v;
    } else return { error: `unknown argument ${a}` };
  }
  if (!CASES.includes(o.case)) return { error: "--case is required" };
  if (!o.home) return { error: "--home is required" };
  const n = Number(o.maxInference);
  if (!Number.isInteger(n) || n < 1 || n > MAX_INFERENCE) return { error: `--max-inference must be 1-${MAX_INFERENCE}` };
  o.maxInference = n;
  if (o.case !== "hotload" && (o.authorizeRealRoot || o.preliminary || o.withRevocation || o.twoSession)) return { error: `${o.case} takes no hotload options` };
  o.home = resolve(o.home);
  return { opts: o };
}

/**
 * Run one check. `io`: { env, out, err, deps } where deps are test seams passed to the case.
 * Exit codes: 0 pass (or dry run), 1 failed/aborted check, 2 refused (usage or authorization).
 */
export async function runAgentCheck(argv, io = {}) {
  const env = io.env ?? process.env;
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  const parsed = parseArgs(argv);
  if (parsed.help) {
    out(USAGE);
    return 0;
  }
  if (parsed.error) {
    err(`verify:agent: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  const o = { ...parsed.opts, env };

  let mods;
  try {
    mods = {
      fixtures: await import("./fixtures.mjs"),
      report: await import("./report.mjs"),
      preflight: await import("../../packages/scout-core/dist/agents/authPreflight.js"),
    };
  } catch {
    err("verify:agent: built packages not found; run `npm run build` first");
    return 1;
  }
  o.claudePath = o.claude ? resolve(o.claude) : mods.preflight.resolveOnPath("claude", env.PATH);
  if (!o.claudePath || !mods.preflight.isExecutableFile(o.claudePath)) {
    err("verify:agent: no executable claude found (PATH or --claude)");
    return 2;
  }
  if (o.case === "hotload") {
    const refusal = (await import("./hotload.mjs")).hotloadRefusal(o);
    if (refusal) {
      err(`verify:agent hotload: ${refusal}`);
      return 2;
    }
  }
  try {
    mods.fixtures.prepareCheckHome(o.home, { env, dryRun: o.dryRun });
  } catch (e) {
    err(`verify:agent: ${e.message}`);
    return 2;
  }

  const deps = { out, err, ...(io.deps ?? {}) };
  const res =
    o.case === "hotload"
      ? await (await import("./hotload.mjs")).runHotload(o, deps)
      : await (await import("./background.mjs")).runBackground(o.case, o, deps);
  if (!res.report) return res.code;
  try {
    const { path, report } = mods.report.writeReport(o.home, o.case, res.report, { env, secrets: res.secrets ?? [] });
    for (const l of mods.report.summaryLines(report, path)) out(l);
  } catch (e) {
    err(`verify:agent: report not written: ${e.message}`);
    return 1;
  }
  return res.code;
}

if (isMain(import.meta.url)) {
  runAgentCheck(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      process.stderr.write("verify:agent: internal error\n");
      process.exit(1);
    },
  );
}
