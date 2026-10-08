import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { AnyHelloSchema, BRIDGE_PROTOCOL, NATIVE_COMMAND_MAX_BYTES } from "@scout/contracts";
import { encodeFrame, FrameDecoder, frameHeader, MAX_FRAME_FROM_CHROME, MAX_FRAME_TO_CHROME, MAX_PANEL_FRAME_BYTES } from "@scout/contracts/frame";
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
  POLICY_TIMEOUT_MS,
  RETRY_INTERVAL_MS,
  RETRY_WINDOW_MS,
} from "./relay.js";

const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${EXT_ID}/`;

const focus = { kind: "focus", seq: 1, at: 1000, browserFocused: true, windowId: 7 } as const;
const permissions = { kind: "permissions", revision: 5, at: 999, granted: ["https://linear.app/*"] } as const;
/** The core's answer to hello: capture disabled until it has the extension's snapshot. */
const POLICY = { type: "capture_policy", revision: 1, paused: false, captureEnabled: false } as const;
const HELLO = { type: "hello", protocol: BRIDGE_PROTOCOL } as const;
const UNREACHABLE = { type: "core_unavailable", reason: "unreachable" } as const;
const UNSAFE = { type: "core_unavailable", reason: "unsafe" } as const;

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
  /** Connect, then answer hello with the initial capture-disabled policy. */
  handshake() {
    this.succeed();
    this.feed(POLICY);
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
    h.last().handshake();
    expect(h.last().frames()).toEqual([HELLO]);
    await settle();
    expect(h.toChrome()).toEqual([POLICY, { type: "ready" }]);

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
    expect(h.toChrome()).toEqual([POLICY, { type: "ready" }, { type: "ack", seq: 4 }, { type: "core_unavailable" }]);
    expect(h.host.drops().fromChrome.forwarded).toBe(2);
    expect(h.host.drops().fromCore.forwarded).toBe(3);
    expect(h.exits).toEqual([]);
  });

  it("drops and counts invalid Chrome frames and keeps the stream going", async () => {
    const h = harness();
    h.last().handshake();
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
    h.last().handshake();
    h.last().feed({ type: "ack", seq: -1 });
    h.last().feed({ type: "hello", protocol: 1 });
    h.last().feed({ type: "capture_policy", revision: 2, paused: "no", captureEnabled: true });
    h.last().feed({ type: "ack", seq: 2 });
    await settle();
    expect(h.toChrome()).toEqual([POLICY, { type: "ready" }, { type: "ack", seq: 2 }]);
    expect(h.host.drops().fromCore).toEqual({ forwarded: 2, invalid: 3, oversized: 0 });
  });

  it("relays later capture_policy frames from the core to Chrome", async () => {
    const h = harness();
    h.last().handshake();
    const enabled = { type: "capture_policy", revision: 2, paused: false, captureEnabled: true, extra: 1 };
    const paused = { type: "capture_policy", revision: 3, paused: true, captureEnabled: false };
    h.last().feed(enabled);
    h.last().feed(paused);
    await settle();
    expect(h.toChrome()).toEqual([POLICY, { type: "ready" }, { type: "capture_policy", revision: 2, paused: false, captureEnabled: true }, paused]);
  });

  it("buffers the latest observation per kind before connect and flushes it after hello, in order", async () => {
    const h = harness();
    const focus2 = { ...focus, seq: 2, windowId: 8 };
    h.stdin.write(encodeFrame(focus));
    h.stdin.write(encodeFrame(permissions));
    h.stdin.write(encodeFrame(focus2)); // replaces the older focus
    await settle();
    expect(h.last().frames()).toEqual([]);
    h.last().handshake();
    expect(h.last().frames()).toEqual([
      HELLO,
      { type: "observation", observation: permissions },
      { type: "observation", observation: focus2 },
    ]);
    expect(h.host.drops().fromChrome).toMatchObject({ forwarded: 2, noCore: 1 });
  });

  it("flushes permissions, then focus, regardless of arrival order, and drops page_text sent before the handshake", async () => {
    const h = harness();
    const pageText = {
      kind: "page_text",
      seq: 2,
      at: 1001,
      tabId: 3,
      documentId: "doc-a",
      url: "https://linear.app/acme/issue/ENG-1",
      source: "page",
      title: "Issue",
      text: "body",
      truncated: false,
    } as const;
    const refocus = { ...focus, seq: 3, at: 1002 };
    h.stdin.write(encodeFrame(focus));
    h.stdin.write(encodeFrame(pageText));
    h.stdin.write(encodeFrame(refocus)); // same tab refocused
    h.stdin.write(encodeFrame(permissions));
    await settle();
    h.last().handshake();
    expect(h.last().frames()).toEqual([
      HELLO,
      { type: "observation", observation: permissions },
      { type: "observation", observation: refocus },
    ]);
    expect(h.host.drops().fromChrome).toMatchObject({ forwarded: 2, noCore: 1, textBeforeReady: 1 });
  });

  it("keeps the pre-connect buffer across retries and counts leftovers on exit", async () => {
    const h = harness();
    h.stdin.write(encodeFrame(focus));
    await settle();
    h.last().fail();
    h.timers.advance(RETRY_INTERVAL_MS);
    h.last().handshake();
    expect(h.last().frames().slice(1)).toEqual([{ type: "observation", observation: focus }]);

    const g = harness();
    g.stdin.write(encodeFrame(focus));
    g.stdin.end();
    await settle();
    expect(g.host.drops().fromChrome).toMatchObject({ forwarded: 0, noCore: 1 });
  });

  it("drops and counts observations while the core socket is backed up", async () => {
    const h = harness();
    h.last().handshake();
    h.last().writableLength = CORE_WRITE_HIGH_WATER_BYTES + 1;
    h.stdin.write(encodeFrame(focus));
    await settle();
    expect(h.last().frames()).toEqual([HELLO]);
    expect(h.host.drops().fromChrome).toMatchObject({ forwarded: 0, backpressure: 1 });
  });

  it("returns a snapshot from drops(), not live counters", async () => {
    const h = harness();
    h.last().handshake();
    const before = h.host.drops();
    h.stdin.write(encodeFrame(focus));
    await settle();
    expect(before.fromChrome.forwarded).toBe(0);
    expect(h.host.drops().fromChrome.forwarded).toBe(1);
  });
});

describe("protocol-3 window commands and panel frames", () => {
  const pause = { type: "command", command: { type: "pause" } } as const;
  const approve = {
    type: "command",
    command: { type: "approve", commandId: "sp-1", resourceId: `res_${"a".repeat(64)}`, version: "1".repeat(64), expectedRevision: 2 },
  } as const;
  const openLink = {
    type: "command",
    command: { type: "open_link", commandId: "sp-2", coreInstanceId: "core-1", visitEpoch: 3, jobId: "job-1", candidateId: "c1" },
  } as const;
  const grant = { type: "panel", state: { type: "grant", agentBrowserContext: false } } as const;
  /** What Chrome got, read with the panel cap. */
  const decodeAll = (out: Buffer[]) => new FrameDecoder({ maxBytes: MAX_PANEL_FRAME_BYTES }).push(Buffer.concat(out));

  it("forwards validated commands as command bridge frames, re-encoded without extra keys", async () => {
    const h = harness();
    h.last().handshake();
    h.stdin.write(encodeFrame({ ...pause, extra: 1 }));
    h.stdin.write(encodeFrame({ type: "command", command: { ...openLink.command, href: "https://evil.example/" } })); // strict: refused
    h.stdin.write(encodeFrame(openLink));
    await settle();
    expect(h.last().frames().slice(1)).toEqual([pause, openLink]);
    expect(h.host.drops().fromChrome).toMatchObject({ forwarded: 2, commandsHandedOff: 2, invalid: 1 });
  });

  it("refuses frontmost and shutdown from the extension and counts them, never forwarding", async () => {
    const h = harness();
    h.last().handshake();
    h.stdin.write(encodeFrame({ type: "command", command: { type: "frontmost", bundleId: "com.google.Chrome", at: 1 } }));
    h.stdin.write(encodeFrame({ type: "command", command: { type: "shutdown" } }));
    h.stdin.write(encodeFrame({ type: "command", command: { type: "shutdown", commandId: "x" } }));
    h.stdin.write(encodeFrame({ type: "command", command: { type: "teleport" } }));
    await settle();
    expect(h.last().frames()).toEqual([HELLO]);
    expect(h.host.drops().fromChrome).toMatchObject({ forwarded: 0, commandsHandedOff: 0, refusedCommand: 3, invalid: 1 });
  });

  it("forwards the largest valid command: every relay command fits NATIVE_COMMAND_MAX_BYTES (the size check is a guard)", async () => {
    const h = harness();
    h.last().handshake();
    const origin = `https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}:65535`;
    const big = {
      type: "command",
      command: { type: "set_auto_acquire", commandId: "x".repeat(64), origin, enabled: true, expectedEnabled: false, acknowledgeRisk: true },
    };
    h.stdin.write(encodeFrame(big));
    await settle();
    expect(Buffer.byteLength(`${JSON.stringify(big.command)}\n`)).toBeLessThan(NATIVE_COMMAND_MAX_BYTES);
    expect(h.host.drops().fromChrome).toMatchObject({ commandOversized: 0, invalid: 0, forwarded: 1 });
  });

  it("never buffers a command before ready: dropped and counted, and none reach the core after the handshake", async () => {
    const h = harness();
    h.stdin.write(encodeFrame(pause));
    h.stdin.write(encodeFrame(approve));
    await settle();
    h.last().succeed(); // connected, hello sent, no policy yet
    h.stdin.write(encodeFrame(pause));
    await settle();
    h.last().feed(POLICY);
    await settle();
    expect(h.last().frames()).toEqual([HELLO]);
    expect(h.host.drops().fromChrome).toMatchObject({ commandBeforeReady: 3, forwarded: 0 });
    h.stdin.write(encodeFrame(pause));
    await settle();
    expect(h.last().frames()).toEqual([HELLO, pause]);
  });

  it("relays validated panel frames to Chrome after ready, and drops invalid ones", async () => {
    const h = harness();
    h.last().succeed();
    h.last().feed(grant); // before the policy: not relayed
    h.last().feed(POLICY);
    h.last().feed({ ...grant, extra: 1 });
    h.last().feed({ type: "panel", state: { type: "results", status: "ok" } }); // invalid state
    h.last().feed({ type: "panel", state: { type: "ack", commandId: "sp-2", ok: true, revision: 0, approvalRevision: 0, target: { href: "https://docs.example/a" } } });
    await settle();
    expect(h.toChrome()).toEqual([
      POLICY,
      { type: "ready" },
      grant,
      { type: "panel", state: { type: "ack", commandId: "sp-2", ok: true, revision: 0, approvalRevision: 0, target: { href: "https://docs.example/a" } } },
    ]);
    expect(h.host.drops().fromCore).toMatchObject({ forwarded: 3, invalid: 2 });
  });

  it("carries a panel frame up to 1 MiB to Chrome, drops a larger one unread, and drops any other frame over 16 KiB", async () => {
    const out: Buffer[] = [];
    const stdout = new Writable({
      write(chunk: Buffer, _enc, cb) {
        out.push(chunk);
        cb();
      },
    });
    const h = harness({ stdout });
    h.last().handshake();
    // A preview chunk carries the bulk: its text is free-form.
    const chunk = (textBytes: number) => ({
      type: "panel",
      state: {
        type: "preview",
        commandId: "sp-3",
        resourceId: `res_${"a".repeat(64)}`,
        version: "1".repeat(64),
        seq: 0,
        offset: 0,
        totalBytes: 1,
        text: "t".repeat(textBytes),
        sha256: "b".repeat(64),
        descriptor: { kind: "llms_txt", siteOrigin: "https://docs.example", sourceUrl: "https://docs.example/llms.txt" },
      },
    });
    const overhead = Buffer.byteLength(JSON.stringify(chunk(0)));
    const fits = chunk(MAX_PANEL_FRAME_BYTES - overhead);
    const tooBig = chunk(MAX_PANEL_FRAME_BYTES - overhead + 1);
    const fatPolicy = { type: "capture_policy", revision: 2, paused: false, captureEnabled: false, pad: "p".repeat(MAX_FRAME_TO_CHROME) };
    h.last().emit("data", Buffer.concat([encodeFrame(fits, MAX_PANEL_FRAME_BYTES), encodeFrame(tooBig, MAX_PANEL_FRAME_BYTES + 1), encodeFrame(fatPolicy, MAX_PANEL_FRAME_BYTES), encodeFrame(grant)]));
    await settle();
    const got = decodeAll(out).map((r) => (r.ok ? (r.value["type"] as string) : r.code));
    expect(got).toEqual(["capture_policy", "ready", "panel", "panel"]);
    expect(h.host.drops().decoderDrops.fromCore).toMatchObject({ oversized: 2 });
  });
});

describe("protocol-3 handshake", () => {
  const pageText = {
    kind: "page_text", seq: 3, at: 1002, tabId: 3, documentId: "doc-a", url: "https://linear.app/acme/issue/ENG-1",
    source: "page", title: "Issue", text: "body", truncated: false,
  } as const;

  it("holds ready until the core's capture_policy, forwards the policy first, and buffers observations meanwhile", async () => {
    const h = harness();
    h.last().succeed();
    h.stdin.write(encodeFrame(focus));
    h.stdin.write(encodeFrame(permissions));
    h.stdin.write(encodeFrame(pageText));
    await settle();
    expect(h.last().frames()).toEqual([HELLO]);
    expect(h.toChrome()).toEqual([]);

    h.last().feed({ type: "ack", seq: 1 }); // not a policy: the handshake is not done
    await settle();
    expect(h.toChrome()).toEqual([]);
    expect(h.host.drops().fromCore.invalid).toBe(1);

    h.last().feed(POLICY);
    await settle();
    expect(h.toChrome()).toEqual([POLICY, { type: "ready" }]);
    expect(h.last().frames()).toEqual([HELLO, { type: "observation", observation: permissions }, { type: "observation", observation: focus }]);
    expect(h.host.drops().fromChrome).toMatchObject({ textBeforeReady: 1 });

    // After ready, page_text goes straight through.
    h.stdin.write(encodeFrame(pageText));
    await settle();
    expect(h.last().frames().at(-1)).toEqual({ type: "observation", observation: pageText });
  });

  it("upgrade_required from the core: core_unavailable{upgrade_required}, exit 1, no retry", async () => {
    const h = harness();
    h.stdin.write(encodeFrame(permissions));
    await settle();
    h.last().succeed();
    h.last().feed({ type: "upgrade_required", protocol: 3 });
    await settle();
    expect(h.toChrome()).toEqual([{ type: "core_unavailable", reason: "upgrade_required" }]);
    expect(h.exits).toEqual([EXIT_CORE_UNAVAILABLE]);
    expect(h.last().destroyed).toBe(true);
    expect(h.last().frames()).toEqual([HELLO]);
    h.timers.advance(RETRY_WINDOW_MS * 2);
    expect(h.sockets).toHaveLength(1);
    expect(h.host.drops().fromChrome.noCore).toBe(1);
  });

  it("a core that connects but never sends a policy: given up after the policy timeout, retried, then exit 1", async () => {
    const h = harness();
    h.stdin.write(encodeFrame(permissions));
    await settle();
    h.last().succeed();
    h.timers.advance(POLICY_TIMEOUT_MS - 1);
    await settle();
    expect(h.last().destroyed).toBe(false);
    expect(h.toChrome()).toEqual([]);
    h.timers.advance(1);
    await settle();
    expect(h.last().destroyed).toBe(true);
    expect(h.last().frames()).toEqual([HELLO]);
    expect(h.toChrome()).toEqual([UNREACHABLE]);
    expect(h.timers.pending).toBe(1); // the retry, inside the usual window

    // Every retry connects and stays silent: the bounded retry window still ends in exit 1.
    for (let t = 0; t < RETRY_WINDOW_MS; t += RETRY_INTERVAL_MS) {
      h.timers.advance(RETRY_INTERVAL_MS);
      h.last().succeed();
      h.timers.advance(POLICY_TIMEOUT_MS);
    }
    await settle();
    expect(h.sockets).toHaveLength(16);
    expect(h.sockets.every((s) => s.destroyed)).toBe(true);
    expect(h.exits).toEqual([EXIT_CORE_UNAVAILABLE]);
    expect(h.toChrome()).toEqual([UNREACHABLE]);
    expect(h.timers.pending).toBe(0);
    expect(h.logs.join("\n")).toContain("no-policy");
    expect(h.host.drops().fromChrome.noCore).toBe(1);
  });

  it("a policy and an ack in one chunk are forwarded in order", async () => {
    const h = harness();
    h.last().succeed();
    h.last().emit("data", Buffer.concat([encodeFrame(POLICY), encodeFrame({ type: "ack", seq: 1 })]));
    await settle();
    expect(h.toChrome()).toEqual([POLICY, { type: "ready" }, { type: "ack", seq: 1 }]);
    expect(h.timers.pending).toBe(0); // the policy timer is gone
  });

  it("upgrade_required followed by more bytes in the same chunk: nothing after it is processed", async () => {
    const h = harness();
    h.last().succeed();
    h.last().emit(
      "data",
      Buffer.concat([encodeFrame({ type: "upgrade_required", protocol: 3 }), encodeFrame(POLICY), encodeFrame({ type: "ack", seq: 1 })]),
    );
    await settle();
    expect(h.toChrome()).toEqual([{ type: "core_unavailable", reason: "upgrade_required" }]);
    expect(h.exits).toEqual([EXIT_CORE_UNAVAILABLE]);
    expect(h.host.drops().fromCore).toEqual({ forwarded: 0, invalid: 0, oversized: 0 });
    expect(h.timers.pending).toBe(0);
  });

  it("an old core that closes right after hello: unreachable, then a retry that can still succeed", async () => {
    const h = harness();
    h.stdin.write(encodeFrame(permissions));
    await settle();
    h.last().succeed();
    h.last().destroy(); // no frame at all
    await settle();
    expect(h.toChrome()).toEqual([UNREACHABLE]);
    expect(h.exits).toEqual([]);
    expect(h.timers.pending).toBe(1);
    h.timers.advance(RETRY_INTERVAL_MS);
    expect(h.sockets).toHaveLength(2);
    h.last().handshake();
    await settle();
    expect(h.toChrome()).toEqual([UNREACHABLE, POLICY, { type: "ready" }]);
    expect(h.last().frames()).toEqual([HELLO, { type: "observation", observation: permissions }]);
  });
});

describe("core unavailable", () => {
  it("reports once, retries every 2 s, and exits 1 after 30 s", async () => {
    const h = harness();
    h.last().fail("ENOENT");
    await settle();
    expect(h.toChrome()).toEqual([UNREACHABLE]);

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
    expect(h.toChrome()).toEqual([UNREACHABLE]);
    expect(h.timers.pending).toBe(0);
  });

  it("proceeds normally when a retry connects", async () => {
    const h = harness();
    h.last().fail();
    h.timers.advance(RETRY_INTERVAL_MS);
    h.last().fail();
    h.timers.advance(RETRY_INTERVAL_MS);
    h.last().handshake();
    expect(h.last().frames()).toEqual([HELLO]);

    h.timers.advance(RETRY_WINDOW_MS * 2);
    h.stdin.write(encodeFrame(focus));
    await settle();
    expect(h.sockets).toHaveLength(3);
    expect(h.last().frames().slice(1)).toEqual([{ type: "observation", observation: focus }]);
    expect(h.exits).toEqual([]);
  });

  it("reports core_unavailable and exits 0 when the core closes the socket after the handshake", async () => {
    const h = harness();
    h.last().handshake();
    h.last().destroy();
    await settle();
    expect(h.toChrome()).toEqual([POLICY, { type: "ready" }, UNREACHABLE]);
    expect(h.exits).toEqual([EXIT_OK]);
    expect(h.sockets).toHaveLength(1);
  });
});

describe("shutdown", () => {
  it("closes the socket and exits 0 when Chrome closes stdin", async () => {
    const h = harness();
    h.last().handshake();
    h.stdin.end();
    await settle();
    expect(h.last().destroyed).toBe(true);
    expect(h.exits).toEqual([EXIT_OK]);
    expect(h.toChrome()).toEqual([POLICY, { type: "ready" }]);
  });

  it("stop() closes the socket, logs the reason, and exits 0 once", async () => {
    const h = harness();
    h.last().handshake();
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
    h.last().handshake();
    h.stdin.write(encodeFrame({ kind: "page_text", secret: "SECRET-PAGE-TEXT" }));
    h.stdin.end();
    await settle();
    const all = h.logs.join("\n");
    expect(all).toContain('"invalid":1');
    expect(all).not.toContain("SECRET-PAGE-TEXT");
  });
});

/**
 * A fake core on a real Unix socket. It reads hello the way the protocol-3 core does: any
 * hello parses, a mismatched protocol gets upgrade_required and a close, a matching one the
 * initial capture-disabled policy. `protocol: 1` with `oldCore` models a protocol-1 core,
 * which closes on a hello it does not know without sending anything.
 */
async function fakeCore(path: string, { protocol = BRIDGE_PROTOCOL, oldCore = false } = {}) {
  const received: unknown[] = [];
  const peers: Socket[] = [];
  const server = createServer((s) => {
    peers.push(s);
    const d = new FrameDecoder();
    let greeted = false;
    s.on("data", (c) => {
      for (const r of d.push(c)) {
        if (!r.ok) continue;
        received.push(r.value);
        if (greeted) continue;
        greeted = true;
        const hello = AnyHelloSchema.safeParse(r.value);
        if (hello.success && hello.data.protocol === protocol) {
          s.write(encodeFrame(POLICY));
        } else if (oldCore) {
          s.destroy();
        } else {
          s.end(encodeFrame({ type: "upgrade_required", protocol }));
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  return { server, received, peers };
}

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
    const core = await fakeCore(path);
    server = core.server;

    const h = harness({ socketPath: path, connect: (p) => netConnect({ path: p }) });
    await waitFor(() => h.toChrome().length === 2);
    h.stdin.write(encodeFrame(focus));
    await waitFor(() => core.received.length === 2);
    expect(core.received).toEqual([HELLO, { type: "observation", observation: focus }]);

    core.peers[0]!.write(encodeFrame({ type: "ack", seq: 1 }));
    await waitFor(() => h.toChrome().length === 3);
    core.peers[0]!.destroy();
    await waitFor(() => h.exits.length === 1);
    expect(h.toChrome()).toEqual([POLICY, { type: "ready" }, { type: "ack", seq: 1 }, UNREACHABLE]);
    expect(h.exits).toEqual([EXIT_OK]);
  });

  it("reports core_unavailable when the socket file is missing", async () => {
    dir = mkdtempSync(join(tmpdir(), "scout-nh-"));
    const h = harness({ socketPath: join(dir, "core.sock"), connect: (p) => netConnect({ path: p }) });
    await waitFor(() => h.timers.pending === 1);
    expect(h.toChrome()).toEqual([UNREACHABLE]);
    expect(h.timers.pending).toBe(1);
    h.stdin.end();
    await settle();
    expect(h.exits).toEqual([EXIT_OK]);
  });
});

describe("mixed bridge versions fail closed", () => {
  let dir: string;
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  const start = async (opts: Parameters<typeof fakeCore>[1]) => {
    dir = mkdtempSync(join(tmpdir(), "scout-nh-"));
    const path = join(dir, "core.sock");
    const core = await fakeCore(path, opts);
    server = core.server;
    return { path, core };
  };

  it("a protocol-1 relay's hello gets upgrade_required from a protocol-3 core, then a close", async () => {
    const { path } = await start({});
    const got: unknown[] = [];
    const client = netConnect({ path });
    const d = new FrameDecoder();
    client.on("data", (c) => {
      for (const r of d.push(c)) if (r.ok) got.push(r.value);
    });
    const closed = new Promise<void>((r) => client.on("close", () => r()));
    client.write(encodeFrame({ type: "hello", protocol: 1 }));
    await closed;
    expect(got).toEqual([{ type: "upgrade_required", protocol: BRIDGE_PROTOCOL }]);
  });

  it("this relay against a newer core: core_unavailable{upgrade_required}, exit 1, no retry", async () => {
    const { path, core } = await start({ protocol: BRIDGE_PROTOCOL + 1 });
    let connects = 0;
    const h = harness({
      socketPath: path,
      connect: (p) => {
        connects++;
        return netConnect({ path: p });
      },
    });
    await waitFor(() => h.exits.length === 1);
    expect(h.toChrome()).toEqual([{ type: "core_unavailable", reason: "upgrade_required" }]);
    expect(h.exits).toEqual([EXIT_CORE_UNAVAILABLE]);
    expect(h.timers.pending).toBe(0);
    h.timers.advance(RETRY_WINDOW_MS * 2);
    expect(connects).toBe(1);
    expect(core.received).toEqual([HELLO]);
    expect(h.logs.join("\n")).toContain("upgrade-required");
  });

  it("this relay against a protocol-1 core that just closes: unreachable, then the retry window and exit 1", async () => {
    const { path, core } = await start({ protocol: 1, oldCore: true });
    let connects = 0;
    let closes = 0;
    const h = harness({
      socketPath: path,
      connect: (p) => {
        connects++;
        const s = netConnect({ path: p });
        s.on("close", () => closes++);
        return s;
      },
    });
    // Between connect and close the policy timer is pending too: wait for each close.
    await waitFor(() => closes === 1 && h.timers.pending === 1);
    expect(h.toChrome()).toEqual([UNREACHABLE]);
    h.stdin.write(encodeFrame({ ...focus, seq: 9 }));
    await settle();
    for (let t = 0; t < RETRY_WINDOW_MS; t += RETRY_INTERVAL_MS) {
      h.timers.advance(RETRY_INTERVAL_MS);
      await waitFor(() => (closes === connects && h.timers.pending === 1) || h.exits.length === 1);
    }
    expect(h.exits).toEqual([EXIT_CORE_UNAVAILABLE]);
    expect(h.toChrome()).toEqual([UNREACHABLE]);
    // Only hellos ever reached the old core: nothing is relayed without a policy.
    expect(core.received.every((f) => (f as { type?: string }).type === "hello")).toBe(true);
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
    expect(h.toChrome()).toEqual([UNREACHABLE]);
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
    expect(h.toChrome()).toEqual([UNSAFE]);
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
    expect(h.toChrome()).toEqual([UNREACHABLE, UNSAFE]);
    expect(h.exits).toEqual([EXIT_CORE_UNAVAILABLE]);
    expect(h.timers.pending).toBe(0);
  });

  it("connects through a private dir and socket", async () => {
    home = mkdtempSync(join(tmpdir(), "scout-home-"));
    mkdirSync(join(home, "run"), { mode: 0o700 });
    const path = coreSocketPath(home);
    const core = await fakeCore(path);
    try {
      chmodSync(path, 0o600);
      const h = withRealCheck(path, { connect: (p) => netConnect({ path: p }) });
      await waitFor(() => h.toChrome().length === 2);
      expect(core.received).toEqual([HELLO]);
      expect(h.toChrome()).toEqual([POLICY, { type: "ready" }]);
      h.host.stop("test-done");
      await waitFor(() => h.exits.length === 1);
    } finally {
      core.server.close();
    }
  });
});
