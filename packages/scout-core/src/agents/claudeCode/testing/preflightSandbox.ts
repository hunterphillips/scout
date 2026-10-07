// Test-only: a temp HOME with a user config dir, a temp SCOUT_HOME, a stand-in `claude`
// that is never executed (spawnSync is faked), and a gateway-shaped parent env. Adapted
// from the removed personal-context package (see git history before 2026-10-02).

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SpawnSyncFn } from "../authPreflight.js";

/** Fake secrets. None of these may ever appear in a report or a log. */
export const SENTINELS = [
  "SENTINEL-API-KEY-7f3a",
  "SENTINEL-AUTH-TOKEN-91c2",
  "sentinel-gateway.example.invalid",
  "SENTINEL-HELPER-CMD-44d0",
  "sentinel-user@example.invalid",
  "SENTINEL-ORG-ID-5e6b",
  "SENTINEL-FILE-CONTENT-8b8b",
];

export const LOGGED_IN_STATUS = {
  loggedIn: true,
  email: "sentinel-user@example.invalid",
  orgId: "SENTINEL-ORG-ID-5e6b",
};

const HELP_AUTH = "Usage: claude auth [options] [command]\n\nCommands:\n  login [options]   Sign in\n  status [options]  Show authentication status\n";
const HELP_STATUS = "Usage: claude auth status [options]\n\nOptions:\n  --json      Output as JSON (default)\n";

export interface FakeCall {
  command: string;
  args: string[];
  cwd: string;
  envNames: string[];
}

export interface FakeClaudeOptions {
  /** The `auth status --json` answer: an object (serialized) or raw stdout. */
  status?: unknown;
  version?: string;
  statusExit?: number;
  /** `auth status --json` hits the spawn timeout (as spawnSync reports it: ETIMEDOUT, SIGKILL). */
  statusTimeout?: boolean;
  helpAuth?: string;
  helpStatus?: string;
}

/** A spawnSync stand-in answering the four allowlisted invocations; records every call. */
export function fakeSpawnSync(opts: FakeClaudeOptions = {}): { spawnSync: SpawnSyncFn; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const spawnSync: SpawnSyncFn = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd, envNames: Object.keys(options.env).sort() });
    const ok = (stdout: string) => ({ status: 0, signal: null, stdout });
    const key = args.join(" ");
    if (key === "--version") return ok(`${opts.version ?? "2.1.286"} (Claude Code)\n`);
    if (key === "auth --help") return ok(opts.helpAuth ?? HELP_AUTH);
    if (key === "auth status --help") return ok(opts.helpStatus ?? HELP_STATUS);
    if (key === "auth status --json") {
      if (opts.statusTimeout) {
        const error = Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" });
        return { status: null, signal: "SIGKILL", stdout: "", error };
      }
      const st = opts.status ?? LOGGED_IN_STATUS;
      return { status: opts.statusExit ?? 0, signal: null, stdout: typeof st === "string" ? st : JSON.stringify(st) };
    }
    return { status: 99, signal: null, stdout: "" };
  };
  return { spawnSync, calls };
}

export interface Sandbox {
  root: string;
  home: string;
  /** root/work: a child cwd inside the sandbox. */
  cwd: string;
  scoutHome: string;
  jobsRoot: string;
  claudePath: string;
  writeFile(relPath: string, text: string): string;
  /** HOME and a PATH holding only the sandbox's `claude`, plus `extra`. */
  baseEnv(extra?: Record<string, string>): Record<string, string>;
}

const created: string[] = [];

export function cleanupSandboxes(): void {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function makeSandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-pf-")));
  created.push(root);
  const home = join(root, "home");
  const scoutHome = join(root, "scout-home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(scoutHome, { mode: 0o700 });
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "work"));
  const claudePath = join(root, "bin", "claude");
  writeFileSync(claudePath, "#!/bin/sh\nexit 97\n");
  chmodSync(claudePath, 0o755);
  return {
    root,
    home,
    cwd: join(root, "work"),
    scoutHome,
    jobsRoot: join(scoutHome, "run", "jobs"),
    claudePath,
    writeFile(relPath, text) {
      const p = join(root, relPath);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
      return p;
    },
    baseEnv(extra = {}) {
      return { HOME: home, PATH: join(root, "bin"), ...extra };
    },
  };
}

/** A parent env shaped like this workspace's: gateway, API, provider, model and nested-session variables. */
export function gatewayParentEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    USER: "someone",
    LOGNAME: "someone",
    LANG: "en_US.UTF-8",
    TMPDIR: tmpdir(),
    SHELL: "/bin/zsh",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:4000/sentinel-gateway.example.invalid",
    ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a",
    ANTHROPIC_AUTH_TOKEN: "SENTINEL-AUTH-TOKEN-91c2",
    ANTHROPIC_MODEL: "gateway-default-model",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    SCOUT_HOME: "/nowhere",
    NODE_OPTIONS: "--require /nowhere/evil.js",
    ...extra,
  };
}

export function sentinelsIn(text: string): string[] {
  return SENTINELS.filter((s) => text.includes(s));
}
