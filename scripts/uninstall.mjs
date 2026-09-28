#!/usr/bin/env node
// Scout uninstall: remove only the files listed in <SCOUT_HOME>/installed.json,
// and only those that still carry this install's Scout marker.
//
// Usage: node scripts/uninstall.mjs [--dry-run] [--include-key]
// Env overrides: SCOUT_HOME (see lib/paths.mjs); every other path comes from installed.json.
// Never touches ~/.rook, ~/.scout/logs, or anything not listed.

import { lstatSync, readFileSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute } from "node:path";
import { layout } from "./lib/paths.mjs";
import { extensionIdFromPem } from "./lib/extension-key.mjs";
import { readInstalled } from "./lib/installed.mjs";
import { exists, fileMarker, readJsonObject, writeJson } from "./lib/files.mjs";
import { isMain } from "./lib/is-main.mjs";

export function parseArgs(argv) {
  const opts = { dryRun: false, includeKey: false };
  for (const a of argv) {
    if (a === "--dry-run") opts.dryRun = true;
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

/** Decide what to do with one entry: { action: "remove"|"strip-key"|"gone"|"keep"|"skip", reason }. */
export function judge(entry, marker, { includeKey }) {
  const p = entry.path;
  if (typeof p !== "string" || !isAbsolute(p)) return { action: "skip", reason: "path is not absolute" };
  if (!exists(p)) return { action: "gone", reason: "already absent" };
  if (!isRegularFile(p)) return { action: "skip", reason: "not a regular file" };
  switch (entry.kind) {
    case "config":
    case "wrapper":
    case "nmh-manifest":
      return fileMarker(p, entry.kind) === marker
        ? { action: "remove", reason: "marker matches" }
        : { action: "skip", reason: "Scout marker missing or different; not removing" };
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

export function runUninstall(argv, { env = process.env, out = console.log, err = console.error } = {}) {
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

  out(`Files listed in ${L.installed}:`);
  for (const f of record.files) out(`  ${f.kind.padEnd(22)} ${f.path}`);
  if (opts.dryRun) out(`Dry run: nothing is changed.`);

  const remaining = [];
  let skipped = 0;
  for (const entry of record.files) {
    const { action, reason } = judge(entry, record.marker, opts);
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
    } else if (action === "gone") {
      out(`skip ${entry.path} (${reason})`);
    } else {
      if (action === "skip") skipped++;
      out(`${action === "keep" ? "keep" : "SKIP"} ${entry.path} (${reason})`);
      remaining.push(entry);
    }
  }

  if (remaining.length === 0) {
    if (!opts.dryRun) unlinkSync(L.installed);
    out(`${opts.dryRun ? "would remove" : "removed"} ${L.installed}`);
  } else {
    if (!opts.dryRun) writeJson(L.installed, { ...record, files: remaining }, 0o600);
    out(`${opts.dryRun ? "would keep" : "kept"} ${L.installed} listing the ${remaining.length} file(s) not removed`);
  }
  removeDirIfEmpty(L.binDir, out, opts.dryRun);
  removeDirIfEmpty(L.runDir, out, opts.dryRun);
  out(`Left in place: ${L.logsDir} (including diagnostics.jsonl) and any file not listed above.`);
  return skipped > 0 ? 2 : 0;
}

if (isMain(import.meta.url)) process.exitCode = runUninstall(process.argv.slice(2));
