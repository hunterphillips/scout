// The opt-in agent integration (setup --agent-integration): one user-scope `scout` MCP
// registration through `claude mcp add` (lib/claude-mcp.mjs) and the static
// `scout-integration` skill (lib/integration-skill.mjs), both recorded in installed.json
// together with `skillsRoot`. Plan, apply, remove and inspect live here so setup, uninstall
// and doctor share one notion of "ours".
//
// Ours means: the registration `get` shows exactly the recorded command at user scope; the
// skill dir holds exactly SKILL.md hashing to the recorded value (or to the current template,
// for a re-run). Anything else named `scout` / `scout-integration` is refused at setup and
// left in place at uninstall. A `get` that cannot tell is never read as absent.
//
// The registered command is `<nodePath> <scoutRoot>/packages/scout-mcp/dist/main.js` with no
// args (the adapter defaults to ~/.scout/run). `get` joins args by spaces, so paths with
// whitespace are refused. When the Scout home is not the real ~/.scout (a test install),
// SCOUT_CLAUDE_BIN and SCOUT_SKILLS_ROOT must both be given, so a test can never reach the
// real Claude Code configuration.

import { tmpdir } from "node:os";
import { isExecutableFile, resolveClaude, defaultClaudeFallbacks } from "./executables.mjs";
import { mcpAddUser, mcpGet, ownsRegistration, removeOwnedRegistration } from "./claude-mcp.mjs";
import { INTEGRATION_SERVER_NAME, allowedPath, integrationSkillPath, parseRegistrationCommand, upsertEntry } from "./installed.mjs";
import { checkSkillsRoot, countRuntimeWrappers, inspectSkill, removeSkill, skillDir, skillTemplate, writeSkill } from "./integration-skill.mjs";
import { isRealScoutHome, skillsRootFor } from "./paths.mjs";
import { exists } from "./files.mjs";

export const INTEGRATION_KINDS = ["mcp-registration", "skill"];
export const isIntegrationEntry = (f) => INTEGRATION_KINDS.includes(f?.kind);

/** Lines setup prints so the user knows what the connection reaches. */
export const INTEGRATION_EXPLANATION = [
  "The `scout` MCP connection is registered at user scope: it is available in all of your Claude Code sessions, in every project.",
  "It exposes only website resources you approved in Scout (AGENTS.md, llms.txt, skills), read on demand.",
  "Browser context (the current site and recent pages) is a separate opt-in in the Scout app; it stays off until you grant it there.",
  "Remove it with `npm run uninstall -- --agent-integration`.",
];

/**
 * The `claude` to run, or { error }. SCOUT_CLAUDE_BIN wins; otherwise PATH and the usual
 * fallbacks. A test install (Scout home not the real ~/.scout) requires SCOUT_CLAUDE_BIN.
 */
export function integrationClaude(env, claudeFallbacks) {
  if (env.SCOUT_CLAUDE_BIN) {
    return isExecutableFile(env.SCOUT_CLAUDE_BIN) ? { path: env.SCOUT_CLAUDE_BIN } : { error: `SCOUT_CLAUDE_BIN is not an absolute path to an executable: ${env.SCOUT_CLAUDE_BIN}` };
  }
  if (!isRealScoutHome(env)) return { error: "the Scout home is not the real ~/.scout, so SCOUT_CLAUDE_BIN must name the claude to run" };
  const path = resolveClaude({ pathVar: env.PATH ?? "", fallbacks: claudeFallbacks ?? defaultClaudeFallbacks(env) });
  return path ? { path } : { error: "claude not found on PATH, ~/.local/bin, or /opt/homebrew/bin" };
}

const mcpOpts = (env, timeoutMs) => ({ env, cwd: tmpdir(), ...(timeoutMs ? { timeoutMs } : {}) });
const describeExit = (exit) => (exit ? `exit ${exit.status ?? "none"}${exit.signal ? `, signal ${exit.signal}` : ""}${exit.timedOut ? ", timed out" : ""}` : "");

/** The recorded integration entries of a record: { registration, skill } (either may be undefined). */
export function recordedIntegration(record) {
  const files = record?.files ?? [];
  return { registration: files.find((f) => f.kind === "mcp-registration"), skill: files.find((f) => f.kind === "skill") };
}

/**
 * Work out the integration without changing anything; throws a refusal with a reason.
 * Runs `claude mcp get scout` (read-only; the CLI health-checks the server it finds).
 * Returns { skillsRoot, claudePath, expected, commandText, registration, skill, template, warnings }
 * where registration.action is add | keep | replace and skill.action is write | keep.
 */
export function planIntegration({ env, L, nodePath, record, claudeFallbacks, mcpTimeoutMs }) {
  const warnings = [];
  if (!isRealScoutHome(env) && (!env.SCOUT_SKILLS_ROOT || !env.SCOUT_CLAUDE_BIN)) {
    throw new Error("--agent-integration with a Scout home that is not the real ~/.scout needs both SCOUT_SKILLS_ROOT and SCOUT_CLAUDE_BIN, so a test install cannot touch the real Claude Code configuration");
  }
  if (isRealScoutHome(env)) {
    if (env.SCOUT_SKILLS_ROOT) warnings.push(`SCOUT_SKILLS_ROOT is set; the integration skill goes to ${skillsRootFor(env)}`);
    if (env.SCOUT_CLAUDE_BIN) warnings.push(`SCOUT_CLAUDE_BIN is set; registering through ${env.SCOUT_CLAUDE_BIN}`);
  }
  const claude = integrationClaude(env, claudeFallbacks);
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
        `agent integration: an MCP server named "${INTEGRATION_SERVER_NAME}" is already registered and is not this install's (command: ${get.command ?? "?"} ${get.args ?? ""}, scope: ${get.scope ?? "?"}).\n` +
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
  return { skillsRoot, skillsRootExists: root.exists, claudePath: claude.path, expected, commandText, registration, skill, template, warnings };
}

/** Dry-run lines for a plan. */
export function describeIntegration(p) {
  const add = `${p.claudePath} mcp add --scope user ${INTEGRATION_SERVER_NAME} -- ${p.commandText}`;
  const reg = {
    add: `would register: ${add}`,
    keep: `would keep the existing user-scope registration "${INTEGRATION_SERVER_NAME}" (${p.commandText})`,
    replace: `would replace this install's earlier registration (${p.registration.previous?.command} ${p.registration.previous?.args.join(" ")}): ${add}`,
  }[p.registration.action];
  const path = integrationSkillPath(p.skillsRoot);
  return [
    p.skillsRootExists ? `would keep skills root ${p.skillsRoot}` : `would create skills root ${p.skillsRoot} (0700)`,
    p.skill.action === "keep" ? `would keep ${path} (0600; already the current skill)` : `would write ${path} (0600) in a 0700 dir`,
    reg,
    `would record skillsRoot=${p.skillsRoot} and the two entries in installed.json`,
  ];
}

/**
 * Apply a plan. `save(record)` persists the record; it is called before each outward change
 * so a crash leaves a record that uninstall can act on. Returns the new record; throws on
 * failure with the record already saved.
 */
export function applyIntegration(p, record, { env, save, out, mcpTimeoutMs }) {
  const opts = mcpOpts(env, mcpTimeoutMs);
  const path = integrationSkillPath(p.skillsRoot);

  record = { ...upsertEntry(record, { path, kind: "skill", sha256: p.template.sha256 }), skillsRoot: p.skillsRoot };
  if (p.skill.action === "write") {
    save(record);
    writeSkill(p.skillsRoot, p.template.text);
    out(`wrote ${path} (0600)`);
  } else {
    save(record);
    out(`kept  ${path} (0600)`);
  }

  const entry = { path: p.commandText, kind: "mcp-registration", name: INTEGRATION_SERVER_NAME, scope: "user" };
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
  if (!ownsRegistration(got, p.expected)) {
    throw new Error(`\`claude mcp add\` did not leave the expected registration (add ${describeExit(add)}; get ${got.exists === "unknown" ? describeExit(got.exit) : got.exists ? "shows a different command" : "finds none"})`);
  }
  out(`registered MCP server "${INTEGRATION_SERVER_NAME}" (user scope): ${p.commandText}`);
  return record;
}

/**
 * Remove the recorded integration, each part only if it is still ours. Returns
 * { record, lines, left } where `record` has the removed entries (and, once the skill entry
 * is gone, skillsRoot) dropped, and `left` counts parts left in place. With dryRun nothing
 * changes (the `get` still runs; it is read-only).
 */
export function removeIntegration(record, { env, L, dryRun, claudeFallbacks, mcpTimeoutMs }) {
  const lines = [];
  let left = 0;
  const would = dryRun ? "would " : "";
  const drop = new Set();
  const { registration, skill } = recordedIntegration(record);

  if (registration) {
    const expected = registration.name === INTEGRATION_SERVER_NAME && registration.scope === "user" && allowedPath("mcp-registration", registration.path, L, record) ? parseRegistrationCommand(registration.path) : null;
    const claude = integrationClaude(env, claudeFallbacks);
    if (!expected) {
      lines.push(`SKIP MCP registration ${JSON.stringify(registration.path)} (not a registration setup makes; not touching)`);
      left++;
    } else if (claude.error) {
      lines.push(`SKIP MCP server "${INTEGRATION_SERVER_NAME}" (${claude.error}; not touching)`);
      left++;
    } else if (dryRun) {
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
      const state = dryRun ? dryRunSkillState(dir, skill.sha256) : removeSkill(record.skillsRoot, skill.sha256);
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

  const skillsRoot = record.skillsRoot;
  const files = record.files.filter((f) => !drop.has(f));
  const next = { ...record, files };
  if (!files.some((f) => f.kind === "skill")) delete next.skillsRoot;
  if (skillsRoot) {
    const w = countRuntimeWrappers(L.exportsManifest, skillsRoot);
    lines.push(
      w.count === null
        ? `Scout app skill wrappers in ${skillsRoot}: unknown (${w.manifest} unreadable); setup never touches them`
        : `Scout app skill wrappers remaining in ${skillsRoot}: ${w.count} (listed in ${w.manifest}; the Scout app manages them, setup never touches them)`,
    );
  }
  return { record: next, lines, left };
}

function dryRunSkillState(dir, expected) {
  const seen = inspectSkill(dir);
  if (seen.state === "absent") return "absent";
  if (seen.state === "empty" || (seen.state === "file" && seen.sha256 === expected)) return "would_remove";
  return { symlink: "left_symlink", other: "left_modified", file: "left_modified" }[seen.state] ?? seen.state;
}

/**
 * Doctor checks for the integration: [{ status, label, detail }]. Read-only (runs
 * `claude mcp get`, which the CLI also uses to health-check the server).
 */
export function checkIntegration(record, { env, L, claudeFallbacks, mcpTimeoutMs }) {
  const out = [];
  const add = (status, label, detail = "") => out.push({ status, label, detail });
  const { registration, skill } = recordedIntegration(record);
  if (!registration && !skill && !record?.skillsRoot) {
    add("OK", "agent integration", "not installed (optional: npm run setup -- --agent-integration)");
    return out;
  }

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
    const claude = integrationClaude(env, claudeFallbacks);
    if (!expected) add("FAIL", "MCP registration", `recorded entry is not one setup makes: ${registration.path}`);
    else if (claude.error) add("WARN", "MCP registration not checked", claude.error);
    else {
      const get = mcpGet(claude.path, INTEGRATION_SERVER_NAME, mcpOpts(env, mcpTimeoutMs));
      if (get.exists === "unknown") add("WARN", `MCP server "${INTEGRATION_SERVER_NAME}" state unknown`, `claude mcp get: ${describeExit(get.exit)}`);
      else if (get.exists === false) add("FAIL", `MCP server "${INTEGRATION_SERVER_NAME}" is registered and is this install's`, "absent; re-run `npm run setup -- --agent-integration`");
      else if (ownsRegistration(get, expected)) add("OK", `MCP server "${INTEGRATION_SERVER_NAME}" is registered and is this install's`, `${registration.path} (status: ${get.health ?? "?"})`);
      else add("FAIL", `MCP server "${INTEGRATION_SERVER_NAME}" is registered and is this install's`, `foreign: ${get.command ?? "?"} ${get.args ?? ""} (${get.scope ?? "?"})`);
    }
  }
  return out;
}

