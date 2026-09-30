// A throwaway service home for server and CLI tests. Everything lives in one temp dir:
//   <base>/home         fake HOME (notes/ holds a markdown fixture)
//   <base>/pcm          PERSONAL_CONTEXT_HOME (0700)
//   <base>/bin/claude   a wrapper that answers the preflight's four allowlisted `claude`
//                       invocations like a logged-in subscription CLI and execs
//                       test/fake-claude.mjs (FAKE_MODE from <base>/mode) for runs.
// The real `claude` is never run; nothing touches the network.

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RankRequest } from "../api.js";
import type { SourceConfig } from "../config.js";
import { runServer, type RunningServer } from "../server.js";
import { readServerInfo } from "../serviceFiles.js";

export const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FAKE = join(PKG_DIR, "test", "fake-claude.mjs");
export const SERVER_JS = join(PKG_DIR, "dist", "server.js");
export const CLI_JS = join(PKG_DIR, "dist", "cli.js");

const AUTH_HELP = "Usage: claude auth [options] [command]\\n\\nCommands:\\n  login [options]   Sign in\\n  status [options]  Show authentication status\\n";
const STATUS_HELP = "Usage: claude auth status [options]\\n\\nOptions:\\n  --json      Output as JSON (default)\\n";
const STATUS_JSON = '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}';

export interface ServerFixture {
  base: string;
  home: string;
  pcmHome: string;
  notes: string;
  claude: string;
  fakeLog: string;
  env: Record<string, string>;
  setMode(mode: string): void;
  writeConfig(extra?: Record<string, unknown>): void;
  cleanup(): void;
}

const fixtures: ServerFixture[] = [];

export function notesSource(root: string, enabled = true): SourceConfig {
  return { id: "notes", kind: "markdown_dir", enabled, root, exclude: [] };
}

export function makeServerFixture(opts: { mode?: string; sources?: (fx: { notes: string; home: string }) => SourceConfig[] } = {}): ServerFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pcm-server-")));
  const home = join(base, "home");
  const pcmHome = join(base, "pcm");
  const notes = join(home, "notes");
  mkdirSync(notes, { recursive: true });
  mkdirSync(pcmHome, { mode: 0o700 });
  mkdirSync(join(base, "bin"));
  writeFileSync(join(notes, "billing-migration.md"), "# Billing migration\n\nWe move invoices to usage-based billing.\n");
  writeFileSync(join(notes, "todo.md"), "billing todo item\n");
  const modeFile = join(base, "mode");
  const fakeLog = join(base, "fake.log");
  writeFileSync(modeFile, opts.mode ?? "ok");
  const claude = join(base, "bin", "claude");
  writeFileSync(
    claude,
    [
      "#!/bin/sh",
      'case "$*" in',
      '  "--version") echo "2.1.281 (Claude Code)"; exit 0 ;;',
      `  "auth --help") printf '${AUTH_HELP}'; exit 0 ;;`,
      `  "auth status --help") printf '${STATUS_HELP}'; exit 0 ;;`,
      `  "auth status --json") echo '${STATUS_JSON}'; exit 0 ;;`,
      "esac",
      `FAKE_MODE="$(/bin/cat '${modeFile}')" FAKE_LOG='${fakeLog}' FAKE_DELAY_MS=300 exec '${process.execPath}' '${FAKE}' "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(claude, 0o755);
  const env: Record<string, string> = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    USER: "someone",
    TMPDIR: tmpdir(),
    PERSONAL_CONTEXT_HOME: pcmHome,
    PCM_PORT: "0",
  };
  const sources = opts.sources ?? ((f) => [notesSource(f.notes)]);
  const fx: ServerFixture = {
    base,
    home,
    pcmHome,
    notes,
    claude,
    fakeLog,
    env,
    setMode: (mode) => writeFileSync(modeFile, mode),
    writeConfig(extra = {}) {
      const cfg = { nodePath: process.execPath, claudePath: claude, sources: sources({ notes, home }), ...extra };
      writeFileSync(join(pcmHome, "config.json"), JSON.stringify(cfg, null, 2), { mode: 0o600 });
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
  fx.writeConfig();
  fixtures.push(fx);
  return fx;
}

// ---------- process bookkeeping ----------

interface FakeLogLine {
  pid?: number;
  sourcesPid?: number;
  prompt?: string;
}

export function fakeLines(fx: ServerFixture): FakeLogLine[] {
  return existsSync(fx.fakeLog)
    ? readFileSync(fx.fakeLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as FakeLogLine)
    : [];
}

export function fakePids(fx: ServerFixture): number[] {
  return fakeLines(fx).flatMap((l) => [l.pid, l.sourcesPid].filter((p): p is number => typeof p === "number"));
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Wait until the fake CLI and its source-tools server are both up for `n` runs. */
export async function waitForRuns(fx: ServerFixture, n = 1): Promise<void> {
  await waitFor(() => fakeLines(fx).filter((l) => typeof l.sourcesPid === "number").length >= n);
}

export async function waitAllGone(pids: number[], ms = 3000): Promise<number[]> {
  const until = Date.now() + ms;
  while (pids.some(alive) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  return pids.filter(alive);
}

/** Run dirs left under the default scratch root. */
export function scratchEntries(fx: ServerFixture): string[] {
  const dir = join(fx.pcmHome, "run", "scratch");
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

export function runLines(fx: ServerFixture): Array<Record<string, unknown>> {
  const p = join(fx.pcmHome, "runs.jsonl");
  return existsSync(p)
    ? readFileSync(p, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
}

// ---------- servers and clients ----------

const servers: RunningServer[] = [];
const children: ChildProcess[] = [];
const clients: Client[] = [];

export async function startServer(fx: ServerFixture, extraEnv: Record<string, string> = {}): Promise<{ server: RunningServer; logs: string[] }> {
  const logs: string[] = [];
  const server = await runServer({ env: { ...fx.env, ...extraEnv }, log: (l) => logs.push(l) });
  servers.push(server);
  return { server, logs };
}

export function token(fx: ServerFixture): string {
  return readFileSync(join(fx.pcmHome, "token"), "utf8").trim();
}

export async function connect(fx: ServerFixture, port: number): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token(fx)}` } },
  });
  const client = new Client({ name: "pcm-test", version: "0" });
  await client.connect(transport as Transport);
  clients.push(client);
  return { client, transport };
}

/** Spawn dist/server.js as a child; resolves once run/server.json names it. */
export async function spawnServer(fx: ServerFixture, extraEnv: Record<string, string> = {}): Promise<{ child: ChildProcess; port: number; stderr: () => string; exited: Promise<number | null> }> {
  const child = spawn(process.execPath, [SERVER_JS], { env: { ...fx.env, ...extraEnv }, stdio: ["ignore", "ignore", "pipe"] });
  children.push(child);
  let err = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (c: string) => (err += c));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  await waitFor(() => readServerInfo(fx.pcmHome)?.pid === child.pid || child.exitCode !== null, 20_000);
  if (child.exitCode !== null) throw new Error(`server exited early: ${err}`);
  return { child, port: readServerInfo(fx.pcmHome)!.port, stderr: () => err, exited };
}

export function rankRequest(extra: Partial<RankRequest> = {}): RankRequest {
  return {
    requestId: "r1",
    site: { origin: "https://docs.example.com", name: "Example Docs" },
    candidates: [
      { id: "c1", title: "Usage billing guide", description: "metering and invoices", labelQuality: "published" },
      { id: "c2", title: "Webhooks", labelQuality: "slug" },
      { id: "c3", title: "Team offsite", labelQuality: "image_title" },
    ],
    maxResults: 3,
    deadlineMs: 20_000,
    ...extra,
  };
}

export const observation = {
  sensor: "scout",
  kind: "viewed_page" as const,
  observedAt: "2026-09-30T12:00:00Z",
  url: "https://github.com/o/r/issues/1",
  title: "Billing issue",
  text: "usage billing migration",
  truncated: false,
};

/** Close every client, server and child this module started, kill leftover fakes, remove fixtures. */
export async function cleanupAll(): Promise<void> {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const s of servers.splice(0)) await s.shutdown("sigterm").catch(() => {});
  for (const ch of children.splice(0)) {
    if (ch.exitCode === null && ch.signalCode === null) {
      ch.kill("SIGKILL");
      await new Promise((r) => ch.once("exit", r));
    }
  }
  for (const fx of fixtures.splice(0)) {
    for (const pid of fakePids(fx)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    fx.cleanup();
  }
}
