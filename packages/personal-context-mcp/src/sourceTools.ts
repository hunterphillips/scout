#!/usr/bin/env node
// The source-tools entrypoint: `node dist/sourceTools.js --run-dir <absolute dir>`.
// The agent runner starts it through `--mcp-config` as the stdio MCP server `sources`.
//
// The run dir must be a real 0700 directory owned by us (checkRunDir; else exit 2 with a
// fixed code). It reads <runDir>/snapshot.json and <runDir>/sources.json before serving (a bad file
// exits 2 with a fixed code on stderr), appends to <runDir>/audit.jsonl, and writes
// nothing else. stdout carries MCP protocol only. It exits 0 on stdin EOF, on
// SIGTERM/SIGINT/SIGHUP, and when orphaned. Importing this module does nothing.

import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { systemClock } from "./clock.js";
import type { ExclusionOptions } from "./config.js";
import { createAuditLog } from "./sourceTools/audit.js";
import { watchLifecycle } from "./sourceTools/lifecycle.js";
import { AUDIT_FILE, checkRunDir, readRunFiles, RunFileError } from "./sourceTools/runFiles.js";
import { createSourceToolsServer } from "./sourceTools/server.js";

export { createSourceToolsServer } from "./sourceTools/server.js";
export type { SourceToolsDeps } from "./sourceTools/server.js";

function diag(code: string): void {
  // Fixed codes only; never paths, queries or content.
  process.stderr.write(`source-tools: ${code}\n`);
}

/** `--run-dir <absolute path>` and nothing else. */
export function parseSourceToolsArgs(argv: readonly string[]): { runDir: string } | undefined {
  if (argv.length !== 2 || argv[0] !== "--run-dir") return undefined;
  const dir = argv[1];
  if (dir === undefined || !isAbsolute(dir) || dir.includes("\0")) return undefined;
  return { runDir: dir };
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

  const args = parseSourceToolsArgs(process.argv.slice(2));
  if (!args) {
    diag("usage");
    process.exit(2);
  }
  const dirCode = checkRunDir(args.runDir);
  if (dirCode !== undefined) {
    diag(dirCode);
    process.exit(2);
  }
  let files;
  try {
    files = readRunFiles(args.runDir);
  } catch (e) {
    diag(e instanceof RunFileError ? e.code : "run-files-invalid");
    process.exit(2);
  }

  const exclusion: ExclusionOptions = {};
  if (process.env.PERSONAL_CONTEXT_HOME) exclusion.serviceHome = process.env.PERSONAL_CONTEXT_HOME;
  const audit = createAuditLog(join(args.runDir, AUDIT_FILE), systemClock);
  const server = createSourceToolsServer({ runDir: args.runDir, files, clock: systemClock, audit, exclusion });

  watchLifecycle({
    stdin: process.stdin,
    signals: process,
    getppid: () => process.ppid,
    onExit: (reason) => {
      try {
        audit.lifecycle("exit", reason);
      } catch {
        // run dir already gone: nothing else to record
      }
      process.exit(0);
    },
  });

  audit.lifecycle("start");
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
