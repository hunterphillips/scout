#!/usr/bin/env node
// Scout doctor: read-only checks of what setup.mjs installed. Prints one
// OK / WARN / FAIL line per check; exits 1 if any check fails.
//
// Usage: node scripts/doctor.mjs
// Env overrides: SCOUT_HOME, PERSONAL_CONTEXT_HOME, CHROME_NMH_DIR (see lib/paths.mjs).

import { lstatSync, readFileSync } from "node:fs";
import { HOST_NAME, REPO_ROOT, layout } from "./lib/paths.mjs";
import { EXTENSION_ID_RE, extensionIdFromManifestKey, extensionIdFromPem } from "./lib/extension-key.mjs";
import { isExecutableFile } from "./lib/executables.mjs";
import { readInstalled } from "./lib/installed.mjs";
import { exists, readJsonObject, wrapperScript } from "./lib/files.mjs";
import { isMain } from "./lib/is-main.mjs";

const oct = (m) => (m & 0o777).toString(8).padStart(4, "0");

/** Run every check; returns [{ status: "OK"|"WARN"|"FAIL", label, detail }]. Writes nothing. */
export function runChecks(env = process.env) {
  const results = [];
  const add = (status, label, detail = "") => results.push({ status, label, detail });
  const check = (ok, label, detail) => add(ok ? "OK" : "FAIL", label, detail);
  const tryRead = (fn) => {
    try {
      return { value: fn() };
    } catch (e) {
      return { error: e.message };
    }
  };

  const base = layout({ env });
  const installed = tryRead(() => readInstalled(base.installed));
  check(installed.value != null, "install record parses", installed.error ?? (installed.value ? base.installed : `${base.installed} missing`));
  const marker = installed.value?.marker;

  const sc = tryRead(() => readJsonObject(base.scoutConfig));
  const scout = sc.value ?? null;
  check(scout != null, "scout config exists and parses", sc.error ?? (scout ? base.scoutConfig : `${base.scoutConfig} missing`));
  const pc = tryRead(() => readJsonObject(base.pcConfig));
  const pcCfg = pc.value ?? null;
  check(pcCfg != null, "personal-context config exists and parses", pc.error ?? (pcCfg ? base.pcConfig : `${base.pcConfig} missing`));

  const L = layout({ env, scoutRoot: typeof scout?.scoutRoot === "string" ? scout.scoutRoot : REPO_ROOT });
  const extensionId = scout?.extensionId;

  check(isExecutableFile(scout?.nodePath), "scout nodePath is an executable file", String(scout?.nodePath));
  check(isExecutableFile(pcCfg?.nodePath), "personal-context nodePath is an executable file", String(pcCfg?.nodePath));
  if (pcCfg && pcCfg.claudePath == null) add("WARN", "claudePath not set", "Phase 3 needs it; re-run setup once claude is installed");
  else check(isExecutableFile(pcCfg?.claudePath), "claudePath is an executable file", String(pcCfg?.claudePath));

  check(typeof extensionId === "string" && EXTENSION_ID_RE.test(extensionId), "extensionId is 32 chars a-p", String(extensionId));
  check(exists(L.coreMain), "scoutRoot has scout-core dist/main.js", L.coreMain);
  check(exists(L.hostJs), "scoutRoot has native-host dist/host.js", L.hostJs);

  // Wrapper
  const w = tryRead(() => ({ st: lstatSync(L.wrapper), text: readFileSync(L.wrapper, "utf8") }));
  check(w.value?.st.isFile(), "native host wrapper exists", w.error ?? L.wrapper);
  if (w.value?.st.isFile()) {
    check((w.value.st.mode & 0o777) === 0o700, "wrapper mode is 0700", oct(w.value.st.mode));
    const expected = marker && scout ? wrapperScript({ nodePath: scout.nodePath, hostJs: L.hostJs, scoutHome: L.scoutHome, marker }) : null;
    check(expected !== null && w.value.text === expected, "wrapper has the marker and the configured node and host paths", L.wrapper);
  }

  // Native messaging manifest
  const nm = tryRead(() => readJsonObject(L.nmhManifest));
  const nmh = nm.value ?? null;
  check(nmh != null, "native messaging manifest exists and parses", nm.error ?? (nmh ? L.nmhManifest : `${L.nmhManifest} missing`));
  if (nmh) {
    check(nmh.name === HOST_NAME && nmh.type === "stdio", "manifest name and type", `${nmh.name} ${nmh.type}`);
    check(nmh.path === L.wrapper, "manifest path is the wrapper", String(nmh.path));
    const origin = `chrome-extension://${extensionId}/`;
    const origins = nmh.allowed_origins;
    check(Array.isArray(origins) && origins.length === 1 && origins[0] === origin, "allowed_origins is exactly the extension origin", JSON.stringify(origins));
  }

  // Built extension manifest key
  const em = tryRead(() => readJsonObject(L.extensionManifest));
  const key = em.value?.key;
  let derived = null;
  if (typeof key === "string") derived = tryRead(() => extensionIdFromManifestKey(key)).value ?? null;
  check(derived !== null && derived === extensionId, "built extension manifest key derives extensionId", em.error ?? (typeof key === "string" ? `${L.extensionManifest} -> ${derived}` : `${L.extensionManifest} has no key; re-run \`npm run setup\``));

  // Private dirs
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
  privateDir(L.scoutHome, "scout home is a 0700 dir owned by you", false);
  privateDir(L.runDir, "scout run dir is a 0700 dir owned by you", true);

  // Key
  const k = tryRead(() => ({ st: lstatSync(L.keyPem), pem: readFileSync(L.keyPem, "utf8") }));
  check(k.value?.st.isFile() && (k.value.st.mode & 0o777) === 0o600, "extension key is a 0600 file", k.error ?? `${L.keyPem} ${oct(k.value.st.mode)}`);
  if (k.value) {
    const id = tryRead(() => extensionIdFromPem(k.value.pem));
    check(id.value === extensionId, "extension key derives extensionId", id.error ?? String(id.value));
  }
  return results;
}

export function runDoctor(env = process.env, out = console.log) {
  const results = runChecks(env);
  for (const r of results) out(`${r.status.padEnd(4)} ${r.label}${r.detail ? `: ${r.detail}` : ""}`);
  const failed = results.filter((r) => r.status === "FAIL").length;
  out(failed ? `${failed} check(s) failed.` : "All checks passed.");
  return failed ? 1 : 0;
}

if (isMain(import.meta.url)) process.exitCode = runDoctor();
