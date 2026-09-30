// Test fixtures for the preflight and launch profile: a temp HOME, a stand-in `claude`
// file that is never executed (spawnSync is faked), and helpers that keep host state out.

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ManagedPaths, SpawnSyncFn } from "../authPreflight.js";

/** Fake secrets. None of these may ever appear in a report. */
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
  status [options]  Show authentication status
`;
const HELP_STATUS = `Usage: claude auth status [options]

Options:
  --json      Output as JSON (default)
`;

export interface FakeCall {
  command: string;
  args: string[];
  cwd: string;
  envNames: string[];
}

export interface FakeClaudeOptions {
  status?: unknown;
  statusExit?: number;
  statusTimeout?: boolean;
  helpAuth?: string;
  helpStatus?: string;
}

/** A spawnSync stand-in answering the four allowlisted invocations; records every call. */
export function fakeClaude(opts: FakeClaudeOptions = {}): { spawnSync: SpawnSyncFn; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const spawnSync: SpawnSyncFn = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd, envNames: Object.keys(options.env).sort() });
    const key = args.join(" ");
    const ok = (stdout: string) => ({ status: 0, signal: null, stdout });
    if (key === "--version") return ok("2.1.281 (Claude Code)\n");
    if (key === "auth --help") return ok(opts.helpAuth ?? HELP_AUTH);
    if (key === "auth status --help") return ok(opts.helpStatus ?? HELP_STATUS);
    if (key === "auth status --json") {
      if (opts.statusTimeout) {
        const error = Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" });
        return { status: null, signal: "SIGKILL", stdout: "", error };
      }
      const s = opts.status ?? SUBSCRIPTION_STATUS;
      return { status: opts.statusExit ?? 0, signal: null, stdout: typeof s === "string" ? s : JSON.stringify(s) };
    }
    return { status: 99, signal: null, stdout: "" };
  };
  return { spawnSync, calls };
}

export interface Sandbox {
  root: string;
  home: string;
  cwd: string;
  scratch: string;
  claudePath: string;
  managedPaths: ManagedPaths;
  writeUserSettings(obj: unknown, name?: string): void;
  writeFile(relPath: string, text: string): string;
  baseEnv(extra?: Record<string, string>): Record<string, string>;
}

const created: string[] = [];

export function cleanupSandboxes(): void {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
}

/**
 * root/home (HOME, with .claude/), root/work (workspace stand-in), root/bin/claude (a
 * 0755 file that is never run), and a separate scratch root outside root.
 */
export function makeSandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pcm-preflight-")));
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "pcm-scratch-")));
  created.push(root, scratch);
  const home = join(root, "home");
  const cwd = join(root, "work");
  const bin = join(root, "bin");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(cwd);
  mkdirSync(bin);
  const claudePath = join(bin, "claude");
  writeFileSync(claudePath, "#!/bin/sh\nexit 97\n");
  chmodSync(claudePath, 0o755);
  return {
    root,
    home,
    cwd,
    scratch,
    claudePath,
    managedPaths: {
      files: [join(root, "managed/managed-settings.json"), join(home, ".claude/remote-settings.json")],
      dropInDirs: [join(root, "managed/managed-settings.d")],
      opaque: [join(root, "managed/com.anthropic.claudecode.plist")],
    },
    writeUserSettings(obj, name = "settings.json") {
      writeFileSync(join(home, ".claude", name), typeof obj === "string" ? obj : JSON.stringify(obj));
    },
    writeFile(relPath, text) {
      const p = join(root, relPath);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
      return p;
    },
    baseEnv(extra = {}) {
      return { HOME: home, PATH: bin, ...extra };
    },
  };
}

/** A parent env shaped like this workspace's: gateway, API, provider, model and nested-session variables. */
export function gatewayParentEnv(sb: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...sb.baseEnv(),
    USER: "someone",
    LOGNAME: "someone",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    LC_CTYPE: "UTF-8",
    TMPDIR: "/tmp/",
    SHELL: "/bin/zsh",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:4000/sentinel-gateway.example.invalid",
    ANTHROPIC_API_KEY: "SENTINEL-API-KEY-7f3a",
    ANTHROPIC_AUTH_TOKEN: "SENTINEL-AUTH-TOKEN-91c2",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "SENTINEL-FILE-CONTENT-8b8b",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_MESSAGING_TOKEN: "SENTINEL-AUTH-TOKEN-91c2",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    PERSONAL_CONTEXT_HOME: "/nowhere",
    NODE_OPTIONS: "--require /nowhere/evil.js",
    ...extra,
  };
}

export function expectNoSentinels(text: string): string[] {
  return SENTINELS.filter((s) => text.includes(s));
}
