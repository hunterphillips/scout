// Scout Chrome native-messaging host.
//
// Chrome runs this (through the ~/.scout/bin/scout-native-host wrapper) as
//   node dist/host.js chrome-extension://<id>/ [--parent-window=...]
// with stdin/stdout as the native-messaging channel. The host:
//   - exits 2 unless argv[2] is exactly the configured extension origin;
//   - connects to the core at ~/.scout/run/core.sock and sends hello;
//   - relays Chrome -> core: each frame validated as a BrowserObservation and
//     re-encoded as {type:"observation", observation};
//   - relays core -> Chrome: each frame validated as a ToChromeFrame and re-encoded;
//   - when the socket is missing, reports core_unavailable once and retries every
//     2 s for 30 s, then exits 1;
//   - when the core closes the socket, reports core_unavailable and exits 0;
//   - when Chrome closes stdin, closes the socket and exits 0.
// It never launches the core. stdout carries frames only; logs go to stderr and
// contain codes and counts, never message content.

import { readFileSync, realpathSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Duplex, Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_PROTOCOL,
  BrowserObservationSchema,
  type Hello,
  type ObservationFrame,
  type ToChromeFrame,
  ToChromeFrameSchema,
} from "@scout/contracts";
import {
  encodeFrame,
  FrameDecoder,
  FrameError,
  type FrameResult,
  MAX_FRAME_FROM_CHROME,
  MAX_FRAME_TO_CHROME,
} from "@scout/contracts/frame";

export const RETRY_INTERVAL_MS = 2_000;
export const RETRY_WINDOW_MS = 30_000;
/** Upper bound on waiting for stdout to flush before exiting anyway. */
export const EXIT_FLUSH_TIMEOUT_MS = 500;

export const EXIT_OK = 0;
export const EXIT_CORE_UNAVAILABLE = 1;
export const EXIT_REFUSED = 2;

const EXTENSION_ID_RE = /^[a-p]{32}$/;

export interface HostTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface HostDeps {
  /** argv[2] as Chrome passed it: the caller origin. */
  callerOrigin: string | undefined;
  /** Configured extension id (32 chars a-p), or undefined when config is missing. */
  extensionId: string | undefined;
  socketPath: string;
  stdin: Readable;
  stdout: Writable;
  connect(path: string): Duplex;
  timers: HostTimers;
  exit(code: number): void;
  log(line: string): void;
}

/** Drop counts, by direction and reason. Counts only, never content. */
export interface HostCounters {
  fromChrome: { forwarded: number; invalid: number; noCore: number; oversized: number };
  fromCore: { forwarded: number; invalid: number };
}

export interface Host {
  readonly counters: HostCounters;
  readonly chromeDecoder: FrameDecoder;
  readonly coreDecoder: FrameDecoder;
}

export function expectedOrigin(extensionId: string): string {
  return `chrome-extension://${extensionId}/`;
}

export function createHost(deps: HostDeps): Host {
  const { stdin, stdout, timers, log } = deps;
  const counters: HostCounters = {
    fromChrome: { forwarded: 0, invalid: 0, noCore: 0, oversized: 0 },
    fromCore: { forwarded: 0, invalid: 0 },
  };
  const chromeDecoder = new FrameDecoder({ maxBytes: MAX_FRAME_FROM_CHROME });
  const coreDecoder = new FrameDecoder({ maxBytes: MAX_FRAME_TO_CHROME });
  const host: Host = { counters, chromeDecoder, coreDecoder };

  let finished = false;
  let exited = false;
  let pendingWrites = 0;
  let exitCode = EXIT_OK;
  let socket: Duplex | null = null;
  let connected = false;
  let retryTimer: unknown = null;
  let retriesLeft = Math.floor(RETRY_WINDOW_MS / RETRY_INTERVAL_MS);
  let reportedUnavailable = false;

  const doExit = () => {
    if (exited) return;
    exited = true;
    deps.exit(exitCode);
  };

  const finish = (code: number, reason: string) => {
    if (finished) return;
    finished = true;
    exitCode = code;
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
    const s = socket;
    socket = null;
    s?.destroy();
    log(`scout-native-host: exit ${code} (${reason}) ${JSON.stringify(dropSummary(host))}`);
    if (pendingWrites === 0) doExit();
    else timers.setTimeout(doExit, EXIT_FLUSH_TIMEOUT_MS);
  };

  const sendToChrome = (frame: ToChromeFrame) => {
    if (finished) return;
    pendingWrites += 1;
    stdout.write(encodeFrame(frame, MAX_FRAME_TO_CHROME), () => {
      pendingWrites -= 1;
      if (finished && pendingWrites === 0) doExit();
    });
  };

  /** First failed connect of the retry window: tell the extension once. */
  const reportUnavailable = () => {
    if (reportedUnavailable) return;
    reportedUnavailable = true;
    sendToChrome({ type: "core_unavailable" });
  };

  // Origin check comes first, before any socket activity.
  if (deps.extensionId === undefined || !EXTENSION_ID_RE.test(deps.extensionId)) {
    finish(EXIT_REFUSED, "config-missing-extension-id");
    return host;
  }
  if (deps.callerOrigin !== expectedOrigin(deps.extensionId)) {
    finish(EXIT_REFUSED, "origin-rejected");
    return host;
  }

  const onCoreFrame = (r: FrameResult) => {
    if (!r.ok) return; // counted by the decoder
    const parsed = ToChromeFrameSchema.safeParse(r.value);
    if (!parsed.success) {
      counters.fromCore.invalid += 1;
      return;
    }
    counters.fromCore.forwarded += 1;
    sendToChrome(parsed.data);
  };

  const onChromeFrame = (r: FrameResult) => {
    if (!r.ok) return; // counted by the decoder
    const parsed = BrowserObservationSchema.safeParse(r.value);
    if (!parsed.success) {
      counters.fromChrome.invalid += 1;
      return;
    }
    if (socket === null || !connected) {
      counters.fromChrome.noCore += 1;
      return;
    }
    const frame: ObservationFrame = { type: "observation", observation: parsed.data };
    let bytes: Buffer;
    try {
      bytes = encodeFrame(frame, MAX_FRAME_FROM_CHROME);
    } catch (e) {
      if (!(e instanceof FrameError)) throw e;
      counters.fromChrome.oversized += 1;
      return;
    }
    counters.fromChrome.forwarded += 1;
    socket.write(bytes);
  };

  const connectNow = () => {
    retryTimer = null;
    if (finished) return;
    const s = deps.connect(deps.socketPath);
    socket = s;
    let errorCode = "closed";
    s.on("connect", () => {
      if (socket !== s) return;
      connected = true;
      const hello: Hello = { type: "hello", protocol: BRIDGE_PROTOCOL };
      s.write(encodeFrame(hello, MAX_FRAME_FROM_CHROME));
      log("scout-native-host: connected to core");
    });
    s.on("data", (chunk: Buffer) => {
      if (socket !== s) return;
      for (const r of coreDecoder.push(chunk)) onCoreFrame(r);
    });
    s.on("error", (e: NodeJS.ErrnoException) => {
      errorCode = e.code ?? "error";
    });
    s.on("close", () => {
      if (socket !== s) return; // we closed it
      socket = null;
      if (connected) {
        connected = false;
        coreDecoder.end();
        sendToChrome({ type: "core_unavailable" });
        finish(EXIT_OK, "core-closed");
        return;
      }
      reportUnavailable();
      if (retriesLeft <= 0) {
        finish(EXIT_CORE_UNAVAILABLE, `core-unavailable:${errorCode}`);
        return;
      }
      retriesLeft -= 1;
      retryTimer = timers.setTimeout(connectNow, RETRY_INTERVAL_MS);
    });
  };

  stdin.on("data", (chunk: Buffer) => {
    if (finished) return;
    for (const r of chromeDecoder.push(chunk)) onChromeFrame(r);
  });
  stdin.on("end", () => {
    chromeDecoder.end();
    finish(EXIT_OK, "stdin-closed");
  });
  stdin.on("error", () => finish(EXIT_OK, "stdin-error"));
  stdout.on("error", () => finish(EXIT_OK, "stdout-error"));

  connectNow();
  return host;
}

function dropSummary(host: Host) {
  return {
    ...host.counters,
    decoderDrops: { fromChrome: host.chromeDecoder.dropped, fromCore: host.coreDecoder.dropped },
  };
}

/** The ~/.scout root, overridable with SCOUT_HOME. */
export function scoutHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.SCOUT_HOME || join(homedir(), ".scout");
}

/** Reads `extensionId` from <scoutHome>/config.json; undefined when missing or malformed. */
export function readExtensionId(home: string): string | undefined {
  try {
    const cfg: unknown = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    if (cfg !== null && typeof cfg === "object" && "extensionId" in cfg) {
      const id = (cfg as { extensionId: unknown }).extensionId;
      if (typeof id === "string") return id;
    }
  } catch {
    // missing or unreadable config: refused below
  }
  return undefined;
}

export function main(): void {
  const home = scoutHome();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => process.exit(0));
  createHost({
    callerOrigin: process.argv[2],
    extensionId: readExtensionId(home),
    socketPath: join(home, "run", "core.sock"),
    stdin: process.stdin,
    stdout: process.stdout,
    connect: (path) => netConnect({ path }),
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    },
    exit: (code) => process.exit(code),
    log: (line) => process.stderr.write(`${line}\n`),
  });
}

function isEntrypoint(): boolean {
  try {
    const argv1 = process.argv[1];
    return !!argv1 && realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) main();
