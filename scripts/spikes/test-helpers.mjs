// Test fixtures for auth-preflight: a temp HOME, a fake `claude` binary that
// logs every invocation, and a runner for the real script as a subprocess.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./auth-preflight.mjs";

export const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "auth-preflight.mjs");

// Fake secrets. None of these may ever appear in preflight output.
export const SENTINELS = [
  "SENTINEL-API-KEY-7f3a",
  "SENTINEL-AUTH-TOKEN-91c2",
  "sentinel-gateway.example.invalid",
  "SENTINEL-HELPER-CMD-44d0",
  "sentinel-user@example.invalid",
  "SENTINEL-ORG-ID-5e6b",
  "SENTINEL-ORG-NAME-0a1d",
  "SENTINEL-FILE-CONTENT-8b8b",
  "SENTINEL-STDERR-3c3c",
];

export const SUBSCRIPTION_STATUS = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "sentinel-user@example.invalid",
  orgId: "SENTINEL-ORG-ID-5e6b",
  orgName: "SENTINEL-ORG-NAME-0a1d",
  subscriptionType: "max",
};

const HELP_AUTH = `Usage: claude auth [options] [command]

Commands:
  login [options]   Sign in to your Anthropic account
  logout            Log out from your Anthropic account
  status [options]  Show authentication status
`;
const HELP_STATUS = `Usage: claude auth status [options]

Options:
  -h, --help  Display help for command
  --json      Output as JSON (default)
  --text      Output as human-readable text
`;

const TMP_PREFIX = join(tmpdir(), "scout-preflight-");
const created = new Set();

/** Delete only sandboxes this module created under the temp dir. */
export function cleanupSandboxes() {
  for (const root of created) {
    if (root.startsWith(TMP_PREFIX)) rmSync(root, { recursive: true, force: true });
    created.delete(root);
  }
}

/**
 * Build a sandbox. `status` is the object (or raw string) the fake
 * `claude auth status --json` prints; `statusExit` its exit code.
 */
export function makeSandbox({
  status = SUBSCRIPTION_STATUS,
  statusExit = 0,
  statusSleep = 0,
  helpAuth = HELP_AUTH,
  helpStatus = HELP_STATUS,
} = {}) {
  const root = mkdtempSync(TMP_PREFIX);
  created.add(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const cwd = join(root, "work");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(bin);
  mkdirSync(cwd);
  const log = join(root, "claude-invocations.log");
  const out = (name, text) => {
    const p = join(root, name);
    writeFileSync(p, text);
    return p;
  };
  const statusFile = out("status.out", typeof status === "string" ? status : JSON.stringify(status));
  const authHelp = out("auth-help.out", helpAuth);
  const statusHelp = out("status-help.out", helpStatus);
  const claude = join(bin, "claude");
  writeFileSync(
    claude,
    `#!/bin/sh
echo "$*" >> '${log}'
[ -n "$SCOUT_TEST_MARKER" ] && echo "$*" >> '${log}.marker'
case "$*" in
  "--version") echo "2.1.281 (Claude Code)" ;;
  "auth --help") /bin/cat '${authHelp}' ;;
  "auth status --help") /bin/cat '${statusHelp}' ;;
  "auth status --json") ${statusSleep ? `exec /bin/sleep ${statusSleep}` : ""}
    /bin/pwd -P > '${log}.status-cwd'; /usr/bin/env | /usr/bin/cut -d= -f1 | /usr/bin/sort > '${log}.status-env-names'
    /bin/cat '${statusFile}'; echo "SENTINEL-STDERR-3c3c" >&2; exit ${statusExit} ;;
  *) echo "unexpected" >&2; exit 99 ;;
esac
`,
  );
  chmodSync(claude, 0o755);

  return {
    root,
    home,
    bin,
    cwd,
    writeUserSettings(obj, name = "settings.json") {
      writeFileSync(join(home, ".claude", name), typeof obj === "string" ? obj : JSON.stringify(obj));
    },
    writeFile(relPath, text) {
      const p = join(root, relPath);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
      return p;
    },
    invocationsWithMarkerEnv() {
      return existsSync(log + ".marker") ? readFileSync(log + ".marker", "utf8").trim().split("\n") : [];
    },
    /** Physical cwd and env key names (never values) seen by `auth status --json`. */
    statusRunContext() {
      if (!existsSync(log + ".status-cwd")) return undefined;
      return {
        cwd: readFileSync(log + ".status-cwd", "utf8").trim(),
        envNames: readFileSync(log + ".status-env-names", "utf8").trim().split("\n"),
      };
    },
    invocations() {
      return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    },
    baseEnv(extra = {}) {
      return { HOME: home, PATH: bin, ...extra };
    },
  };
}

/**
 * Managed-settings locations re-rooted inside the sandbox, so host managed
 * state can never leak into a test.
 */
export function sandboxManagedPaths(sb) {
  return {
    files: [join(sb.root, "managed/managed-settings.json"), join(sb.home, ".claude/remote-settings.json")],
    dropInDirs: [join(sb.root, "managed/managed-settings.d")],
    opaque: [join(sb.root, "managed/com.anthropic.claudecode.plist")],
  };
}

/**
 * Run the production preflight in-process, hermetically: sandbox managed
 * paths, ancestor walk stopped at the sandbox root. The fake claude binary is
 * still really spawned.
 */
export function run(sb, { env = {}, ...deps } = {}) {
  const { stdout, code } = main({
    env: sb.baseEnv(env),
    cwd: sb.cwd,
    managedPaths: sandboxManagedPaths(sb),
    projectStopAt: sb.root,
    ...deps,
  });
  return { code, stdout, stderr: "", report: JSON.parse(stdout) };
}

/** An fs whose every path outside `root` looks like hostile managed policy. */
export function hostileOutside(root) {
  // Accept the root under its real path too (macOS: /var -> /private/var).
  const roots = [root, fs.realpathSync(root)];
  const inside = (p) => roots.some((r) => String(p).startsWith(r + sep));
  const probedOutside = [];
  const hostile = JSON.stringify({ apiKeyHelper: "SENTINEL-HELPER-CMD-44d0", env: { ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a" } });
  return {
    probedOutside,
    fs: {
      readFileSync: (p, o) => (inside(p) ? fs.readFileSync(p, o) : (probedOutside.push(p), hostile)),
      readdirSync: (p, o) => (inside(p) ? fs.readdirSync(p, o) : (probedOutside.push(p), ["evil.json"])),
      statSync: (p, o) => (inside(p) ? fs.statSync(p, o) : (probedOutside.push(p), fs.statSync(root))),
    },
  };
}

/** Run the real script as a subprocess (entrypoint coverage only). */
export function runEntrypoint(sb, { env = {}, args = [] } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: sb.cwd,
    env: sb.baseEnv(env),
    encoding: "utf8",
    timeout: 30_000,
  });
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    report = undefined;
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, report };
}

export function expectNoSentinels(expect, ...texts) {
  for (const t of texts) for (const s of SENTINELS) expect(t).not.toContain(s);
}
