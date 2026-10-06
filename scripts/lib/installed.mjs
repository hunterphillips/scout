// Scout setup: ~/.scout/installed.json, the record of every file setup wrote.
//
// { "version": 1, "marker": "<token>", "skillsRoot"?: "<abs dir>", "skillsRootCreated"?: true,
//   "files": [ { "path", "kind", ...extra } ] }
// kinds: config | wrapper | nmh-manifest | key | extension-manifest-key
//        | mcp-registration | skill | agent-profile | launch-agent | app-bundle
// agent-profile { path: "<SCOUT_HOME>/agent-profile.json", sha256 }: written only when absent,
//                     with the absolute claude path setup resolved; removed only while unchanged
// launch-agent  { path: "<LaunchAgents>/dev.scout.app.plist", sha256, program }: the optional
//                     login launch (setup --login-launch); removed only while unchanged
// app-bundle    { path: "<Applications>/Scout.app", sha256 }: the installed app (bundle-app
//                     --install); sha256 is bundleHash (every file in the bundle); removed only
//                     while it matches
// `kinds`: the sorted kind names present, rewritten on every save (saveInstalled), so a
// later reader can tell a record that lists its kinds from an older one. `version` stays 1.
// The agent integration (setup --agent-integration, lib/agent-integration.mjs) adds:
//   skillsRoot        the Claude Code skills root; scout-core reads it (installedRecord.ts)
//                     to export runtime skill wrappers there
//   skillsRootCreated true only when setup created the skills root itself; uninstall leaves
//                     the root in place either way (Claude Code shares it) and says so
//   mcp-registration  { path: "<nodePath> <scout-mcp main.js>", agent, name: "scout", ... }:
//                     the command the agent's CLI registered; `path` is that command, not a file.
//                     Claude Code (`claude mcp add`): scope "user". Codex (`codex mcp add`):
//                     codexHome, the Codex home it went into
//   skill             { path: "<root>/scout-integration/SKILL.md", agent, sha256 }: the static
//                     skill; root is skillsRoot for Claude Code, `<Codex home>/skills` for Codex
// `agent` is "claude-code" or "codex"; an entry without it is Claude Code's (records written
// before the Codex integration). These two kinds are singletons per agent.
// Records without these fields are still valid version-1 records.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeJson } from "./files.mjs";
import { basename, isAbsolute, join, resolve } from "node:path";

export const KINDS = ["config", "wrapper", "nmh-manifest", "key", "extension-manifest-key", "mcp-registration", "skill", "agent-profile", "launch-agent", "app-bundle"];

/** Kinds that may appear at most once (per agent, for AGENT_KINDS); a new entry replaces the old one whatever its path. */
const SINGLETON_KINDS = ["mcp-registration", "skill", "agent-profile", "launch-agent", "app-bundle"];

/** The agents an integration can be installed for. */
export const AGENT_IDS = ["claude-code", "codex"];
/** Kinds recorded once per agent. */
export const AGENT_KINDS = ["mcp-registration", "skill"];

/** The agent an integration entry belongs to (absent means Claude Code); undefined for other kinds. */
export function agentOf(entry) {
  if (!AGENT_KINDS.includes(entry?.kind)) return undefined;
  return entry.agent === undefined ? "claude-code" : entry.agent;
}

export const CODEX_SKILL_SUFFIX = "/skills/scout-integration/SKILL.md";

export const INTEGRATION_SERVER_NAME = "scout";
export const INTEGRATION_SKILL_DIR = "scout-integration";
export const SCOUT_MCP_MAIN_SUFFIX = "/packages/scout-mcp/dist/main.js";

const isCleanAbsolute = (p) => typeof p === "string" && isAbsolute(p) && resolve(p) === p;

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
  if ("skillsRoot" in data && !isCleanAbsolute(data.skillsRoot)) throw new Error(`${path} has an invalid skillsRoot`);
  if ("skillsRootCreated" in data && typeof data.skillsRootCreated !== "boolean") throw new Error(`${path} has an invalid skillsRootCreated`);
  if ("kinds" in data && (!Array.isArray(data.kinds) || !data.kinds.every((k) => typeof k === "string"))) throw new Error(`${path} has an invalid kinds list`);
  return data;
}

/** Write the record (0600) with `kinds` set to the kind names its entries use. */
export function saveInstalled(path, record) {
  const kinds = [...new Set(record.files.map((f) => f.kind))].sort();
  writeJson(path, { ...record, kinds }, 0o600);
}

/** Adds or replaces the entry for `entry.path` (per agent, for AGENT_KINDS); never duplicates. */
export function upsertEntry(record, entry) {
  if (!KINDS.includes(entry.kind)) throw new Error(`unknown kind ${entry.kind}`);
  const single = SINGLETON_KINDS.includes(entry.kind);
  const agent = agentOf(entry);
  const files = record.files.filter((f) => !((f.path === entry.path || (single && f.kind === entry.kind)) && agentOf(f) === agent));
  files.push(entry);
  return { ...record, files };
}

export const EXTENSION_MANIFEST_SUFFIX = "/packages/browser-extension/dist/manifest.json";

/** The integration skill file under a skills root. */
export function integrationSkillPath(skillsRoot) {
  return join(skillsRoot, INTEGRATION_SKILL_DIR, "SKILL.md");
}

/** `{ command, args }` from a recorded "<nodePath> <main.js>" command string, or null if it is not that shape. */
export function parseRegistrationCommand(text) {
  if (typeof text !== "string") return null;
  const parts = text.split(" ");
  if (parts.length !== 2 || parts.some((p) => !isCleanAbsolute(p) || /\s/.test(p))) return null;
  if (!parts[1].endsWith(SCOUT_MCP_MAIN_SUFFIX)) return null;
  return { command: parts[0], args: [parts[1]] };
}

/**
 * True when `path` is a place setup could have written an entry of `kind`, given
 * `L` (a layout from paths.mjs), the record it came from (for `skillsRoot`) and, for the
 * integration kinds, the entry itself (for its `agent`). Uninstall and doctor ignore any other
 * entry, so a tampered installed.json cannot point them at arbitrary files or registrations.
 */
export function allowedPath(kind, path, L, record, entry = { kind }) {
  const agent = agentOf({ ...entry, kind });
  if (agent !== undefined && !AGENT_IDS.includes(agent)) return false;
  if (kind === "mcp-registration") return parseRegistrationCommand(path) !== null;
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) return false;
  switch (kind) {
    case "skill":
      if (agent === "codex") return path.endsWith(CODEX_SKILL_SUFFIX) && path.length > CODEX_SKILL_SUFFIX.length;
      return isCleanAbsolute(record?.skillsRoot) && path === integrationSkillPath(record.skillsRoot);
    case "key":
      return path === L.keyPem;
    case "config":
      return path === L.scoutConfig;
    case "wrapper":
      return path === L.wrapper;
    case "nmh-manifest":
      return basename(path) === "dev.scout.bridge.json";
    case "extension-manifest-key":
      return path.endsWith(EXTENSION_MANIFEST_SUFFIX);
    case "agent-profile":
      return path === L.agentProfile;
    case "launch-agent":
      return path === L.launchAgent;
    case "app-bundle":
      return path === L.installedApp;
    default:
      return false;
  }
}
