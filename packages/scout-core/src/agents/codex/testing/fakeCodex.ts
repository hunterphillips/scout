// Test-only: install the scripted fake `codex` (fake-codex.mjs) behind a wrapper script, and a
// user Codex home whose auth.json the private home links to. The fixture core for the job's
// real scout-mcp server is Claude's (claudeCode/testing/fakeCli.ts startFixtureCore).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export { FIXTURE_ORIGIN, FIXTURE_TOKEN, startFixtureCore, type FixtureCore } from "../../claudeCode/testing/fakeCli.js";

const FAKE = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));

export interface FakeCodexLogLine {
  /** `--version` / `login status` (and anything unexpected). */
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

export interface FakeCodex {
  /** The wrapper: an absolute executable, as a Codex profile's codexPath. */
  path: string;
  setMode(mode: string): void;
  setLogin(login: "chatgpt" | "api-key" | "none"): void;
  setVersion(version: string): void;
  lines(): FakeCodexLogLine[];
  /** Every pid the fake reported for an exec: the CLI and the MCP servers it started. */
  pids(): number[];
}

export interface FakeCodexOptions {
  mode?: string;
  version?: string;
  login?: "chatgpt" | "api-key" | "none";
}

/** Mode, version and login are read from files in `dir` at each launch, so a test can change them between runs. */
export function installFakeCodex(dir: string, { mode = "ok", version = "0.155.1", login = "chatgpt" }: FakeCodexOptions = {}): FakeCodex {
  mkdirSync(join(dir, "bin"), { recursive: true });
  const path = join(dir, "bin", "codex");
  const files = { mode: join(dir, "fake-codex-mode"), version: join(dir, "fake-codex-version"), login: join(dir, "fake-codex-login") };
  const log = join(dir, "fake-codex.log");
  writeFileSync(files.mode, mode);
  writeFileSync(files.version, version);
  writeFileSync(files.login, login);
  writeFileSync(
    path,
    `#!/bin/sh\nFAKE_MODE="$(cat '${files.mode}')" FAKE_VERSION="$(cat '${files.version}')" FAKE_LOGIN="$(cat '${files.login}')" FAKE_LOG='${log}' exec '${process.execPath}' '${FAKE}' "$@"\n`,
  );
  chmodSync(path, 0o755);
  const lines = (): FakeCodexLogLine[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as FakeCodexLogLine)
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

/** `<dir>/.codex/auth.json` (0600, placeholder tokens): the target of the private home's link when HOME is `dir`. */
export function fakeUserCodexHome(dir: string): string {
  const codexDir = join(dir, ".codex");
  mkdirSync(codexDir, { recursive: true, mode: 0o700 });
  const auth = join(codexDir, "auth.json");
  writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "placeholder-id", access_token: "placeholder-access", refresh_token: "placeholder-refresh" } }), { mode: 0o600 });
  chmodSync(auth, 0o600);
  return auth;
}
