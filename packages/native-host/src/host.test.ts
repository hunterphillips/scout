import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Duplex, PassThrough, Writable } from "node:stream";
import { encodeFrame, FrameDecoder, frameHeader, MAX_FRAME_FROM_CHROME } from "@scout/contracts/frame";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHost,
  EXIT_CORE_UNAVAILABLE,
  EXIT_OK,
  EXIT_REFUSED,
  type HostDeps,
  readExtensionId,
  RETRY_INTERVAL_MS,
  RETRY_WINDOW_MS,
  scoutHome,
} from "./host.js";

const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${EXT_ID}/`;

const focus = { kind: "focus", seq: 1, at: 1000, browserFocused: true, windowId: 7 } as const;
const permissions = { kind: "permissions", granted: ["https://github.com/*"] } as const;

const tick = () => new Promise<void>((r) => setImmediate(r));
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
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
class FakeSocket extends EventEmitter {
  readonly written: Buffer[] = [];
  destroyed = false;
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
  const stdout = new Writable({
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
    stdin,
    stdout,
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      connectTimes.push(timers.now);
      return s as unknown as Duplex;
    },
    timers,
    exit: (c) => exits.push(c),
    log: (l) => logs.push(l),
    ...over,
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
    expect(h.host.counters.fromChrome.forwarded).toBe(2);
    expect(h.host.counters.fromCore.forwarded).toBe(2);
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
    expect(h.host.counters.fromChrome).toMatchObject({ forwarded: 1, invalid: 2 });
    expect(h.host.chromeDecoder.dropped).toMatchObject({ "invalid-json": 1, oversized: 1 });
  });

  it("drops and counts invalid core frames", async () => {
    const h = harness();
    h.last().succeed();
    h.last().feed({ type: "ack", seq: -1 });
    h.last().feed({ type: "hello", protocol: 1 });
    h.last().feed({ type: "ack", seq: 2 });
    await settle();
    expect(h.toChrome()).toEqual([{ type: "ack", seq: 2 }]);
    expect(h.host.counters.fromCore).toEqual({ forwarded: 1, invalid: 2 });
  });

  it("drops observations that arrive before the core is connected", async () => {
    const h = harness();
    h.stdin.write(encodeFrame(focus));
    await settle();
    h.last().succeed();
    expect(h.last().frames()).toEqual([{ type: "hello", protocol: 1 }]);
    expect(h.host.counters.fromChrome.noCore).toBe(1);
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
    await new Promise((r) => setTimeout(r, 50));
    h.stdin.write(encodeFrame(focus));
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([{ type: "hello", protocol: 1 }, { type: "observation", observation: focus }]);

    peer!.write(encodeFrame({ type: "ack", seq: 1 }));
    await new Promise((r) => setTimeout(r, 50));
    peer!.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.toChrome()).toEqual([{ type: "ack", seq: 1 }, { type: "core_unavailable" }]);
    expect(h.exits).toEqual([EXIT_OK]);
  });

  it("reports core_unavailable when the socket file is missing", async () => {
    dir = mkdtempSync(join(tmpdir(), "scout-nh-"));
    const h = harness({ socketPath: join(dir, "core.sock"), connect: (p) => netConnect({ path: p }) });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.toChrome()).toEqual([{ type: "core_unavailable" }]);
    expect(h.timers.pending).toBe(1);
    h.stdin.end();
    await settle();
    expect(h.exits).toEqual([EXIT_OK]);
  });
});

describe("config", () => {
  it("reads extensionId from <SCOUT_HOME>/config.json", () => {
    const home = mkdtempSync(join(tmpdir(), "scout-home-"));
    try {
      expect(scoutHome({ SCOUT_HOME: home })).toBe(home);
      expect(readExtensionId(home)).toBeUndefined();
      writeFileSync(join(home, "config.json"), JSON.stringify({ extensionId: EXT_ID, nodePath: "/x" }));
      expect(readExtensionId(home)).toBe(EXT_ID);
      writeFileSync(join(home, "config.json"), "{broken");
      expect(readExtensionId(home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
