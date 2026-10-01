// Test fixture for setup/uninstall/doctor: a temp home and fake scoutRoot, both under a path
// with spaces (or without, for the agent integration, which refuses spaces), and a fake
// `claude` for the integration's `claude mcp add/get/remove`.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./paths.mjs";

/** The scripted CLI the agent checks use; its `mcp` subcommands copy CLI 2.1.286's messages and `get` layout. */
const FAKE_CLAUDE = join(REPO_ROOT, "packages", "scout-core", "src", "agents", "testing", "fake-claude.mjs");

export const FAKE_MANIFEST = {
  manifest_version: 3,
  name: "Scout Sensor",
  version: "0.1.0",
  permissions: ["nativeMessaging"],
};

/**
 * `rootPrefix` lets a test put shell metacharacters in every fixture path; `spaces: false`
 * gives space-free paths. The root is a real path (no symlinked ancestor such as macOS /var).
 */
export function makeFixture({ withClaude = true, rootPrefix = "scout setup test ", spaces = true } = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), spaces ? rootPrefix : rootPrefix.replace(/\s+/g, "-")));
  const home = join(root, spaces ? "home dir" : "home");
  const scoutRoot = join(root, spaces ? "scout root" : "scout-root");
  const binDir = join(root, "bin");
  for (const d of ["browser-extension", "native-host", "scout-core", "scout-mcp"]) mkdirSync(join(scoutRoot, "packages", d, "dist"), { recursive: true });
  writeFileSync(join(scoutRoot, "packages/browser-extension/dist/manifest.json"), JSON.stringify(FAKE_MANIFEST, null, 2) + "\n");
  writeFileSync(join(scoutRoot, "packages/native-host/dist/host.js"), "// fake host\n");
  writeFileSync(join(scoutRoot, "packages/scout-core/dist/main.js"), "// fake core\n");
  writeFileSync(join(scoutRoot, "packages/scout-mcp/dist/main.js"), "// fake scout-mcp\n");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (withClaude) {
    writeFileSync(join(binDir, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "claude"), 0o755);
  }
  const env = {
    HOME: home,
    PATH: binDir,
    SCOUT_HOME: join(home, ".scout"),
    PERSONAL_CONTEXT_HOME: join(home, ".personal-context-mcp"),
    CHROME_NMH_DIR: join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
  };
  return { root, home, scoutRoot, binDir, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * A fake `claude` at `<dir>/claude` running the shared fake CLI. Its user MCP registry is
 * `$HOME/.claude.json` of the env it runs with. `setMode(m)` picks a fake-claude mode
 * (e.g. mcp-get-killed, mcp-get-hang, mcp-add-fail); `calls()` lists its subcommands.
 */
export function makeFakeClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  const modeFile = join(dir, "mode");
  const log = join(dir, "calls.jsonl");
  writeFileSync(modeFile, "");
  writeFileSync(path, `#!/bin/sh\nFAKE_MODE="$(/bin/cat '${modeFile}')" FAKE_LOG='${log}' exec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`);
  chmodSync(path, 0o755);
  return {
    path,
    setMode: (m) => writeFileSync(modeFile, m),
    calls: () => {
      try {
        return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).subcommand).filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

/** Every file under `dir`, relative, sorted. */
export function listTree(dir) {
  const out = [];
  const walk = (d, rel) => {
    let names;
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

