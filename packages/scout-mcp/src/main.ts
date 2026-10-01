#!/usr/bin/env node
// The Scout MCP adapter: `node dist/main.js [--socket <abs path>] [--token-file <abs path>]`.
// An agent harness starts it as the stdio MCP server `scout`.
//
// Paths come from argv, else SCOUT_AGENT_SOCKET / SCOUT_AGENT_TOKEN_FILE, else
// `<SCOUT_HOME or ~/.scout>/run/agent.sock` and `run/agent-token`. Nothing is opened until
// the first tool call; a missing core makes that call fail with `unavailable`. The adapter
// never starts a core. stdout carries MCP protocol only; stderr gets fixed codes only (never
// paths, tokens or content). It exits 0 on stdin EOF, SIGTERM/SIGINT/SIGHUP, or when
// orphaned. Importing this module does nothing.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSocketBackend } from "./client.js";
import { createScoutMcpServer } from "./tools.js";

export interface AdapterPaths {
  socketPath: string;
  tokenFile: string;
}

function diag(code: string): void {
  process.stderr.write(`scout-mcp: ${code}\n`);
}

const usable = (p: string | undefined): p is string => p !== undefined && p !== "" && isAbsolute(p) && !p.includes("\0");

/** Undefined on any unknown flag, missing value, or non-absolute path. */
export function parseAdapterArgs(argv: readonly string[], env: NodeJS.ProcessEnv): AdapterPaths | undefined {
  const flags = new Map<string, string | undefined>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]!;
    if ((name !== "--socket" && name !== "--token-file") || flags.has(name)) return undefined;
    flags.set(name, argv[i + 1]);
  }
  const runDir = join(env.SCOUT_HOME || join(homedir(), ".scout"), "run");
  const socketPath = flags.has("--socket") ? flags.get("--socket") : env.SCOUT_AGENT_SOCKET || join(runDir, "agent.sock");
  const tokenFile = flags.has("--token-file") ? flags.get("--token-file") : env.SCOUT_AGENT_TOKEN_FILE || join(runDir, "agent-token");
  return usable(socketPath) && usable(tokenFile) ? { socketPath, tokenFile } : undefined;
}

const ORPHAN_CHECK_MS = 1_000;

/**
 * Exit once on stdin EOF/close, a termination signal, or when the parent PID changes.
 * Adapted from personal-context-mcp's sourceTools/lifecycle.ts (not imported: scout-mcp
 * must not depend on that package).
 */
function watchLifecycle(onExit: () => void): void {
  const initialPpid = process.ppid;
  let done = false;
  const exit = (): void => {
    if (done) return;
    done = true;
    onExit();
  };
  setInterval(() => {
    if (process.ppid === 1 || process.ppid !== initialPpid) exit();
  }, ORPHAN_CHECK_MS).unref();
  process.stdin.on("end", exit);
  process.stdin.on("close", exit);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, exit);
}

async function main(): Promise<void> {
  // Protocol-only stdout: nothing in this process may print to it by accident.
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
  process.on("uncaughtException", () => {
    diag("internal-error");
    process.exit(1);
  });
  process.on("unhandledRejection", () => {
    diag("internal-error");
    process.exit(1);
  });

  const paths = parseAdapterArgs(process.argv.slice(2), process.env);
  if (!paths) {
    diag("usage");
    process.exit(2);
  }
  const backend = createSocketBackend(paths);
  const server = createScoutMcpServer({ backend });
  watchLifecycle(() => {
    backend.close();
    process.exit(0);
  });
  await server.connect(new StdioServerTransport());
}

function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  try {
    return !!argv1 && realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch(() => {
    diag("failed-to-start");
    process.exit(1);
  });
}
