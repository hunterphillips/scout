// Test fixture for setup/uninstall/doctor: a temp home and fake scoutRoot, both under a path with spaces.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FAKE_MANIFEST = {
  manifest_version: 3,
  name: "Scout Sensor",
  version: "0.1.0",
  permissions: ["nativeMessaging"],
};

export function makeFixture({ withClaude = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "scout setup test "));
  const home = join(root, "home dir");
  const scoutRoot = join(root, "scout root");
  const binDir = join(root, "bin");
  for (const d of ["browser-extension", "native-host", "scout-core"]) mkdirSync(join(scoutRoot, "packages", d, "dist"), { recursive: true });
  writeFileSync(join(scoutRoot, "packages/browser-extension/dist/manifest.json"), JSON.stringify(FAKE_MANIFEST, null, 2) + "\n");
  writeFileSync(join(scoutRoot, "packages/native-host/dist/host.js"), "// fake host\n");
  writeFileSync(join(scoutRoot, "packages/scout-core/dist/main.js"), "// fake core\n");
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

