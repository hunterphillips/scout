// Test-only: install the scripted fake `pi` (fake-pi.mjs) behind a wrapper script, and a
// user Pi agent dir whose auth.json the private job dir links to. The fixture core for the job's
// real scout-mcp server is Claude's (claudeCode/testing/fakeCli.ts startFixtureCore).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export { FIXTURE_ORIGIN, FIXTURE_TOKEN, startFixtureCore, type FixtureCore } from "../../claudeCode/testing/fakeCli.js";

const FAKE = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));

export interface FakePiLogLine {
  /** `--version` / `--list-models` (and anything unexpected). */
  sub?: boolean;
  unexpected?: boolean;
  argv?: string[];
  cwd?: string;
  envKeys?: string[];
  pid?: number;
  violations?: string[];
  authLinked?: boolean;
  scoutPid?: number;
  prompt?: string;
}

export interface FakePi {
  /** The wrapper: an absolute executable, as a Pi profile's piPath. */
  path: string;
  setMode(mode: string): void;
  setLogin(login: "ready" | "none"): void;
  setVersion(version: string): void;
  lines(): FakePiLogLine[];
  /** Every pid the fake reported for an exec: the CLI and the MCP servers it started. */
  pids(): number[];
}

export interface FakePiOptions {
  mode?: string;
  version?: string;
  login?: "ready" | "none";
}

/** Mode, version and login are read from files in `dir` at each launch, so a test can change them between runs. */
export function installFakePi(dir: string, { mode = "ok", version = "1.0.4", login = "ready" }: FakePiOptions = {}): FakePi {
  mkdirSync(join(dir, "bin"), { recursive: true });
  const path = join(dir, "bin", "pi");
  const files = { mode: join(dir, "fake-pi-mode"), version: join(dir, "fake-pi-version"), login: join(dir, "fake-pi-login") };
  const log = join(dir, "fake-pi.log");
  writeFileSync(files.mode, mode);
  writeFileSync(files.version, version);
  writeFileSync(files.login, login);
  const wrapper = [
    "#!/bin/sh",
    `export FAKE_MODE="$(cat '${files.mode}')"`,
    `export FAKE_VERSION="$(cat '${files.version}')"`,
    `export FAKE_LOGIN="$(cat '${files.login}')"`,
    `export FAKE_LOG='${log}'`,
    `exec '${process.execPath}' '${FAKE}' "$@"`,
    "",
  ].join("\n");
  writeFileSync(path, wrapper);
  chmodSync(path, 0o755);
  const lines = (): FakePiLogLine[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as FakePiLogLine)
      : [];
  return {
    path,
    setMode: (m) => writeFileSync(files.mode, m),
    setLogin: (l) => writeFileSync(files.login, l),
    setVersion: (v) => writeFileSync(files.version, v),
    lines,
    pids: () => lines().flatMap((l) => [l.pid, l.scoutPid].filter((p): p is number => typeof p === "number")),
  };
}

/** A private placeholder login for the fake. */
export function fakeUserPiAgentDir(dir: string): string {
  const agentDir = join(dir, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const auth = join(agentDir, "auth.json");
  writeFileSync(auth, JSON.stringify({ openai: { type: "oauth", access: "placeholder" } }), { mode: 0o600 });
  chmodSync(auth, 0o600);
  return agentDir;
}
