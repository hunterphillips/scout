// The native skill hot-load check (P1.4). One headless multi-turn `claude -p` stream-json
// process stands in for an already-open interactive session (it is not an interactive
// session; the report says so); a proof skill is added to the skills root after its first
// turn, and the second turn must list it, use it natively (the Skill tool) and read the
// resource through Scout. Inference requests: turn 1 and turn 2, plus one each for
// --with-revocation and --two-session when the budget (--max-inference) allows them. One
// inference request is one turn (one user message); the API calls inside a turn are
// recorded per turn in usage.turns. The default budget is 2; more needs --acknowledge-budget
// (run.mjs), because the plan allows at most two inference requests per authorized check.
//
// Pure turn analysis lives in classify.mjs; the one cleanup in cleanup.mjs.
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
// restart (preflight again first)/revocation -> cleanup -> registry re-check -> report. Cleanup runs exactly once, on every path,
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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../lib/paths.mjs";
import { createLaunchProfile, filterChildEnv, runProfilePreflight } from "../../packages/scout-core/dist/agents/launchProfile.js";
import { renderSkillWrapper } from "../../packages/scout-core/dist/capabilities/wrapper.js";
import { analyzeTurn, classifyTurn2, classifyUse, errorCode, proofServerState } from "./classify.mjs";
import { runCleanup } from "./cleanup.mjs";
import { CHECK_MODEL, makeThrowawayRoot, SCOUT_MCP_MAIN, startSkillFixture } from "./fixtures.mjs";
import { mcpAddUser, mcpGet, ownsRegistration, pathExists, registryNames, removeOwnedRegistration, removeOwnedSkill, userAllowRuleCounts, writeProofSkill } from "./registration.mjs";
import { buildReport, shellish, summarizeInit } from "./report.mjs";
import { startSession } from "./session.mjs";

export { analyzeTurn, classifyTurn2, classifyUse, listedSkillNames, NOT_LOADED_READ_ERRORS, proofServerState, readErrorCode } from "./classify.mjs";

export const HOTLOAD_DEFAULTS = Object.freeze({ settleMs: 3000, turnTimeoutMs: 180_000, registryRecheckMs: 3000 });
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
 *                               server_not_connected, or the skill was invoked and no read
 *                               was made (mcpStatusAtInit holds the init status)
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
  "The user's own allow rules (from --setting-sources user) also apply in the session; userAllowRules counts them (and those naming mcp__ tools) from the user settings file at the start of the run.",
  "Turn records keep no model text: only Scout's names (scout-proof-*, Skill, ToolSearch, the proof server's tools), outcome booleans and fixed codes; other tool uses are counted.",
  "registry compares the user config's mcpServers key names (counted, never named) before `mcp add` and after cleanup; foreignChanged means another writer changed it during the run, reappeared means our entry came back after removal (also re-checked with `mcp get` a few seconds later).",
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
      "  cleanup (also on SIGINT/SIGTERM/SIGHUP; every step runs even if one fails): skill dir removed if unchanged; registration removed if `mcp get` shows our command at user scope (even if `mcp add` failed); session, fixture and throwaway dir removed",
      ...(label === "preliminary" ? [] : ["  registry: user config mcpServers key names counted before `mcp add` and after cleanup (names never kept); `mcp get` again ~3 s after cleanup"]),
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
  let argv = [];
  let registryBefore;
  let userAllowRules;
  let cliVersion;

  let wakeAbort;
  const abortP = new Promise((r) => (wakeAbort = r));
  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    const r = deps.abortSignal?.reason;
    abortReason = typeof r === "string" && /^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(r) ? r : "signal";
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
    sessions[i].close = await handles[i].close().catch((e) => ({ closeFailed: true, error: errorCode(e), processesRemaining: null }));
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
    const a = analyzeTurn(raw, { name, readTool, proofPhrase: fixture.proofPhrase });
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
    userAllowRules = userAllowRuleCounts(profile.env);
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
      // Key names only, read-only, so the end of the run can tell whether another writer
      // changed the registry underneath us. A 0600 copy of the names stays in the throwaway dir.
      registryBefore = registryNames(profile.env);
      if (registryBefore) writeFileSync(join(throwaway.root, "registry-names-before.json"), JSON.stringify(registryBefore), { mode: 0o600, flag: "wx" });
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
    // A fresh session only after the preflight passes again for the same env, cwd and binary.
    const restart = async () => {
      await closeSession(handles.length - 1);
      checkAbort();
      const again = runProfilePreflight(profile, { parentEnv: o.env, ...(deps.preflightSeams ?? {}) });
      preflight.beforeRestart = { verdict: again.verdict, reasons: again.reasons };
      checkAbort();
      if (again.verdict !== "subscription") {
        failures.push("preflight_failed_before_restart");
        afterRestart = "preflight_failed";
        return false;
      }
      session = open();
      return true;
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
      if (o.twoSession && (await restart())) {
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
    outcome = classifyTurn2(t2.a, mcp);
    if (outcome === "skill_not_invoked" && o.twoSession && (await restart())) {
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
  const mcpOpts = () => ({ env: profile.env, cwd: profile.cwd, ...(deps.mcpTimeoutMs ? { timeoutMs: deps.mcpTimeoutMs } : {}) });
  let cleanupP;
  const cleanupOnce = () =>
    (cleanupP ??= runCleanup({
      // Getters: each step sees the run's state as it is when that step runs.
      label,
      sessions,
      closeSession,
      get skill() {
        return skill;
      },
      get addAttempted() {
        return addAttempted;
      },
      get registered() {
        return registered;
      },
      removeRegistration: () => removeOwnedRegistration(o.claudePath, name, mcpCommand, mcpOpts()),
      get fixture() {
        return fixture;
      },
      get profile() {
        return profile;
      },
      throwaway,
      cleanup,
      failures,
    }));

  const mainP = main().catch((e) => {
    if (!(e instanceof Aborted) && !aborted) failures.push(errorCode(e));
  });
  await Promise.race([mainP, abortP]);
  // An abort stopped the session; give the in-flight step a moment to notice before cleaning up.
  if (aborted) await Promise.race([mainP, new Promise((r) => setTimeout(r, ABORT_SETTLE_MS))]);
  try {
    await cleanupOnce();
  } catch (e) {
    // runCleanup records each step's own error; this is a last resort so the report is written.
    cleanup.ok = false;
    failures.push(`cleanup_${errorCode(e)}`);
  }
  await deps.hooks?.afterCleanup?.({ name });

  // Did the registry change underneath us, and did our entry come back after removal?
  let registry;
  if (label === "acceptance" && addAttempted) {
    const after = registryNames(profile.env);
    const others = (names) => names?.filter((n) => n !== name) ?? [];
    const removedClean = ["removed", "not_registered"].includes(cleanup.registration);
    let recheck = "not_run";
    if (removedClean) {
      await new Promise((r) => setTimeout(r, deps.registryRecheckMs ?? HOTLOAD_DEFAULTS.registryRecheckMs));
      const got = mcpGet(o.claudePath, name, { env: profile.env, cwd: tmpdir(), ...(deps.mcpTimeoutMs ? { timeoutMs: deps.mcpTimeoutMs } : {}) });
      recheck = got.exists === true ? "present" : got.exists === false ? "absent" : "unknown";
    }
    registry = {
      before: registryBefore ? registryBefore.length : null,
      after: after ? after.length : null,
      reappeared: removedClean && (!!after?.includes(name) || recheck === "present"),
      foreignChanged: registryBefore && after ? JSON.stringify(others(registryBefore)) !== JSON.stringify(others(after)) : null,
      recheck,
    };
    if (registry.reappeared) failures.push("registration_reappeared");
  }
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
    registry,
    userAllowRules,
    notes: [...REPORT_NOTES],
  });
  return { code: pass ? 0 : 1, report, secrets };
}

export function refuse(deps, message) {
  deps.err(`verify:agent hotload: ${message}`);
  return { code: 2 };
}
