#!/usr/bin/env node
// Scout setup: install the extension key, configs, native host wrapper, and
// Chrome native-messaging manifest. Every file written is recorded in
// <SCOUT_HOME>/installed.json so uninstall.mjs can remove exactly those.
//
// Usage: node scripts/setup.mjs [--dry-run] [--yes] [--scout-root <dir>]
// Env overrides: SCOUT_HOME, PERSONAL_CONTEXT_HOME, CHROME_NMH_DIR (see lib/paths.mjs).
// Never touches ~/.rook or any process.

import { mkdirSync, readFileSync, statSync } from "node:fs";
import { DEFAULT_DESTINATIONS, HOST_NAME, REPO_ROOT, layout } from "./lib/paths.mjs";
import { extensionIdFromPem, generateKeyPem, manifestKey } from "./lib/extension-key.mjs";
import { defaultClaudeFallbacks, isExecutableFile, resolveClaude, resolveNode } from "./lib/executables.mjs";
import { newMarker, readInstalled, upsertEntry } from "./lib/installed.mjs";
import { ensurePrivateDir, exists, fileMarker, readJsonObject, wrapperScript, writeFileMode, writeJson } from "./lib/files.mjs";
import { isMain } from "./lib/is-main.mjs";

export function parseArgs(argv) {
  const opts = { dryRun: false, yes: false, scoutRoot: REPO_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--yes") opts.yes = true;
    else if (a === "--scout-root") {
      if (!argv[i + 1]) throw new Error("--scout-root needs a directory");
      opts.scoutRoot = argv[++i];
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function validDestinations(v) {
  return Array.isArray(v) && v.length > 0 && v.every((d) => typeof d === "string" && d.length > 0);
}

/**
 * Work out everything setup would write without writing anything.
 * Returns { L, marker, extensionId, claudePath, warnings, steps } where each step is
 * { path, kind, mode, summary, entry, write() }.
 */
export function planSetup({ env = process.env, scoutRoot = REPO_ROOT, dryRun = false } = {}) {
  const L = layout({ env, scoutRoot });
  const warnings = [];

  if (!exists(L.extensionManifest)) {
    throw new Error(`built extension manifest not found at ${L.extensionManifest}\nRun \`npm run build\` in ${L.scoutRoot} first.`);
  }
  const extManifest = readJsonObject(L.extensionManifest);
  if (!exists(L.hostJs)) warnings.push(`native host not built yet: ${L.hostJs} (run \`npm run build\`)`);

  const record = readInstalled(L.installed);
  const marker = record?.marker ?? newMarker();

  const nodePath = resolveNode();
  if (!isExecutableFile(nodePath)) throw new Error(`node path is not an executable file: ${nodePath}`);
  const claudePath = resolveClaude({ pathVar: env.PATH ?? "", fallbacks: defaultClaudeFallbacks(env) });
  if (!claudePath) warnings.push("claude not found on PATH, ~/.local/bin, or /opt/homebrew/bin; writing claudePath: null (Phase 3 needs it)");

  // Refuse to overwrite a marker-bearing file that isn't ours.
  const foreign = [
    [L.scoutConfig, "config"],
    [L.pcConfig, "config"],
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
  let pem = keyExists ? readFileSync(L.keyPem, "utf8") : null;
  if (!pem && !dryRun) pem = generateKeyPem();
  const extensionId = pem ? extensionIdFromPem(pem) : null;
  const key = pem ? manifestKey(pem) : null;
  const idText = extensionId ?? "<derived from the new key>";

  const existingScout = readJsonObject(L.scoutConfig) ?? {};
  const destinations = validDestinations(existingScout.destinations) ? existingScout.destinations : DEFAULT_DESTINATIONS;
  const scoutConfig = { ...existingScout, x_scout_marker: marker, nodePath, scoutRoot: L.scoutRoot, extensionId, destinations };
  const existingPc = readJsonObject(L.pcConfig) ?? {};
  const pcConfig = { ...existingPc, x_scout_marker: marker, nodePath, claudePath };
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
      summary: keyExists ? "extension key (exists, reused)" : "new 2048-bit RSA extension key (would generate)",
      entry: { path: L.keyPem, kind: "key", extensionId },
      write: keyExists ? null : () => writeFileMode(L.keyPem, pem, 0o600),
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
      kind: "config",
      mode: 0o600,
      summary: `nodePath=${nodePath} claudePath=${claudePath ?? "null"}`,
      entry: { path: L.pcConfig, kind: "config" },
      write: () => writeJson(L.pcConfig, pcConfig, 0o600),
    },
    {
      path: L.wrapper,
      kind: "wrapper",
      mode: 0o700,
      summary: `exec "${nodePath}" "${L.hostJs}" "$@"`,
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
  return { L, marker, record, extensionId, nodePath, claudePath, warnings, steps };
}

export function runSetup(argv, { env = process.env, out = console.log, err = console.error } = {}) {
  let opts, plan;
  try {
    opts = parseArgs(argv);
    plan = planSetup({ env, scoutRoot: opts.scoutRoot, dryRun: opts.dryRun });
  } catch (e) {
    err(`setup: ${e.message}`);
    return 1;
  }
  const { L, steps, warnings } = plan;
  for (const w of warnings) err(`warning: ${w}`);
  const mode = (m) => m.toString(8).padStart(4, "0");

  if (opts.dryRun) {
    out(`Dry run: nothing is written.`);
    out(`would create dirs ${L.scoutHome} (0700), ${L.binDir} (0700), ${L.pcHome} (0700), ${L.nmhDir}`);
    for (const s of steps) {
      const verb = s.write ? "would write" : "would keep";
      out(`${verb} ${s.path} (${mode(s.mode)}): ${s.summary}`);
    }
    out(`would record ${steps.length} files in ${L.installed} (0600)`);
    return 0;
  }

  ensurePrivateDir(L.scoutHome);
  ensurePrivateDir(L.binDir);
  ensurePrivateDir(L.pcHome);
  mkdirSync(L.nmhDir, { recursive: true });

  let record = plan.record ?? { version: 1, marker: plan.marker, files: [] };
  for (const s of steps) {
    if (s.write) s.write();
    record = upsertEntry(record, s.entry);
    writeJson(L.installed, record, 0o600);
    out(`${s.write ? "wrote" : "kept "} ${s.path} (${mode(s.mode)})`);
  }
  out(`recorded ${record.files.length} files in ${L.installed}`);
  out(`extension ID: ${plan.extensionId}`);
  out(`Load the unpacked extension from ${L.extensionManifest.replace(/\/manifest\.json$/, "")}, then run \`npm run doctor\`.`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = runSetup(process.argv.slice(2));
