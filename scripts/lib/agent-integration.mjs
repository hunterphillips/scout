// The opt-in agent integration (setup --agent-integration), for each agent Scout supports:
//   Claude Code  one user-scope `scout` MCP registration through `claude mcp add`
//                (lib/claude-mcp.mjs) and the static `scout-integration` skill under the Claude
//                Code skills root, recorded in installed.json together with `skillsRoot`.
//   Codex        one `scout` entry in the user's Codex config through `codex mcp add`
//                (lib/codex-mcp.mjs) and the same skill under `<Codex home>/skills`, recorded
//                with `agent: "codex"` and the Codex home. Scout's app exports no skill
//                wrappers for Codex, so `skillsRoot` stays Claude Code's.
// Each agent's two entries are recorded once (lib/installed.mjs agentOf). Plan, apply, remove
// and inspect live here so setup, uninstall and doctor share one notion of "ours".
//
// Ours means: the registration `get` shows exactly the recorded command at user scope; the
// skill dir holds exactly SKILL.md hashing to the recorded value (or to the current template,
// for a re-run). Anything else named `scout` / `scout-integration` is refused at setup and
// left in place at uninstall. A `get` that cannot tell is never read as absent.
//
// The registered command is `<nodePath> <scoutRoot>/packages/scout-mcp/dist/main.js` with no
// args (the adapter defaults to ~/.scout/run). `get` joins args by spaces, so paths with
// whitespace are refused. When the Scout home is not the real ~/.scout (a test install),
// SCOUT_CLAUDE_BIN and SCOUT_SKILLS_ROOT (Claude Code) or SCOUT_CODEX_BIN and SCOUT_CODEX_HOME
// (Codex) must both be given, so a test can never reach the real agent configuration. On the
// real ~/.scout all four are refused (setup, uninstall and doctor), so a test override can
// never be applied to a real install. `realHome` (tests only) replaces the account home
// isRealScoutHome compares against.
//
// A foreign registration's command and args are never printed: only its scope and a short
// hash of the command text.

import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isExecutableFile, defaultAgentFallbacks, resolveAgentBinary } from "./executables.mjs";
import { mcpAddUser, mcpGet, ownsRegistration, removeOwnedRegistration } from "./claude-mcp.mjs";
import { piMcpAdd, piMcpGet, ownsPiRegistration, removeOwnedPiRegistration } from "./pi-mcp.mjs";
import { codexMcpAdd, codexMcpGet, ownsCodexRegistration, removeOwnedCodexRegistration } from "./codex-mcp.mjs";
import { AGENT_IDS, INTEGRATION_SERVER_NAME, agentOf, allowedPath, integrationSkillPath, parseRegistrationCommand, upsertEntry } from "./installed.mjs";
import { checkSkillsRoot, countRuntimeWrappers, inspectSkill, readExportsManifest, removeSkill, skillDir, skillTemplate, writeSkill } from "./integration-skill.mjs";
import { codexHomeFor, piAgentDirFor, isRealScoutHome, skillsRootFor } from "./paths.mjs";
import { exists } from "./files.mjs";

export const INTEGRATION_KINDS = ["mcp-registration", "skill"];
export const isIntegrationEntry = (f) => INTEGRATION_KINDS.includes(f?.kind);

/** The agents setup knows: the CLI it runs and the test override naming that CLI. */
export const AGENTS = Object.freeze({
  "claude-code": Object.freeze({ id: "claude-code", label: "Claude Code", bin: "claude", binEnv: "SCOUT_CLAUDE_BIN" }),
  codex: Object.freeze({ id: "codex", label: "Codex", bin: "codex", binEnv: "SCOUT_CODEX_BIN" }),
  pi: Object.freeze({ id: "pi", label: "Pi", bin: "pi", binEnv: "SCOUT_PI_BIN" }),
});
export { AGENT_IDS };

/** Env overrides for test installs only: refused with the real ~/.scout. */
export const TEST_OVERRIDES = ["SCOUT_SKILLS_ROOT", "SCOUT_CLAUDE_BIN", "SCOUT_CODEX_BIN", "SCOUT_CODEX_HOME", "SCOUT_PI_BIN", "SCOUT_PI_AGENT_DIR"];

/** Lines setup prints so the user knows what the connection reaches. */
export function integrationExplanation(agent = "claude-code") {
  const label = AGENTS[agent].label;
  return [
    agent === "pi" ? "The `scout` MCP connection is registered in your Pi agent directory: it is available in all your Pi sessions." : agent === "codex"
      ? "The `scout` MCP connection is registered in your Codex configuration: it is available in all of your Codex sessions, in every project."
      : "The `scout` MCP connection is registered at user scope: it is available in all of your Claude Code sessions, in every project.",
    "It exposes only the website files you approved for your agent in Scout (llms.txt, AGENTS.md, skills), read on demand.",
    "Browser context (the current site and the pages you read recently on allowed sites) is a separate opt-in, off by default: turn it on in the Scout side panel's Settings (\"Let your agent see the current site and pages you read on allowed sites\").",
    "With Scout quit, the connection stays registered and its tools answer that Scout is not running.",
    `Start a new ${label} session to load it: running sessions do not reload MCP servers or skills.`,
    "Remove it with `npm run uninstall -- --agent-integration`.",
  ];
}

/** Said wherever `claude mcp get` runs (setup dry run, uninstall dry run, doctor). */
export const GET_NOTE = `\`claude mcp get ${INTEGRATION_SERVER_NAME}\` runs read-only; the Claude CLI health-checks (starts) whatever is registered under that name`;

/** The refusal when test overrides are set on the real ~/.scout, or null. */
export function overrideRefusal(env, realHome) {
  if (!isRealScoutHome(env, realHome)) return null;
  const set = TEST_OVERRIDES.filter((k) => env[k]);
  return set.length ? `${set.join(" and ")} ${set.length > 1 ? "are" : "is"} for test installs only and refused with the real ~/.scout; unset ${set.length > 1 ? "them" : "it"} and re-run` : null;
}

/** A foreign registration, described without its command or args. */
function describeForeign(get) {
  const digest = createHash("sha256").update(`${get.command ?? ""} ${get.args ?? ""}`, "utf8").digest("hex").slice(0, 12);
  return `scope: ${get.scope ?? "?"}; command differs from this install's (sha256 ${digest})`;
}

/**
 * The agent CLI to run for `agent` ("claude-code" | "codex"), or { error }. Its override
 * (SCOUT_CLAUDE_BIN / SCOUT_CODEX_BIN) wins; otherwise PATH and the usual fallbacks
 * (`fallbacks.claudeFallbacks` / `fallbacks.codexFallbacks` replace them in tests). A test
 * install (Scout home not the real ~/.scout) requires the override; the real ~/.scout refuses
 * every test override.
 */
export function findAgentBinary(agent, env, fallbacks = {}, realHome) {
  const a = AGENTS[agent];
  if (!a) return { error: `unknown agent ${agent}` };
  const refusal = overrideRefusal(env, realHome);
  if (refusal) return { error: refusal };
  const override = env[a.binEnv];
  if (override) {
    return isExecutableFile(override) ? { path: override } : { error: `${a.binEnv} is not an absolute path to an executable: ${override}` };
  }
  if (!isRealScoutHome(env, realHome)) return { error: `the Scout home is not the real ~/.scout, so ${a.binEnv} must name the ${a.bin} to run` };
  const given = agent === "codex" ? fallbacks.codexFallbacks : agent === "pi" ? fallbacks.piFallbacks : fallbacks.claudeFallbacks;
  const path = resolveAgentBinary(a.bin, { pathVar: env.PATH ?? "", fallbacks: given ?? defaultAgentFallbacks(a.bin, env) });
  return path ? { path } : { error: `${a.bin} not found on PATH, ~/.local/bin, or /opt/homebrew/bin` };
}

/** The `claude` to run, or { error } (findAgentBinary for Claude Code). */
export function integrationClaude(env, claudeFallbacks, realHome) {
  return findAgentBinary("claude-code", env, { claudeFallbacks }, realHome);
}

/**
 * The Codex home the Codex integration uses, or { error }: SCOUT_CODEX_HOME on a test home
 * (required there), CODEX_HOME or ~/.codex on the real one (SCOUT_CODEX_HOME refused).
 */
export function integrationCodexHome(env, realHome) {
  const refusal = overrideRefusal(env, realHome);
  if (refusal) return { error: refusal };
  if (!isRealScoutHome(env, realHome) && !env.SCOUT_CODEX_HOME) return { error: "the Scout home is not the real ~/.scout, so SCOUT_CODEX_HOME must name the Codex home" };
  return { path: codexHomeFor(env) };
}

const mcpOpts = (env, timeoutMs) => ({ env, cwd: tmpdir(), ...(timeoutMs ? { timeoutMs } : {}) });
const codexOpts = (env, codexHome, timeoutMs) => ({ env, cwd: tmpdir(), codexHome, ...(timeoutMs ? { timeoutMs } : {}) });
const describeExit = (exit) => (exit ? `exit ${exit.status ?? "none"}${exit.signal ? `, signal ${exit.signal}` : ""}${exit.timedOut ? ", timed out" : ""}` : "");

/** One agent's recorded integration entries: { registration, skill } (either may be undefined). */
export function recordedIntegration(record, agent = "claude-code") {
  const files = (record?.files ?? []).filter((f) => agentOf(f) === agent);
  return { registration: files.find((f) => f.kind === "mcp-registration"), skill: files.find((f) => f.kind === "skill") };
}

/** True when anything of `agent`'s integration is recorded (for Claude Code, a skillsRoot too). */
export function hasRecordedIntegration(record, agent) {
  const { registration, skill } = recordedIntegration(record, agent);
  return !!(registration || skill || (agent === "claude-code" && record?.skillsRoot));
}

/**
 * Work out the integration for `agent` without changing anything; throws a refusal with a
 * reason. Runs the agent CLI's read-only `mcp get scout` (Claude's also health-checks the
 * server it finds). Returns { agent, skillsRoot, expected, commandText, registration, skill,
 * template, warnings, ... } where registration.action is add | keep | replace and skill.action
 * is write | keep.
 */
export function planIntegration({ agent = "claude-code", ...o }) {
  return agent === "pi" ? planPiIntegration(o) : agent === "codex" ? planCodexIntegration(o) : planClaudeIntegration(o);
}

function planClaudeIntegration({ env, L, nodePath, record, claudeFallbacks, mcpTimeoutMs, realHome }) {
  const warnings = [];
  if (!isRealScoutHome(env, realHome) && (!env.SCOUT_SKILLS_ROOT || !env.SCOUT_CLAUDE_BIN)) {
    throw new Error("--agent-integration with a Scout home that is not the real ~/.scout needs both SCOUT_SKILLS_ROOT and SCOUT_CLAUDE_BIN, so a test install cannot touch the real Claude Code configuration");
  }
  const refusal = overrideRefusal(env, realHome);
  if (refusal) throw new Error(`agent integration: ${refusal}`);
  const claude = integrationClaude(env, claudeFallbacks, realHome);
  if (claude.error) throw new Error(`agent integration: ${claude.error}`);

  const commandText = `${nodePath} ${L.mcpMain}`;
  const expected = parseRegistrationCommand(commandText);
  if (!expected) throw new Error(`agent integration: the node path and the scout-mcp entrypoint must be absolute and contain no spaces (claude mcp get joins arguments by spaces): ${commandText}`);
  if (!exists(L.mcpMain)) {
    throw new Error(`agent integration: scout-mcp is not built: ${L.mcpMain} (run \`npm run build\`)`);
  }

  const skillsRoot = skillsRootFor(env);
  if (record?.skillsRoot && record.skillsRoot !== skillsRoot) {
    throw new Error(`agent integration: already installed with skills root ${record.skillsRoot}; run \`npm run uninstall -- --agent-integration\` before using ${skillsRoot}`);
  }
  // The Scout app's runtime wrappers live under the root its exports manifest names; a new
  // root here would point the core at another root while those wrappers stay behind.
  let exported;
  try {
    exported = readExportsManifest(L.exportsManifest);
  } catch (e) {
    throw new Error(`agent integration: cannot tell where the Scout app's skill wrappers are (${e.message}); nothing was changed`);
  }
  if (exported && exported.wrappers > 0 && exported.skillsRoot !== skillsRoot) {
    throw new Error(
      `agent integration: the Scout app has ${exported.wrappers} skill wrapper(s) exported under ${exported.skillsRoot}, not ${skillsRoot}.\n` +
        `Nothing was changed. Revoke those capabilities in Scout (which removes their wrappers), or re-run with the skills root ${exported.skillsRoot}.`,
    );
  }
  const root = checkSkillsRoot(skillsRoot);
  const recorded = recordedIntegration(record);
  const template = skillTemplate();

  // Registration
  const get = mcpGet(claude.path, INTEGRATION_SERVER_NAME, mcpOpts(env, mcpTimeoutMs));
  let registration;
  if (get.exists === "unknown") {
    throw new Error(`agent integration: \`claude mcp get ${INTEGRATION_SERVER_NAME}\` could not tell whether a registration exists (${describeExit(get.exit)}); nothing was changed`);
  } else if (get.exists === false) registration = { action: "add" };
  else if (ownsRegistration(get, expected)) registration = { action: "keep" };
  else {
    const previous = recorded.registration && parseRegistrationCommand(recorded.registration.path);
    if (previous && ownsRegistration(get, previous)) registration = { action: "replace", previous };
    else {
      throw new Error(
        `agent integration: an MCP server named "${INTEGRATION_SERVER_NAME}" is already registered and is not this install's (${describeForeign(get)}).\n` +
          `Nothing was changed. Remove or rename that registration yourself (\`claude mcp remove ${INTEGRATION_SERVER_NAME}\`) and re-run.`,
      );
    }
  }

  // Skill
  const dir = skillDir(skillsRoot);
  const seen = inspectSkill(dir);
  let skill;
  if (seen.state === "absent") skill = { action: "write" };
  else if (seen.state === "file" && seen.sha256 === template.sha256) skill = { action: "keep" };
  else if (recorded.skill && (seen.state === "empty" || (seen.state === "file" && seen.sha256 === recorded.skill.sha256))) skill = { action: "write" };
  else {
    throw new Error(`agent integration: ${dir} exists and is not this install's skill (${seen.state === "file" ? "different content" : seen.state}).\nNothing was changed. Move it aside and re-run.`);
  }
  return { agent: "claude-code", skillsRoot, skillsRootExists: root.exists, claudePath: claude.path, expected, commandText, registration, skill, template, warnings };
}

/** The skill action for a dir, given the recorded skill entry; throws a refusal. */
function skillAction(dir, template, recordedSkill) {
  const seen = inspectSkill(dir);
  if (seen.state === "absent") return { action: "write" };
  if (seen.state === "file" && seen.sha256 === template.sha256) return { action: "keep" };
  if (recordedSkill && (seen.state === "empty" || (seen.state === "file" && seen.sha256 === recordedSkill.sha256))) return { action: "write" };
  throw new Error(`agent integration: ${dir} exists and is not this install's skill (${seen.state === "file" ? "different content" : seen.state}).\nNothing was changed. Move it aside and re-run.`);
}

function planCodexIntegration({ env, L, nodePath, record, codexFallbacks, mcpTimeoutMs, realHome }) {
  const warnings = [];
  if (!isRealScoutHome(env, realHome) && (!env.SCOUT_CODEX_HOME || !env.SCOUT_CODEX_BIN)) {
    throw new Error("--agent-integration for Codex with a Scout home that is not the real ~/.scout needs both SCOUT_CODEX_HOME and SCOUT_CODEX_BIN, so a test install cannot touch the real Codex configuration");
  }
  const refusal = overrideRefusal(env, realHome);
  if (refusal) throw new Error(`agent integration: ${refusal}`);
  const codex = findAgentBinary("codex", env, { codexFallbacks }, realHome);
  if (codex.error) throw new Error(`agent integration: ${codex.error}`);

  const commandText = `${nodePath} ${L.mcpMain}`;
  const expected = parseRegistrationCommand(commandText);
  if (!expected) throw new Error(`agent integration: the node path and the scout-mcp entrypoint must be absolute and contain no spaces (the install record keeps the command on one line): ${commandText}`);
  if (!exists(L.mcpMain)) {
    throw new Error(`agent integration: scout-mcp is not built: ${L.mcpMain} (run \`npm run build\`)`);
  }

  const codexHome = codexHomeFor(env);
  let home;
  try {
    home = lstatSync(codexHome);
  } catch {
    throw new Error(`agent integration: the Codex home ${codexHome} does not exist; run \`codex login\` once, then re-run`);
  }
  if (home.isSymbolicLink() || !home.isDirectory() || home.uid !== process.getuid()) {
    throw new Error(`agent integration: the Codex home ${codexHome} is not a directory owned by you (a symlink is not followed); nothing was changed`);
  }
  const recorded = recordedIntegration(record, "codex");
  if (recorded.registration?.codexHome && recorded.registration.codexHome !== codexHome) {
    throw new Error(`agent integration: already installed for the Codex home ${recorded.registration.codexHome}; run \`npm run uninstall -- --agent-integration\` before using ${codexHome}`);
  }
  const skillsRoot = join(codexHome, "skills");
  const root = checkSkillsRoot(skillsRoot);
  const template = skillTemplate();

  const get = codexMcpGet(codex.path, INTEGRATION_SERVER_NAME, codexOpts(env, codexHome, mcpTimeoutMs));
  let registration;
  if (get.exists === "unknown") {
    throw new Error(`agent integration: \`codex mcp get ${INTEGRATION_SERVER_NAME}\` could not tell whether a server is configured (${describeExit(get.exit)}); nothing was changed`);
  } else if (get.exists === false) registration = { action: "add" };
  else if (ownsCodexRegistration(get, expected)) registration = { action: "keep" };
  else {
    const previous = recorded.registration && parseRegistrationCommand(recorded.registration.path);
    if (previous && ownsCodexRegistration(get, previous)) registration = { action: "replace", previous };
    else {
      throw new Error(
        `agent integration: Codex already has an MCP server named "${INTEGRATION_SERVER_NAME}" that is not this install's (${describeForeignCodex(get)}).\n` +
          `Nothing was changed. Remove or rename it yourself (\`codex mcp remove ${INTEGRATION_SERVER_NAME}\`) and re-run.`,
      );
    }
  }
  const skill = skillAction(skillDir(skillsRoot), template, recorded.skill);
  return { agent: "codex", codexHome, skillsRoot, skillsRootExists: root.exists, codexPath: codex.path, expected, commandText, registration, skill, template, warnings };
}

function integrationPiDir(env, realHome) {
  const refusal = overrideRefusal(env, realHome);
  if (refusal) return { error: refusal };
  if (!isRealScoutHome(env, realHome) && !env.SCOUT_PI_AGENT_DIR) return { error: "the Scout home is not the real ~/.scout, so SCOUT_PI_AGENT_DIR must name the Pi agent directory" };
  return { path: piAgentDirFor(env) };
}

function planPiIntegration({ env, L, nodePath, record, piFallbacks, mcpTimeoutMs, realHome }) {
  if (!isRealScoutHome(env, realHome) && (!env.SCOUT_PI_AGENT_DIR || !env.SCOUT_PI_BIN)) throw new Error("--agent-integration for Pi with a test home needs both SCOUT_PI_AGENT_DIR and SCOUT_PI_BIN");
  const refusal = overrideRefusal(env, realHome);
  if (refusal) throw new Error(`agent integration: ${refusal}`);
  const pi = findAgentBinary("pi", env, { piFallbacks }, realHome);
  if (pi.error) throw new Error(`agent integration: ${pi.error}`);
  const commandText = `${nodePath} ${L.mcpMain}`;
  const expected = parseRegistrationCommand(commandText);
  if (!expected) throw new Error("agent integration: the node path and scout-mcp entrypoint must be absolute and contain no spaces");
  if (!exists(L.mcpMain)) throw new Error(`agent integration: scout-mcp is not built: ${L.mcpMain}`);
  const agentDir = piAgentDirFor(env);
  let home;
  try { home = lstatSync(agentDir); } catch { throw new Error(`agent integration: the Pi agent directory ${agentDir} does not exist`); }
  if (home.isSymbolicLink() || !home.isDirectory() || home.uid !== process.getuid()) throw new Error(`agent integration: the Pi agent directory ${agentDir} is not a real directory owned by you`);
  const recorded = recordedIntegration(record, "pi");
  if (recorded.registration?.agentDir && recorded.registration.agentDir !== agentDir) throw new Error(`agent integration: already installed for Pi at ${recorded.registration.agentDir}`);
  const skillsRoot = join(agentDir, "skills");
  const root = checkSkillsRoot(skillsRoot);
  const template = skillTemplate();
  const get = piMcpGet(agentDir);
  let registration;
  if (get.exists === "unknown") throw new Error("agent integration: Pi mcp.json is unreadable or invalid; nothing was changed");
  if (get.exists === false) registration = { action: "add" };
  else if (ownsPiRegistration(get, expected)) registration = { action: "keep" };
  else {
    const previous = recorded.registration && parseRegistrationCommand(recorded.registration.path);
    if (previous && ownsPiRegistration(get, previous)) registration = { action: "replace", previous };
    else throw new Error("agent integration: Pi already has an MCP server named scout that is foreign; nothing was changed");
  }
  const skill = skillAction(skillDir(skillsRoot), template, recorded.skill);
  return { agent: "pi", agentDir, skillsRoot, skillsRootExists: root.exists, piPath: pi.path, expected, commandText, registration, skill, template, warnings: [] };
}

/** A foreign Codex entry, described without its command or args. */
function describeForeignCodex(get) {
  const digest = createHash("sha256").update(`${get.command ?? ""} ${(get.args ?? []).join(" ")}`, "utf8").digest("hex").slice(0, 12);
  return `command differs from this install's (sha256 ${digest})`;
}

/** Dry-run lines for a plan. */
export function describeIntegration(p) {
  if (p.agent === "pi") return [
    p.skillsRootExists ? `would keep skills root ${p.skillsRoot}` : `would create skills root ${p.skillsRoot} (0700)`,
    p.skill.action === "keep" ? `would keep ${integrationSkillPath(p.skillsRoot)}` : `would write ${integrationSkillPath(p.skillsRoot)} (0600)`,
    p.registration.action === "keep" ? `would keep Pi MCP server "scout"` : `would register with Pi (${p.agentDir}): ${p.piPath} mcp add scout --exposure direct -- ${p.commandText}`,
    "would record the two entries in installed.json",
  ];
  if (p.agent === "codex") {
    const add = `${p.codexPath} mcp add ${INTEGRATION_SERVER_NAME} -- ${p.commandText}`;
    const reg = {
      add: `would register with Codex (${p.codexHome}): ${add}`,
      keep: `would keep the existing Codex MCP server "${INTEGRATION_SERVER_NAME}" (${p.commandText})`,
      replace: `would replace this install's earlier Codex MCP server (${p.registration.previous?.command} ${p.registration.previous?.args.join(" ")}): ${add}`,
    }[p.registration.action];
    const path = integrationSkillPath(p.skillsRoot);
    return [
      p.skillsRootExists ? `would keep skills root ${p.skillsRoot}` : `would create skills root ${p.skillsRoot} (0700)`,
      p.skill.action === "keep" ? `would keep ${path} (already the current skill)` : `would write ${path} (0600) in a 0700 dir`,
      reg,
      "would record the two entries in installed.json",
    ];
  }
  const add = `${p.claudePath} mcp add --scope user ${INTEGRATION_SERVER_NAME} -- ${p.commandText}`;
  const reg = {
    add: `would register: ${add}`,
    keep: `would keep the existing user-scope registration "${INTEGRATION_SERVER_NAME}" (${p.commandText})`,
    replace: `would replace this install's earlier registration (${p.registration.previous?.command} ${p.registration.previous?.args.join(" ")}): ${add}`,
  }[p.registration.action];
  const path = integrationSkillPath(p.skillsRoot);
  return [
    p.skillsRootExists ? `would keep skills root ${p.skillsRoot}` : `would create skills root ${p.skillsRoot} (0700)`,
    p.skill.action === "keep" ? `would keep ${path} (already the current skill)` : `would write ${path} (0600) in a 0700 dir`,
    GET_NOTE,
    reg,
    `would record skillsRoot=${p.skillsRoot} and the two entries in installed.json`,
  ];
}

/**
 * Apply a plan. `save(record)` persists the record; it is called before each outward change
 * so a crash leaves a record that uninstall can act on. Returns the new record; throws on
 * failure with the record already saved.
 */
export function applyIntegration(p, record, o) {
  return p.agent === "pi" ? applyPiIntegration(p, record, o) : p.agent === "codex" ? applyCodexIntegration(p, record, o) : applyClaudeIntegration(p, record, o);
}

function reportKeptSkill(path, out) {
  let m = null;
  try {
    m = (lstatSync(path).mode & 0o777).toString(8).padStart(4, "0");
  } catch {
    // reported without a mode
  }
  out(`kept  ${path}${m ? ` (${m})` : ""}`);
}

function applyPiIntegration(p, record, { env, save, out, mcpTimeoutMs }) {
  const opts = { env, cwd: tmpdir(), agentDir: p.agentDir, ...(mcpTimeoutMs ? { timeoutMs: mcpTimeoutMs } : {}) };
  const path = integrationSkillPath(p.skillsRoot);
  record = upsertEntry(record, { path, kind: "skill", agent: "pi", sha256: p.template.sha256 });
  save(record);
  if (p.skill.action === "write") {
    const { rootCreated } = writeSkill(p.skillsRoot, p.template.text);
    if (rootCreated) out(`created skills root ${p.skillsRoot} (0700)`);
    out(`wrote ${path} (0600)`);
  } else reportKeptSkill(path, out);
  const entry = { path: p.commandText, kind: "mcp-registration", agent: "pi", name: INTEGRATION_SERVER_NAME, agentDir: p.agentDir };
  record = upsertEntry(record, entry);
  save(record);
  if (p.registration.action === "keep") { out('kept  Pi MCP server "scout"'); return record; }
  // Pi's add replaces in place, so ownership was checked while planning.
  const add = piMcpAdd(p.piPath, INTEGRATION_SERVER_NAME, p.expected, opts);
  if (!add.ok || !ownsPiRegistration(piMcpGet(p.agentDir), p.expected)) throw new Error('`pi mcp add` failed or did not leave the expected server');
  out('registered Pi MCP server "scout"');
  return record;
}

function applyCodexIntegration(p, record, { env, save, out, mcpTimeoutMs }) {
  const opts = codexOpts(env, p.codexHome, mcpTimeoutMs);
  const path = integrationSkillPath(p.skillsRoot);
  record = upsertEntry(record, { path, kind: "skill", agent: "codex", sha256: p.template.sha256 });
  save(record);
  if (p.skill.action === "write") {
    const { rootCreated } = writeSkill(p.skillsRoot, p.template.text);
    if (rootCreated) out(`created skills root ${p.skillsRoot} (0700)`);
    out(`wrote ${path} (0600)`);
  } else reportKeptSkill(path, out);

  const entry = { path: p.commandText, kind: "mcp-registration", agent: "codex", name: INTEGRATION_SERVER_NAME, codexHome: p.codexHome };
  if (p.registration.action === "replace") {
    // Record the old command until it is gone, so a failure here leaves it removable.
    const rm = removeOwnedCodexRegistration(p.codexPath, INTEGRATION_SERVER_NAME, p.registration.previous, opts);
    if (rm.state !== "removed" && rm.state !== "absent") throw new Error(`could not remove the earlier Codex MCP server (${rm.state}${rm.exit ? `, ${describeExit(rm.exit)}` : ""})`);
  }
  record = upsertEntry(record, entry);
  save(record);
  if (p.registration.action === "keep") {
    out(`kept  Codex MCP server "${INTEGRATION_SERVER_NAME}": ${p.commandText}`);
    return record;
  }
  const add = codexMcpAdd(p.codexPath, INTEGRATION_SERVER_NAME, p.expected.command, p.expected.args, opts);
  const got = codexMcpGet(p.codexPath, INTEGRATION_SERVER_NAME, opts);
  const owned = ownsCodexRegistration(got, p.expected);
  if (!add.ok || !owned) {
    throw new Error(
      `\`codex mcp add\` ${add.ok ? "did not leave the expected server" : "failed"} (add ${describeExit(add)}; get ${got.exists === "unknown" ? describeExit(got.exit) : owned ? "shows this install's server" : got.exists ? "shows a different command" : "finds none"})`,
    );
  }
  out(`registered Codex MCP server "${INTEGRATION_SERVER_NAME}" (${p.codexHome}): ${p.commandText}`);
  return record;
}

function applyClaudeIntegration(p, record, { env, save, out, mcpTimeoutMs }) {
  const opts = mcpOpts(env, mcpTimeoutMs);
  const path = integrationSkillPath(p.skillsRoot);

  record = { ...upsertEntry(record, { path, kind: "skill", agent: "claude-code", sha256: p.template.sha256 }), skillsRoot: p.skillsRoot };
  save(record);
  if (p.skill.action === "write") {
    const { rootCreated } = writeSkill(p.skillsRoot, p.template.text);
    if (rootCreated) {
      record = { ...record, skillsRootCreated: true };
      save(record);
      out(`created skills root ${p.skillsRoot} (0700)`);
    }
    out(`wrote ${path} (0600)`);
  } else reportKeptSkill(path, out);

  const entry = { path: p.commandText, kind: "mcp-registration", agent: "claude-code", name: INTEGRATION_SERVER_NAME, scope: "user" };
  if (p.registration.action === "replace") {
    // Record the old command until it is gone, so a failure here leaves it removable.
    const rm = removeOwnedRegistration(p.claudePath, INTEGRATION_SERVER_NAME, p.registration.previous, opts);
    if (rm.state !== "removed" && rm.state !== "absent") throw new Error(`could not remove the earlier registration (${rm.state}${rm.exit ? `, ${describeExit(rm.exit)}` : ""})`);
  }
  record = upsertEntry(record, entry);
  save(record);
  if (p.registration.action === "keep") {
    out(`kept  MCP server "${INTEGRATION_SERVER_NAME}" (user scope): ${p.commandText}`);
    return record;
  }
  const add = mcpAddUser(p.claudePath, INTEGRATION_SERVER_NAME, p.expected.command, p.expected.args, opts);
  const got = mcpGet(p.claudePath, INTEGRATION_SERVER_NAME, opts);
  // A failed add is a failure even when `get` shows the entry: the record (saved above) keeps
  // the registration, so uninstall can remove it.
  const owned = ownsRegistration(got, p.expected);
  if (!add.ok || !owned) {
    throw new Error(
      `\`claude mcp add\` ${add.ok ? "did not leave the expected registration" : "failed"} (add ${describeExit(add)}; get ${got.exists === "unknown" ? describeExit(got.exit) : owned ? "shows this install's registration" : got.exists ? "shows a different command" : "finds none"})`,
    );
  }
  out(`registered MCP server "${INTEGRATION_SERVER_NAME}" (user scope): ${p.commandText}`);
  return record;
}

/**
 * Remove every agent's recorded integration, each part only if it is still ours. Returns
 * { record, lines, left } where `record` has the removed entries (and, once Claude Code's skill
 * entry is gone, skillsRoot) dropped, and `left` counts parts left in place. With dryRun
 * nothing changes (the `get` still runs; it is read-only).
 */
export function removeIntegration(record, { env, L, dryRun, claudeFallbacks, codexFallbacks, piFallbacks, mcpTimeoutMs, realHome }) {
  const lines = [];
  let left = 0;
  const would = dryRun ? "would " : "";
  const drop = new Set();
  const { registration, skill } = recordedIntegration(record);

  if (registration) {
    const expected = registration.name === INTEGRATION_SERVER_NAME && registration.scope === "user" && allowedPath("mcp-registration", registration.path, L, record) ? parseRegistrationCommand(registration.path) : null;
    const claude = integrationClaude(env, claudeFallbacks, realHome);
    if (!expected) {
      lines.push(`SKIP MCP registration ${JSON.stringify(registration.path)} (not a registration setup makes; not touching)`);
      left++;
    } else if (claude.error) {
      lines.push(`SKIP MCP server "${INTEGRATION_SERVER_NAME}" (${claude.error}; not touching)`);
      left++;
    } else if (dryRun) {
      lines.push(GET_NOTE);
      const get = mcpGet(claude.path, INTEGRATION_SERVER_NAME, mcpOpts(env, mcpTimeoutMs));
      if (get.exists === false) lines.push(`skip MCP server "${INTEGRATION_SERVER_NAME}" (already absent)`);
      else if (ownsRegistration(get, expected)) lines.push(`would remove MCP server "${INTEGRATION_SERVER_NAME}" (user scope; still exactly ${registration.path})`);
      else {
        lines.push(`SKIP MCP server "${INTEGRATION_SERVER_NAME}" (${get.exists === "unknown" ? `claude mcp get could not tell: ${describeExit(get.exit)}` : "registration changed; not Scout's"}; not touching)`);
        left++;
      }
    } else {
      const r = removeOwnedRegistration(claude.path, INTEGRATION_SERVER_NAME, expected, mcpOpts(env, mcpTimeoutMs));
      if (r.state === "removed") {
        lines.push(`removed MCP server "${INTEGRATION_SERVER_NAME}" (user scope; was exactly ${registration.path})`);
        drop.add(registration);
      } else if (r.state === "absent") {
        lines.push(`skip MCP server "${INTEGRATION_SERVER_NAME}" (already absent)`);
        drop.add(registration);
      } else {
        const why = {
          left_changed: "registration changed; not Scout's, not touching",
          unknown_state: `claude mcp get could not tell (${describeExit(r.exit)}); not touching`,
          remove_failed: `claude mcp remove failed${r.exit ? ` (${describeExit(r.exit)})` : ""}`,
          removal_unverified: `removed, but claude mcp get could not confirm it (${describeExit(r.exit)}); kept in the record`,
        }[r.state];
        lines.push(`SKIP MCP server "${INTEGRATION_SERVER_NAME}" (${why})`);
        left++;
      }
    }
  }

  if (skill) {
    if (!allowedPath("skill", skill.path, L, record) || typeof skill.sha256 !== "string") {
      lines.push(`SKIP ${skill.path} (not a path setup writes for kind skill; not touching)`);
      left++;
    } else {
      const dir = skillDir(record.skillsRoot);
      let state;
      try {
        // The root may have been swapped (e.g. for a symlink) since setup checked it.
        checkSkillsRoot(record.skillsRoot);
        state = dryRun ? dryRunSkillState(dir, skill.sha256) : removeSkill(record.skillsRoot, skill.sha256);
      } catch (e) {
        state = `skills root check failed: ${e.message}`;
      }
      if (state === "removed" || state === "would_remove") {
        lines.push(`${would}remove ${dir} (holds exactly the recorded skill)`);
        drop.add(skill);
      } else if (state === "absent") {
        lines.push(`skip ${dir} (already absent)`);
        drop.add(skill);
      } else {
        lines.push(`SKIP ${dir} (${{ left_modified: "changed since setup", left_symlink: "a symlink" }[state] ?? state}; not touching)`);
        left++;
      }
    }
  }

  const piPart = removePiIntegration(record, { env, L, dryRun, piFallbacks, mcpTimeoutMs, realHome });
  lines.push(...piPart.lines); left += piPart.left; for (const f of piPart.drop) drop.add(f);
  const codexPart = removeCodexIntegration(record, { env, L, dryRun, codexFallbacks, mcpTimeoutMs, realHome });
  lines.push(...codexPart.lines);
  left += codexPart.left;
  for (const f of codexPart.drop) drop.add(f);
  for (const f of record.files.filter((x) => isIntegrationEntry(x) && !AGENT_IDS.includes(agentOf(x)))) {
    lines.push(`SKIP ${f.kind} ${JSON.stringify(f.path)} (for an agent setup does not know: ${JSON.stringify(String(f.agent))}; not touching)`);
    left++;
  }

  const skillsRoot = record.skillsRoot;
  const files = record.files.filter((f) => !drop.has(f));
  const next = { ...record, files };
  if (!files.some((f) => f.kind === "skill" && agentOf(f) === "claude-code")) {
    delete next.skillsRoot;
    delete next.skillsRootCreated;
    if (skillsRoot && record.skillsRootCreated === true) {
      lines.push(`${dryRun ? "would leave" : "left"} skills root ${skillsRoot} in place: setup created it, but Claude Code shares it`);
    }
  }
  // Uninstall removed the unchanged wrappers first (uninstall.mjs unexportWrappers); what is
  // left changed after Scout wrote it. In a dry run nothing was removed, so nothing is counted.
  let rootReal = false;
  try {
    rootReal = !!skillsRoot && checkSkillsRoot(skillsRoot).exists;
  } catch {
    // a symlinked or missing root: uninstall already reported its wrappers as unreachable
  }
  if (skillsRoot && !dryRun && rootReal) {
    const w = countRuntimeWrappers(L.exportsManifest, skillsRoot);
    if (w.count === null) lines.push(`Scout app skill wrappers in ${skillsRoot}: unknown (${w.manifest} unreadable); uninstall leaves any there`);
    else if (w.count > 0) {
      lines.push(`Scout app skill wrappers left in ${skillsRoot}: ${w.count} (listed in ${w.manifest}): they changed after Scout wrote them, so uninstall leaves them; delete them yourself if you no longer want them.`);
    }
  }
  return { record: next, lines, left };
}

/**
 * The Codex part of removeIntegration: { lines, left, drop }. The registration is removed with
 * `codex mcp remove` after a `get` shows exactly the recorded command, and only from the Codex
 * home this environment names (the recorded one); the skill only from `<that home>/skills`.
 */
function removeCodexIntegration(record, { env, L, dryRun, codexFallbacks, mcpTimeoutMs, realHome }) {
  const lines = [];
  let left = 0;
  const drop = [];
  const would = dryRun ? "would " : "";
  const { registration, skill } = recordedIntegration(record, "codex");
  if (!registration && !skill) return { lines, left, drop };
  const home = integrationCodexHome(env, realHome);

  if (registration) {
    const expected = registration.name === INTEGRATION_SERVER_NAME && allowedPath("mcp-registration", registration.path, L, record, registration) ? parseRegistrationCommand(registration.path) : null;
    const codex = findAgentBinary("codex", env, { codexFallbacks }, realHome);
    const label = `Codex MCP server "${INTEGRATION_SERVER_NAME}"`;
    if (!expected) {
      lines.push(`SKIP Codex MCP registration ${JSON.stringify(registration.path)} (not a registration setup makes; not touching)`);
      left++;
    } else if (home.error || codex.error) {
      lines.push(`SKIP ${label} (${home.error ?? codex.error}; not touching)`);
      left++;
    } else if (registration.codexHome !== home.path) {
      lines.push(`SKIP ${label} (recorded for the Codex home ${String(registration.codexHome)}, not ${home.path}; not touching)`);
      left++;
    } else if (dryRun) {
      const get = codexMcpGet(codex.path, INTEGRATION_SERVER_NAME, codexOpts(env, home.path, mcpTimeoutMs));
      if (get.exists === false) lines.push(`skip ${label} (already absent)`);
      else if (ownsCodexRegistration(get, expected)) lines.push(`would remove ${label} (still exactly ${registration.path})`);
      else {
        lines.push(`SKIP ${label} (${get.exists === "unknown" ? `codex mcp get could not tell: ${describeExit(get.exit)}` : "changed; not Scout's"}; not touching)`);
        left++;
      }
    } else {
      const r = removeOwnedCodexRegistration(codex.path, INTEGRATION_SERVER_NAME, expected, codexOpts(env, home.path, mcpTimeoutMs));
      if (r.state === "removed") {
        lines.push(`removed ${label} (was exactly ${registration.path})`);
        drop.push(registration);
      } else if (r.state === "absent") {
        lines.push(`skip ${label} (already absent)`);
        drop.push(registration);
      } else {
        const why = {
          left_changed: "changed; not Scout's, not touching",
          unknown_state: `codex mcp get could not tell (${describeExit(r.exit)}); not touching`,
          remove_failed: `codex mcp remove failed${r.exit ? ` (${describeExit(r.exit)})` : ""}`,
          removal_unverified: `removed, but codex mcp get could not confirm it (${describeExit(r.exit)}); kept in the record`,
        }[r.state];
        lines.push(`SKIP ${label} (${why})`);
        left++;
      }
    }
  }

  if (skill) {
    const root = dirname(dirname(skill.path));
    if (!allowedPath("skill", skill.path, L, record, skill) || typeof skill.sha256 !== "string") {
      lines.push(`SKIP ${skill.path} (not a path setup writes for the Codex skill; not touching)`);
      left++;
    } else if (home.error || root !== join(home.path, "skills")) {
      lines.push(`SKIP ${dirname(skill.path)} (${home.error ?? `not under this environment's Codex home ${home.path}`}; not touching)`);
      left++;
    } else {
      const dir = skillDir(root);
      let state;
      try {
        checkSkillsRoot(root);
        state = dryRun ? dryRunSkillState(dir, skill.sha256) : removeSkill(root, skill.sha256);
      } catch (e) {
        state = `skills root check failed: ${e.message}`;
      }
      if (state === "removed" || state === "would_remove") {
        lines.push(`${would}remove ${dir} (holds exactly the recorded skill)`);
        drop.push(skill);
      } else if (state === "absent") {
        lines.push(`skip ${dir} (already absent)`);
        drop.push(skill);
      } else {
        lines.push(`SKIP ${dir} (${{ left_modified: "changed since setup", left_symlink: "a symlink" }[state] ?? state}; not touching)`);
        left++;
      }
    }
  }
  return { lines, left, drop };
}

function removePiIntegration(record, { env, L, dryRun, piFallbacks, mcpTimeoutMs, realHome }) {
  const lines = [], drop = [];
  let left = 0;
  const { registration, skill } = recordedIntegration(record, "pi");
  if (!registration && !skill) return { lines, drop, left };
  const home = integrationPiDir(env, realHome);
  if (registration) {
    const expected = registration.name === INTEGRATION_SERVER_NAME && allowedPath("mcp-registration", registration.path, L, record, registration) ? parseRegistrationCommand(registration.path) : null;
    const pi = findAgentBinary("pi", env, { piFallbacks }, realHome);
    if (!expected || home.error || pi.error || registration.agentDir !== home.path) { lines.push('SKIP Pi MCP server "scout" (record or environment mismatch; not touching)'); left++; }
    else if (dryRun) {
      const get = piMcpGet(home.path);
      if (get.exists === false) lines.push('skip Pi MCP server "scout" (already absent)');
      else if (ownsPiRegistration(get, expected)) lines.push('would remove Pi MCP server "scout"');
      else { lines.push('SKIP Pi MCP server "scout" (changed or unreadable; not touching)'); left++; }
    } else {
      const r = removeOwnedPiRegistration(pi.path, INTEGRATION_SERVER_NAME, expected, { env, cwd: tmpdir(), agentDir: home.path, ...(mcpTimeoutMs ? { timeoutMs: mcpTimeoutMs } : {}) });
      if (r.state === "removed" || r.state === "absent") { lines.push(`${r.state === "removed" ? "removed" : "skip"} Pi MCP server "scout"`); drop.push(registration); }
      else { lines.push(`SKIP Pi MCP server "scout" (${r.state}; not touching)`); left++; }
    }
  }
  if (skill) {
    const root = dirname(dirname(skill.path));
    if (!allowedPath("skill", skill.path, L, record, skill) || typeof skill.sha256 !== "string" || home.error || root !== join(home.path, "skills")) { lines.push(`SKIP ${skill.path} (not this Pi skill path; not touching)`); left++; }
    else {
      let state;
      try { checkSkillsRoot(root); state = dryRun ? dryRunSkillState(skillDir(root), skill.sha256) : removeSkill(root, skill.sha256); }
      catch (e) { state = e.message; }
      if (["removed", "would_remove", "absent"].includes(state)) { lines.push(`${dryRun ? "would remove" : state === "absent" ? "skip" : "removed"} ${skillDir(root)}`); drop.push(skill); }
      else { lines.push(`SKIP ${skillDir(root)} (${state}; not touching)`); left++; }
    }
  }
  return { lines, drop, left };
}

function dryRunSkillState(dir, expected) {
  const seen = inspectSkill(dir);
  if (seen.state === "absent") return "absent";
  if (seen.state === "empty" || (seen.state === "file" && seen.sha256 === expected)) return "would_remove";
  return { symlink: "left_symlink", other: "left_modified", file: "left_modified" }[seen.state] ?? seen.state;
}

/**
 * Doctor checks for every agent's recorded integration: [{ status, label, detail }].
 * Read-only (runs `claude mcp get`, which that CLI also uses to health-check the server, and
 * `codex mcp get --json`, which does not start it).
 */
export function checkIntegration(record, { env, L, claudeFallbacks, codexFallbacks, piFallbacks, mcpTimeoutMs, realHome }) {
  const out = [];
  const add = (status, label, detail = "") => out.push({ status, label, detail });
  const claudeInstalled = hasRecordedIntegration(record, "claude-code");
  const codexInstalled = hasRecordedIntegration(record, "codex");
  const piInstalled = hasRecordedIntegration(record, "pi");
  if (!claudeInstalled && !codexInstalled && !piInstalled) {
    add("OK", "agent integration", "not installed (optional: npm run setup -- --agent-integration)");
    return out;
  }
  const refusal = overrideRefusal(env, realHome);
  if (refusal) add("FAIL", "agent integration test overrides are unset", refusal);
  if (claudeInstalled) out.push(...checkClaudeIntegration(record, { env, L, claudeFallbacks, mcpTimeoutMs, realHome }));
  if (piInstalled) out.push(...checkPiIntegration(record, { env, L, piFallbacks, realHome }));
  if (codexInstalled) out.push(...checkCodexIntegration(record, { env, L, codexFallbacks, mcpTimeoutMs, realHome }));
  return out;
}

function checkPiIntegration(record, { env, L, piFallbacks, realHome }) {
  const out = [];
  const add = (status, label, detail = "") => out.push({ status, label, detail });
  const { registration, skill } = recordedIntegration(record, "pi");
  const home = integrationPiDir(env, realHome);
  if (!skill) add("FAIL", "Pi integration skill", "not recorded");
  else if (!allowedPath("skill", skill.path, L, record, skill) || home.error || dirname(dirname(skill.path)) !== join(home.path, "skills")) add("FAIL", "Pi integration skill", "recorded path or agent directory differs");
  else {
    const seen = inspectSkill(dirname(skill.path));
    add(seen.state === "file" && seen.sha256 === skill.sha256 ? "OK" : "FAIL", "Pi integration skill is exactly the installed one", skill.path);
  }
  if (!registration) add("FAIL", "Pi MCP registration", "not recorded");
  else {
    const expected = registration.name === INTEGRATION_SERVER_NAME ? parseRegistrationCommand(registration.path) : null;
    const pi = findAgentBinary("pi", env, { piFallbacks }, realHome);
    if (!expected) add("FAIL", "Pi MCP registration", "recorded entry is invalid");
    else if (home.error || pi.error || registration.agentDir !== home.path) add("WARN", "Pi MCP registration not checked", home.error ?? pi.error ?? "agent directory differs");
    else {
      const get = piMcpGet(home.path);
      add(get.exists === "unknown" ? "WARN" : ownsPiRegistration(get, expected) ? "OK" : "FAIL", "Pi MCP server scout is configured and is this install’s", get.exists === "unknown" ? "mcp.json unreadable" : get.exists === false ? "absent" : ownsPiRegistration(get, expected) ? registration.path : "foreign server");
    }
  }
  return out;
}

function checkCodexIntegration(record, { env, L, codexFallbacks, mcpTimeoutMs, realHome }) {
  const out = [];
  const add = (status, label, detail = "") => out.push({ status, label, detail });
  const { registration, skill } = recordedIntegration(record, "codex");
  const home = integrationCodexHome(env, realHome);

  if (!skill) add("FAIL", "Codex integration skill", "not recorded");
  else if (!allowedPath("skill", skill.path, L, record, skill)) add("FAIL", "Codex integration skill", `recorded path is not a skill path: ${skill.path}`);
  else if (home.error) add("WARN", "Codex integration skill not checked", home.error);
  else if (dirname(dirname(skill.path)) !== join(home.path, "skills")) add("WARN", "Codex integration skill not checked", `${skill.path} is not under this environment's Codex home ${home.path}`);
  else {
    const seen = inspectSkill(dirname(skill.path));
    const state = seen.state === "file" ? (seen.sha256 === skill.sha256 ? "ours" : "modified") : seen.state === "empty" || seen.state === "other" ? "modified" : seen.state;
    add(state === "ours" ? "OK" : "FAIL", "Codex integration skill is exactly the installed one", `${skill.path}: ${state}`);
  }

  if (!registration) add("FAIL", "Codex MCP registration", "not recorded");
  else {
    const expected = registration.name === INTEGRATION_SERVER_NAME ? parseRegistrationCommand(registration.path) : null;
    const codex = findAgentBinary("codex", env, { codexFallbacks }, realHome);
    if (!expected) add("FAIL", "Codex MCP registration", `recorded entry is not one setup makes: ${registration.path}`);
    else if (home.error || codex.error) add("WARN", "Codex MCP registration not checked", home.error ?? codex.error);
    else if (registration.codexHome !== home.path) add("WARN", "Codex MCP registration not checked", `recorded for the Codex home ${String(registration.codexHome)}, not ${home.path}`);
    else {
      const get = codexMcpGet(codex.path, INTEGRATION_SERVER_NAME, codexOpts(env, home.path, mcpTimeoutMs));
      const label = `Codex MCP server "${INTEGRATION_SERVER_NAME}" is configured and is this install's`;
      if (get.exists === "unknown") add("WARN", `Codex MCP server "${INTEGRATION_SERVER_NAME}" state unknown`, `codex mcp get: ${describeExit(get.exit)}`);
      else if (get.exists === false) add("FAIL", label, "absent; re-run `npm run setup -- --agent codex --agent-integration`");
      else if (ownsCodexRegistration(get, expected)) add(get.enabled ? "OK" : "WARN", label, `${registration.path} (${get.enabled ? "enabled" : "disabled in your Codex config"})`);
      else add("FAIL", label, `foreign: ${describeForeignCodex(get)}`);
    }
  }
  return out;
}

function checkClaudeIntegration(record, { env, L, claudeFallbacks, mcpTimeoutMs, realHome }) {
  const out = [];
  const add = (status, label, detail = "") => out.push({ status, label, detail });
  const { registration, skill } = recordedIntegration(record);

  let rootOk = false;
  try {
    rootOk = typeof record.skillsRoot === "string" && checkSkillsRoot(record.skillsRoot).exists;
  } catch {
    rootOk = false;
  }
  add(rootOk ? "OK" : "FAIL", "skillsRoot is recorded and is a real directory owned by you", String(record?.skillsRoot));

  if (!skill) add("FAIL", "integration skill", "not recorded");
  else if (!allowedPath("skill", skill.path, L, record)) add("FAIL", "integration skill", `recorded path is not the skill path: ${skill.path}`);
  else {
    const seen = inspectSkill(skillDir(record.skillsRoot));
    const state = seen.state === "file" ? (seen.sha256 === skill.sha256 ? "ours" : "modified") : seen.state === "empty" || seen.state === "other" ? "modified" : seen.state;
    add(state === "ours" ? "OK" : "FAIL", "integration skill is exactly the installed one", `${skill.path}: ${state}`);
  }

  if (!registration) add("FAIL", "MCP registration", "not recorded");
  else {
    const expected = registration.name === INTEGRATION_SERVER_NAME && registration.scope === "user" ? parseRegistrationCommand(registration.path) : null;
    const claude = integrationClaude(env, claudeFallbacks, realHome);
    if (!expected) add("FAIL", "MCP registration", `recorded entry is not one setup makes: ${registration.path}`);
    else if (claude.error) add("WARN", "MCP registration not checked", claude.error);
    else {
      const get = mcpGet(claude.path, INTEGRATION_SERVER_NAME, mcpOpts(env, mcpTimeoutMs));
      const label = `MCP server "${INTEGRATION_SERVER_NAME}" is registered and is this install's`;
      const note = `; ${GET_NOTE}`;
      if (get.exists === "unknown") add("WARN", `MCP server "${INTEGRATION_SERVER_NAME}" state unknown`, `claude mcp get: ${describeExit(get.exit)}${note}`);
      else if (get.exists === false) add("FAIL", label, `absent; re-run \`npm run setup -- --agent-integration\`${note}`);
      else if (ownsRegistration(get, expected)) add("OK", label, `${registration.path} (status: ${get.health ?? "?"})${note}`);
      else add("FAIL", label, `foreign: ${describeForeign(get)}${note}`);
    }
  }
  return out;
}

