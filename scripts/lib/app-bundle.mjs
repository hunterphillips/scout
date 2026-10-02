// Scout.app bundle metadata and the optional login LaunchAgent (P4.3).
//
// The bundle (scripts/bundle-app.mjs) is `Scout.app/Contents/{MacOS/Scout, Info.plist,
// Resources/}`: CFBundleIdentifier dev.scout.app, LSUIElement (menu-bar only, no Dock icon),
// CFBundleVersion from the root package.json. The app reads ~/.scout/config.json for the
// absolute nodePath and scoutRoot at launch, so nothing depends on Finder's PATH.
//
// The LaunchAgent (setup --login-launch) is `<LaunchAgents>/dev.scout.app.plist`: RunAtLoad,
// ProgramArguments = the bundled binary's absolute path, no KeepAlive. Setup records it with its
// SHA-256; uninstall removes it only while the hash matches. LAUNCH_AGENTS_DIR moves it for
// tests; like the agent integration's overrides, a test home (not the real ~/.scout) must set
// it and the real ~/.scout refuses it.

import { createHash } from "node:crypto";
import { APP_BUNDLE_ID, isRealScoutHome } from "./paths.mjs";

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
  const real = isRealScoutHome(env, realHome);
  if (real && env.LAUNCH_AGENTS_DIR) return "LAUNCH_AGENTS_DIR is for test installs only and refused with the real ~/.scout; unset it and re-run";
  if (!real && !env.LAUNCH_AGENTS_DIR) return "--login-launch with a Scout home that is not the real ~/.scout needs LAUNCH_AGENTS_DIR, so a test install cannot touch ~/Library/LaunchAgents";
  return null;
}
