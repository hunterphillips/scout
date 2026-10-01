// Test-only: a temp world for the agent-check scripts. A temp HOME with an empty user
// skills root, the scripted fake `claude` (packages/scout-core/src/agents/testing/
// fake-claude.mjs) behind a wrapper, hermetic managed-settings paths, and a gateway-shaped
// parent env carrying sentinel values that must never reach a report.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/paths.mjs";
import { runAgentCheck } from "./run.mjs";

const FAKE = join(REPO_ROOT, "packages", "scout-core", "src", "agents", "testing", "fake-claude.mjs");
export const SENTINELS = ["SENTINEL-API-KEY-7f3a", "sentinel-gateway.example.invalid"];

const worlds = [];

export function cleanupWorlds() {
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
}

export function makeWorld(mode = "hotload-watch") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sac-")));
  chmodSync(root, 0o700);
  worlds.push({ root });
  const home = join(root, "home");
  const skillsRoot = join(home, ".claude", "skills");
  mkdirSync(skillsRoot, { recursive: true });
  const scoutHome = join(root, "scout-home");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const modeFile = join(root, "fake-mode");
  const log = join(root, "fake.log");
  writeFileSync(modeFile, mode);
  const claude = join(bin, "claude");
  writeFileSync(claude, `#!/bin/sh\nFAKE_MODE="$(cat '${modeFile}')" FAKE_LOG='${log}' exec '${process.execPath}' '${FAKE}' "$@"\n`);
  chmodSync(claude, 0o755);
  const env = {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    USER: "someone",
    LOGNAME: "someone",
    LANG: "en_US.UTF-8",
    TMPDIR: tmpdir(),
    SHELL: "/bin/sh",
    ANTHROPIC_API_KEY: SENTINELS[0],
    ANTHROPIC_BASE_URL: `http://127.0.0.1:4000/${SENTINELS[1]}`,
    CLAUDECODE: "1",
  };
  const managedPaths = { files: [join(root, "managed", "managed-settings.json")], dropInDirs: [join(root, "managed", "d")], opaque: [join(root, "managed", "p.plist")] };
  const registryFile = join(home, ".claude.json");

  const w = {
    root,
    home,
    skillsRoot,
    scoutHome,
    claude,
    env,
    registryFile,
    setMode: (m) => writeFileSync(modeFile, m),
    lines: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    registry: () => (existsSync(registryFile) ? JSON.parse(readFileSync(registryFile, "utf8")).mcpServers ?? {} : {}),
    reports: () => {
      const dir = join(w.scoutHome, "agent-check");
      return existsSync(dir) ? readdirSync(dir).sort().map((f) => join(dir, f)) : [];
    },
    /** Run verify:agent against this world; deps are merged over fast test seams. */
    async run(args, deps = {}) {
      const lines = [];
      const code = await runAgentCheck([...args, "--home", w.scoutHome, "--claude", claude], {
        env,
        out: (s) => lines.push(String(s)),
        err: (s) => lines.push(String(s)),
        deps: { preflightSeams: { managedPaths }, settleMs: 50, turnTimeoutMs: 20_000, killGraceMs: 500, cancelAfterInitMs: 300, ...deps },
      });
      const files = w.reports();
      const reportText = files.length ? readFileSync(files.at(-1), "utf8") : undefined;
      return { code, text: lines.join("\n"), report: reportText ? JSON.parse(reportText) : undefined, reportText };
    },
  };
  return w;
}

/** Every entry (dirs included) under `dir`, with mode, sorted. */
export function snapshotTree(dir) {
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
      const p = join(d, e.name);
      out.push(`${r} ${statSync(p).mode.toString(8)}${e.isFile() ? ` ${readFileSync(p).length}` : ""}`);
      if (e.isDirectory()) walk(p, r);
    }
  };
  walk(dir, "");
  return out.sort();
}
