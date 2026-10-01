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
// real Claude Code configuration. On the real ~/.scout both are refused (setup, uninstall and
// doctor), so a test override can never be applied to a real install. `realHome` (tests only)
// replaces the account home isRealScoutHome compares against.
//
// A foreign registration's command and args are never printed: only its scope and a short
// hash of the command text.

import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { isExecutableFile, resolveClaude, defaultClaudeFallbacks } from "./executables.mjs";
import { mcpAddUser, mcpGet, ownsRegistration, removeOwnedRegistration } from "./claude-mcp.mjs";
import { INTEGRATION_SERVER_NAME, allowedPath, integrationSkillPath, parseRegistrationCommand, upsertEntry } from "./installed.mjs";
import { checkSkillsRoot, countRuntimeWrappers, inspectSkill, readExportsManifest, removeSkill, skillDir, skillTemplate, writeSkill } from "./integration-skill.mjs";
import { isRealScoutHome, skillsRootFor } from "./paths.mjs";
import { exists } from "./files.mjs";

export const INTEGRATION_KINDS = ["mcp-registration", "skill"];
export const isIntegrationEntry = (f) => INTEGRATION_KINDS.includes(f?.kind);

/** Lines setup prints so the user knows what the connection reaches. */
export const INTEGRATION_EXPLANATION = [
  "The `scout` MCP connection is registered at user scope: it is available in all of your Claude Code sessions, in every project.",
  "It exposes only website resources you approved in Scout (AGENTS.md, llms.txt, skills), read on demand.",
  "Browser context (the current site and recent pages) is a separate opt-in, off by default: today it is `agentBrowserContext` in ~/.scout/config.json; a Scout app toggle is coming.",
  "Remove it with `npm run uninstall -- --agent-integration`.",
];

/** Said wherever `claude mcp get` runs (setup dry run, uninstall dry run, doctor). */
export const GET_NOTE = `\`claude mcp get ${INTEGRATION_SERVER_NAME}\` runs read-only; the Claude CLI health-checks (starts) whatever is registered under that name`;

/** The refusal when test overrides are set on the real ~/.scout, or null. */
export function overrideRefusal(env, realHome) {
  if (!isRealScoutHome(env, realHome)) return null;
  const set = ["SCOUT_SKILLS_ROOT", "SCOUT_CLAUDE_BIN"].filter((k) => env[k]);
  return set.length ? `${set.join(" and ")} ${set.length > 1 ? "are" : "is"} for test installs only and refused with the real ~/.scout; unset ${set.length > 1 ? "them" : "it"} and re-run` : null;
}

/** A foreign registration, described without its command or args. */
function describeForeign(get) {
  const digest = createHash("sha256").update(`${get.command ?? ""} ${get.args ?? ""}`, "utf8").digest("hex").slice(0, 12);
  return `scope: ${get.scope ?? "?"}; command differs from this install's (sha256 ${digest})`;
}

/**
 * The `claude` to run, or { error }. SCOUT_CLAUDE_BIN wins; otherwise PATH and the usual
 * fallbacks. A test install (Scout home not the real ~/.scout) requires SCOUT_CLAUDE_BIN; the
 * real ~/.scout refuses it (and SCOUT_SKILLS_ROOT).
 */
export function integrationClaude(env, claudeFallbacks, realHome) {
  const refusal = overrideRefusal(env, realHome);
  if (refusal) return { error: refusal };
  if (env.SCOUT_CLAUDE_BIN) {
    return isExecutableFile(env.SCOUT_CLAUDE_BIN) ? { path: env.SCOUT_CLAUDE_BIN } : { error: `SCOUT_CLAUDE_BIN is not an absolute path to an executable: ${env.SCOUT_CLAUDE_BIN}` };
  }
  if (!isRealScoutHome(env, realHome)) return { error: "the Scout home is not the real ~/.scout, so SCOUT_CLAUDE_BIN must name the claude to run" };
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
export function planIntegration({ env, L, nodePath, record, claudeFallbacks, mcpTimeoutMs, realHome }) {
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
export function applyIntegration(p, record, { env, save, out, mcpTimeoutMs }) {
  const opts = mcpOpts(env, mcpTimeoutMs);
  const path = integrationSkillPath(p.skillsRoot);

  record = { ...upsertEntry(record, { path, kind: "skill", sha256: p.template.sha256 }), skillsRoot: p.skillsRoot };
  save(record);
  if (p.skill.action === "write") {
    const { rootCreated } = writeSkill(p.skillsRoot, p.template.text);
    if (rootCreated) {
      record = { ...record, skillsRootCreated: true };
      save(record);
      out(`created skills root ${p.skillsRoot} (0700)`);
    }
    out(`wrote ${path} (0600)`);
  } else {
    let m = null;
    try {
      m = (lstatSync(path).mode & 0o777).toString(8).padStart(4, "0");
    } catch {
      // reported without a mode
    }
    out(`kept  ${path}${m ? ` (${m})` : ""}`);
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
 * Remove the recorded integration, each part only if it is still ours. Returns
 * { record, lines, left } where `record` has the removed entries (and, once the skill entry
 * is gone, skillsRoot) dropped, and `left` counts parts left in place. With dryRun nothing
 * changes (the `get` still runs; it is read-only).
 */
export function removeIntegration(record, { env, L, dryRun, claudeFallbacks, mcpTimeoutMs, realHome }) {
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

  const skillsRoot = record.skillsRoot;
  const files = record.files.filter((f) => !drop.has(f));
  const next = { ...record, files };
  if (!files.some((f) => f.kind === "skill")) {
    delete next.skillsRoot;
    delete next.skillsRootCreated;
    if (skillsRoot && record.skillsRootCreated === true) {
      lines.push(`${dryRun ? "would leave" : "left"} skills root ${skillsRoot} in place: setup created it, but Claude Code shares it`);
    }
  }
  if (skillsRoot) {
    const w = countRuntimeWrappers(L.exportsManifest, skillsRoot);
    lines.push(
      w.count === null
        ? `Scout app skill wrappers in ${skillsRoot}: unknown (${w.manifest} unreadable); setup never touches them`
        : `Scout app skill wrappers remaining in ${skillsRoot}: ${w.count} (listed in ${w.manifest}; the Scout app manages them, setup never touches them)`,
    );
    if (w.count > 0) lines.push("To remove them, revoke those capabilities in Scout (which removes their wrappers) before uninstalling; uninstall never removes them.");
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
export function checkIntegration(record, { env, L, claudeFallbacks, mcpTimeoutMs, realHome }) {
  const out = [];
  const add = (status, label, detail = "") => out.push({ status, label, detail });
  const { registration, skill } = recordedIntegration(record);
  if (!registration && !skill && !record?.skillsRoot) {
    add("OK", "agent integration", "not installed (optional: npm run setup -- --agent-integration)");
    return out;
  }
  const refusal = overrideRefusal(env, realHome);
  if (refusal) add("FAIL", "agent integration test overrides are unset", refusal);

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

