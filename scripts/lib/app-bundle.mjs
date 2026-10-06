// Scout.app bundle metadata and the optional login LaunchAgent (P4.3).
//
// The bundle (scripts/bundle-app.mjs) is `Scout.app/Contents/{MacOS/Scout, Info.plist,
// Resources/}`: CFBundleIdentifier dev.scout.app, LSUIElement (menu-bar only, no Dock icon),
// CFBundleVersion from the root package.json. The app reads ~/.scout/config.json for the
// absolute nodePath and scoutRoot at launch, so nothing depends on Finder's PATH.
//
// The LaunchAgent (setup --login-launch) is `<LaunchAgents>/dev.scout.app.plist`: RunAtLoad,
// ProgramArguments = the bundled binary's absolute path, no KeepAlive. Setup records it with its
// SHA-256; uninstall removes it only while the hash matches, and on the real home boots it out
// of launchd. LAUNCH_AGENTS_DIR moves it for tests (lib/paths.mjs locationOverrideRefusal).
//
// The installed copy (bundle-app --install) is `~/Applications/Scout.app`
// (SCOUT_APPLICATIONS_DIR for tests), recorded as kind `app-bundle` with bundleHash (every
// file in the bundle, so uninstall never deletes files bundle-app did not put there).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { APP_BUNDLE_ID, locationOverrideRefusal } from "./paths.mjs";

export const APP_NAME = "Scout";
export const APP_EXECUTABLE = "Scout";

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const PLIST_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
`;

export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Info.plist for Scout.app. `version` must be a dotted numeric version (CFBundleVersion). */
export function infoPlist({ version }) {
  if (!/^\d+(\.\d+){0,2}$/.test(String(version))) throw new Error(`not a bundle version: ${version}`);
  const entries = [
    ["CFBundleIdentifier", "string", APP_BUNDLE_ID],
    ["CFBundleName", "string", APP_NAME],
    ["CFBundleDisplayName", "string", APP_NAME],
    ["CFBundleExecutable", "string", APP_EXECUTABLE],
    ["CFBundlePackageType", "string", "APPL"],
    ["CFBundleInfoDictionaryVersion", "string", "6.0"],
    ["CFBundleVersion", "string", version],
    ["CFBundleShortVersionString", "string", version],
    ["LSMinimumSystemVersion", "string", "14.0"],
    ["LSUIElement", "bool", true],
    ["NSHighResolutionCapable", "bool", true],
  ];
  const body = entries.map(([k, type, v]) => `\t<key>${k}</key>\n\t${type === "bool" ? (v ? "<true/>" : "<false/>") : `<string>${xmlEscape(v)}</string>`}`).join("\n");
  return `${PLIST_HEAD}<dict>\n${body}\n</dict>\n</plist>\n`;
}

/** The login LaunchAgent: run the bundled binary at login, once. `program` is absolute. */
export function launchAgentPlist({ program }) {
  if (typeof program !== "string" || !program.startsWith("/") || /[\0\n]/.test(program)) throw new Error(`not an absolute program path: ${program}`);
  return `${PLIST_HEAD}<dict>
\t<key>Label</key>
\t<string>${APP_BUNDLE_ID}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xmlEscape(program)}</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>LimitLoadToSessionType</key>
\t<string>Aqua</string>
\t<key>ProcessType</key>
\t<string>Interactive</string>
</dict>
</plist>
`;
}

/** The refusal for LAUNCH_AGENTS_DIR, or null: required with a test home, refused with the real ~/.scout. */
export function launchAgentRefusal(env, realHome) {
  return locationOverrideRefusal("LAUNCH_AGENTS_DIR", env, realHome);
}

/** The refusal for SCOUT_APPLICATIONS_DIR (bundle-app --install, the login launch's default app), or null. */
export function applicationsRefusal(env, realHome) {
  return locationOverrideRefusal("SCOUT_APPLICATIONS_DIR", env, realHome);
}

/** The bundle's CFBundleIdentifier, read with `plutil -extract` (null when absent or unreadable). */
export function bundleIdOf(app) {
  const r = spawnSync("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(app, "Contents", "Info.plist")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** True when `app` is a real directory (not a symlink) whose Info.plist names dev.scout.app. */
export function isScoutBundle(app) {
  try {
    if (!lstatSync(app).isDirectory()) return false;
  } catch {
    return false;
  }
  return bundleIdOf(app) === APP_BUNDLE_ID;
}

/**
 * The installed bundle's ownership hash: SHA-256 over every entry under `dir`, sorted by
 * relative path. A file contributes its path and its own SHA-256, a symlink its path and its
 * target string (never the pointed-to content), a directory its path. `_CodeSignature/`
 * directories are left out, since `codesign` rewrites them. Null when `dir` is not a real
 * directory or holds anything unreadable or of another type.
 */
export function bundleHash(dir) {
  const entries = [];
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      const a = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(a);
      if (st.isSymbolicLink()) entries.push([r, `link\0${readlinkSync(a)}`]);
      else if (st.isDirectory()) {
        if (name === "_CodeSignature") continue;
        entries.push([r, "dir"]);
        walk(a, r);
      } else if (st.isFile()) entries.push([r, `file\0${createHash("sha256").update(readFileSync(a)).digest("hex")}`]);
      else throw new Error(`not a file, directory or symlink: ${a}`);
    }
  };
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    walk(dir, "");
  } catch {
    return null;
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash("sha256");
  for (const [rel, what] of entries) h.update(`${rel}\0${what}\n`);
  return h.digest("hex");
}
