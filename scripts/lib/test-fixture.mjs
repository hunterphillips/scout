// Test fixture for setup/uninstall/doctor: a temp home and fake scoutRoot, both under a path
// with spaces (or without, for the agent integration, which refuses spaces), and a fake
// `claude` for the integration's `claude mcp add/get/remove`.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./paths.mjs";

/** The scripted CLI the agent checks use; its `mcp` subcommands copy CLI 2.1.286's messages and `get` layout. */
const FAKE_CLAUDE = join(REPO_ROOT, "packages", "scout-core", "src", "agents", "claudeCode", "testing", "fake-claude.mjs");

export const FAKE_MANIFEST = {
  manifest_version: 3,
  name: "Scout",
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
  for (const d of ["browser-extension", "native-host", "scout-core", "scout-mcp", "contracts"]) mkdirSync(join(scoutRoot, "packages", d, "dist"), { recursive: true });
  mkdirSync(join(scoutRoot, "packages", "scout-core", "dist", "agents", "claudeCode"), { recursive: true });
  writeFileSync(join(scoutRoot, "packages/contracts/dist/bridge.js"), "export const BRIDGE_PROTOCOL = 3;\n");
  writeFileSync(join(scoutRoot, "packages/scout-core/dist/agents/claudeCode/claudeJob.js"), 'export const VERIFIED_CLI_VERSION = "2.1.286";\n');
  writeFileSync(join(scoutRoot, "packages/scout-core/dist/agents/claudeCode/profile.js"), 'export const CLAUDE_CODE_ADAPTER_ID = "claude-code";\nexport const DEFAULT_CLAUDE_CODE_MODEL = "claude-sonnet-5-5";\n');
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
    CHROME_NMH_DIR: join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
    // A test home never runs a claude found on PATH: setup records this one in the agent profile.
    ...(withClaude ? { SCOUT_CLAUDE_BIN: join(binDir, "claude") } : {}),
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


/**
 * Approve `skills` in a real capability store under `scoutHome` and export their wrappers into
 * `skillsRoot` as the core would (scout-core dist; the scripts' global setup builds it). The store
 * is closed afterwards, so its lock is free. Returns the wrapper names.
 */
export async function exportRealWrappers(scoutHome, skillsRoot, skills = ["pay"]) {
  const { createHash } = await import("node:crypto");
  const { createCapabilityStore } = await import("../../packages/scout-core/dist/capabilities/store.js");
  const { createSkillExporter } = await import("../../packages/scout-core/dist/capabilities/exports.js");
  const { wrapperName } = await import("../../packages/scout-core/dist/capabilities/identity.js");
  const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
  const origin = "https://s.example";
  mkdirSync(skillsRoot, { recursive: true });
  const exporter = createSkillExporter({ scoutHome, skillsRoot });
  const store = await createCapabilityStore({ scoutHome, clock: { now: () => 1_800_000_000_000 }, syncExports: (state) => exporter.sync(state) });
  const names = [];
  for (const name of skills) {
    const text = `---\nname: ${name}\ndescription: d\n---\n# ${name}\n`;
    const sourceUrl = `${origin}/skills/${name}/SKILL.md`;
    const resource = { kind: "skill", siteOrigin: origin, publisherOrigin: origin, sourceUrl, finalUrl: sourceUrl, text, sha256: sha(text), byteLength: Buffer.byteLength(text), fetchedAt: 1, skill: { name, sha256: sha(text) } };
    const report = await store.ingest(
      { origin, checkedAt: 1, robots: "not_fetched", items: [{ kind: "skill", sourceUrl, status: "found", source: "network", resource }], externalReferences: [], skillsOverCap: 0, acceptedBytes: 0, stats: { requests: 0, refused: 0, ms: 0 } },
      { chromePermitted: false },
    );
    const { resourceId, version } = report.results[0];
    await store.approve({ resourceId, version, expectedRevision: store.getResource(resourceId).revision });
    names.push(wrapperName("skill", resourceId));
  }
  await exporter.sync(store.snapshot());
  await store.close();
  return names;
}
