// The redacted evidence report for one compatibility check, written to
// `<home>/agent-check/<case>-<timestamp>.json` (dir 0700, file 0600) and pasted into the
// plan's phase log.
//
// What goes in: CLI version, effective argv, preflight verdict and reason codes, the env
// filtering applied (forwarded key names, dropped key count), what the init event loaded
// (Scout's servers and tools by name and status; everything else as counts), the model,
// the outcome class, structured output (synthetic picks), timings, usage counts, cleanup
// evidence, and each inference request made. What never goes in: tokens, env values, full
// prompts, the user's other skill/server/tool names, and absolute paths under $HOME (shown
// as `~`). redactReport() enforces the last two on the finished object as well, and
// writeReport() refuses to write if a secret survives.

import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const REPORT_DIR = "agent-check";
export const REPORT_SCHEMA = 1;
/** Longest model text kept per turn. */
export const TEXT_MAX = 600;

function homes(env) {
  const out = new Set();
  for (const h of [env?.HOME, homedir()]) {
    if (typeof h !== "string" || h.length < 2) continue;
    out.add(h.replace(/\/+$/, ""));
    try {
      out.add(realpathSync(h).replace(/\/+$/, ""));
    } catch {
      // keep the given one
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** `s` with every secret replaced and every $HOME prefix shown as `~`. */
export function redactString(s, { env, secrets = [] }) {
  let out = s;
  for (const secret of secrets) if (typeof secret === "string" && secret.length >= 6) out = out.split(secret).join("<redacted>");
  for (const h of homes(env)) out = out.split(`${h}/`).join("~/").replace(new RegExp(`${escapeRe(h)}(?=$|[^\\w.-])`, "g"), "~");
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A deep copy with redactString applied to every string (keys included). */
export function redactReport(value, opts) {
  if (typeof value === "string") return redactString(value, opts);
  if (Array.isArray(value)) return value.map((v) => redactReport(v, opts));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactString(k, opts), redactReport(v, opts)]));
  }
  return value;
}

/** Model text as evidence: bounded, redacted. */
export function evidenceText(text, opts) {
  if (typeof text !== "string") return undefined;
  const t = redactString(text, opts);
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX)}...` : t;
}

/**
 * The init event as evidence. Only names that are Scout's (`keep`) are listed; the user's
 * other servers, tools and skills are counted, never named.
 */
export function summarizeInit(init, keep) {
  if (!init) return { seen: false };
  const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
  const tools = Array.isArray(init.tools) ? init.tools.filter((t) => typeof t === "string") : [];
  const skills = Array.isArray(init.skills) ? init.skills.filter((t) => typeof t === "string") : [];
  const ours = servers.filter((s) => keep.server(s?.name));
  return {
    seen: true,
    cliVersion: typeof init.claude_code_version === "string" ? init.claude_code_version : undefined,
    model: typeof init.model === "string" ? init.model : undefined,
    permissionMode: typeof init.permissionMode === "string" ? init.permissionMode : undefined,
    apiKeySource: typeof init.apiKeySource === "string" ? init.apiKeySource : undefined,
    mcpServers: ours.map((s) => ({ name: s.name, status: s.status })),
    otherMcpServers: servers.length - ours.length,
    tools: tools.filter((t) => keep.tool(t)),
    otherTools: tools.filter((t) => !keep.tool(t)).length,
    skills: skills.filter((t) => keep.skill(t)),
    otherSkills: skills.filter((t) => !keep.skill(t)).length,
    plugins: Array.isArray(init.plugins) ? init.plugins.length : 0,
  };
}

/** Usage counts from a `result` event. */
export function usageOf(result) {
  const u = result?.usage ?? {};
  const n = (v) => (typeof v === "number" ? v : undefined);
  return {
    turns: n(result?.num_turns),
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    cacheWriteTokens: n(u.cache_creation_input_tokens),
    durationMs: n(result?.duration_ms),
  };
}

export function buildReport(caseName, fields) {
  return { schema: REPORT_SCHEMA, case: caseName, ...fields };
}

/**
 * Redact, check, and write the report. Returns its path. Throws (writing nothing) if a
 * secret or an absolute $HOME path is still present after redaction.
 */
export function writeReport(home, caseName, report, opts) {
  const clean = redactReport(report, opts);
  const json = JSON.stringify(clean, null, 2) + "\n";
  for (const s of opts.secrets ?? []) if (typeof s === "string" && s.length >= 6 && json.includes(s)) throw new Error("report: a secret survived redaction");
  for (const h of homes(opts.env)) if (json.includes(`${h}/`) || json.includes(`"${h}"`)) throw new Error("report: a $HOME path survived redaction");
  const dir = join(home, REPORT_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${caseName}-${stamp}.json`);
  writeFileSync(path, json, { mode: 0o600, flag: "wx" });
  return { path, report: clean };
}

/** An argv element as a reader would type it (display only; nothing is run through a shell). */
export const shellish = (a) => (a === "" || /[\s{"'$`\\]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a);

/** A few lines for the terminal. */
export function summaryLines(report, path) {
  const lines = [`verify:agent ${report.case}: ${report.pass ? "PASS" : "FAIL"} (${report.outcome})`];
  if (report.label) lines.push(`  label: ${report.label}`);
  if ("gatePass" in report) lines.push(`  counts for the Phase 1 gate: ${report.gatePass ? "yes" : "no"}`);
  if (report.case === "hotload") lines.push("  session: one headless multi-turn `claude -p` stream-json process standing in for an interactive session");
  if (report.cli?.version) lines.push(`  claude ${report.cli.version}; preflight ${report.preflight?.verdict ?? "not run"}`);
  if (Array.isArray(report.inferenceRequests)) lines.push(`  inference requests: ${report.inferenceRequests.length}`);
  if (report.mcpStatusSeen) lines.push(`  proof MCP server at turn 1: ${report.mcpStatusSeen}${report.mcpToolsDeferred ? " (tools not listed in init; ToolSearch offered)" : ""}`);
  if (report.discovery) lines.push(`  turn 2 listing: ${report.discovery}`);
  if (Array.isArray(report.failures) && report.failures.length) lines.push(`  failures: ${report.failures.join(", ")}`);
  if (report.cleanup) lines.push(`  cleanup: ${report.cleanup.ok ? "complete" : "INCOMPLETE"}`);
  if (path) lines.push(`  report: ${path}`);
  return lines;
}
