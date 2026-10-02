#!/usr/bin/env node
// Scout uninstall: remove only the files listed in <SCOUT_HOME>/installed.json, and only those
// that are still exactly what setup wrote (its marker, or its recorded hash).
// Lists the files and asks y/N before changing anything; --yes skips the prompt.
// Without a terminal on stdin and without --yes, it aborts.
//
// Entries whose path is outside what setup could have written (lib/installed.mjs
// allowedPath) are skipped and reported. A legacy `config-merged` entry (the personal-context
// config setup used to merge into) is reported and dropped from the record; uninstall never
// edits or deletes that file or its directory.
//
// Order: first, when installed.json records a skillsRoot and capabilities/exports.json lists
// skill wrappers, the Scout app's wrappers go through the core's one-shot
// `cli.js capabilities unexport-all` (it holds the store lock, removes only wrappers still
// hashing to their recorded ownership, and keeps changed ones, which are listed). While Scout
// runs it holds that lock (and the agent profile's), so a real uninstall stops before changing
// anything while Scout runs, wrappers or not: quit Scout first. The prompt lists the wrappers.
// Then the agent integration (the `scout` MCP registration and the scout-integration skill,
// each only while still exactly what setup installed; lib/agent-integration.mjs), then the
// files. --agent-integration does the first two only. With the real ~/.scout and
// SCOUT_SKILLS_ROOT or SCOUT_CLAUDE_BIN set, it refuses before changing anything.
// A removed login LaunchAgent stays loaded until logout; it only ever ran the app at login.
//
// Usage: node scripts/uninstall.mjs [--dry-run] [--yes] [--include-key] [--agent-integration]
// Env overrides: SCOUT_HOME, SCOUT_CLAUDE_BIN, LAUNCH_AGENTS_DIR (see lib/paths.mjs); the other
// paths, and the skills root, come from installed.json, checked against allowedPath.
// Never touches ~/.rook, ~/.scout/logs, or anything not listed. Never removes a directory
// because its name starts with `scout-`.

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { REPO_ROOT, layout } from "./lib/paths.mjs";
import { extensionIdFromPem } from "./lib/extension-key.mjs";
import { allowedPath, readInstalled } from "./lib/installed.mjs";
import { exists, fileMarker, readJsonObject, writeJson } from "./lib/files.mjs";
import { isMain } from "./lib/is-main.mjs";
import { isIntegrationEntry, overrideRefusal, removeIntegration } from "./lib/agent-integration.mjs";
import { readExportsManifest } from "./lib/integration-skill.mjs";
import { sha256 } from "./lib/app-bundle.mjs";
import { coreLockHolder } from "./lib/core-state.mjs";

export function parseArgs(argv) {
  const opts = { dryRun: false, yes: false, includeKey: false, agentIntegration: false };
  for (const a of argv) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--agent-integration") opts.agentIntegration = true;
    else if (a === "--yes") opts.yes = true;
    else if (a === "--include-key") opts.includeKey = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function isRegularFile(p) {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Ask `question` on the terminal. Resolves true for y/yes, false otherwise, and
 * null without asking when stdin is not a terminal.
 */
export async function ttyConfirm(question, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) return null;
  const rl = createInterface({ input, output });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** Decide what to do with one entry: { action: "remove"|"strip-key"|"legacy"|"gone"|"keep"|"skip", reason }. */
export function judge(entry, marker, { includeKey }, L, record) {
  const p = entry.path;
  if (!allowedPath(entry.kind, p, L, record)) return { action: "skip", reason: `not a path setup writes for kind ${entry.kind}; not touching` };
  if (entry.kind === "config-merged") {
    return { action: "legacy", reason: "legacy record: setup no longer merges into the personal-context config; uninstall never edits or deletes it or its directory" };
  }
  if (!exists(p)) return { action: "gone", reason: "already absent" };
  if (!isRegularFile(p)) return { action: "skip", reason: "not a regular file" };
  switch (entry.kind) {
    case "config":
    case "wrapper":
    case "nmh-manifest":
      return fileMarker(p, entry.kind) === marker
        ? { action: "remove", reason: "marker matches" }
        : { action: "skip", reason: "Scout marker missing or different; not removing" };
    case "agent-profile":
    case "launch-agent": {
      let text = null;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        // unreadable
      }
      return text !== null && typeof entry.sha256 === "string" && sha256(text) === entry.sha256
        ? { action: "remove", reason: "unchanged since setup wrote it" }
        : { action: "skip", reason: "changed since setup wrote it; not removing" };
    }
    case "key": {
      if (!includeKey) return { action: "keep", reason: "extension key kept so the extension ID survives a reinstall (pass --include-key to remove)" };
      let id = null;
      try {
        id = extensionIdFromPem(readFileSync(p, "utf8"));
      } catch {
        // unreadable or not a key
      }
      return id && id === entry.extensionId
        ? { action: "remove", reason: "key matches the recorded extension ID" }
        : { action: "skip", reason: "key does not match the recorded extension ID; not removing" };
    }
    case "extension-manifest-key": {
      let m = null;
      try {
        m = readJsonObject(p);
      } catch {
        // malformed
      }
      if (!m) return { action: "skip", reason: "manifest is not a JSON object" };
      if (!("key" in m)) return { action: "gone", reason: "manifest has no key field" };
      return m.key === entry.key
        ? { action: "strip-key", reason: "key field matches" }
        : { action: "skip", reason: "manifest key differs from the recorded one; not stripping" };
    }
    default:
      return { action: "skip", reason: `unknown kind ${entry.kind}` };
  }
}

function removeDirIfEmpty(dir, out, dryRun) {
  if (!exists(dir)) return;
  if (dryRun) {
    out(`would remove ${dir} if empty`);
    return;
  }
  try {
    rmdirSync(dir);
    out(`removed empty dir ${dir}`);
  } catch (e) {
    if (e.code === "ENOTEMPTY" || e.code === "EEXIST") out(`kept ${dir} (not empty)`);
    else throw e;
  }
}

export async function runUninstall(argv, { env = process.env, out = console.log, err = console.error, confirm = ttyConfirm, claudeFallbacks, mcpTimeoutMs, realHome } = {}) {
  let opts, record;
  const L = layout({ env });
  try {
    opts = parseArgs(argv);
    record = readInstalled(L.installed);
  } catch (e) {
    err(`uninstall: ${e.message}`);
    return 1;
  }
  if (!record) {
    out(`Nothing to uninstall: ${L.installed} does not exist.`);
    return 0;
  }

  const hasIntegration = record.files.some(isIntegrationEntry) || "skillsRoot" in record;
  if (opts.agentIntegration && !hasIntegration) {
    out(`Nothing to uninstall: ${L.installed} lists no agent integration.`);
    return 0;
  }
  const refusal = hasIntegration && overrideRefusal(env, realHome);
  if (refusal) {
    err(`uninstall: agent integration: ${refusal}. Nothing changed.`);
    return 1;
  }
  // Scout holds its store and profile locks while it runs; nothing is removed under it.
  const holder = coreLockHolder(L);
  if (holder.state === "running" && !opts.dryRun) {
    err(`uninstall: Scout is running (pid ${holder.pid}); quit Scout first. Nothing changed.`);
    return 1;
  }
  const listed = opts.agentIntegration ? record.files.filter(isIntegrationEntry) : record.files;
  out(`${opts.agentIntegration ? "Agent integration" : "Files"} listed in ${L.installed}:`);
  for (const f of listed) out(`  ${String(f.kind).padEnd(22)} ${f.path}`);
  const wrappers = exportedWrapperNames(record, L);
  if (wrappers.length) {
    out(`Scout app skill wrappers listed in ${L.exportsManifest} (each removed only if unchanged since Scout wrote it):`);
    for (const name of wrappers) out(`  ${"skill-wrapper".padEnd(22)} ${join(record.skillsRoot, name)}`);
  }
  if (holder.state === "running") out(`Scout is running (pid ${holder.pid}): the real run would stop here and change nothing; quit Scout first.`);
  if (opts.dryRun) out(`Dry run: nothing is changed.`);
  else if (!opts.yes) {
    const answer = await confirm(
      opts.agentIntegration
        ? `Remove the MCP registration and skill above if they are still exactly what setup installed${wrappers.length ? ", and the unchanged skill wrappers" : ""}? [y/N] `
        : `Remove the files above that are still exactly what setup wrote${wrappers.length ? ", and the unchanged skill wrappers" : ""}? [y/N] `,
    );
    if (answer === null) {
      err("uninstall: stdin is not a terminal; re-run with --yes to confirm. Nothing changed.");
      return 1;
    }
    if (!answer) {
      out("Aborted. Nothing changed.");
      return 1;
    }
  }

  let skipped = 0;
  const unexport = unexportWrappers(record, { env, L, dryRun: opts.dryRun });
  for (const line of unexport.lines) out(line);
  if (unexport.stop) {
    err(`uninstall: ${unexport.stop}. Nothing changed.`);
    return 1;
  }
  skipped += unexport.kept;

  let working = record;
  if (hasIntegration) {
    const r = removeIntegration(record, { env, L, dryRun: opts.dryRun, claudeFallbacks, mcpTimeoutMs, realHome });
    for (const line of r.lines) out(line);
    skipped += r.left;
    working = r.record;
  }

  const remaining = [];
  for (const entry of working.files) {
    if (opts.agentIntegration || isIntegrationEntry(entry)) {
      remaining.push(entry);
      continue;
    }
    const { action, reason } = judge(entry, record.marker, opts, L, record);
    const would = opts.dryRun ? "would " : "";
    if (action === "remove") {
      if (!opts.dryRun) unlinkSync(entry.path);
      out(`${would}remove ${entry.path} (${reason})`);
    } else if (action === "strip-key") {
      if (!opts.dryRun) {
        const m = readJsonObject(entry.path);
        delete m.key;
        writeJson(entry.path, m, statSync(entry.path).mode & 0o777);
      }
      out(`${would}strip "key" from ${entry.path} (${reason})`);
    } else if (action === "legacy") {
      out(`leave ${entry.path} (${reason}; ${would}drop the entry)`);
    } else if (action === "gone") {
      out(`skip ${entry.path} (${reason})`);
    } else {
      if (action === "skip") skipped++;
      out(`${action === "keep" ? "keep" : "SKIP"} ${entry.path} (${reason})`);
      remaining.push(entry);
    }
  }

  const final = { ...working, files: remaining };
  if (remaining.length === 0 && !("skillsRoot" in final)) {
    if (!opts.dryRun) unlinkSync(L.installed);
    out(`${opts.dryRun ? "would remove" : "removed"} ${L.installed}`);
  } else if (JSON.stringify(final) === JSON.stringify(record)) {
    out(`${opts.dryRun ? "would leave" : "left"} ${L.installed} unchanged`);
  } else {
    if (!opts.dryRun) writeJson(L.installed, final, 0o600);
    out(`${opts.dryRun ? "would keep" : "kept"} ${L.installed} listing the ${remaining.length} entr${remaining.length === 1 ? "y" : "ies"} not removed`);
  }
  if (opts.agentIntegration) return skipped > 0 ? 2 : 0;
  removeDirIfEmpty(L.binDir, out, opts.dryRun);
  removeDirIfEmpty(L.runDir, out, opts.dryRun);
  out(`Left in place: ${L.logsDir} (including diagnostics.jsonl) and any file not listed above.`);
  return skipped > 0 ? 2 : 0;
}

/** The core CLI that runs `capabilities unexport-all`: the installed scoutRoot's, else this checkout's. */
function coreCli(L) {
  let root = null;
  try {
    const cfg = readJsonObject(L.scoutConfig);
    if (typeof cfg?.scoutRoot === "string") root = cfg.scoutRoot;
  } catch {
    // unreadable config: this checkout's CLI
  }
  const installed = root ? layout({ scoutRoot: root }).coreCli : null;
  return installed && exists(installed) ? installed : layout({ scoutRoot: REPO_ROOT }).coreCli;
}

/** Wrapper names exports.json lists, when installed.json records a skills root; [] if unreadable. */
function exportedWrapperNames(record, L) {
  if (!record.skillsRoot) return [];
  try {
    const entries = JSON.parse(readFileSync(L.exportsManifest, "utf8"))?.entries;
    return Array.isArray(entries) ? entries.map((e) => e?.name).filter((n) => typeof n === "string" && /^scout-[a-z]+-[0-9a-f]{16}$/.test(n)) : [];
  } catch {
    return [];
  }
}

/**
 * Step one: remove the Scout app's exported skill wrappers through the core's one-shot CLI.
 * Returns { lines, kept, stop? }: `stop` is a reason to change nothing at all.
 */
export function unexportWrappers(record, { env, L, dryRun }) {
  const lines = [];
  if (!record.skillsRoot) return { lines, kept: 0 };
  let listed;
  try {
    listed = readExportsManifest(L.exportsManifest);
  } catch (e) {
    listed = { error: e.message };
  }
  if (!listed || listed.wrappers === 0) return { lines, kept: 0 };
  const cli = coreCli(L);
  const command = `${process.execPath} ${cli} capabilities unexport-all --home ${L.scoutHome}`;
  if (dryRun) {
    lines.push(`would run ${command}`);
    if (listed.error) lines.push(`  (${listed.error}; the real run would stop here and change nothing)`);
    else lines.push(`  it would remove each of the ${listed.wrappers} Scout app skill wrapper(s) listed in ${L.exportsManifest} that is unchanged, and keep and list any you changed`);
    return { lines, kept: 0 };
  }
  // Checked again by the CLI itself, which holds the lock: Scout may have started since.
  if (coreLockHolder(L).state === "running") return { lines, kept: 0, stop: "Scout is running and owns its skill wrappers; quit Scout first" };
  const r = spawnSync(process.execPath, [cli, "capabilities", "unexport-all", "--home", L.scoutHome, "--json"], {
    env: { ...env, SCOUT_HOME: L.scoutHome },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  if (r.status === 2) return { lines, kept: 0, stop: "Scout is running and owns its skill wrappers; quit Scout first" };
  let outcome = null;
  try {
    outcome = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    // reported below
  }
  if ((r.status !== 0 && r.status !== 3) || !outcome) {
    const why = (r.stderr || "").trim().split("\n").at(-1) || (r.error ? r.error.message : `exit ${r.status ?? r.signal}`);
    return { lines, kept: 0, stop: `could not remove the Scout app's skill wrappers (${why})` };
  }
  if (outcome.note) lines.push(`Scout app skill wrappers: ${outcome.note}`);
  for (const name of outcome.removed) lines.push(`removed ${join(record.skillsRoot, name)} (Scout app skill wrapper, unchanged since Scout wrote it)`);
  for (const k of outcome.kept) lines.push(`SKIP ${join(record.skillsRoot, k.name)} (Scout app skill wrapper, ${k.code === "left_symlink" ? "now a symlink" : k.code === "io_error" ? "the file system refused" : "changed since Scout wrote it"}; not touching, still listed in ${L.exportsManifest})`);
  return { lines, kept: outcome.kept.length };
}

if (isMain(import.meta.url)) process.exitCode = await runUninstall(process.argv.slice(2));
