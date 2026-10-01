// Scout Chrome native-messaging host: the relay.
//
// createHost wires Chrome's stdin/stdout to the core's Unix socket. All process
// and filesystem access comes in through HostDeps, so tests drive it with fakes.
// The relay:
//   - exits 2 unless the caller origin is exactly the configured extension origin;
//   - before each connect attempt, checks the core's runtime dir and socket are
//     ours and private: missing is treated like ENOENT (retry), anything else
//     unsafe reports core_unavailable and exits 1 without retrying;
//   - connects to the core and sends a protocol-2 hello. The core answers with a
//     capture-disabled capture_policy (the negotiation ack); the relay forwards it,
//     flushes the pre-connect buffer, then tells the extension {type:"ready"} (its
//     signal that the link is healthy). The extension answers that policy with a
//     fresh permissions snapshot and focus, so the policy must not wait on them;
//   - a core that answers upgrade_required (protocol mismatch) is reported as
//     core_unavailable{reason:"upgrade_required"} and the relay exits 1 without
//     retrying: mixed versions fail closed. A core that closes before any policy (an
//     old core) is treated as unreachable: the normal retry window, then exit 1;
//   - relays Chrome -> core: each frame validated as a BrowserObservation and
//     re-encoded as {type:"observation", observation}. Frames that arrive before the
//     handshake is done wait in a small buffer holding only the latest permissions
//     and latest focus, flushed in that order. page_text that arrives before then is
//     dropped and counted: it was approved under no current policy;
//   - relays core -> Chrome: each frame validated as a ToChromeFrame and re-encoded;
//   - when the core is unavailable, reports core_unavailable once and retries every
//     2 s for 30 s, then exits 1;
//   - when the core closes the socket after the handshake, reports core_unavailable
//     and exits 0;
//   - when Chrome closes stdin, or stop() is called, closes the socket and exits 0.
// It never launches the core. stdout carries frames only; logs contain codes and
// counts, never message content.

import type { Readable, Writable } from "node:stream";
import {
  BRIDGE_PROTOCOL,
  BrowserObservationSchema,
  type CoreUnavailableReason,
  type Hello,
  type ObservationFrame,
  type ToChromeFrame,
  ToChromeFrameSchema,
} from "@scout/contracts";
import {
  type DropCode,
  encodeFrame,
  FrameDecoder,
  FrameError,
  type FrameResult,
  MAX_FRAME_FROM_CHROME,
  MAX_FRAME_TO_CHROME,
} from "@scout/contracts/frame";
import type { RuntimeCheck } from "./config.js";

export const RETRY_INTERVAL_MS = 2_000;
export const RETRY_WINDOW_MS = 30_000;
/** Upper bound on waiting for stdout to flush before exiting anyway. */
export const EXIT_FLUSH_TIMEOUT_MS = 500;
/** Observations are dropped, not queued, while the core socket buffers more than this. */
export const CORE_WRITE_HIGH_WATER_BYTES = 1024 * 1024;

export const EXIT_OK = 0;
export const EXIT_CORE_UNAVAILABLE = 1;
export const EXIT_REFUSED = 2;

const EXTENSION_ID_RE = /^[a-p]{32}$/;

/** Observation kinds the pre-connect buffer keeps (latest of each). */
type BufferedKind = "permissions" | "focus";

/**
 * Flush order for the pre-connect buffer. Fixed, not arrival order: the core
 * accepts focus only after a permissions snapshot on the same connection.
 */
const PRE_CONNECT_FLUSH_ORDER: readonly BufferedKind[] = ["permissions", "focus"];

export interface HostTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The parts of a net.Socket the relay uses. */
export interface CoreSocket {
  readonly writableLength: number;
  write(chunk: Buffer): boolean;
  destroy(): void;
  on(event: "connect", listener: () => void): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

export interface HostDeps {
  /** argv[2] as Chrome passed it: the caller origin. */
  callerOrigin: string | undefined;
  /** Configured extension id (32 chars a-p), or undefined when config is missing. */
  extensionId: string | undefined;
  socketPath: string;
  /** Runs before every connect attempt; production passes config.checkRuntimeDir. */
  checkRuntime(socketPath: string): RuntimeCheck;
  connect(path: string): CoreSocket;
  stdin: Readable;
  stdout: Writable;
  timers: HostTimers;
  exit(code: number): void;
  log(line: string): void;
}

/** Drop and forward counts, by direction and reason. Counts only, never content. */
export interface HostDrops {
  fromChrome: {
    forwarded: number;
    invalid: number;
    noCore: number;
    oversized: number;
    backpressure: number;
    /** page_text that arrived before the handshake finished: dropped, never buffered. */
    textBeforeReady: number;
  };
  fromCore: { forwarded: number; invalid: number };
  decoderDrops: { fromChrome: Record<DropCode, number>; fromCore: Record<DropCode, number> };
}

export interface Host {
  /** A snapshot of the counters; later traffic does not change it. */
  drops(): HostDrops;
  /** Close the socket and exit 0 through the normal flush path (e.g. on a signal). */
  stop(reason: string): void;
}

export function expectedOrigin(extensionId: string): string {
  return `chrome-extension://${extensionId}/`;
}

export function createHost(deps: HostDeps): Host {
  const { stdin, stdout, timers, log } = deps;
  const fromChrome = { forwarded: 0, invalid: 0, noCore: 0, oversized: 0, backpressure: 0, textBeforeReady: 0 };
  const fromCore = { forwarded: 0, invalid: 0 };
  const chromeDecoder = new FrameDecoder({ maxBytes: MAX_FRAME_FROM_CHROME });
  const coreDecoder = new FrameDecoder({ maxBytes: MAX_FRAME_TO_CHROME });

  const drops = (): HostDrops => ({
    fromChrome: { ...fromChrome },
    fromCore: { ...fromCore },
    decoderDrops: { fromChrome: { ...chromeDecoder.dropped }, fromCore: { ...coreDecoder.dropped } },
  });

  let finished = false;
  let exited = false;
  let pendingWrites = 0;
  let exitCode = EXIT_OK;
  let socket: CoreSocket | null = null;
  /** The core answered hello with a capture_policy, and ready was sent. */
  let ready = false;
  let retryTimer: unknown = null;
  let flushTimer: unknown = null;
  let retriesLeft = Math.floor(RETRY_WINDOW_MS / RETRY_INTERVAL_MS);
  let reportedUnavailable: CoreUnavailableReason | null = null;
  /** Encoded observations waiting for the handshake: latest permissions and latest focus. */
  const preConnect = new Map<BufferedKind, Buffer>();

  const doExit = () => {
    if (exited) return;
    exited = true;
    if (flushTimer !== null) timers.clearTimeout(flushTimer);
    flushTimer = null;
    deps.exit(exitCode);
  };

  const finish = (code: number, reason: string) => {
    if (finished) return;
    finished = true;
    exitCode = code;
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
    fromChrome.noCore += preConnect.size;
    preConnect.clear();
    const s = socket;
    socket = null;
    s?.destroy();
    log(`scout-native-host: exit ${code} (${reason}) ${JSON.stringify(drops())}`);
    if (pendingWrites === 0) doExit();
    else flushTimer = timers.setTimeout(doExit, EXIT_FLUSH_TIMEOUT_MS);
  };

  const host: Host = { drops, stop: (reason) => finish(EXIT_OK, reason) };

  const sendToChrome = (frame: ToChromeFrame) => {
    if (finished) return;
    pendingWrites += 1;
    stdout.write(encodeFrame(frame, MAX_FRAME_TO_CHROME), () => {
      pendingWrites -= 1;
      if (finished && pendingWrites === 0) doExit();
    });
  };

  /** Tell the extension the core is unavailable: once per reason, so retries do not repeat it. */
  const reportUnavailable = (reason: CoreUnavailableReason) => {
    if (reportedUnavailable === reason) return;
    reportedUnavailable = reason;
    sendToChrome({ type: "core_unavailable", reason });
  };

  // Origin check comes first, before any filesystem or socket activity.
  if (deps.extensionId === undefined || !EXTENSION_ID_RE.test(deps.extensionId)) {
    finish(EXIT_REFUSED, "config-missing-extension-id");
    return host;
  }
  if (deps.callerOrigin !== expectedOrigin(deps.extensionId)) {
    finish(EXIT_REFUSED, "origin-rejected");
    return host;
  }

  const writeToCore = (s: CoreSocket, bytes: Buffer) => {
    if (s.writableLength > CORE_WRITE_HIGH_WATER_BYTES) {
      fromChrome.backpressure += 1;
      return;
    }
    fromChrome.forwarded += 1;
    s.write(bytes);
  };

  /** The core accepted hello: forward its policy, flush the buffer, then announce ready. */
  const completeHandshake = (s: CoreSocket, policy: ToChromeFrame) => {
    fromCore.forwarded += 1;
    sendToChrome(policy);
    for (const kind of PRE_CONNECT_FLUSH_ORDER) {
      const bytes = preConnect.get(kind);
      if (bytes !== undefined) writeToCore(s, bytes);
    }
    preConnect.clear();
    ready = true;
    sendToChrome({ type: "ready" });
    log("scout-native-host: connected to core");
  };

  const onCoreFrame = (s: CoreSocket, r: FrameResult) => {
    if (!r.ok) return; // counted by the decoder
    const parsed = ToChromeFrameSchema.safeParse(r.value);
    if (!parsed.success) {
      fromCore.invalid += 1;
      return;
    }
    const frame = parsed.data;
    if (frame.type === "upgrade_required") {
      // Mixed versions: fail closed and stay down until the components match.
      reportUnavailable("upgrade_required");
      finish(EXIT_CORE_UNAVAILABLE, `upgrade-required:${frame.protocol}`);
      return;
    }
    if (!ready) {
      // Only a capture_policy completes the handshake; nothing else is relayed before it.
      if (frame.type === "capture_policy") completeHandshake(s, frame);
      else fromCore.invalid += 1;
      return;
    }
    fromCore.forwarded += 1;
    sendToChrome(frame);
  };

  const onChromeFrame = (r: FrameResult) => {
    if (!r.ok) return; // counted by the decoder
    const parsed = BrowserObservationSchema.safeParse(r.value);
    if (!parsed.success) {
      fromChrome.invalid += 1;
      return;
    }
    const frame: ObservationFrame = { type: "observation", observation: parsed.data };
    let bytes: Buffer;
    try {
      bytes = encodeFrame(frame, MAX_FRAME_FROM_CHROME);
    } catch (e) {
      if (!(e instanceof FrameError)) throw e;
      fromChrome.oversized += 1;
      return;
    }
    if (socket !== null && ready) {
      writeToCore(socket, bytes);
      return;
    }
    // Handshake not done (or retrying). page_text was approved under no current
    // policy: drop it. Otherwise keep only the latest per kind.
    const kind = parsed.data.kind;
    if (kind === "page_text") {
      fromChrome.textBeforeReady += 1;
      return;
    }
    if (preConnect.has(kind)) fromChrome.noCore += 1;
    preConnect.set(kind, bytes);
  };

  const scheduleRetry = (errorCode: string) => {
    reportUnavailable("unreachable");
    if (retriesLeft <= 0) {
      finish(EXIT_CORE_UNAVAILABLE, `core-unavailable:${errorCode}`);
      return;
    }
    retriesLeft -= 1;
    retryTimer = timers.setTimeout(connectNow, RETRY_INTERVAL_MS);
  };

  function connectNow() {
    retryTimer = null;
    if (finished) return;

    const check = deps.checkRuntime(deps.socketPath);
    if (check.status === "missing") {
      scheduleRetry("ENOENT");
      return;
    }
    if (check.status === "refused") {
      reportUnavailable("unsafe");
      finish(EXIT_CORE_UNAVAILABLE, `runtime-refused:${check.reason}`);
      return;
    }

    const s = deps.connect(deps.socketPath);
    socket = s;
    let errorCode = "closed";
    s.on("connect", () => {
      if (socket !== s) return;
      const hello: Hello = { type: "hello", protocol: BRIDGE_PROTOCOL };
      s.write(encodeFrame(hello, MAX_FRAME_FROM_CHROME));
      // ready waits for the core's capture_policy (completeHandshake).
    });
    s.on("data", (chunk) => {
      if (socket !== s) return;
      for (const r of coreDecoder.push(chunk)) {
        if (socket !== s) return; // a frame in this chunk ended the connection
        onCoreFrame(s, r);
      }
    });
    s.on("error", (e) => {
      errorCode = e.code ?? "error";
    });
    s.on("close", () => {
      if (socket !== s) return; // we closed it
      socket = null;
      coreDecoder.end();
      if (ready) {
        // A close after the handshake is the core going away: exit so Chrome
        // relaunches us, rather than retrying.
        ready = false;
        sendToChrome({ type: "core_unavailable", reason: "unreachable" });
        finish(EXIT_OK, "core-closed");
        return;
      }
      // Closed before any policy: not up yet, or an old core that refused our hello.
      scheduleRetry(errorCode === "closed" ? "closed-before-policy" : errorCode);
    });
  }

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
