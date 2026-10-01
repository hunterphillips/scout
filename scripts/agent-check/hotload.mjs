// The native skill hot-load check (P1.4). One headless multi-turn Claude session stands in
// for an already-open chat; a proof skill is added to the skills root after its first turn,
// and the second turn must use it natively (the Skill tool) and read the resource through
// Scout. Inference requests: turn 1 and turn 2, plus one each for --with-revocation and
// --two-session when the budget (--max-inference) allows them.
//
// Acceptance mode (--authorize-real-root) uses the real user skills root
// (`$CLAUDE_CONFIG_DIR/skills`, else `~/.claude/skills`) and a user-scope MCP registration,
// both named `scout-proof-<nonce>`. Preliminary mode (--preliminary) changes nothing outside
// a throwaway dir: the skill goes in the session cwd's project skills dir and the server
// comes from --mcp-config; its report is labeled preliminary and cannot pass the gate.
// Without either flag a real run exits 2: the gate stays unverified.
//
// Order: preflight for the exact env/cwd/binary of the session -> register -> start the
// session (the skills root already exists) -> turn 1 -> write the skill -> turn 2 -> optional
// restart/revocation -> cleanup (always, in finally) -> report.
//
// Session flags, verified in `claude --help` 2.1.286 unless noted:
//   --model <m> -p --input-format stream-json --output-format stream-json --verbose
//   --permission-mode dontAsk --allowedTools <Skill + the proof server's two tools>
//   --tools Skill                 built-ins limited to Skill ("Skill" is in the binary's
//                                 built-in tool list; that --tools keeps it is checked in
//                                 the init event, not assumed)
//   --settings {"disableAllHooks":true}   the user's hooks do not run in the check
//   --no-session-persistence
//   --setting-sources user        (preliminary: user,project) so the user-scope
//                                 registration and user skills root apply
// Never --strict-mcp-config: the user-scope registration must load.

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
const NONCE_RE = /^[a-z0-9]{10}$/;

export const PROMPTS = Object.freeze({
  list: () =>
    'Scout compatibility check, step 1. Without using any tools, reply in one line with the names of the skills available to you right now whose names start with "scout-proof-", or "Skills: none" if there are none.',
  use: (name) =>
    `Scout compatibility check, step 2. Use the skill named ${name} with the Skill tool and follow its instructions to read the resource it points to. Then reply with only the line from that resource that starts with "Proof phrase:". If you cannot use the skill or read the resource, say so in one line.`,
  revoke: (tool, resourceId) =>
    `Scout compatibility check, revocation step. Call the tool ${tool} directly with resourceId ${resourceId} and reply in one line with what Scout returned. Do not repeat anything from earlier answers.`,
});

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

export function sessionArgs({ model, name, preliminary, mcpConfigFile }) {
  const allowed = ["Skill", `mcp__${name}__read_resource`, `mcp__${name}__list_resources`].join(",");
  return [
    "--model", model,
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "dontAsk",
    "--allowedTools", allowed,
    "--tools", "Skill",
    "--settings", JSON.stringify({ disableAllHooks: true }),
    "--no-session-persistence",
    "--setting-sources", preliminary ? "user,project" : "user",
    ...(preliminary ? ["--mcp-config", mcpConfigFile] : []),
  ];
}

/** What one turn shows: Scout tool uses (others counted), errors, the proof phrase, usage. */
export function analyzeTurn(turn, { name, readTool, proofPhrase, opts }) {
  const uses = [];
  const results = new Map();
  for (const ev of turn.events) {
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (ev.type === "assistant" && b?.type === "tool_use") uses.push({ id: b.id, name: b.name, skill: b.input?.skill });
      if (ev.type === "user" && b?.type === "tool_result") {
        const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c) => c?.text ?? "").join("\n") : "";
        results.set(b.tool_use_id, { isError: b.is_error === true, text });
      }
    }
  }
  const label = (u) => (u.name === "Skill" ? `Skill(${u.skill === name ? name : "other"})` : u.name === readTool || u.name === `mcp__${name}__list_resources` ? u.name : "other");
  const skillUses = uses.filter((u) => u.name === "Skill" && u.skill === name);
  const reads = uses.filter((u) => u.name === readTool);
  const finalText = typeof turn.result?.result === "string" ? turn.result.result : "";
  return {
    ms: turn.ms,
    completed: !!turn.result && !turn.timedOut,
    timedOut: turn.timedOut,
    sessionExited: turn.exited,
    resultSubtype: turn.result?.subtype,
    resultIsError: turn.result?.is_error === true,
    toolUses: uses.map((u) => ({ name: label(u), error: results.get(u.id)?.isError ?? null })),
    skillInvoked: skillUses.length > 0,
    skillSucceeded: skillUses.some((u) => results.get(u.id) && !results.get(u.id).isError),
    readCalled: reads.length > 0,
    readSucceeded: reads.some((u) => results.get(u.id) && !results.get(u.id).isError),
    readRevoked: reads.some((u) => results.get(u.id)?.isError && /\brevoked\b/.test(results.get(u.id).text)),
    proofPhraseQuoted: finalText.includes(proofPhrase),
    text: evidenceText(finalText.split(proofPhrase).join("<proof phrase>"), opts),
    usage: usageOf(turn.result),
  };
}

/**
 * @param {object} o  parsed options: home, env, claudePath, authorizeRealRoot, preliminary,
 *   maxInference, withRevocation, twoSession, dryRun
 * @param {object} deps  out, err, and test seams: nonce, settleMs, turnTimeoutMs,
 *   preflightSeams, killGraceMs, hooks.{onStart, afterTurn}
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

  if (o.dryRun) {
    const skillsRoot = label === "preliminary" ? "<throwaway cwd>/.claude/skills" : realSkillsRoot;
    const lines = [
      "verify:agent hotload --dry-run: nothing is created, registered or launched.",
      `  mode: ${label ?? "not authorized (a real run exits 2; the gate stays unverified)"}`,
      `  claude: ${o.claudePath}`,
      `  model: ${CHECK_MODEL}`,
      `  proof name (MCP registration and skill dir): ${name}`,
      `  skills root: ${skillsRoot}${label === "preliminary" ? "" : ` (exists: ${pathExists(realSkillsRoot) ? "yes" : "no"})`}`,
      `  proof skill: ${join(skillsRoot, name, "SKILL.md")} (written after turn 1)`,
      label === "preliminary"
        ? `  MCP server: --mcp-config <throwaway>/mcp.json -> ${process.execPath} ${SCOUT_MCP_MAIN} --socket <throwaway>/a.sock --token-file <throwaway>/agent-token`
        : `  register: ${o.claudePath} mcp add --scope user ${name} -- ${process.execPath} ${SCOUT_MCP_MAIN} --socket <throwaway>/a.sock --token-file <throwaway>/agent-token`,
      `  preflight: billing preflight for the session's exact env, cwd (<throwaway>/s/session) and binary`,
      `  session: ${o.claudePath} ${sessionArgs({ model: CHECK_MODEL, name, preliminary: label === "preliminary", mcpConfigFile: "<throwaway>/mcp.json" }).map(shellish).join(" ")}`,
      `  inference requests: at most ${Math.min(o.maxInference, 4)} (turn 1 list skills; turn 2 use the skill${o.twoSession ? "; restart if turn 2 fails" : ""}${o.withRevocation ? "; read after revocation" : ""})`,
      "  cleanup: skill dir removed if unchanged; registration removed if `mcp get` still shows our command; session, fixture and throwaway dir removed",
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
  let revocation = "not_requested";
  let afterRestart = "not_run";
  let skill;
  let registered = false;
  let fixture;
  let profile;
  let session;
  let mcpCommand;
  const secrets = [];
  const throwaway = makeThrowawayRoot("scout-hl-");
  const keep = { server: (n) => n === name, tool: (t) => t === "Skill" || t.startsWith(`mcp__${name}__`), skill: (s) => s === name || s.startsWith("scout-proof-") };
  const reportOpts = { env: o.env, secrets };
  let argv = [];
  let cliVersion;

  const turnOn = async (s, purpose, text) => {
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
    return { raw, a };
  };

  const main = async () => {
    fixture = await startSkillFixture(throwaway.root);
    secrets.push(fixture.token);
    await deps.hooks?.onStart?.({ token: fixture.token, name, root: throwaway.root });
    profile = createLaunchProfile({
      parentEnv: o.env,
      claudePath: o.claudePath,
      model: CHECK_MODEL,
      jobsRoot: join(throwaway.root, "s"),
      jobId: "session",
      workspaceRoots: [resolve(REPO_ROOT, "..")],
    });
    const io = { env: profile.env, cwd: profile.cwd };
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
        failures.push("registration_exists");
        return;
      }
      registered = mcpAddUser(o.claudePath, name, mcpCommand.command, mcpCommand.args, io);
      const got = mcpGet(o.claudePath, name, io);
      registration.get = { scope: got.scope, health: got.health, type: got.type, command: got.command, args: got.args };
      registration.ownedAfterAdd = ownsRegistration(got, mcpCommand);
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
      const s = startSession({ claudePath: o.claudePath, args: argv, cwd: profile.cwd, env: profile.env, ...(deps.killGraceMs ? { killGraceMs: deps.killGraceMs } : {}) });
      sessions.push({ n: sessions.length + 1, startedAt: new Date().toISOString() });
      return s;
    };

    session = open();
    const t1 = await turnOn(session, "list_skills", PROMPTS.list());
    const init = session.events.find((e) => e.type === "system" && e.subtype === "init");
    initSummary = summarizeInit(init, keep);
    if (cliVersion && initSummary.cliVersion && cliVersion !== initSummary.cliVersion) failures.push("cli_version_changed");
    if (!t1?.a.completed) {
      failures.push("turn1_incomplete");
      return;
    }
    const server = initSummary.mcpServers.find((s) => s.name === name);
    registration.loadedAtStart = server?.status ?? "absent";
    if (server?.status !== "connected" || !initSummary.tools.includes(readTool)) {
      outcome = "mcp_requires_restart";
      return;
    }
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
    skill = { ...writeProofSkill(skillsRoot, name, text), writtenAt: new Date().toISOString(), afterTurn: 1 };
    await new Promise((r) => setTimeout(r, settleMs));

    const t2 = await turnOn(session, "use_skill", PROMPTS.use(name));
    const used = (a) => a.skillSucceeded && a.readSucceeded && a.proofPhraseQuoted;
    let active = session;
    if (t2 && used(t2.a)) {
      outcome = "hotload_pass";
    } else {
      outcome = t2?.a.completed ? "hotload_requires_reload" : "aborted";
      if (!t2?.a.completed) failures.push("turn2_incomplete");
      if (o.twoSession && t2?.a.completed) {
        sessions.at(-1).close = await session.close();
        session = open();
        active = session;
        const t3 = await turnOn(session, "use_skill_after_restart", PROMPTS.use(name));
        afterRestart = t3 ? (used(t3.a) ? "works" : "fails") : "not_run";
      }
    }

    if (o.withRevocation && (outcome === "hotload_pass" || afterRestart === "works")) {
      fixture.revoke();
      const removed = removeOwnedSkill(skill.dir, skill.hash);
      skill.removedAtRevocation = removed;
      const r = await turnOn(active, "read_after_revocation", PROMPTS.revoke(readTool, fixture.resourceId));
      revocation = !r ? "not_run" : r.a.readRevoked ? "refused" : r.a.readSucceeded ? "served" : r.a.readCalled ? "failed_other" : "not_attempted";
      if (revocation !== "refused") failures.push(`revocation_${revocation}`);
    }
  };

  try {
    await main();
  } catch (e) {
    failures.push(`error_${e?.code ?? e?.name ?? "unknown"}`);
  } finally {
    // Always: session, skill dir, registration, fixture, throwaway dir.
    if (session) sessions.at(-1).close = await session.close().catch(() => ({ closeFailed: true }));
    cleanup.skillDir = skill ? removeOwnedSkill(skill.dir, skill.hash) : "not_created";
    if (skill?.removedAtRevocation === "removed" && cleanup.skillDir === "absent") cleanup.skillDir = "removed_at_revocation";
    if (label === "acceptance" && registered) {
      cleanup.registration = removeOwnedRegistration(o.claudePath, name, mcpCommand, { env: profile.env, cwd: profile.cwd });
    } else cleanup.registration = label === "acceptance" ? "not_registered" : "none (mcp-config file)";
    const proc = sessions.map((s) => s.close?.processesRemaining ?? 0).reduce((a, b) => a + b, 0);
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
  }

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
    argv: [o.claudePath, ...argv],
    init: initSummary,
    skill: skill && { path: join(skill.dir, "SKILL.md"), sha256: skill.hash, writtenAt: skill.writtenAt, writtenAfterTurn: skill.afterTurn, settleMs },
    turns,
    afterRestart,
    revocation,
    inferenceRequests: inference,
    sessions,
    cleanup,
    notes: [
      "Old conversation text remains in a session after revocation; the check shows only that Scout refuses later reads.",
      "One-time MCP registration (registration.loadedAtStart) is recorded separately from per-resource skill hot-load (outcome).",
    ],
  });
  return { code: pass ? 0 : 1, report, secrets };
}

export function refuse(deps, message) {
  deps.err(`verify:agent hotload: ${message}`);
  return { code: 2 };
}
