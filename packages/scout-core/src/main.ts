// Scout core process entrypoint. The native app launches
//   node packages/scout-core/dist/main.js --stdio
// and speaks JSONL on stdin (NativeCommand) and stdout (PanelState). Logs go to stderr
// only. The native host reaches the core on <scoutHome>/run/core.sock.
//
// The process exits 0 when stdin closes (the app quit or crashed), on SIGTERM/SIGINT/
// SIGHUP, or on a `shutdown` command, after closing the socket server and removing the
// socket file. It never outlives the app by more than SHUTDOWN_DEADLINE_MS.

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { NativeCommandSchema, type PanelState } from "@scout/contracts";
import { type Clock, systemClock } from "./clock.js";
import { ConfigError, readDestinations } from "./config.js";
import { type Coordinator, createCoordinator } from "./coordinator.js";
import { createDiagnostics, defaultDiagnosticsPath, type Diagnostics, scoutHome } from "./diagnostics.js";
import { createSocketServer, SocketServerError } from "./socketServer.js";

/** Hard cap on shutdown: exit anyway if closing takes longer. */
export const SHUTDOWN_DEADLINE_MS = 500;

export const EXIT_OK = 0;
export const EXIT_START_FAILED = 1;
export const EXIT_USAGE = 2;

export interface StdioDeps {
  stdin: Readable;
  stdout: Writable;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Called once, after shutdown has finished or its deadline passed. */
  exit: (code: number) => void;
  clock?: Clock;
  diagnostics?: Diagnostics;
}

export interface StdioCore {
  shutdown(reason: string): Promise<void>;
}

/** Start the core on the given streams. Resolves once the socket is listening. */
export async function runStdio(deps: StdioDeps): Promise<StdioCore> {
  const clock = deps.clock ?? systemClock;
  const home = scoutHome(deps.env);
  const diagnostics =
    deps.diagnostics ?? createDiagnostics({ path: defaultDiagnosticsPath(deps.env), clock, warn: deps.log });

  let destinations: readonly string[];
  try {
    destinations = readDestinations(home);
  } catch (e) {
    const code = e instanceof ConfigError ? e.code : "config-unreadable";
    deps.log(`scout-core: ${code}`);
    diagnostics.event("start_failed", { code });
    deps.exit(EXIT_START_FAILED);
    return { shutdown: async () => {} };
  }

  let stdoutOpen = true;
  const emitPanel = (state: PanelState): void => {
    if (!stdoutOpen) return;
    deps.stdout.write(`${JSON.stringify(state)}\n`);
  };

  let coordinator: Coordinator;
  try {
    coordinator = createCoordinator({
      config: { destinations },
      clock,
      diagnostics,
      emitPanel,
      onShutdownRequested: () => void shutdown("shutdown-command"),
    });
  } catch {
    deps.log("scout-core: config-invalid-destinations");
    diagnostics.event("start_failed", { code: "config-invalid-destinations" });
    deps.exit(EXIT_START_FAILED);
    return { shutdown: async () => {} };
  }

  const server = createSocketServer({
    runDir: join(home, "run"),
    onClient: (client) => coordinator.attachClient(client),
    diagnostics,
  });

  // stdin lines are not length-capped: the only writer is the native app that launched
  // us over a private pipe, and its commands are a few dozen bytes. Deliberate.
  const rl = createInterface({ input: deps.stdin, crlfDelay: Infinity });
  let shuttingDown: Promise<void> | null = null;
  // Settles (never rejects) once start() has finished either way, so a shutdown that
  // arrives mid-bind closes the listener that bind is about to produce.
  let startSettled: Promise<void> = Promise.resolve();
  const shutdown = (reason: string): Promise<void> => {
    if (shuttingDown !== null) return shuttingDown;
    // Claim shutdown before rl.close(): it emits "close" synchronously, which would
    // otherwise re-enter here as a second, stdin-closed shutdown with its own exit.
    let finished!: () => void;
    shuttingDown = new Promise<void>((resolve) => (finished = resolve));
    diagnostics.event("shutdown", { reason });
    deps.log(`scout-core: shutdown (${reason})`);
    coordinator.stop();
    rl.close();
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DEADLINE_MS).unref());
    const closed = startSettled.then(() => server.close());
    void Promise.race([closed, deadline]).then(() => {
      deps.exit(EXIT_OK);
      finished();
    });
    return shuttingDown;
  };

  let invalidLines = 0;
  rl.on("line", (line) => {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      value = undefined;
    }
    const parsed = NativeCommandSchema.safeParse(value);
    if (!parsed.success) {
      invalidLines += 1;
      diagnostics.event("native_command_invalid", { count: invalidLines });
      return;
    }
    coordinator.handleNativeCommand(parsed.data);
  });
  // stdin closing means the app is gone: never outlive it.
  rl.on("close", () => void shutdown("stdin-closed"));
  rl.on("error", () => void shutdown("stdin-error"));
  deps.stdout.on("error", () => {
    stdoutOpen = false;
    void shutdown("stdout-error");
  });

  const starting = server.start();
  startSettled = starting.then(
    () => {},
    () => {},
  );
  try {
    await starting;
  } catch (e) {
    const code = e instanceof SocketServerError ? e.code : "listen-failed";
    deps.log(`scout-core: socket server refused to start: ${code}`);
    diagnostics.event("start_failed", { code });
    // The app left while we were binding: shutdown already owns the exit.
    if (shuttingDown !== null) return { shutdown };
    // Claim shutdown first: rl.close() emits "close" synchronously, and that must not
    // start a second, stdin-closed shutdown with its own exit.
    shuttingDown = Promise.resolve();
    coordinator.stop();
    rl.close();
    deps.exit(EXIT_START_FAILED);
    return { shutdown: async () => {} };
  }
  // stdin may have closed while the socket was binding; that shutdown closes the server.
  if (shuttingDown !== null) await shuttingDown;
  else deps.log(`scout-core: listening on ${server.socketPath}`);
  return { shutdown };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (!argv.includes("--stdio")) {
    process.stderr.write("usage: main.js --stdio\n");
    process.exit(EXIT_USAGE);
  }
  let exited = false;
  const exit = (code: number): void => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };
  let core: StdioCore | null = null;
  const pendingSignals: string[] = [];
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      if (core === null) pendingSignals.push(sig);
      else void core.shutdown(`signal:${sig}`);
    });
  }
  core = await runStdio({
    stdin: process.stdin,
    stdout: process.stdout,
    env: process.env,
    log: (line) => void process.stderr.write(`${line}\n`),
    exit,
  });
  const first = pendingSignals[0];
  if (first !== undefined) void core.shutdown(`signal:${first}`);
}

function isEntrypoint(): boolean {
  try {
    const argv1 = process.argv[1];
    return !!argv1 && realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) void main();
