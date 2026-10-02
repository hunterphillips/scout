#!/usr/bin/env node
// Scout doctor: read-only report of what setup installed and what is running, in eight
// sections, each ok / warn / fail with one line, followed by its checks that are not OK
// (all checks with --verbose). Exits 1 if any check fails, else 0.
//
//   install record      installed.json, its marker and entries, a legacy `config-merged` entry
//                       (noted, never acted on), the Scout config, private dirs
//   Mac app             the installed Scout.app (bundle-app --install, hash-checked) and the
//                       login LaunchAgent (FAIL when the binary it starts is missing)
//   core                whether Scout runs (pid from capabilities/store.lock), run/core.sock,
//                       run/agent.sock, run/agent-token ownership and modes
//   Chrome relay        the native-messaging manifest (allowed_origins), wrapper, extension key,
//                       and the bridge protocol the installed host speaks (read from the built
//                       contracts; Chrome is never started)
//   agent integration   the `scout` MCP registration (exact match via `claude mcp get`, which
//                       the CLI also uses to health-check the server) and the skill
//   CLI                 the agent profile's claude and `claude --version` against the version
//                       Scout's flag set was verified with (advisory)
//   billing             the core's last logged billing preflight verdict, or "not yet checked";
//                       doctor never runs a preflight and never spends quota
//   recommendations     config.json `destinations`; empty means off
// Runs no model, connects to no socket, writes nothing. SCOUT_SKILLS_ROOT or SCOUT_CLAUDE_BIN
// with the real ~/.scout is a failed check.
//
// Usage: node scripts/doctor.mjs [--verbose]
// Env overrides: SCOUT_HOME, CHROME_NMH_DIR, SCOUT_CLAUDE_BIN, LAUNCH_AGENTS_DIR,
// SCOUT_APPLICATIONS_DIR (see lib/paths.mjs); one that breaks the test-override rule is a FAIL.

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { HOST_NAME, REPO_ROOT, layout, locationOverrideRefusal } from "./lib/paths.mjs";
import { EXTENSION_ID_RE, extensionIdFromManifestKey, extensionIdFromPem } from "./lib/extension-key.mjs";
import { isExecutableFile } from "./lib/executables.mjs";
import { allowedPath, readInstalled } from "./lib/installed.mjs";
import { exists, readJsonObject, wrapperScript } from "./lib/files.mjs";
import { isMain } from "./lib/is-main.mjs";
import { checkIntegration, integrationClaude } from "./lib/agent-integration.mjs";
import { appBundleHash, applicationsRefusal, isScoutBundle, launchAgentRefusal, sha256 } from "./lib/app-bundle.mjs";
import { coreLockHolder, inspectPrivate, lastPreflight } from "./lib/core-state.mjs";

const oct = (m) => (m & 0o777).toString(8).padStart(4, "0");
const CLI_VERSION_TIMEOUT_MS = 10_000;

export const SECTIONS = ["install record", "Mac app", "core", "Chrome relay", "agent integration", "CLI", "billing", "recommendations"];

const tryRead = (fn) => {
  try {
    return { value: fn() };
  } catch (e) {
    return { error: e.message };
  }
};

/** `export const NAME = <number or "string">` from a built file, or null. */
function builtConstant(path, name) {
  const text = tryRead(() => readFileSync(path, "utf8")).value;
  const m = text && new RegExp(`export const ${name} = ("[^"]*"|\\d+);`).exec(text);
  return m ? JSON.parse(m[1]) : null;
}

/**
 * Every section: [{ title, status: "ok"|"warn"|"fail", summary, checks: [{ status: "OK"|"WARN"|"FAIL", label, detail }] }].
 * Writes nothing. `claudeVersion(path)` replaces running `<path> --version` (tests).
 */
export function runReport(env = process.env, { claudeFallbacks, mcpTimeoutMs, realHome, claudeVersion = runClaudeVersion } = {}) {
  const sections = new Map(SECTIONS.map((t) => [t, { title: t, summary: "", checks: [] }]));
  let current;
  const section = (title, summary) => {
    current = sections.get(title);
    current.summary = summary;
  };
  const add = (status, label, detail = "") => current.checks.push({ status, label, detail });
  const check = (ok, label, detail) => add(ok ? "OK" : "FAIL", label, detail);

  const base = layout({ env });
  const installed = tryRead(() => readInstalled(base.installed));
  const record = installed.value ?? null;
  const marker = record?.marker;
  const sc = tryRead(() => readJsonObject(base.scoutConfig));
  const scout = sc.value ?? null;
  const L = layout({ env, scoutRoot: typeof scout?.scoutRoot === "string" ? scout.scoutRoot : REPO_ROOT });
  const extensionId = scout?.extensionId;
  const markerCheck = (value, label) => check(marker != null && value === marker, label, `${String(value)} (recorded ${String(marker)})`);
  const uid = process.getuid();
  const privateDir = (dir, label, optional) => {
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      if (!optional) add("FAIL", label, `${dir} missing`);
      return;
    }
    check(st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o777) === 0o700, label, `${dir} ${oct(st.mode)} uid=${st.uid}`);
  };

  // ---- install record
  section("install record", record ? `${base.installed}: ${record.files.length} entr${record.files.length === 1 ? "y" : "ies"}` : `${base.installed} ${installed.error ? "unreadable" : "missing"}; run \`npm run setup\``);
  check(record != null, "install record parses", installed.error ?? (record ? base.installed : `${base.installed} missing`));
  if (record) {
    const outside = record.files.filter((f) => !allowedPath(f.kind, f.path, L, record));
    check(outside.length === 0, "install record lists only paths setup writes", outside.length ? outside.map((f) => `${f.kind} ${f.path}`).join("; ") : base.installed);
    for (const f of record.files.filter((x) => x.kind === "config-merged")) {
      add("OK", "legacy personal-context record noted, never acted on", `${f.path}: setup no longer merges into it; uninstall drops the entry and leaves the file and its directory`);
    }
  }
  check(scout != null, "scout config exists and parses", sc.error ?? (scout ? base.scoutConfig : `${base.scoutConfig} missing`));
  if (scout) markerCheck(scout.x_scout_marker, "scout config carries the recorded marker");
  check(isExecutableFile(scout?.nodePath), "scout nodePath is an executable file", String(scout?.nodePath));
  check(exists(L.coreMain), "scoutRoot has scout-core dist/main.js", L.coreMain);
  privateDir(L.scoutHome, "scout home is a 0700 dir owned by you", false);
  privateDir(L.binDir, "scout bin dir is a 0700 dir owned by you", false);

  // ---- Mac app
  section("Mac app", "");
  const installedApp = record?.files.find((f) => f.kind === "app-bundle");
  const launch = record?.files.find((f) => f.kind === "launch-agent");
  for (const [entry, rule, name] of [[installedApp, applicationsRefusal, "SCOUT_APPLICATIONS_DIR"], [launch, launchAgentRefusal, "LAUNCH_AGENTS_DIR"]]) {
    const r = entry && rule(env, realHome);
    if (r) add("FAIL", `${name} test-override rule`, r);
  }
  let appLine;
  if (installedApp) {
    if (!allowedPath("app-bundle", installedApp.path, L, record)) {
      add("FAIL", "installed Scout.app", `recorded path is not the install location: ${installedApp.path}`);
      appLine = "install record unusable";
    } else if (!exists(installedApp.path)) {
      add("FAIL", "installed Scout.app", `${installedApp.path} is gone; re-run \`npm run bundle-app -- --install\``);
      appLine = "installed app missing";
    } else if (appBundleHash(installedApp.path) !== installedApp.sha256) {
      add("WARN", "installed Scout.app is unchanged since bundle-app --install", `${installedApp.path} changed; uninstall will leave it`);
      appLine = `installed at ${installedApp.path} (changed)`;
    } else {
      add("OK", "installed Scout.app", installedApp.path);
      appLine = `installed at ${installedApp.path}`;
    }
  } else {
    const built = isScoutBundle(L.appBundle);
    add("WARN", "installed Scout.app", `not installed; \`npm run bundle-app -- --install\` copies it to ${L.installedApp}${built ? ` (a build exists at ${L.appBundle})` : ""}`);
    appLine = built ? `built at ${L.appBundle}, not installed` : "not installed";
  }
  let loginLine = "login launch off";
  if (launch) {
    const text = tryRead(() => readFileSync(launch.path, "utf8")).value;
    if (!allowedPath("launch-agent", launch.path, L, record)) add("FAIL", "login LaunchAgent", `recorded path is not one setup writes: ${launch.path}`);
    else if (text == null) add("FAIL", "login LaunchAgent", `${launch.path} is gone; re-run \`npm run setup -- --login-launch\``);
    else if (sha256(text) !== launch.sha256) add("WARN", "login LaunchAgent is unchanged since setup", `${launch.path} changed; uninstall will leave it`);
    else {
      const ok = isExecutableFile(launch.program);
      check(ok, "login LaunchAgent starts an existing app binary", ok ? String(launch.program) : `${launch.program} is missing; re-run \`npm run bundle-app -- --install\``);
      loginLine = ok ? "login launch on" : "login launch broken";
    }
  } else if (exists(L.launchAgent)) {
    add("WARN", "login LaunchAgent", `${L.launchAgent} exists but setup did not write it`);
  } else add("OK", "login LaunchAgent", "off (optional: `npm run setup -- --login-launch`)");
  current.summary = `${appLine}; ${loginLine}`;

  // ---- core
  const holder = coreLockHolder(L);
  const running = holder.state === "running";
  section("core", running ? `running (pid ${holder.pid})` : `not running${holder.state === "stale" ? ` (stale lock from pid ${holder.pid})` : ""}; with Scout quit, the side panel says so and nothing is recorded`);
  add(running ? "OK" : "WARN", "core process", running ? `pid ${holder.pid} holds ${L.storeLock}` : holder.state === "unreadable" ? `${L.storeLock} unreadable` : "not running; start Scout");
  privateDir(L.runDir, "scout run dir is a 0700 dir owned by you", true);
  for (const [path, kind, mode, label] of [
    [L.coreSock, "socket", 0o600, "run/core.sock is a 0600 socket owned by you"],
    [L.agentSock, "socket", 0o600, "run/agent.sock is a 0600 socket owned by you"],
    [L.agentToken, "file", 0o600, "run/agent-token is a 0600 file owned by you"],
  ]) {
    const seen = inspectPrivate(path, kind, mode);
    if (seen.state === "bad") add("FAIL", label, seen.detail);
    else if (seen.state === "absent") add(running ? "FAIL" : "OK", label, running ? `${path} absent while Scout runs` : `${path} absent (Scout not running)`);
    else add(running ? "OK" : "WARN", label, running ? seen.detail : `${seen.detail}, left by a core that is gone; the next start replaces it`);
  }

  // ---- Chrome relay
  const protocol = builtConstant(join(L.scoutRoot, "packages", "contracts", "dist", "bridge.js"), "BRIDGE_PROTOCOL");
  section("Chrome relay", "");
  const nmhRule = locationOverrideRefusal("CHROME_NMH_DIR", env, realHome);
  if (nmhRule) add("FAIL", "CHROME_NMH_DIR test-override rule", nmhRule);
  check(exists(L.hostJs), "scoutRoot has native-host dist/host.js", L.hostJs);
  check(protocol !== null, "the installed host's bridge protocol", protocol !== null ? `protocol ${protocol} (from the built contracts)` : "packages/contracts/dist/bridge.js missing; run `npm run build`");
  check(typeof extensionId === "string" && EXTENSION_ID_RE.test(extensionId), "extensionId is 32 chars a-p", String(extensionId));
  const w = tryRead(() => ({ st: lstatSync(L.wrapper), text: readFileSync(L.wrapper, "utf8") }));
  check(w.value?.st.isFile(), "native host wrapper exists", w.error ?? L.wrapper);
  if (w.value?.st.isFile()) {
    check((w.value.st.mode & 0o777) === 0o700, "wrapper mode is 0700", oct(w.value.st.mode));
    const expected = marker && scout ? wrapperScript({ nodePath: scout.nodePath, hostJs: L.hostJs, scoutHome: L.scoutHome, marker }) : null;
    check(expected !== null && w.value.text === expected, "wrapper has the marker and the configured node and host paths", L.wrapper);
  }
  const nm = tryRead(() => readJsonObject(L.nmhManifest));
  const nmh = nm.value ?? null;
  let originsOk = false;
  check(nmh != null, "native messaging manifest exists and parses", nm.error ?? (nmh ? L.nmhManifest : `${L.nmhManifest} missing`));
  if (nmh) {
    markerCheck(nmh.x_scout_marker, "native messaging manifest carries the recorded marker");
    const st = tryRead(() => lstatSync(L.nmhManifest));
    check(st.value?.isFile() && (st.value.mode & 0o777) === 0o644, "native messaging manifest is a 0644 file", st.error ?? oct(st.value.mode));
    check(nmh.name === HOST_NAME && nmh.type === "stdio", "manifest name and type", `${nmh.name} ${nmh.type}`);
    check(nmh.path === L.wrapper, "manifest path is the wrapper", String(nmh.path));
    const origins = nmh.allowed_origins;
    originsOk = Array.isArray(origins) && origins.length === 1 && origins[0] === `chrome-extension://${extensionId}/`;
    check(originsOk, "allowed_origins is exactly the extension origin", JSON.stringify(origins));
  }
  const em = tryRead(() => readJsonObject(L.extensionManifest));
  const key = em.value?.key;
  const derived = typeof key === "string" ? (tryRead(() => extensionIdFromManifestKey(key)).value ?? null) : null;
  check(derived !== null && derived === extensionId, "built extension manifest key derives extensionId", em.error ?? (typeof key === "string" ? `${L.extensionManifest} -> ${derived}` : `${L.extensionManifest} has no key; re-run \`npm run setup\``));
  const k = tryRead(() => ({ st: lstatSync(L.keyPem), pem: readFileSync(L.keyPem, "utf8") }));
  check(k.value?.st.isFile() && (k.value.st.mode & 0o777) === 0o600, "extension key is a 0600 file", k.error ?? `${L.keyPem} ${oct(k.value.st.mode)}`);
  if (k.value) {
    const id = tryRead(() => extensionIdFromPem(k.value.pem));
    check(id.value === extensionId, "extension key derives extensionId", id.error ?? String(id.value));
  }
  current.summary = `${originsOk ? `host ${HOST_NAME} allows chrome-extension://${extensionId}/` : "host manifest not usable"}; bridge protocol ${protocol ?? "unknown"}`;

  // ---- agent integration
  const integration = record ? checkIntegration(record, { env, L, claudeFallbacks, mcpTimeoutMs, realHome }) : [];
  section("agent integration", integration.length === 1 && /not installed/.test(integration[0].detail) ? "not installed (optional)" : record ? "installed" : "no install record");
  current.checks.push(...integration);
  if (record && current.summary === "installed") current.summary = integration.every((c) => c.status === "OK") ? "installed; registration and skill are this install's" : "installed; see below";

  // ---- CLI
  section("CLI", "");
  const profile = tryRead(() => readJsonObject(L.agentProfile));
  const recordedProfile = record?.files.find((f) => f.kind === "agent-profile");
  let claudePath = null;
  if (profile.value) {
    claudePath = typeof profile.value.claudePath === "string" && isAbsolute(profile.value.claudePath) ? profile.value.claudePath : null;
    check(isExecutableFile(claudePath), "agent profile names an executable claude", `${L.agentProfile}: ${String(profile.value.claudePath)}`);
    const text = tryRead(() => readFileSync(L.agentProfile, "utf8")).value;
    if (recordedProfile && text != null && sha256(text) !== recordedProfile.sha256) add("OK", "agent profile", "edited since setup wrote it (yours now; uninstall leaves it)");
  } else {
    add("WARN", "agent profile", profile.error ? `${L.agentProfile} unreadable` : `${L.agentProfile} missing: background recommendations are unavailable; re-run \`npm run setup\` once claude is installed`);
    // As setup: SCOUT_CLAUDE_BIN on a test home, never a claude found on PATH there.
    claudePath = integrationClaude(env, claudeFallbacks, realHome).path ?? null;
  }
  const verified = builtConstant(join(L.scoutRoot, "packages", "scout-core", "dist", "agents", "claudeJob.js"), "VERIFIED_CLI_VERSION");
  let version = null;
  if (claudePath && isExecutableFile(claudePath)) {
    version = claudeVersion(claudePath, env);
    if (!version) add("WARN", "claude --version", `${claudePath} printed no version`);
    else if (verified && version !== verified) add("WARN", "claude version matches the verified one (advisory)", `${version}; Scout's flag set was verified with ${verified}. Jobs still run; a new version triggers one re-check of billing`);
    else add("OK", "claude version matches the verified one (advisory)", `${version}${verified ? "" : " (verified version unknown: scout-core not built)"}`);
  } else if (!profile.value) add("WARN", "claude", "not found on PATH, ~/.local/bin, or /opt/homebrew/bin");
  current.summary = claudePath ? `${claudePath}${version ? ` ${version}` : ""}${verified ? ` (verified ${verified})` : ""}` : "no claude";

  // ---- billing
  const pre = lastPreflight(L.diagnosticsLog);
  section("billing", pre ? `last preflight: ${pre.verdict}${pre.cliVersion ? ` (CLI ${pre.cliVersion})` : ""}` : "not yet checked");
  if (!pre) add("WARN", "billing preflight", "not yet checked: the core runs it before the first job; doctor never runs one");
  else add(pre.verdict === "subscription" ? "OK" : "WARN", "billing preflight", `${pre.verdict} at ${new Date(pre.t).toISOString()}${pre.verdict === "subscription" ? "" : ": jobs run only on a subscription verdict"}`);

  // ---- recommendations
  const destinations = Array.isArray(scout?.destinations) ? scout.destinations : [];
  section("recommendations", destinations.length ? `on for ${destinations.join(", ")}` : "off (no destinations in config.json)");
  add("OK", "destinations", destinations.length ? `${destinations.length} host(s); every settled visit there spends your Claude quota` : "off");

  return [...sections.values()].map((s) => ({
    ...s,
    status: s.checks.some((c) => c.status === "FAIL") ? "fail" : s.checks.some((c) => c.status === "WARN") ? "warn" : "ok",
  }));
}

/** Every check, flattened, each with its section title. */
export function runChecks(env = process.env, opts = {}) {
  return runReport(env, opts).flatMap((s) => s.checks.map((c) => ({ ...c, section: s.title })));
}

/** `<claude> --version` → "2.1.286", or null. Read-only; no model call. */
export function runClaudeVersion(claudePath, env = process.env) {
  const r = spawnSync(claudePath, ["--version"], { env: { ...env }, cwd: tmpdir(), encoding: "utf8", timeout: CLI_VERSION_TIMEOUT_MS, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
  return /(\d+\.\d+\.\d+)/.exec(r.stdout ?? "")?.[1] ?? null;
}

export function runDoctor(env = process.env, out = console.log, opts = {}) {
  const sections = runReport(env, opts);
  for (const s of sections) {
    out(`${s.status.padEnd(4)} ${s.title}: ${s.summary}`);
    for (const c of s.checks) if (opts.verbose || c.status !== "OK" || c.label.startsWith("legacy")) out(`     ${c.status.padEnd(4)} ${c.label}${c.detail ? `: ${c.detail}` : ""}`);
  }
  const failed = sections.flatMap((s) => s.checks).filter((c) => c.status === "FAIL").length;
  out(failed ? `${failed} check(s) failed.` : "No failed checks.");
  return failed ? 1 : 0;
}

if (isMain(import.meta.url)) process.exitCode = runDoctor(process.env, console.log, { verbose: process.argv.includes("--verbose") });
