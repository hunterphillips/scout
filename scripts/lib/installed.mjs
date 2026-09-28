// Scout setup: ~/.scout/installed.json, the record of every file setup wrote.
//
// { "version": 1, "marker": "<token>", "files": [ { "path", "kind", ...extra } ] }
// kinds: config | config-merged | wrapper | nmh-manifest | key | extension-manifest-key
// config-merged: a file someone else owns (the personal-context config); setup added
// only the keys in `keys`, and uninstall removes only those.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export const KINDS = ["config", "config-merged", "wrapper", "nmh-manifest", "key", "extension-manifest-key"];

/** The keys setup merges into ~/.personal-context-mcp/config.json. */
export const PC_MERGED_KEYS = ["x_scout_marker", "nodePath", "claudePath"];

export function newMarker() {
  return randomBytes(16).toString("hex");
}

/** The parsed record, or null when absent. Throws on a malformed file. */
export function readInstalled(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const data = JSON.parse(text);
  if (data?.version !== 1 || typeof data.marker !== "string" || !Array.isArray(data.files)) {
    throw new Error(`${path} is not a Scout install record`);
  }
  return data;
}

/** Adds or replaces the entry for `entry.path`; never duplicates. */
export function upsertEntry(record, entry) {
  if (!KINDS.includes(entry.kind)) throw new Error(`unknown kind ${entry.kind}`);
  const files = record.files.filter((f) => f.path !== entry.path);
  files.push(entry);
  return { ...record, files };
}

export const EXTENSION_MANIFEST_SUFFIX = "/packages/browser-extension/dist/manifest.json";

/**
 * True when `path` is a place setup could have written an entry of `kind`, given
 * `L` (a layout from paths.mjs). Uninstall and doctor ignore any other entry, so a
 * tampered installed.json cannot point them at arbitrary files.
 */
export function allowedPath(kind, path, L) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) return false;
  switch (kind) {
    case "key":
      return path === L.keyPem;
    case "config":
      return path === L.scoutConfig;
    case "wrapper":
      return path === L.wrapper;
    case "nmh-manifest":
      return basename(path) === "dev.scout.bridge.json";
    case "config-merged":
      return path === L.pcConfig || (basename(path) === "config.json" && basename(dirname(path)) === ".personal-context-mcp");
    case "extension-manifest-key":
      return path.endsWith(EXTENSION_MANIFEST_SUFFIX);
    default:
      return false;
  }
}
