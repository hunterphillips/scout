#!/usr/bin/env node
// Scout uninstall: remove only the files listed in <SCOUT_HOME>/installed.json,
// and only those that still carry this install's Scout marker. For a merged config
// (the personal-context config), it removes only the keys setup added.
// Lists the files and asks y/N before changing anything; --yes skips the prompt.
// Without a terminal on stdin and without --yes, it aborts.
//
// Entries whose path is outside what setup could have written (lib/installed.mjs
// allowedPath) are skipped and reported.
//
// The agent integration (the `scout` MCP registration and the scout-integration skill) is
// removed with everything else, or alone with --agent-integration; each part only while it is
// still exactly what setup installed (lib/agent-integration.mjs). Scout app skill wrappers in
// the skills root are never touched; uninstall reports how many remain.
//
// Usage: node scripts/uninstall.mjs [--dry-run] [--yes] [--include-key] [--agent-integration]
// Env overrides: SCOUT_HOME, PERSONAL_CONTEXT_HOME, SCOUT_CLAUDE_BIN (see lib/paths.mjs); the
// other paths, and the skills root, come from installed.json, checked against allowedPath.
// Never touches ~/.rook, ~/.scout/logs, or anything not listed.

import { lstatSync, readFileSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { layout } from "./lib/paths.mjs";
import { extensionIdFromPem } from "./lib/extension-key.mjs";
import { PC_MERGED_KEYS, allowedPath, readInstalled } from "./lib/installed.mjs";
import { exists, fileMarker, readJsonObject, writeJson } from "./lib/files.mjs";
import { isMain } from "./lib/is-main.mjs";
import { isIntegrationEntry, removeIntegration } from "./lib/agent-integration.mjs";

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

/** Decide what to do with one entry: { action: "remove"|"strip-key"|"strip-merged"|"gone"|"keep"|"skip", reason }. */
export function judge(entry, marker, { includeKey }, L, record) {
  const p = entry.path;
  if (!allowedPath(entry.kind, p, L, record)) return { action: "skip", reason: `not a path setup writes for kind ${entry.kind}; not touching` };
  if (!exists(p)) return { action: "gone", reason: "already absent" };
  if (!isRegularFile(p)) return { action: "skip", reason: "not a regular file" };
  switch (entry.kind) {
    case "config":
    case "wrapper":
    case "nmh-manifest":
      return fileMarker(p, entry.kind) === marker
        ? { action: "remove", reason: "marker matches" }
        : { action: "skip", reason: "Scout marker missing or different; not removing" };
    case "config-merged": {
      let m = null;
      try {
        m = readJsonObject(p);
      } catch {
        // malformed
      }
      if (!m) return { action: "skip", reason: "not a JSON object; not changing" };
      if (m.x_scout_marker !== marker) return { action: "skip", reason: "Scout marker missing or different; not changing" };
      const others = Object.keys(m).filter((k) => !PC_MERGED_KEYS.includes(k));
      return others.length
        ? { action: "strip-merged", reason: `marker matches; keeping ${others.join(", ")}` }
        : { action: "remove", reason: "marker matches and only Scout's keys remain" };
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

export async function runUninstall(argv, { env = process.env, out = console.log, err = console.error, confirm = ttyConfirm, claudeFallbacks, mcpTimeoutMs } = {}) {
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
  const listed = opts.agentIntegration ? record.files.filter(isIntegrationEntry) : record.files;
  out(`${opts.agentIntegration ? "Agent integration" : "Files"} listed in ${L.installed}:`);
  for (const f of listed) out(`  ${String(f.kind).padEnd(22)} ${f.path}`);
  if (opts.dryRun) out(`Dry run: nothing is changed.`);
  else if (!opts.yes) {
    const answer = await confirm(
      opts.agentIntegration
        ? "Remove the MCP registration and skill above if they are still exactly what setup installed? [y/N] "
        : "Remove the files above that still carry this install's marker? [y/N] ",
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
  let working = record;
  if (hasIntegration) {
    const r = removeIntegration(record, { env, L, dryRun: opts.dryRun, claudeFallbacks, mcpTimeoutMs });
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
    } else if (action === "strip-merged") {
      if (!opts.dryRun) {
        const m = readJsonObject(entry.path);
        for (const k of PC_MERGED_KEYS) delete m[k];
        writeJson(entry.path, m, statSync(entry.path).mode & 0o777);
      }
      out(`${would}remove ${PC_MERGED_KEYS.join(", ")} from ${entry.path} (${reason})`);
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

if (isMain(import.meta.url)) process.exitCode = await runUninstall(process.argv.slice(2));
