#!/usr/bin/env node
// Scout setup: install the extension key, the Scout config, the agent profile, the native host
// wrapper, and the Chrome native-messaging manifest. Every file written is recorded in
// <SCOUT_HOME>/installed.json so uninstall.mjs can remove exactly those.
// --agent <claude-code|codex> picks the agent Scout's jobs run through when setup writes the
// agent profile. Without it: Claude Code when `claude` is found, else Codex when `codex` is
// found, else no profile (a warning names both).
// --agent-integration also registers the `scout` MCP server with that agent's CLI (`claude mcp
// add` at user scope, or `codex mcp add`) and installs the static scout-integration skill
// (lib/agent-integration.mjs). The agent is --agent when given, else the profile's adapter,
// else Claude Code. Without the flag, setup never touches an agent's configuration.
// --login-launch [--app <Scout.app>] writes the login LaunchAgent; it starts the installed
// ~/Applications/Scout.app (`npm run bundle-app -- --install`) unless --app names another bundle.
// Setup registers nothing for the side panel: the extension bundle carries it.
// <SCOUT_HOME>/agent-profile.json is written only when absent, with the absolute claude or
// codex path resolved here, so jobs launched from a Finder-started app never look it up on
// PATH; an existing profile is never rewritten. The Codex profile's adapter id, model and
// reasoning effort come from the built scout-core (dist/agents/codex/profile.js).
//
// Usage: node scripts/setup.mjs [--dry-run] [--scout-root <dir>] [--agent <claude-code|codex>]
//                               [--agent-integration] [--login-launch [--app <Scout.app>]]
// Env overrides: SCOUT_HOME, CHROME_NMH_DIR, SCOUT_SKILLS_ROOT, SCOUT_CLAUDE_BIN,
// SCOUT_CODEX_BIN, SCOUT_CODEX_HOME, LAUNCH_AGENTS_DIR, SCOUT_APPLICATIONS_DIR (see
// lib/paths.mjs). All but SCOUT_HOME are for test installs: refused with the real ~/.scout,
// required with a test home where they apply (without SCOUT_CLAUDE_BIN or SCOUT_CODEX_BIN a
// test install finds no agent and writes no agent profile).
// When the Scout home is not the real ~/.scout (SCOUT_HOME or HOME overridden),
// --scout-root is required so a test install cannot re-key the real built extension.
// Never touches ~/.rook or any process.

import { chmodSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_BUNDLE_ID, DEFAULT_DESTINATIONS, HOST_NAME, REPO_ROOT, appBinary, isRealScoutHome, layout, locationOverrideRefusal, scoutHome } from "./lib/paths.mjs";
import { extensionIdFromPem, generateKeyPem, manifestKey } from "./lib/extension-key.mjs";
import { isExecutableFile, resolveNode } from "./lib/executables.mjs";
import { newMarker, readInstalled, saveInstalled, upsertEntry } from "./lib/installed.mjs";
import { builtConstant, checkPrivateDir, ensurePrivateDir, exists, fileMarker, readJsonObject, shDoubleQuote, wrapperScript, writeFileMode, writeJson } from "./lib/files.mjs";
import { isMain } from "./lib/is-main.mjs";
import { AGENTS, AGENT_IDS, applyIntegration, describeIntegration, findAgentBinary, hasRecordedIntegration, integrationExplanation, planIntegration } from "./lib/agent-integration.mjs";
import { applicationsRefusal, bundleIdOf, launchAgentPlist, launchAgentRefusal, sha256 } from "./lib/app-bundle.mjs";

/** Lines setup prints after an install: the one-time steps it cannot do itself. */
export const NEXT_STEPS = [
  "One-time steps setup cannot do:",
  "  1. Load the unpacked extension: chrome://extensions, Developer mode on, Load unpacked, pick the folder below. Reload it there after every `npm run build`.",
  "  2. Click the Scout toolbar button: it opens Scout's side panel for the current tab. Allow a site from the panel to use Scout there.",
  "  3. Start Scout: open the bundled app (`npm run bundle-app` builds it), or `swift run ScoutApp` in native/Scout. With Scout quit, the panel says Scout isn't running; nothing is captured or suggested.",
];

export function parseArgs(argv) {
  const opts = { dryRun: false, scoutRoot: REPO_ROOT, scoutRootGiven: false, agent: null, agentIntegration: false, loginLaunch: false, app: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--agent-integration") opts.agentIntegration = true;
    else if (a === "--login-launch") opts.loginLaunch = true;
    else if (a === "--agent") {
      const id = argv[++i];
      if (!AGENT_IDS.includes(id)) throw new Error(`--agent needs one of ${AGENT_IDS.join(", ")}`);
      opts.agent = id;
    }
    else if (a === "--app") {
      if (!argv[i + 1]) throw new Error("--app needs a Scout.app path");
      opts.app = resolve(argv[++i]);
    }
    else if (a === "--scout-root") {
      if (!argv[i + 1]) throw new Error("--scout-root needs a directory");
      opts.scoutRoot = argv[++i];
      opts.scoutRootGiven = true;
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.app && !opts.loginLaunch) throw new Error("--app goes with --login-launch");
  return opts;
}

function validDestinations(v) {
  return Array.isArray(v) && v.length > 0 && v.every((d) => typeof d === "string" && d.length > 0);
}

/**
 * Work out everything setup would write without writing anything.
 * Returns { L, marker, extensionId, claudePath, agentPath, profileAdapter, warnings, dirs, steps }
 * where each step is { path, kind, mode, summary, entry, keep, write() }. `profileAdapter` is
 * the adapter the agent profile names after this run (the existing file's, or the one setup
 * writes), or null. `claudeFallbacks` / `codexFallbacks` override the places searched after
 * PATH (tests pass [] to make "not found" deterministic). `agent` is --agent.
 */
export function planSetup({ env = process.env, scoutRoot = REPO_ROOT, dryRun = false, agent = null, claudeFallbacks, codexFallbacks, loginLaunch = false, app = null, realHome } = {}) {
  const L = layout({ env, scoutRoot });
  const warnings = [];
  const nmhRefusal = locationOverrideRefusal("CHROME_NMH_DIR", env, realHome);
  if (nmhRefusal) throw new Error(nmhRefusal);

  // Run the private-dir checks up front, so a dry run fails the same way a real run would.
  const dirs = [L.scoutHome, L.binDir].map((path) => ({ path, private: true, ...checkPrivateDir(path) }));
  dirs.push({ path: L.nmhDir, private: false, exists: exists(L.nmhDir) });

  if (!exists(L.extensionManifest)) {
    throw new Error(`built extension manifest not found at ${L.extensionManifest}\nRun \`npm run build\` in ${L.scoutRoot} first.`);
  }
  const extManifest = readJsonObject(L.extensionManifest);
  if (!exists(L.hostJs)) warnings.push(`native host not built yet: ${L.hostJs} (run \`npm run build\`)`);

  const record = readInstalled(L.installed);
  const marker = record?.marker ?? newMarker();

  const nodePath = resolveNode();
  if (!isExecutableFile(nodePath)) throw new Error(`node path is not an executable file: ${nodePath}`);
  if (/\/\.nvm\//.test(nodePath)) {
    warnings.push(`node is under nvm (${nodePath}); an nvm upgrade will move it, and you must re-run \`npm run setup\``);
  }
  if (env.SCOUT_HOME) {
    warnings.push(`SCOUT_HOME is set (${L.scoutHome}); the native app only reads ~/.scout, so this install is for testing`);
  }
  // The same CLIs the agent integration runs: SCOUT_CLAUDE_BIN / SCOUT_CODEX_BIN on a test home
  // (never one found on PATH), PATH and the usual places on the real home.
  const found = Object.fromEntries(AGENT_IDS.map((id) => [id, findAgentBinary(id, env, { claudeFallbacks, codexFallbacks }, realHome)]));
  const chosen = agent ?? AGENT_IDS.find((id) => found[id].path) ?? null;
  const agentPath = chosen ? (found[chosen].path ?? null) : null;
  const claudePath = found["claude-code"].path ?? null;

  // Refuse to overwrite any Scout-owned file that exists without this install's marker.
  const foreign = [
    [L.scoutConfig, "config"],
    [L.wrapper, "wrapper"],
    [L.nmhManifest, "nmh-manifest"],
  ].filter(([p, kind]) => exists(p) && fileMarker(p, kind) !== marker);
  if (foreign.length) {
    throw new Error(
      `refusing to overwrite files that do not carry this install's Scout marker:\n` +
        foreign.map(([p]) => `  ${p}`).join("\n") +
        `\nMove them aside and re-run.`,
    );
  }

  const keyExists = exists(L.keyPem);
  let keyMode = null;
  if (keyExists) {
    const st = lstatSync(L.keyPem);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${L.keyPem} is not a regular file; move it aside and re-run`);
    keyMode = st.mode & 0o777;
  }
  let pem = keyExists ? readFileSync(L.keyPem, "utf8") : null;
  if (!pem && !dryRun) pem = generateKeyPem();
  const extensionId = pem ? extensionIdFromPem(pem) : null;
  const key = pem ? manifestKey(pem) : null;
  const idText = extensionId ?? "<derived from the new key>";

  const existingScout = readJsonObject(L.scoutConfig) ?? {};
  const destinations = validDestinations(existingScout.destinations) ? existingScout.destinations : DEFAULT_DESTINATIONS;
  const scoutConfig = { ...existingScout, x_scout_marker: marker, nodePath, scoutRoot: L.scoutRoot, extensionId, destinations };
  const nmh = {
    name: HOST_NAME,
    description: "Scout native bridge",
    path: L.wrapper,
    type: "stdio",
    allowed_origins: [`chrome-extension://${idText}/`],
    x_scout_marker: marker,
  };
  const extMode = statSync(L.extensionManifest).mode & 0o777;

  const steps = [
    {
      path: L.keyPem,
      kind: "key",
      mode: 0o600,
      summary: keyExists
        ? `extension key (exists, reused${keyMode !== 0o600 ? `; ${dryRun ? "would chmod" : "chmod"} from ${keyMode.toString(8).padStart(4, "0")} to 0600` : ""})`
        : "new 2048-bit RSA extension key (would generate)",
      entry: { path: L.keyPem, kind: "key", extensionId },
      keep: keyExists,
      write: keyExists ? () => keyMode !== 0o600 && chmodSync(L.keyPem, 0o600) : () => writeFileMode(L.keyPem, pem, 0o600),
    },
    {
      path: L.extensionManifest,
      kind: "extension-manifest-key",
      mode: extMode,
      summary: `add "key" to the built extension manifest (extension ID ${idText})`,
      entry: { path: L.extensionManifest, kind: "extension-manifest-key", key },
      write: () => writeJson(L.extensionManifest, { ...extManifest, key }, extMode),
    },
    {
      path: L.scoutConfig,
      kind: "config",
      mode: 0o600,
      summary: `nodePath=${nodePath} scoutRoot=${L.scoutRoot} extensionId=${idText} destinations=${destinations.join(",")}`,
      entry: { path: L.scoutConfig, kind: "config" },
      write: () => writeJson(L.scoutConfig, scoutConfig, 0o600),
    },
    {
      path: L.wrapper,
      kind: "wrapper",
      mode: 0o700,
      summary: `exec ${shDoubleQuote(nodePath)} ${shDoubleQuote(L.hostJs)} "$@"`,
      entry: { path: L.wrapper, kind: "wrapper" },
      write: () => writeFileMode(L.wrapper, wrapperScript({ nodePath, hostJs: L.hostJs, scoutHome: L.scoutHome, marker }), 0o700),
    },
    {
      path: L.nmhManifest,
      kind: "nmh-manifest",
      mode: 0o644,
      summary: `${HOST_NAME} -> ${L.wrapper}, allowed_origins chrome-extension://${idText}/`,
      entry: { path: L.nmhManifest, kind: "nmh-manifest" },
      write: () => writeJson(L.nmhManifest, nmh, 0o644),
    },
  ];
  const profile = agentProfileStep({ L, record, agent: chosen, agentPath });
  if (profile.step) steps.splice(3, 0, profile.step);
  if (profile.note) warnings.push(profile.note);
  if (!profile.exists && !agentPath) {
    const why = chosen ? found[chosen].error : AGENT_IDS.map((id) => found[id].error).join("; ");
    warnings.push(`no agent profile is written (${why}), so suggestions stay unavailable until you re-run setup`);
  }
  if (profile.exists && agent && profile.adapter && profile.adapter !== agent) {
    warnings.push(`the existing agent profile names ${AGENTS[profile.adapter]?.label ?? profile.adapter}, so Scout's jobs keep running there; --agent only picks the agent for a new profile`);
  }
  if (loginLaunch) steps.push(launchAgentStep({ L, record, app, env, realHome }));
  return { L, marker, record, extensionId, nodePath, claudePath, agentPath, profileAdapter: profile.adapter ?? null, warnings, dirs, steps };
}

/** The adapter an agent profile text names, when it is one setup knows; else null. */
function profileAdapterOf(text) {
  try {
    const a = JSON.parse(text)?.adapter;
    return AGENT_IDS.includes(a) ? a : null;
  } catch {
    return null;
  }
}

/**
 * The agent profile: written only when absent (with the absolute claude or codex path), kept
 * while it is still exactly what setup wrote, and otherwise left alone and unrecorded by this
 * run. Returns { step?, note?, exists, adapter? }.
 */
function agentProfileStep({ L, record, agent, agentPath }) {
  const recorded = record?.files.find((f) => f.kind === "agent-profile" && f.path === L.agentProfile);
  if (exists(L.agentProfile)) {
    let text = null;
    try {
      if (lstatSync(L.agentProfile).isFile()) text = readFileSync(L.agentProfile, "utf8");
    } catch {
      // unreadable: left alone below
    }
    const adapter = text === null ? null : profileAdapterOf(text);
    if (recorded && text !== null && sha256(text) === recorded.sha256) {
      return { exists: true, adapter, step: { path: L.agentProfile, kind: "agent-profile", mode: 0o600, summary: "agent profile (exists, written by setup, kept)", entry: recorded, keep: true, write: () => {} } };
    }
    return { exists: true, adapter, note: `kept ${L.agentProfile} as it is (${recorded ? "changed since setup wrote it" : "not written by setup"}); Scout's jobs use the agent and model it names` };
  }
  if (!agentPath) return { exists: false };
  const { text, summary } = agent === "codex" ? codexProfileText(L, agentPath) : claudeProfileText(L, agentPath);
  return {
    exists: false,
    adapter: agent,
    step: {
      path: L.agentProfile,
      kind: "agent-profile",
      mode: 0o600,
      summary: `${summary} (written only because none exists)`,
      entry: { path: L.agentProfile, kind: "agent-profile", sha256: sha256(text) },
      write: () => writeFileMode(L.agentProfile, text, 0o600),
    },
  };
}

/** Constants from a built scout-core file; throws when it is not built. */
function builtConstants(L, rel, names) {
  const built = join(L.scoutRoot, "packages", "scout-core", "dist", ...rel);
  const values = names.map((n) => builtConstant(built, n));
  if (values.some((v) => v === null)) throw new Error(`scout-core not built: ${built} is missing\nRun \`npm run build\` in ${L.scoutRoot} first.`);
  return values;
}

/** The Claude Code profile: adapter id and initial model from the built scout-core. */
function claudeProfileText(L, claudePath) {
  const [adapter, model] = builtConstants(L, ["agents", "claudeCode", "profile.js"], ["CLAUDE_CODE_ADAPTER_ID", "DEFAULT_CLAUDE_CODE_MODEL"]);
  return { text: JSON.stringify({ schemaVersion: 1, adapter, model, claudePath }, null, 2) + "\n", summary: `claudePath=${claudePath} model=${model}` };
}

/** The Codex profile: adapter id, initial model and reasoning effort from the built scout-core. */
function codexProfileText(L, codexPath) {
  const [adapter, model, reasoningEffort] = builtConstants(L, ["agents", "codex", "profile.js"], ["CODEX_ADAPTER_ID", "DEFAULT_CODEX_MODEL", "DEFAULT_CODEX_REASONING_EFFORT"]);
  return {
    text: JSON.stringify({ schemaVersion: 1, adapter, codexPath, model, reasoningEffort }, null, 2) + "\n",
    summary: `codexPath=${codexPath} model=${model} reasoningEffort=${reasoningEffort}`,
  };
}

/** The login LaunchAgent step. Throws a refusal (missing bundle, override rules, foreign file). */
function launchAgentStep({ L, record, app, env, realHome }) {
  const refusal = launchAgentRefusal(env, realHome);
  if (refusal) throw new Error(refusal);
  // Default: the installed copy (bundle-app --install), never a build directory; --app may name
  // any bundle explicitly, a .build one included.
  if (!app) {
    const appsRefusal = applicationsRefusal(env, realHome);
    if (appsRefusal) throw new Error(`--login-launch without --app starts the installed app: ${appsRefusal}`);
    app = L.installedApp;
  }
  const program = appBinary(app);
  if (!isExecutableFile(program)) throw new Error(`--login-launch: no app at ${app} (missing ${program}); run \`npm run bundle-app -- --install\` first, or pass --app <Scout.app>`);
  const id = bundleIdOf(app);
  if (id !== APP_BUNDLE_ID) throw new Error(`--login-launch: ${app} is not a Scout bundle (CFBundleIdentifier ${id ?? "unreadable"}, expected ${APP_BUNDLE_ID})`);
  const text = launchAgentPlist({ program });
  const recorded = record?.files.find((f) => f.kind === "launch-agent" && f.path === L.launchAgent);
  if (exists(L.launchAgent)) {
    let current = null;
    try {
      if (lstatSync(L.launchAgent).isFile()) current = readFileSync(L.launchAgent, "utf8");
    } catch {
      // unreadable: refused below
    }
    if (!recorded || current === null || sha256(current) !== recorded.sha256) {
      throw new Error(`refusing to overwrite ${L.launchAgent}: ${recorded ? "it changed since setup wrote it" : "setup did not write it"}. Move it aside and re-run.`);
    }
  }
  return {
    path: L.launchAgent,
    kind: "launch-agent",
    mode: 0o644,
    summary: `RunAtLoad ${program} (takes effect at your next login)`,
    entry: { path: L.launchAgent, kind: "launch-agent", sha256: sha256(text), program },
    write: () => {
      mkdirSync(L.launchAgentsDir, { recursive: true });
      writeFileMode(L.launchAgent, text, 0o644);
    },
  };
}

export function runSetup(argv, { env = process.env, out = console.log, err = console.error, claudeFallbacks, codexFallbacks, mcpTimeoutMs, realHome } = {}) {
  let opts, plan, integration, integrationAgent;
  try {
    opts = parseArgs(argv);
    const home = resolve(scoutHome(env));
    if (!isRealScoutHome(env, realHome) && !opts.scoutRootGiven) {
      throw new Error(
        `Scout home ${home} is not the real ~/.scout and --scout-root is not given; a test install would re-key the real built extension in ${REPO_ROOT}.\n` +
          `Pass --scout-root <dir> pointing at a separate built copy.`,
      );
    }
    plan = planSetup({ env, scoutRoot: opts.scoutRoot, dryRun: opts.dryRun, agent: opts.agent, claudeFallbacks, codexFallbacks, loginLaunch: opts.loginLaunch, app: opts.app, realHome });
    integrationAgent = opts.agent ?? plan.profileAdapter ?? "claude-code";
    // Every refusal happens here, before anything is written.
    if (opts.agentIntegration) integration = planIntegration({ agent: integrationAgent, env, L: plan.L, nodePath: plan.nodePath, record: plan.record, claudeFallbacks, codexFallbacks, mcpTimeoutMs, realHome });
  } catch (e) {
    err(`setup: ${e.message}`);
    return 1;
  }
  const { L, dirs, steps, warnings } = plan;
  for (const w of [...warnings, ...(integration?.warnings ?? [])]) err(`warning: ${w}`);
  const mode = (m) => m.toString(8).padStart(4, "0");

  if (opts.dryRun) {
    out(`Dry run: nothing is written.`);
    for (const d of dirs) {
      if (!d.exists) out(`would create dir ${d.path}${d.private ? " (0700)" : ""}`);
      else if (d.private && d.mode !== 0o700) out(`would chmod existing dir ${d.path} to 0700 (now ${mode(d.mode)})`);
      else out(`would keep dir ${d.path}${d.private ? " (0700)" : ""}`);
    }
    for (const s of steps) out(`${s.keep ? "would keep" : "would write"} ${s.path} (${mode(s.mode)}): ${s.summary}`);
    out(`would record ${steps.length} files in ${L.installed} (0600)`);
    if (integration) {
      out("Agent integration:");
      for (const line of describeIntegration(integration)) out(line);
      for (const line of integrationExplanation(integration.agent)) out(line);
    } else integrationHint(plan.record, integrationAgent, out);
    return 0;
  }

  let current = L.scoutHome;
  let record = plan.record ?? { version: 1, marker: plan.marker, files: [] };
  try {
    for (const d of dirs) {
      current = d.path;
      if (d.private) ensurePrivateDir(d.path);
      else mkdirSync(d.path, { recursive: true });
    }
    // Record the marker before writing any file that carries it, so a crash leaves a re-runnable install.
    current = L.installed;
    saveInstalled(L.installed, record);
    for (const s of steps) {
      current = s.path;
      s.write();
      record = upsertEntry(record, s.entry);
      current = L.installed;
      saveInstalled(L.installed, record);
      out(`${s.keep ? "kept " : "wrote"} ${s.path} (${mode(s.mode)})`);
    }
  } catch (e) {
    err(`setup: failed at ${current}: ${e.message}`);
    err(`setup: files written so far are recorded in ${L.installed}; fix the cause and re-run (re-running is safe).`);
    return 1;
  }
  if (integration) {
    try {
      record = applyIntegration(integration, record, { env, mcpTimeoutMs, out, save: (r) => saveInstalled(L.installed, r) });
    } catch (e) {
      err(`setup: agent integration failed: ${e.message}`);
      err(`setup: what was done is recorded in ${L.installed}; re-run, or remove it with \`npm run uninstall -- --agent-integration\`.`);
      return 1;
    }
  }
  out(`recorded ${record.files.length} entries in ${L.installed}`);
  if (opts.loginLaunch) out(`Login launch: Scout starts at login from now on; it takes effect at your next login (to start it now, open the app). \`npm run uninstall\` removes ${L.launchAgent}.`);
  out(`extension ID: ${plan.extensionId}`);
  for (const line of NEXT_STEPS) out(line);
  out(`Unpacked extension folder: ${L.extensionManifest.replace(/\/manifest\.json$/, "")}. Then run \`npm run doctor\`.`);
  if (integration) {
    out("Agent integration installed.");
    for (const line of integrationExplanation(integration.agent)) out(line);
  } else integrationHint(record, integrationAgent, out);
  return 0;
}

function integrationHint(record, agent, out) {
  if (hasRecordedIntegration(record, agent)) return;
  const flag = agent === "codex" ? "--agent codex --agent-integration" : "--agent-integration";
  out(`Optional: \`npm run setup -- ${flag}\` adds the \`scout\` MCP connection and skill to all of your ${AGENTS[agent].label} sessions.`);
}

if (isMain(import.meta.url)) process.exitCode = runSetup(process.argv.slice(2));
