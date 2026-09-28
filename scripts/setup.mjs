#!/usr/bin/env node
// Scout setup: install the extension key, configs, native host wrapper, and
// Chrome native-messaging manifest. Every file written is recorded in
// <SCOUT_HOME>/installed.json so uninstall.mjs can remove exactly those.
// ~/.personal-context-mcp/config.json belongs to the personal-context service;
// setup only merges nodePath, claudePath, and x_scout_marker into it.
//
// Usage: node scripts/setup.mjs [--dry-run] [--scout-root <dir>]
// Env overrides: SCOUT_HOME, PERSONAL_CONTEXT_HOME, CHROME_NMH_DIR (see lib/paths.mjs).
// With SCOUT_HOME set, --scout-root is required so a test install cannot re-key the
// real built extension.
// Never touches ~/.rook or any process.

import { chmodSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { DEFAULT_DESTINATIONS, HOST_NAME, REPO_ROOT, layout } from "./lib/paths.mjs";
import { extensionIdFromPem, generateKeyPem, manifestKey } from "./lib/extension-key.mjs";
import { defaultClaudeFallbacks, isExecutableFile, resolveClaude, resolveNode } from "./lib/executables.mjs";
import { PC_MERGED_KEYS, newMarker, readInstalled, upsertEntry } from "./lib/installed.mjs";
import { checkPrivateDir, ensurePrivateDir, exists, fileMarker, readJsonObject, shDoubleQuote, wrapperScript, writeFileMode, writeJson } from "./lib/files.mjs";
import { isMain } from "./lib/is-main.mjs";

export function parseArgs(argv) {
  const opts = { dryRun: false, scoutRoot: REPO_ROOT, scoutRootGiven: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--scout-root") {
      if (!argv[i + 1]) throw new Error("--scout-root needs a directory");
      opts.scoutRoot = argv[++i];
      opts.scoutRootGiven = true;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function validDestinations(v) {
  return Array.isArray(v) && v.length > 0 && v.every((d) => typeof d === "string" && d.length > 0);
}

/**
 * Work out everything setup would write without writing anything.
 * Returns { L, marker, extensionId, claudePath, warnings, dirs, steps } where each step is
 * { path, kind, mode, summary, entry, keep, write() }. `claudeFallbacks` overrides the
 * places searched for claude after PATH (tests pass [] to make "not found" deterministic).
 */
export function planSetup({ env = process.env, scoutRoot = REPO_ROOT, dryRun = false, claudeFallbacks } = {}) {
  const L = layout({ env, scoutRoot });
  const warnings = [];

  // Run the private-dir checks up front, so a dry run fails the same way a real run would.
  const dirs = [L.scoutHome, L.binDir, L.pcHome].map((path) => ({ path, private: true, ...checkPrivateDir(path) }));
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
  const claudePath = resolveClaude({ pathVar: env.PATH ?? "", fallbacks: claudeFallbacks ?? defaultClaudeFallbacks(env) });
  if (!claudePath) warnings.push("claude not found on PATH, ~/.local/bin, or /opt/homebrew/bin; writing claudePath: null (Phase 3 needs it)");

  // Refuse to overwrite any Scout-owned file that exists without this install's marker.
  // The personal-context config is not in this list: it is merged, not owned.
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
  let existingPc;
  try {
    existingPc = readJsonObject(L.pcConfig) ?? {};
  } catch (e) {
    throw new Error(`cannot merge into ${L.pcConfig}: ${e.message}\nFix or move it aside and re-run.`);
  }
  const pcConfig = { ...existingPc, x_scout_marker: marker, nodePath, claudePath };
  const pcKept = Object.keys(existingPc).filter((k) => !PC_MERGED_KEYS.includes(k));
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
      path: L.pcConfig,
      kind: "config-merged",
      mode: 0o600,
      summary:
        `merge nodePath=${nodePath} claudePath=${claudePath ?? "null"}` +
        (pcKept.length ? ` (keeps existing keys: ${pcKept.join(", ")})` : " (new file)"),
      entry: { path: L.pcConfig, kind: "config-merged", keys: PC_MERGED_KEYS },
      write: () => writeJson(L.pcConfig, pcConfig, 0o600),
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
  return { L, marker, record, extensionId, nodePath, claudePath, warnings, dirs, steps };
}

export function runSetup(argv, { env = process.env, out = console.log, err = console.error, claudeFallbacks } = {}) {
  let opts, plan;
  try {
    opts = parseArgs(argv);
    if (env.SCOUT_HOME && !opts.scoutRootGiven) {
      throw new Error(
        `SCOUT_HOME is set but --scout-root is not; a test install would re-key the real built extension in ${REPO_ROOT}.\n` +
          `Pass --scout-root <dir> pointing at a separate built copy.`,
      );
    }
    plan = planSetup({ env, scoutRoot: opts.scoutRoot, dryRun: opts.dryRun, claudeFallbacks });
  } catch (e) {
    err(`setup: ${e.message}`);
    return 1;
  }
  const { L, dirs, steps, warnings } = plan;
  for (const w of warnings) err(`warning: ${w}`);
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
    writeJson(L.installed, record, 0o600);
    for (const s of steps) {
      current = s.path;
      s.write();
      record = upsertEntry(record, s.entry);
      current = L.installed;
      writeJson(L.installed, record, 0o600);
      out(`${s.keep ? "kept " : "wrote"} ${s.path} (${mode(s.mode)})`);
    }
  } catch (e) {
    err(`setup: failed at ${current}: ${e.message}`);
    err(`setup: files written so far are recorded in ${L.installed}; fix the cause and re-run (re-running is safe).`);
    return 1;
  }
  out(`recorded ${record.files.length} files in ${L.installed}`);
  out(`extension ID: ${plan.extensionId}`);
  out(`Load the unpacked extension from ${L.extensionManifest.replace(/\/manifest\.json$/, "")}, then run \`npm run doctor\`.`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = runSetup(process.argv.slice(2));
