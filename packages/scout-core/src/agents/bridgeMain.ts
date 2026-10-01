#!/usr/bin/env node
// The per-job bridge entrypoint: `node dist/agents/bridgeMain.js --job <abs path>`. A job's
// CLI starts it as the stdio MCP server `scout_bridge` (contextToolBridge.ts has the
// behaviour). stdout carries MCP protocol only; stderr gets fixed codes only (never paths,
// names, values or content). It exits on stdin EOF, SIGTERM/SIGINT/SIGHUP, or when
// orphaned, and SIGKILLs its backends on the way out. Importing this module does nothing.

import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContextToolBridge, readBridgeJob } from "./contextToolBridge.js";

const ORPHAN_CHECK_MS = 1000;

function diag(code: string): void {
  process.stderr.write(`scout-bridge: ${code}\n`);
}

/** The job file path, or undefined on any other argv. */
export function parseBridgeArgs(argv: readonly string[]): string | undefined {
  if (argv.length !== 2 || argv[0] !== "--job") return undefined;
  const p = argv[1]!;
  return isAbsolute(p) && !p.includes("\0") ? p : undefined;
}

async function main(): Promise<void> {
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
  console.warn = () => {};
  console.error = () => {};
  let killBackends = (): void => {};
  const die = (code: number): never => {
    killBackends();
    process.exit(code);
  };
  process.on("uncaughtException", () => {
    diag("internal-error");
    die(1);
  });
  process.on("unhandledRejection", () => {
    diag("internal-error");
    die(1);
  });

  const jobPath = parseBridgeArgs(process.argv.slice(2));
  if (!jobPath) {
    diag("usage");
    process.exit(2);
  }
  let job;
  try {
    job = readBridgeJob(jobPath);
  } catch {
    diag("job-file");
    process.exit(2);
  }
  const bridge = createContextToolBridge(job, diag);
  killBackends = () => bridge.killBackends();

  const initialPpid = process.ppid;
  let done = false;
  const exit = (): void => {
    if (done) return;
    done = true;
    die(0);
  };
  setInterval(() => {
    if (process.ppid === 1 || process.ppid !== initialPpid) exit();
  }, ORPHAN_CHECK_MS).unref();
  process.stdin.on("end", exit);
  process.stdin.on("close", exit);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, exit);

  // Connect at once (initialize answers immediately); tools/list waits for the backends.
  await bridge.server.connect(new StdioServerTransport());
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
