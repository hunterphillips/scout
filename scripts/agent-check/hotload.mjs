// The native skill hot-load check (P1.4). One headless multi-turn `claude -p` stream-json
// process stands in for an already-open interactive session (it is not an interactive
// session; the report says so); a proof skill is added to the skills root after its first
// turn, and the second turn must list it, use it natively (the Skill tool) and read the
// resource through Scout. Inference requests: turn 1 and turn 2, plus one each for
// --with-revocation and --two-session when the budget (--max-inference) allows them. One
// inference request is one turn (one user message); the API calls inside a turn are
// recorded per turn in usage.turns.
//
// Acceptance mode (--authorize-real-root) uses the real user skills root
// (`$CLAUDE_CONFIG_DIR/skills`, else `~/.claude/skills`; refused, never created, if missing)
// and a user-scope MCP registration, both named `scout-proof-<nonce>`. Preliminary mode
// (--preliminary) changes nothing outside a throwaway dir: the skill goes in the session
// cwd's project skills dir and the server comes from --mcp-config; its report is labeled
// preliminary and cannot pass the gate. Without either flag a real run exits 2: the gate
// stays unverified.
//
// Order: preflight for the exact env/cwd/binary of the session -> register -> start the
// session (the skills root already exists) -> turn 1 -> write the skill -> turn 2 -> optional
// restart/revocation -> cleanup -> report. Cleanup runs exactly once, on every path,
// including an abort (deps.abortSignal: SIGINT/SIGTERM or an uncaught error in run.mjs),
// which stops the session first and reports outcome `aborted`.
//
// Session flags, verified in `claude --help` 2.1.286 unless noted:
//   --model <m> -p --input-format stream-json --output-format stream-json --verbose
//   --permission-mode dontAsk --allowedTools <Skill, ToolSearch, the proof server's two tools>
//   --tools Skill,ToolSearch      built-ins limited to these two (checked in the init event)
//   --settings {"disableAllHooks":true}   the user's hooks do not run in the check
//   --no-session-persistence
//   --setting-sources user        (preliminary: user,project) so the user-scope
//                                 registration and user skills root apply
//   --max-turns 8                 bounds a runaway turn
// Never --strict-mcp-config: the user-scope registration must load, so every other
// user-scope MCP server and plugin loads too (counted in the report, never named). Their
// tools are present but not in --allowedTools, so dontAsk denies them.
//
// ToolSearch (from the 2.1.286 binary's strings, not from a live run): tool search is on
// only when the ToolSearch tool is in the request's tool list ("Tool search disabled:
// ToolSearchTool is not available" otherwise), and when it is on, MCP tools are deferred
// by default ("Default: tools are deferred when tool search is enabled"; a server's
// `alwaysLoad` opts out). The init event's `tools` is the session's tool pool
// (`tools: e.tools.map(...)`); whether a deferred tool is still listed there cannot be told
// statically. So the session offers ToolSearch from the start (it only loads tool
// definitions), the report records whether the proof tools were listed in init
// (`mcpToolsDeferred` is true when the server is connected but its tools are not) and how
// often ToolSearch was used. MCP startup is non-blocking by default in 2.1.286, so a server
// still connecting at init shows `pending`. That is timing, not failure: the check records
// mcpStatusAtInit and goes on to turn 2 without polling or extra waiting (turn 2's own
// latency is the wait); only turn 2's evidence can then say the server never loaded. A
// `failed` or `absent` server (or any status other than connected/pending) stops after turn 1.

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../lib/paths.mjs";
import { createLaunchProfile, filterChildEnv, runProfilePreflight } from "../../packages/scout-core/dist/agents/launchProfile.js";
import { renderSkillWrapper } from "../../packages/scout-core/dist/capabilities/wrapper.js";
import { CHECK_MODEL, makeThrowawayRoot, SCOUT_MCP_MAIN, startSkillFixture } from "./fixtures.mjs";
import { mcpAddUser, mcpGet, ownsRegistration, pathExists, removeOwnedRegistration, removeOwnedSkill, writeProofSkill } from "./registration.mjs";
import { buildReport, evidenceText, shellish, summarizeInit, usageOf } from "./report.mjs";
import { startSession } from "./session.mjs";

export const HOTLOAD_DEFAULTS = Object.freeze({ settleMs: 3000, turnTimeoutMs: 180_000 });
export const MAX_TURNS = 8;
export const SESSION_TOOLS = Object.freeze(["Skill", "ToolSearch"]);
const NONCE_RE = /^[a-z0-9]{10}$/;
/** How long an aborted run waits for the in-flight step to notice before cleaning up. */
const ABORT_SETTLE_MS = 2000;

/**
 * Outcome classes, each by evidence:
 *   hotload_pass                turn 2 listed the proof skill, invoked it (Skill tool), read the
 *                               resource through the proof server, and quoted the proof phrase
 *   skill_used_not_listed       all of that except the model's own listing omitted the skill
 *   read_ok_phrase_missing      the read succeeded but the phrase is not in the final text
 *   skill_invoked_read_failed   Skill was called; read_resource was not called or errored
 *                               (turn.readError holds the code)
 *   skill_not_invoked           no Skill tool_use naming the proof skill
 *   hotload_requires_reload     --two-session: turn 2 did not invoke it, a fresh session did
 *   skill_never_loads           --two-session: neither session invoked and read it
 *   mcp_not_loaded              turn 1's init showed the proof server failed or absent (stops
 *                               there), or it was pending / listed without tools at init and
 *                               turn 2's read_resource failed as tool_unavailable or
 *                               server_not_connected (mcpStatusAtInit holds the init status)
 *   mcp_requires_restart        --two-session: failed/absent in session 1, connected in a fresh one
 *   preflight_failed, aborted
 */
export const OUTCOMES = Object.freeze([
  "hotload_pass",
  "skill_used_not_listed",
  "read_ok_phrase_missing",
  "skill_invoked_read_failed",
  "skill_not_invoked",
  "hotload_requires_reload",
  "skill_never_loads",
  "mcp_not_loaded",
  "mcp_requires_restart",
  "preflight_failed",
  "aborted",
]);

export const PROMPTS = Object.freeze({
  list: () =>
    'Scout compatibility check, step 1. Without using any tools, reply in one line that starts with "Skills seen:" followed by the names of the skills available to you right now whose names start with "scout-proof-", or "Skills seen: none" if there are none.',
  use: () =>
    'Scout compatibility check, step 2. First, write one line that starts with "Skills seen:" followed by the names of the skills available to you right now whose names start with "scout-proof-", or "Skills seen: none". Then, if you listed one, use it with the Skill tool and follow its instructions to read the resource it points to, and end your reply with only the line from that resource that starts with "Proof phrase:". If you listed none, or cannot use the skill or read the resource, say so in one line.',
  revoke: (tool, resourceId) =>
    `Scout compatibility check, revocation step. Call the tool ${tool} directly with resourceId ${resourceId} and reply in one line with what Scout returned. Do not repeat anything from earlier answers.`,
});

export const REPORT_NOTES = Object.freeze([
  "The session is a single headless multi-turn `claude -p --input-format stream-json --output-format stream-json` process standing in for an interactive session; it is not an interactive session. gatePass is computed from this stand-in.",
  `The session loads every user-scope MCP server and plugin (init.otherMcpServers and init.plugins count them; they are not named), because the user-scope proof registration is visible only with user settings loaded. What the model can do is limited by --tools ${SESSION_TOOLS.join(",")}, --settings {"disableAllHooks":true}, --setting-sources user, --permission-mode dontAsk with --allowedTools set to exactly sessionLimits.allowedTools, and --max-turns ${MAX_TURNS}.`,
  "One inference request is one turn: one user message sent to the session (one job). A turn can make several API calls (tool use); those are counted per turn in turns[].usage.turns.",
  "A missing user skills root is refused (skills_root_missing_not_created), never created.",
  "Old conversation text remains in a session after revocation; the check shows only that Scout refuses later reads.",
  "One-time MCP registration (registration.loadedAtStart, mcpStatusAtInit) is recorded separately from per-resource skill hot-load (outcome).",
  "MCP startup is non-blocking in CLI 2.1.286: a proof server `pending` (or listed without tools) at init does not stop the check; turn 2's evidence decides.",
]);

/** Why a hotload run with these options must not start (nothing changed), or undefined. */
export function hotloadRefusal(o) {
  if (o.authorizeRealRoot && o.preliminary) return "--authorize-real-root and --preliminary cannot be combined";
  const need = requiredInference(o);
  if (o.maxInference < need) return `this run needs --max-inference ${need} (turn 1, turn 2${o.withRevocation ? ", revocation" : ""}${o.twoSession ? ", restart" : ""})`;
  if (!o.authorizeRealRoot && !o.preliminary && !o.dryRun) {
    return "hotload needs --authorize-real-root (the acceptance check) or --preliminary. Nothing was changed; the hot-load gate stays unverified.";
  }
  return undefined;
}

export function requiredInference(o) {
  return 2 + (o.withRevocation ? 1 : 0) + (o.twoSession ? 1 : 0);
}

/** The user skills root production exports will use, from the session's env. */
export function userSkillsRoot(env) {
  return join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME, ".claude"), "skills");
}

export function allowedTools(name) {
  return [...SESSION_TOOLS, `mcp__${name}__read_resource`, `mcp__${name}__list_resources`];
}

export function sessionArgs({ model, name, preliminary, mcpConfigFile }) {
  return [
    "--model", model,
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "dontAsk",
    "--allowedTools", allowedTools(name).join(","),
    "--tools", SESSION_TOOLS.join(","),
    "--settings", JSON.stringify({ disableAllHooks: true }),
    "--no-session-persistence",
    "--setting-sources", preliminary ? "user,project" : "user",
    "--max-turns", String(MAX_TURNS),
    ...(preliminary ? ["--mcp-config", mcpConfigFile] : []),
  ];
}

const resultText = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text ?? "").join("\n") : "");

/** A failed read's code: Scout's own (`Scout <code>: ...`), else a coarse CLI-side class. */
export function readErrorCode(text) {
  const scout = /^Scout ([a-z_]+):/.exec(text ?? "");
  if (scout) return scout[1];
  if (/permission|not allowed|denied/i.test(text ?? "")) return "permission_denied";
  if (/not connected|still connecting|pending|failed to connect/i.test(text ?? "")) return "server_not_connected";
  if (/no such tool|not available|unknown tool/i.test(text ?? "")) return "tool_unavailable";
  return "tool_error";
}

/** Proof-skill names on the model's own "Skills seen:" line (any assistant text this turn). */
export function listedSkillNames(text) {
  const line = /^[^\S\n]*[*_]*Skills seen:[*_]*[^\S\n]*(.*)$/im.exec(text ?? "");
  return { lineFound: !!line, names: line ? [...new Set(line[1].match(/scout-proof-[a-z0-9]+/g) ?? [])] : [] };
}

/** What one turn shows: Scout tool uses (others counted), the listing, errors, the proof phrase, usage. */
export function analyzeTurn(turn, { name, readTool, proofPhrase, opts }) {
  const uses = [];
  const results = new Map();
  const texts = [];
  for (const ev of turn.events) {
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (ev.type === "assistant" && b?.type === "tool_use") uses.push({ id: b.id, name: b.name, skill: b.input?.skill });
      if (ev.type === "assistant" && b?.type === "text" && typeof b.text === "string") texts.push(b.text);
      if (ev.type === "user" && b?.type === "tool_result") results.set(b.tool_use_id, { isError: b.is_error === true, text: resultText(b.content) });
    }
  }
  const label = (u) =>
    u.name === "Skill" ? `Skill(${u.skill === name ? name : "other"})` : u.name === readTool || u.name === `mcp__${name}__list_resources` || u.name === "ToolSearch" ? u.name : "other";
  const skillUses = uses.filter((u) => u.name === "Skill" && u.skill === name);
  const reads = uses.filter((u) => u.name === readTool);
  const readResults = reads.map((u) => results.get(u.id));
  const readSucceeded = readResults.some((r) => r && !r.isError);
  let readError;
  if (!reads.length) readError = "not_called";
  else if (!readSucceeded) {
    const last = readResults.findLast(Boolean);
    readError = last ? readErrorCode(last.text) : "no_result";
  }
  const finalText = typeof turn.result?.result === "string" ? turn.result.result : (texts.at(-1) ?? "");
  const listing = listedSkillNames([...texts, finalText].join("\n"));
  const redact = (t) => evidenceText(t.split(proofPhrase).join("<proof phrase>"), opts);
  return {
    ms: turn.ms,
    completed: !!turn.result && !turn.timedOut,
    timedOut: turn.timedOut,
    sessionExited: turn.exited,
    resultSubtype: turn.result?.subtype,
    resultIsError: turn.result?.is_error === true,
    toolUses: uses.map((u) => ({ name: label(u), error: results.get(u.id)?.isError ?? null })),
    toolSearchUses: uses.filter((u) => u.name === "ToolSearch").length,
    listingLineFound: listing.lineFound,
    listedNames: listing.names,
    discovery: listing.names.includes(name) ? "listed" : "not_listed",
    skillInvoked: skillUses.length > 0,
    skillSucceeded: skillUses.some((u) => results.get(u.id) && !results.get(u.id).isError),
    readCalled: reads.length > 0,
    readSucceeded,
    ...(readError ? { readError } : {}),
    readRevoked: readResults.some((r) => r?.isError && /\brevoked\b/.test(r.text)),
    proofPhraseQuoted: finalText.includes(proofPhrase),
    text: redact(finalText),
    usage: usageOf(turn.result),
  };
}

/** The outcome class of a "use the skill" turn (see OUTCOMES). */
export function classifyUse(a) {
  if (!a.skillInvoked) return "skill_not_invoked";
  if (!a.readSucceeded) return "skill_invoked_read_failed";
  if (!a.proofPhraseQuoted) return "read_ok_phrase_missing";
  return a.discovery === "listed" ? "hotload_pass" : "skill_used_not_listed";
}

/**
 * The proof server's state in an init summary. `atInit` is its status there, or
 * `connected_without_tools`. `proceed`: worth a turn 2 (connected, or still pending, or listed
 * without tools); otherwise (failed, absent, ...) not timing, so the check stops.
 */
export function proofServerState(initSummary, { name, readTool }) {
  const server = initSummary?.mcpServers?.find((s) => s.name === name);
  const status = server?.status ?? "absent";
  const toolsListed = !!initSummary?.tools?.includes(readTool);
  const toolSearchOffered = !!initSummary?.tools?.includes("ToolSearch");
  const atInit = status === "connected" && !toolsListed ? "connected_without_tools" : status;
  return { status, atInit, toolsListed, toolSearchOffered, usable: status === "connected" && toolsListed, proceed: status === "connected" || status === "pending" };
}

/** Read errors that mean the proof server's tool never became callable. */
export const NOT_LOADED_READ_ERRORS = Object.freeze(["tool_unavailable", "server_not_connected"]);

class Aborted extends Error {
  constructor() {
    super("aborted");
    this.name = "Aborted";
  }
}

/**
 * @param {object} o  parsed options: home, env, claudePath, authorizeRealRoot, preliminary,
 *   maxInference, withRevocation, twoSession, dryRun
 * @param {object} deps  out, err, abortSignal, and test seams: nonce, settleMs, turnTimeoutMs,
 *   mcpTimeoutMs, preflightSeams, killGraceMs, hooks.{onStart, afterTurn}
 * @returns {Promise<{ code: number, report?: object, secrets?: string[] }>}
 */
export async function runHotload(o, deps) {
  const { out } = deps;
  const settleMs = deps.settleMs ?? HOTLOAD_DEFAULTS.settleMs;
  const turnTimeoutMs = deps.turnTimeoutMs ?? HOTLOAD_DEFAULTS.turnTimeoutMs;
  const label = o.authorizeRealRoot ? "acceptance" : o.preliminary ? "preliminary" : undefined;
  const refusal = hotloadRefusal(o);
  if (refusal) return refuse(deps, refusal);

  const nonce = deps.nonce?.() ?? randomBytes(8).toString("hex").replace(/[^a-z0-9]/g, "").slice(0, 10).padEnd(10, "0");
  if (!NONCE_RE.test(nonce)) return refuse(deps, "internal: bad nonce");
  const name = `scout-proof-${nonce}`;
  const readTool = `mcp__${name}__read_resource`;
  let env;
  try {
    env = filterChildEnv(o.env);
  } catch {
    return refuse(deps, "the environment has no usable HOME / CLAUDE_CONFIG_DIR");
  }
  const realSkillsRoot = userSkillsRoot(env);
  const sessionLimits = {
    tools: SESSION_TOOLS.join(","),
    allowedTools: allowedTools(name),
    permissionMode: "dontAsk",
    settings: { disableAllHooks: true },
    settingSources: label === "preliminary" ? "user,project" : "user",
    maxTurns: MAX_TURNS,
  };

  if (o.dryRun) {
    const skillsRoot = label === "preliminary" ? "<throwaway cwd>/.claude/skills" : realSkillsRoot;
    const lines = [
      "verify:agent hotload --dry-run: nothing is created, registered or launched.",
      `  mode: ${label ?? "not authorized (a real run exits 2; the gate stays unverified)"}`,
      `  claude: ${o.claudePath}`,
      `  model: ${CHECK_MODEL}`,
      `  proof name (MCP registration and skill dir): ${name}`,
      `  skills root: ${skillsRoot}${label === "preliminary" ? "" : ` (exists: ${pathExists(realSkillsRoot) ? "yes" : "no; a real run refuses rather than creates it"})`}`,
      `  proof skill: ${join(skillsRoot, name, "SKILL.md")} (written after turn 1)`,
      label === "preliminary"
        ? `  MCP server: --mcp-config <throwaway>/mcp.json -> ${process.execPath} ${SCOUT_MCP_MAIN} --socket <throwaway>/a.sock --token-file <throwaway>/agent-token`
        : `  register: ${o.claudePath} mcp add --scope user ${name} -- ${process.execPath} ${SCOUT_MCP_MAIN} --socket <throwaway>/a.sock --token-file <throwaway>/agent-token`,
      `  preflight: billing preflight for the session's exact env, cwd (<throwaway>/s/session) and binary`,
      `  session: ${o.claudePath} ${sessionArgs({ model: CHECK_MODEL, name, preliminary: label === "preliminary", mcpConfigFile: "<throwaway>/mcp.json" }).map(shellish).join(" ")}`,
      "  stand-in: one headless multi-turn `claude -p` stream-json process stands in for an interactive session (not an interactive session)",
      `  loads: every user-scope MCP server and plugin (counted, not named); limits: --tools ${sessionLimits.tools}, hooks disabled, --setting-sources ${sessionLimits.settingSources}, dontAsk with --allowedTools ${sessionLimits.allowedTools.join(",")}, --max-turns ${MAX_TURNS}`,
      `  inference requests: at most ${Math.min(o.maxInference, 4)}, one per turn (turn 1 list skills; turn 2 list then use the skill${o.twoSession ? "; a fresh session if turn 1's MCP load or turn 2's invocation fails" : ""}${o.withRevocation ? "; read after revocation" : ""}); API calls per turn are in turns[].usage.turns`,
      "  cleanup (also on SIGINT/SIGTERM/SIGHUP): skill dir removed if unchanged; registration removed if `mcp get` shows our command at user scope (even if `mcp add` failed); session, fixture and throwaway dir removed",
      `  report: ${join(o.home, "agent-check", "hotload-<timestamp>.json")}`,
    ];
    for (const l of lines) out(l);
    return { code: 0 };
  }

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const failures = [];
  const inference = [];
  const turns = [];
  const sessions = [];
  const cleanup = { ok: false };
  const registration = { mode: label === "preliminary" ? "mcp-config file (no installed change)" : "user scope via claude mcp add" };
  let outcome = "aborted";
  let preflight = { verdict: "not run" };
  let initSummary;
  let mcpStatusAtInit;
  let mcpToolsDeferred;
  let revocation = "not_requested";
  let afterRestart = "not_run";
  let skill;
  let addAttempted = false;
  let registered = false;
  let fixture;
  let profile;
  let session;
  const handles = []; // one per sessions[] entry
  let mcpCommand;
  let aborted = false;
  let abortReason;
  const secrets = [];
  const throwaway = makeThrowawayRoot("scout-hl-");
  const keep = { server: (n) => n === name, tool: (t) => t === "Skill" || t === "ToolSearch" || t.startsWith(`mcp__${name}__`), skill: (s) => s === name || s.startsWith("scout-proof-") };
  const reportOpts = { env: o.env, secrets };
  let argv = [];
  let cliVersion;

  let wakeAbort;
  const abortP = new Promise((r) => (wakeAbort = r));
  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    const r = deps.abortSignal?.reason;
    abortReason = typeof r === "string" && /^[A-Za-z]{1,32}$/.test(r) ? r : "signal";
    session?.terminate();
    wakeAbort();
  };
  if (deps.abortSignal?.aborted) onAbort();
  else deps.abortSignal?.addEventListener("abort", onAbort, { once: true });
  const checkAbort = () => {
    if (aborted) throw new Aborted();
  };

  // Close session i once; close() is idempotent too, so a restart and cleanup can both ask.
  // A close that throws is recorded as unknown, never as zero processes left.
  const closeSession = async (i) => {
    if (sessions[i].close) return;
    sessions[i].close = await handles[i].close().catch((e) => ({ closeFailed: true, error: e?.code ?? e?.name ?? "unknown", processesRemaining: null }));
  };

  const turnOn = async (s, purpose, text) => {
    checkAbort();
    if (inference.length >= o.maxInference) {
      failures.push(`budget_exhausted_before_${purpose}`);
      return undefined;
    }
    inference.push({ n: inference.length + 1, session: sessions.length, purpose, at: new Date().toISOString() });
    const raw = await s.send(text, { timeoutMs: turnTimeoutMs });
    s.pollTree();
    const a = analyzeTurn(raw, { name, readTool, proofPhrase: fixture.proofPhrase, opts: reportOpts });
    turns.push({ purpose, session: sessions.length, ...a });
    await deps.hooks?.afterTurn?.(turns.length, { name, skill, raw });
    checkAbort();
    return { raw, a };
  };

  const main = async () => {
    const f = await startSkillFixture(throwaway.root);
    if (cleanupP) await f.close(); // cleanup already ran without it (abort during start-up)
    fixture = f;
    secrets.push(fixture.token);
    checkAbort();
    await deps.hooks?.onStart?.({ token: fixture.token, name, root: throwaway.root });
    checkAbort();
    profile = createLaunchProfile({
      parentEnv: o.env,
      claudePath: o.claudePath,
      model: CHECK_MODEL,
      jobsRoot: join(throwaway.root, "s"),
      jobId: "session",
      workspaceRoots: [resolve(REPO_ROOT, "..")],
    });
    const io = { env: profile.env, cwd: profile.cwd, ...(deps.mcpTimeoutMs ? { timeoutMs: deps.mcpTimeoutMs } : {}) };
    const skillsRoot = label === "preliminary" ? join(profile.cwd, ".claude", "skills") : realSkillsRoot;
    mcpCommand = { command: process.execPath, args: [SCOUT_MCP_MAIN, "--socket", fixture.socketPath, "--token-file", fixture.tokenFile] };

    // Preflight first: nothing is registered or launched for inference unless it passes.
    const pf = runProfilePreflight(profile, { parentEnv: o.env, ...(deps.preflightSeams ?? {}) });
    preflight = {
      verdict: pf.verdict,
      reasons: pf.reasons,
      envFiltering: { profile: profile.id, forwardedKeys: [...profile.forwardedKeys], droppedKeyCount: profile.droppedKeys.length },
      cwd: "throwaway dir under the system temp dir, outside the workspace",
    };
    cliVersion = pf.cli?.version;
    checkAbort();
    if (pf.verdict !== "subscription") {
      outcome = "preflight_failed";
      failures.push("preflight");
      return;
    }

    // Collisions: refuse rather than touch anything that already exists.
    if (label === "acceptance" && !pathExists(skillsRoot)) {
      failures.push("skills_root_missing_not_created");
      return;
    }
    if (pathExists(join(skillsRoot, name))) {
      failures.push("skill_dir_exists");
      return;
    }
    if (label === "acceptance") {
      const before = mcpGet(o.claudePath, name, io);
      if (before.exists !== false) {
        failures.push(before.exists === "unknown" ? "registration_state_unknown" : "registration_exists");
        if (before.exit) registration.getBefore = before.exit;
        return;
      }
      checkAbort();
      addAttempted = true; // from here on, cleanup checks for our entry whatever `add` reports
      const add = mcpAddUser(o.claudePath, name, mcpCommand.command, mcpCommand.args, io);
      registration.add = add;
      registered = add.ok;
      const got = mcpGet(o.claudePath, name, io);
      registration.get = got.exists === "unknown" ? { exists: "unknown", exit: got.exit } : { exists: got.exists, scope: got.scope, health: got.health, type: got.type, command: got.command, args: got.args };
      registration.ownedAfterAdd = ownsRegistration(got, mcpCommand);
      checkAbort();
      if (!registered || !registration.ownedAfterAdd) {
        failures.push("registration_failed");
        return;
      }
    } else {
      mkdirSync(skillsRoot, { recursive: true, mode: 0o700 }); // the watched parent, before the session
      const file = join(throwaway.root, "mcp.json");
      writeFileSync(file, JSON.stringify({ mcpServers: { [name]: { type: "stdio", ...mcpCommand } } }), { mode: 0o600 });
      registration.mcpConfigFile = file;
    }

    argv = sessionArgs({ model: CHECK_MODEL, name, preliminary: label === "preliminary", mcpConfigFile: registration.mcpConfigFile });
    const open = () => {
      checkAbort();
      const s = startSession({ claudePath: o.claudePath, args: argv, cwd: profile.cwd, env: profile.env, ...(deps.killGraceMs ? { killGraceMs: deps.killGraceMs } : {}) });
      sessions.push({ n: sessions.length + 1, startedAt: new Date().toISOString() });
      handles.push(s);
      return s;
    };
    const restart = async () => {
      await closeSession(handles.length - 1);
      checkAbort();
      session = open();
    };
    const initOf = (s) => summarizeInit(s.events.find((e) => e.type === "system" && e.subtype === "init"), keep);

    session = open();
    const t1 = await turnOn(session, "list_skills", PROMPTS.list());
    initSummary = initOf(session);
    if (cliVersion && initSummary.cliVersion && cliVersion !== initSummary.cliVersion) failures.push("cli_version_changed");
    if (!t1?.a.completed) {
      failures.push("turn1_incomplete");
      return;
    }
    const mcp = proofServerState(initSummary, { name, readTool });
    registration.loadedAtStart = mcp.status;
    mcpStatusAtInit = mcp.atInit;
    if (!mcp.proceed) {
      outcome = "mcp_not_loaded";
      if (o.twoSession) {
        await restart();
        const r = await turnOn(session, "list_skills_after_restart", PROMPTS.list());
        if (!r?.a.completed) {
          afterRestart = "incomplete";
          failures.push("restart_turn_incomplete");
          return;
        }
        const again = proofServerState(initOf(session), { name, readTool });
        afterRestart = again.status === "connected" ? "mcp_connected" : `mcp_${again.status}`;
        if (again.status === "connected") outcome = "mcp_requires_restart";
      }
      return;
    }
    // Connected or still pending: go on. No polling and no extra wait; turn 2 decides.
    mcpToolsDeferred = mcp.status === "connected" ? !mcp.toolsListed : undefined;
    if (!initSummary.tools.includes("Skill")) {
      failures.push("skill_tool_missing");
      return;
    }

    // The proof skill, after the session is open.
    const text = renderSkillWrapper({
      resource: { resourceId: fixture.resourceId, kind: "skill" },
      version: fixture.version,
      publisherOrigin: fixture.publisherOrigin,
      serverName: name,
      name,
      siteDescription: "Synthetic Scout compatibility check resource.",
    });
    checkAbort();
    skill = { ...writeProofSkill(skillsRoot, name, text), writtenAt: new Date().toISOString(), afterTurn: 1 };
    await new Promise((r) => setTimeout(r, settleMs));

    const t2 = await turnOn(session, "use_skill", PROMPTS.use());
    if (!t2?.a.completed) {
      outcome = "aborted";
      failures.push("turn2_incomplete");
      return;
    }
    outcome = classifyUse(t2.a);
    if (!mcp.usable && t2.a.readCalled && !t2.a.readSucceeded && NOT_LOADED_READ_ERRORS.includes(t2.a.readError)) outcome = "mcp_not_loaded";
    if (outcome === "skill_not_invoked" && o.twoSession) {
      await restart();
      const t3 = await turnOn(session, "use_skill_after_restart", PROMPTS.use());
      if (!t3?.a.completed) {
        afterRestart = "incomplete";
        failures.push("restart_turn_incomplete");
      } else {
        afterRestart = classifyUse(t3.a);
        const works = t3.a.skillInvoked && t3.a.readSucceeded && t3.a.proofPhraseQuoted;
        outcome = works ? "hotload_requires_reload" : "skill_never_loads";
      }
    }

    if (o.withRevocation && (outcome === "hotload_pass" || outcome === "hotload_requires_reload")) {
      fixture.revoke();
      const removed = removeOwnedSkill(skill.dir, skill.hash);
      skill.removedAtRevocation = removed;
      const r = await turnOn(session, "read_after_revocation", PROMPTS.revoke(readTool, fixture.resourceId));
      revocation = !r ? "not_run" : r.a.readRevoked ? "refused" : r.a.readSucceeded ? "served" : r.a.readCalled ? "failed_other" : "not_attempted";
      if (revocation !== "refused") failures.push(`revocation_${revocation}`);
    }
  };

  // Runs once, after main() finished or an abort woke us (whichever is first).
  let cleanupP;
  const cleanupOnce = () =>
    (cleanupP ??= (async () => {
      // Always: session, skill dir, registration, fixture, throwaway dir.
      for (let i = 0; i < handles.length; i++) await closeSession(i);
      cleanup.skillDir = skill ? removeOwnedSkill(skill.dir, skill.hash) : "not_created";
      if (skill?.removedAtRevocation === "removed" && cleanup.skillDir === "absent") cleanup.skillDir = "removed_at_revocation";
      if (label === "acceptance" && addAttempted) {
        // Whatever `add` reported: it may have written the entry and then failed or timed out.
        const rm = removeOwnedRegistration(o.claudePath, name, mcpCommand, { env: profile.env, cwd: profile.cwd, ...(deps.mcpTimeoutMs ? { timeoutMs: deps.mcpTimeoutMs } : {}) });
        cleanup.registration = rm.state === "absent" && !registered ? "not_registered" : rm.state;
        if (rm.exit) cleanup.registrationExit = rm.exit;
      } else cleanup.registration = label === "acceptance" ? "not_registered" : "none (mcp-config file)";
      const counts = sessions.map((s) => s.close?.processesRemaining);
      const proc = counts.some((c) => typeof c !== "number") ? null : counts.reduce((a, b) => a + b, 0);
      if (fixture) {
        for (let i = 0; i < 20 && fixture.openConnections() > 0; i++) await new Promise((r) => setTimeout(r, 50));
        cleanup.fixtureConnectionsAtEnd = fixture.openConnections();
        await fixture.close();
      }
      try {
        profile?.cleanup();
      } catch {
        // reported below
      }
      throwaway.remove();
      cleanup.processesRemaining = proc;
      cleanup.throwawayRemoved = !pathExists(throwaway.root);
      cleanup.ok =
        ["removed", "removed_at_revocation", "not_created"].includes(cleanup.skillDir) &&
        ["removed", "not_registered", "none (mcp-config file)"].includes(cleanup.registration) &&
        proc === 0 &&
        cleanup.throwawayRemoved;
      if (!cleanup.ok) failures.push("cleanup_incomplete");
    })());

  const mainP = main().catch((e) => {
    if (!(e instanceof Aborted) && !aborted) failures.push(`error_${e?.code ?? e?.name ?? "unknown"}`);
  });
  await Promise.race([mainP, abortP]);
  // An abort stopped the session; give the in-flight step a moment to notice before cleaning up.
  if (aborted) await Promise.race([mainP, new Promise((r) => setTimeout(r, ABORT_SETTLE_MS))]);
  await cleanupOnce();
  deps.abortSignal?.removeEventListener("abort", onAbort);
  if (aborted) {
    outcome = "aborted";
    failures.push(`aborted_${abortReason}`);
  }

  const t2 = turns.find((t) => t.purpose === "use_skill");
  const toolSearchUses = turns.reduce((n, t) => n + t.toolSearchUses, 0);
  // `pass`: this check succeeded. `gatePass`: it also counts for the Phase 1 gate (acceptance mode only).
  const pass = outcome === "hotload_pass" && (!o.withRevocation || revocation === "refused") && cleanup.ok && failures.length === 0;
  const report = buildReport("hotload", {
    label,
    gate: label === "acceptance" ? "native hot-load (acceptance)" : "preliminary evidence only; does not pass the gate",
    pass,
    gatePass: pass && label === "acceptance",
    outcome,
    failures,
    startedAt,
    totalMs: Date.now() - t0,
    cli: { path: o.claudePath, version: cliVersion },
    preflight,
    name,
    skillsRoot: label === "preliminary" ? "<throwaway cwd>/.claude/skills" : realSkillsRoot,
    registration,
    mcpStatusAtInit,
    mcpToolsDeferred,
    toolSearch: { offered: !!initSummary?.tools?.includes("ToolSearch"), uses: toolSearchUses },
    discovery: t2?.discovery,
    listedNames: t2?.listedNames,
    invocation: t2 && { skillInvoked: t2.skillInvoked, skillSucceeded: t2.skillSucceeded, readCalled: t2.readCalled, readSucceeded: t2.readSucceeded, readError: t2.readError, proofPhraseQuoted: t2.proofPhraseQuoted },
    argv: [o.claudePath, ...argv],
    sessionLimits,
    init: initSummary,
    skill: skill && { path: join(skill.dir, "SKILL.md"), sha256: skill.hash, writtenAt: skill.writtenAt, writtenAfterTurn: skill.afterTurn, settleMs },
    turns,
    afterRestart,
    revocation,
    inferenceRequests: inference,
    sessions,
    cleanup,
    notes: [...REPORT_NOTES],
  });
  return { code: pass ? 0 : 1, report, secrets };
}

export function refuse(deps, message) {
  deps.err(`verify:agent hotload: ${message}`);
  return { code: 2 };
}
