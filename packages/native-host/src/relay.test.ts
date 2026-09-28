import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { encodeFrame, FrameDecoder, frameHeader, MAX_FRAME_FROM_CHROME } from "@scout/contracts/frame";
import { afterEach, describe, expect, it } from "vitest";
import { checkRuntimeDir, coreSocketPath } from "./config.js";
import {
  CORE_WRITE_HIGH_WATER_BYTES,
  type CoreSocket,
  createHost,
  EXIT_CORE_UNAVAILABLE,
  EXIT_FLUSH_TIMEOUT_MS,
  EXIT_OK,
  EXIT_REFUSED,
  type HostDeps,
  RETRY_INTERVAL_MS,
  RETRY_WINDOW_MS,
} from "./relay.js";

const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${EXT_ID}/`;

const focus = { kind: "focus", seq: 1, at: 1000, browserFocused: true, windowId: 7 } as const;
const permissions = { kind: "permissions", granted: ["https://github.com/*"] } as const;

const tick = () => new Promise<void>((r) => setImmediate(r));
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};
/** Polls until `cond` holds, failing after `timeoutMs` of real time. */
const waitFor = async (cond: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** Manual clock: only the host's own timers, advanced explicitly. */
class FakeTimers {
  now = 0;
  private seq = 0;
  private queue = new Map<number, { due: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.queue.set(id, { due: this.now + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.queue.delete(h as number);
  };
  get pending() {
    return this.queue.size;
  }
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      let next: [number, { due: number; fn: () => void }] | undefined;
      for (const e of this.queue) if (e[1].due <= end && (!next || e[1].due < next[1].due)) next = e;
      if (!next) break;
      this.queue.delete(next[0]);
      this.now = next[1].due;
      next[1].fn();
    }
    this.now = end;
  }
}

/** Fake core socket: records writes, lets the test connect, feed, fail, or close it. */
class FakeSocket extends EventEmitter implements CoreSocket {
  readonly written: Buffer[] = [];
  destroyed = false;
  writableLength = 0;
  write(b: Buffer) {
    this.written.push(b);
    return true;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
  succeed() {
    this.emit("connect");
  }
  fail(code = "ENOENT") {
    this.emit("error", Object.assign(new Error(code), { code }));
    this.destroy();
  }
  feed(obj: object) {
    this.emit("data", encodeFrame(obj));
  }
  frames() {
    const d = new FrameDecoder();
    return d.push(Buffer.concat(this.written)).map((r) => (r.ok ? r.value : r.code));
  }
}

function harness(over: Partial<HostDeps> = {}) {
  const stdin = new PassThrough();
  const out: Buffer[] = [];
  const stdout =
    over.stdout ??
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        out.push(chunk);
        cb();
      },
    });
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  const connectTimes: number[] = [];
  const exits: number[] = [];
  const logs: string[] = [];
  const host = createHost({
    callerOrigin: ORIGIN,
    extensionId: EXT_ID,
    socketPath: "/nonexistent/core.sock",
    checkRuntime: () => ({ status: "ok" }),
    stdin,
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      connectTimes.push(timers.now);
      return s;
    },
    timers,
    exit: (c) => exits.push(c),
    log: (l) => logs.push(l),
    ...over,
    stdout,
  });
  const toChrome = () => {
    const d = new FrameDecoder();
    return d.push(Buffer.concat(out)).map((r) => (r.ok ? r.value : r.code));
  };
  const last = () => sockets[sockets.length - 1]!;
  return { host, stdin, timers, sockets, connectTimes, exits, logs, toChrome, last };
}

describe("origin check", () => {
  for (const [name, over] of [
    ["wrong origin", { callerOrigin: "chrome-extension://pppppppppppppppppppppppppppppppp/" }],
    ["missing origin", { callerOrigin: undefined }],
    ["origin without trailing slash", { callerOrigin: `chrome-extension://${EXT_ID}` }],
    ["missing configured id", { extensionId: undefined }],
    ["malformed configured id", { extensionId: "not-an-id", callerOrigin: "chrome-extension://not-an-id/" }],
  ] as const) {
    it(`${name}: exits ${EXIT_REFUSED} before touching the socket`, async () => {
      const h = harness(over);
      await settle();
      expect(h.exits).toEqual([EXIT_REFUSED]);
      expect(h.sockets).toHaveLength(0);
      expect(h.toChrome()).toEqual([]);
    });
  }
});

describe("relay", () => {
  it("sends hello first, then forwards validated, re-encoded frames both ways", async () => {
    const h = harness();
    h.last().succeed();
    expect(h.last().frames()).toEqual([{ type: "hello", protocol: 1 }]);

    h.stdin.write(encodeFrame({ ...focus, injected: "x" }));
    h.stdin.write(encodeFrame(permissions));
    await settle();
    expect(h.last().frames().slice(1)).toEqual([
      { type: "observation", observation: focus },
      { type: "observation", observation: permissions },
    ]);

    h.last().feed({ type: "ack", seq: 4, extra: "dropped" });
    h.last().feed({ type: "core_unavailable" });
    await settle();
    expect(h.toChrome()).toEqual([{ type: "ack", seq: 4 }, { type: "core_unavailable" }]);
    expect(h.host.drops().fromChrome.forwarded).toBe(2);
    expect(h.host.drops().fromCore.forwarded).toBe(2);
    expect(h.exits).toEqual([]);
  });

  it("drops and counts invalid Chrome frames and keeps the stream going", async () => {
    const h = harness();
    h.last().succeed();
    const notJson = Buffer.from("{nope", "utf8");
    const bigLen = MAX_FRAME_FROM_CHROME + 1;
    h.stdin.write(
      Buffer.concat([
        encodeFrame({ kind: "focus", seq: -1 }), // schema-invalid
        encodeFrame({ type: "hello", protocol: 1 }), // not an observation
        frameHeader(notJson.length),
        notJson, // invalid JSON
        frameHeader(bigLen),
        Buffer.alloc(bigLen), // oversized
        encodeFrame(focus),
      ]),
    );
    await settle();
    expect(h.last().frames().slice(1)).toEqual([{ type: "observation", observation: focus }]);
    expect(h.host.drops().fromChrome).toMatchObject({ forwarded: 1, invalid: 2 });
    expect(h.host.drops().decoderDrops.fromChrome).toMatchObject({ "invalid-json": 1, oversized: 1 });
  });

  it("drops and counts invalid core frames", async () => {
    const h = harness();
    h.last().succeed();
    h.last().feed({ type: "ack", seq: -1 });
    h.last().feed({ type: "hello", protocol: 1 });
    h.last().feed({ type: "ack", seq: 2 });
    await settle();
    expect(h.toChrome()).toEqual([{ type: "ack", seq: 2 }]);
    expect(h.host.drops().fromCore).toEqual({ forwarded: 1, invalid: 2 });
  });

  it("buffers the latest observation per kind before connect and flushes it after hello, in order", async () => {
    const h = harness();
    const focus2 = { ...focus, seq: 2, windowId: 8 };
    h.stdin.write(encodeFrame(focus));
    h.stdin.write(encodeFrame(permissions));
    h.stdin.write(encodeFrame(focus2)); // replaces the older focus
    await settle();
    expect(h.last().frames()).toEqual([]);
    h.last().succeed();
    expect(h.last().frames()).toEqual([
      { type: "hello", protocol: 1 },
      { type: "observation", observation: permissions },
      { type: "observation", observation: focus2 },
    ]);
    expect(h.host.drops().fromChrome).toMatchObject({ forwarded: 2, noCore: 1 });
  });

  it("keeps the pre-connect buffer across retries and counts leftovers on exit", async () => {
    const h = harness();
    h.stdin.write(encodeFrame(focus));
    await settle();
    h.last().fail();
    h.timers.advance(RETRY_INTERVAL_MS);
    h.last().succeed();
    expect(h.last().frames().slice(1)).toEqual([{ type: "observation", observation: focus }]);

    const g = harness();
    g.stdin.write(encodeFrame(focus));
    g.stdin.end();
    await settle();
    expect(g.host.drops().fromChrome).toMatchObject({ forwarded: 0, noCore: 1 });
  });

  it("drops and counts observations while the core socket is backed up", async () => {
    const h = harness();
    h.last().succeed();
    h.last().writableLength = CORE_WRITE_HIGH_WATER_BYTES + 1;
    h.stdin.write(encodeFrame(focus));
    await settle();
    expect(h.last().frames()).toEqual([{ type: "hello", protocol: 1 }]);
    expect(h.host.drops().fromChrome).toMatchObject({ forwarded: 0, backpressure: 1 });
  });

  it("returns a snapshot from drops(), not live counters", async () => {
    const h = harness();
    h.last().succeed();
    const before = h.host.drops();
    h.stdin.write(encodeFrame(focus));
    await settle();
    expect(before.fromChrome.forwarded).toBe(0);
    expect(h.host.drops().fromChrome.forwarded).toBe(1);
  });
});

describe("core unavailable", () => {
  it("reports once, retries every 2 s, and exits 1 after 30 s", async () => {
    const h = harness();
    h.last().fail("ENOENT");
    await settle();
    expect(h.toChrome()).toEqual([{ type: "core_unavailable" }]);

    for (let t = RETRY_INTERVAL_MS; t < RETRY_WINDOW_MS; t += RETRY_INTERVAL_MS) {
      h.timers.advance(RETRY_INTERVAL_MS);
      h.last().fail("ECONNREFUSED");
    }
    await settle();
    expect(h.exits).toEqual([]);

    h.timers.advance(RETRY_INTERVAL_MS);
    h.last().fail("ENOENT");
    await settle();
    expect(h.connectTimes).toEqual(Array.from({ length: 16 }, (_, i) => i * RETRY_INTERVAL_MS));
    expect(h.exits).toEqual([EXIT_CORE_UNAVAILABLE]);
    expect(h.toChrome()).toEqual([{ type: "core_unavailable" }]);
    expect(h.timers.pending).toBe(0);
  });

  it("proceeds normally when a retry connects", async () => {
    const h = harness();
    h.last().fail();
    h.timers.advance(RETRY_INTERVAL_MS);
    h.last().fail();
    h.timers.advance(RETRY_INTERVAL_MS);
    h.last().succeed();
    expect(h.last().frames()).toEqual([{ type: "hello", protocol: 1 }]);

    h.timers.advance(RETRY_WINDOW_MS * 2);
    h.stdin.write(encodeFrame(focus));
    await settle();
    expect(h.sockets).toHaveLength(3);
    expect(h.last().frames().slice(1)).toEqual([{ type: "observation", observation: focus }]);
    expect(h.exits).toEqual([]);
  });

  it("reports core_unavailable and exits 0 when the core closes the socket", async () => {
    const h = harness();
    h.last().succeed();
    h.last().destroy();
    await settle();
    expect(h.toChrome()).toEqual([{ type: "core_unavailable" }]);
    expect(h.exits).toEqual([EXIT_OK]);
    expect(h.sockets).toHaveLength(1);
  });
});

describe("shutdown", () => {
  it("closes the socket and exits 0 when Chrome closes stdin", async () => {
    const h = harness();
    h.last().succeed();
    h.stdin.end();
    await settle();
    expect(h.last().destroyed).toBe(true);
    expect(h.exits).toEqual([EXIT_OK]);
    expect(h.toChrome()).toEqual([]);
  });

  it("stop() closes the socket, logs the reason, and exits 0 once", async () => {
    const h = harness();
    h.last().succeed();
    h.host.stop("signal:SIGTERM");
    h.host.stop("signal:SIGINT");
    await settle();
    expect(h.last().destroyed).toBe(true);
    expect(h.exits).toEqual([EXIT_OK]);
    expect(h.logs.join("\n")).toContain("signal:SIGTERM");
    expect(h.logs.join("\n")).not.toContain("signal:SIGINT");
  });

  it("waits at most the flush cap for stdout before exiting", async () => {
    const out: Buffer[] = [];
    const stdout = new Writable({
      write(chunk: Buffer) {
        out.push(chunk); // never calls back
      },
    });
    const h = harness({ stdout });
    h.last().fail();
    await settle();
    h.stdin.end();
    await settle();
    expect(out).toHaveLength(1);
    expect(h.exits).toEqual([]);
    h.timers.advance(EXIT_FLUSH_TIMEOUT_MS - 1);
    expect(h.exits).toEqual([]);
    h.timers.advance(1);
    expect(h.exits).toEqual([EXIT_OK]);
  });

  it("exits 0 without throwing when stdout errors (EPIPE)", async () => {
    const stdout = new Writable({
      write(_chunk, _enc, cb) {
        cb(Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
      },
    });
    const h = harness({ stdout });
    h.last().fail();
    await settle();
    expect(h.exits).toEqual([EXIT_OK]);
    expect(h.logs.join("\n")).toContain("stdout-error");
    h.timers.advance(RETRY_WINDOW_MS * 2);
    expect(h.exits).toEqual([EXIT_OK]);
  });

  it("logs drop counts, never content", async () => {
    const h = harness();
    h.last().succeed();
    h.stdin.write(encodeFrame({ kind: "page_text", secret: "SECRET-PAGE-TEXT" }));
    h.stdin.end();
    await settle();
    const all = h.logs.join("\n");
    expect(all).toContain('"invalid":1');
    expect(all).not.toContain("SECRET-PAGE-TEXT");
  });
});

describe("with a real Unix socket", () => {
  let dir: string;
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("relays through net.connect to a fake core server", async () => {
    dir = mkdtempSync(join(tmpdir(), "scout-nh-"));
    const path = join(dir, "core.sock");
    const received: unknown[] = [];
    let peer: Socket | undefined;
    server = createServer((s) => {
      peer = s;
      const d = new FrameDecoder();
      s.on("data", (c) => {
        for (const r of d.push(c)) if (r.ok) received.push(r.value);
      });
    });
    await new Promise<void>((r) => server!.listen(path, r));

    const h = harness({ socketPath: path, connect: (p) => netConnect({ path: p }) });
    await waitFor(() => received.length === 1);
    h.stdin.write(encodeFrame(focus));
    await waitFor(() => received.length === 2);
    expect(received).toEqual([{ type: "hello", protocol: 1 }, { type: "observation", observation: focus }]);

    peer!.write(encodeFrame({ type: "ack", seq: 1 }));
    await waitFor(() => h.toChrome().length === 1);
    peer!.destroy();
    await waitFor(() => h.exits.length === 1);
    expect(h.toChrome()).toEqual([{ type: "ack", seq: 1 }, { type: "core_unavailable" }]);
    expect(h.exits).toEqual([EXIT_OK]);
  });

  it("reports core_unavailable when the socket file is missing", async () => {
    dir = mkdtempSync(join(tmpdir(), "scout-nh-"));
    const h = harness({ socketPath: join(dir, "core.sock"), connect: (p) => netConnect({ path: p }) });
    await waitFor(() => h.timers.pending === 1);
    expect(h.toChrome()).toEqual([{ type: "core_unavailable" }]);
    expect(h.timers.pending).toBe(1);
    h.stdin.end();
    await settle();
    expect(h.exits).toEqual([EXIT_OK]);
  });
});

describe("runtime-dir check against a temp SCOUT_HOME", () => {
  let home: string;
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const withRealCheck = (socketPath: string, over: Partial<HostDeps> = {}) =>
    harness({ socketPath, checkRuntime: checkRuntimeDir, ...over });

  it("treats a missing runtime dir like ENOENT: reports once and retries", async () => {
    home = mkdtempSync(join(tmpdir(), "scout-home-"));
    const h = withRealCheck(coreSocketPath(home));
    await settle();
    expect(h.sockets).toHaveLength(0);
    expect(h.toChrome()).toEqual([{ type: "core_unavailable" }]);
    expect(h.timers.pending).toBe(1);

    mkdirSync(join(home, "run"), { mode: 0o700 });
    h.timers.advance(RETRY_INTERVAL_MS); // dir exists, socket still missing
    expect(h.sockets).toHaveLength(0);
    expect(h.exits).toEqual([]);
    expect(h.timers.pending).toBe(1);
  });

  it("refuses a runtime dir with group/other access: core_unavailable, exit 1, no retry", async () => {
    home = mkdtempSync(join(tmpdir(), "scout-home-"));
    mkdirSync(join(home, "run"));
    chmodSync(join(home, "run"), 0o755);
    const h = withRealCheck(coreSocketPath(home));
    await settle();
    expect(h.sockets).toHaveLength(0);
    expect(h.toChrome()).toEqual([{ type: "core_unavailable" }]);
    expect(h.exits).toEqual([EXIT_CORE_UNAVAILABLE]);
    expect(h.timers.pending).toBe(0);
    expect(h.logs.join("\n")).toContain("runtime-refused:runtime-dir-not-private");
  });

  it("refuses on a retry when the runtime dir turns unsafe mid-window", async () => {
    home = mkdtempSync(join(tmpdir(), "scout-home-"));
    const h = withRealCheck(coreSocketPath(home));
    await settle();
    mkdirSync(join(home, "run"), { mode: 0o700 });
    chmodSync(join(home, "run"), 0o770);
    h.timers.advance(RETRY_INTERVAL_MS);
    await settle();
    expect(h.toChrome()).toEqual([{ type: "core_unavailable" }]);
    expect(h.exits).toEqual([EXIT_CORE_UNAVAILABLE]);
    expect(h.timers.pending).toBe(0);
  });

  it("connects through a private dir and socket", async () => {
    home = mkdtempSync(join(tmpdir(), "scout-home-"));
    mkdirSync(join(home, "run"), { mode: 0o700 });
    const path = coreSocketPath(home);
    const received: unknown[] = [];
    const server = createServer((s) => {
      const d = new FrameDecoder();
      s.on("data", (c) => {
        for (const r of d.push(c)) if (r.ok) received.push(r.value);
      });
    });
    await new Promise<void>((r) => server.listen(path, r));
    try {
      chmodSync(path, 0o600);
      const h = withRealCheck(path, { connect: (p) => netConnect({ path: p }) });
      await waitFor(() => received.length === 1);
      expect(received).toEqual([{ type: "hello", protocol: 1 }]);
      h.host.stop("test-done");
      await waitFor(() => h.exits.length === 1);
    } finally {
      server.close();
    }
  });
});
