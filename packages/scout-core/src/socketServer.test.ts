import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect, createServer, Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, type ToChromeFrame } from "@scout/contracts";
import { encodeFrame, frameHeader, MAX_FRAME_FROM_CHROME, MAX_FRAME_TO_CHROME, toChromeDecoder } from "@scout/contracts/frame";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiagnosticFields, Diagnostics } from "./diagnostics.js";
import { EventEmitter } from "node:events";
import { createClientWriter, createSocketServer, RELAY_HIGH_WATER_BYTES, type SocketClient, type SocketServer, SocketServerError } from "./socketServer.js";

function spyDiagnostics() {
  const events: Array<{ name: string; fields: DiagnosticFields }> = [];
  const diagnostics: Diagnostics = { failures: 0, event: (name, fields = {}) => void events.push({ name, fields }) };
  return { events, diagnostics };
}

const FOCUS = { kind: "focus", seq: 1, at: 1, browserFocused: true, windowId: 1, tabId: 3 };

/** A raw client that collects decoded frames from the server. */
async function rawClient(path: string) {
  const sock = connect({ path });
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  const frames: Array<Record<string, unknown>> = [];
  const dec = toChromeDecoder();
  sock.on("data", (c: Buffer) => {
    for (const r of dec.push(c)) if (r.ok) frames.push(r.value);
  });
  const closed = new Promise<void>((resolve) => sock.once("close", () => resolve()));
  sock.on("error", () => {});
  return { sock, frames, closed, send: (obj: object) => sock.write(encodeFrame(obj, MAX_FRAME_FROM_CHROME)) };
}

const until = async (cond: () => boolean, ms = 2_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("socketServer", () => {
  let root: string;
  let runDir: string;
  let server: SocketServer | null = null;
  const extra: Array<Server | Socket> = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "scs-"));
    runDir = join(root, "run");
  });
  afterEach(async () => {
    await server?.close();
    server = null;
    for (const s of extra.splice(0)) {
      if (s instanceof Socket) s.destroy();
      else s.close();
    }
    rmSync(root, { recursive: true, force: true });
  });

  const start = async (onClient: (c: SocketClient) => void = () => {}) => {
    const spy = spyDiagnostics();
    server = createSocketServer({ runDir, onClient, diagnostics: spy.diagnostics });
    await server.start();
    return { ...spy, server };
  };

  const refusal = async (): Promise<string> => {
    try {
      await start();
    } catch (e) {
      expect(e).toBeInstanceOf(SocketServerError);
      server = null;
      return (e as SocketServerError).code;
    }
    throw new Error("start() did not refuse");
  };

  it("creates the run dir 0700 and the socket 0600", async () => {
    const { server: s } = await start();
    expect(lstatSync(runDir).mode & 0o777).toBe(0o700);
    const st = lstatSync(s.socketPath);
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("publishes the socket already 0600 and leaves no temp name behind", async () => {
    // The final name must never show the umask mode, even to a host that stats it the
    // instant it appears: bind a permissive umask to make the pre-chmod mode visible.
    const old = process.umask(0o000);
    let st;
    try {
      const { server: s } = await start();
      st = lstatSync(s.socketPath);
    } finally {
      process.umask(old);
    }
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o077).toBe(0);
    expect(st.mode & 0o777).toBe(0o600);
    expect(readdirSync(runDir)).toEqual(["core.sock"]);
  });

  it("the final name appears only after the chmod", async () => {
    const seen: boolean[] = [];
    const spy = spyDiagnostics();
    server = createSocketServer({
      runDir,
      onClient: () => {},
      diagnostics: spy.diagnostics,
      chmod: (path, mode) => {
        seen.push(existsSync(join(runDir, "core.sock")));
        expect(path).toBe(join(runDir, `core.sock.${process.pid}.tmp`));
        chmodSync(path, mode);
      },
    });
    await server.start();
    expect(seen).toEqual([false]);
    expect(lstatSync(server.socketPath).mode & 0o777).toBe(0o600);
  });

  it("refuses, without replacing it, a core.sock another core published while we were binding", async () => {
    const other = createServer();
    extra.push(other);
    const listen = Server.prototype.listen;
    Server.prototype.listen = function (this: Server, ...args: unknown[]) {
      Server.prototype.listen = listen;
      // Another core wins the race for the final name while our bind is pending.
      other.listen({ path: join(runDir, "core.sock") });
      return (listen as (...a: unknown[]) => Server).apply(this, args);
    } as typeof listen;
    try {
      expect(await refusal()).toBe("already-running");
    } finally {
      Server.prototype.listen = listen;
    }
    await until(() => other.listening);
    expect(lstatSync(join(runDir, "core.sock")).isSocket()).toBe(true);
    expect(readdirSync(runDir)).toEqual(["core.sock"]);
    const probe = await rawClient(join(runDir, "core.sock"));
    extra.push(probe.sock);
  });

  it("refuses a group- or world-accessible run dir without changing it", async () => {
    mkdirSync(runDir);
    chmodSync(runDir, 0o755);
    expect(await refusal()).toBe("runtime-dir-not-private");
    expect(lstatSync(runDir).mode & 0o777).toBe(0o755);
    chmodSync(runDir, 0o770);
    expect(await refusal()).toBe("runtime-dir-not-private");
  });

  it("refuses a symlinked run dir", async () => {
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, runDir);
    expect(await refusal()).toBe("runtime-dir-not-directory");
  });

  it("refuses a non-socket file at the socket path", async () => {
    mkdirSync(runDir, { mode: 0o700 });
    writeFileSync(join(runDir, "core.sock"), "x");
    expect(await refusal()).toBe("socket-not-socket");
  });

  it("replaces a stale socket after a refused probe", async () => {
    mkdirSync(runDir, { mode: 0o700 });
    const path = join(runDir, "core.sock");
    // A listener killed with SIGKILL leaves its socket file behind: a stale socket.
    const child = spawn(process.execPath, [
      "-e",
      "require('net').createServer().listen(process.argv[1], () => console.log('ready'))",
      path,
    ]);
    await new Promise<void>((r) => child.stdout.once("data", () => r()));
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.kill("SIGKILL");
    await exited;
    expect(lstatSync(path).isSocket()).toBe(true);

    // No inode comparison: Linux hands the freed inode straight to the new socket. A stale
    // socket refuses connections, so the hello below is what proves the file was replaced.
    const clients: SocketClient[] = [];
    const { server: s } = await start((c) => clients.push(c));
    const st = lstatSync(s.socketPath);
    expect(st.mode & 0o777).toBe(0o600);
    const c = await rawClient(s.socketPath);
    extra.push(c.sock);
    c.send({ type: "hello", protocol: BRIDGE_PROTOCOL });
    await until(() => clients.length === 1);
  });

  it("refuses to start while another core is listening", async () => {
    mkdirSync(runDir, { mode: 0o700 });
    const live = createServer();
    extra.push(live);
    await new Promise<void>((r) => live.listen({ path: join(runDir, "core.sock") }, () => r()));
    expect(await refusal()).toBe("already-running");
    expect(lstatSync(join(runDir, "core.sock")).isSocket()).toBe(true);
  });

  it("removes its socket on close", async () => {
    const { server: s } = await start();
    await s.close();
    server = null;
    expect(existsSync(s.socketPath)).toBe(false);
  });

  it("leaves the process umask alone while listen is pending", async () => {
    // Anything else the process creates during bind (e.g. the diagnostics log dir) must
    // get its requested mode, not one narrowed by a process-wide umask.
    const probe = join(root, "made-during-listen");
    const listen = Server.prototype.listen;
    Server.prototype.listen = function (this: Server, ...args: unknown[]) {
      mkdirSync(probe, { mode: 0o700 });
      return (listen as (...a: unknown[]) => Server).apply(this, args);
    } as typeof listen;
    try {
      await start();
    } finally {
      Server.prototype.listen = listen;
    }
    expect(lstatSync(probe).mode & 0o777).toBe(0o700);
  });

  it("closes the listener and removes the socket when the post-listen chmod fails", async () => {
    const spy = spyDiagnostics();
    const bound: Server[] = [];
    const listen = Server.prototype.listen;
    Server.prototype.listen = function (this: Server, ...args: unknown[]) {
      bound.push(this);
      return (listen as (...a: unknown[]) => Server).apply(this, args);
    } as typeof listen;
    const s = createSocketServer({
      runDir,
      onClient: () => {},
      diagnostics: spy.diagnostics,
      chmod: () => {
        throw new Error("EPERM");
      },
    });
    try {
      await expect(s.start()).rejects.toMatchObject({ code: "listen-failed" });
    } finally {
      Server.prototype.listen = listen;
    }
    expect(existsSync(s.socketPath)).toBe(false);
    expect(readdirSync(runDir)).toEqual([]);
    expect(bound).toHaveLength(1);
    expect(bound[0]?.listening).toBe(false);
    expect(spy.events.some((e) => e.name === "socket_listening")).toBe(false);
  });

  it("closes a connection that does not say hello in time", async () => {
    const spy = spyDiagnostics();
    server = createSocketServer({ runDir, onClient: () => {}, diagnostics: spy.diagnostics, helloTimeoutMs: 50 });
    await server.start();
    const c = await rawClient(server.socketPath);
    await c.closed;
    expect(spy.events).toContainEqual({ name: "bridge_rejected", fields: { conn: 1, code: "hello-timeout" } });
  });

  it("closes a connection whose first frame is not hello", async () => {
    const clients: SocketClient[] = [];
    const { server: s, events } = await start((c) => clients.push(c));
    const c = await rawClient(s.socketPath);
    c.send({ type: "observation", observation: FOCUS });
    await c.closed;
    expect(clients).toHaveLength(0);
    expect(events).toContainEqual({ name: "bridge_rejected", fields: { conn: 1, code: "handshake" } });
  });

  it("closes a connection that sends a malformed frame before hello", async () => {
    const { server: s, events } = await start();
    const c = await rawClient(s.socketPath);
    c.sock.write(Buffer.concat([frameHeader(3), Buffer.from("{{{")]));
    await c.closed;
    expect(events).toContainEqual({ name: "bridge_rejected", fields: { conn: 1, code: "invalid-json" } });
  });

  it.each([1, 2, 3, 5])("answers a protocol-%i hello with upgrade_required, then closes", async (protocol) => {
    const clients: SocketClient[] = [];
    const { server: s, events } = await start((cl) => clients.push(cl));
    const c = await rawClient(s.socketPath);
    // A frame after the mismatched hello is ignored.
    c.sock.write(
      Buffer.concat([
        encodeFrame({ type: "hello", protocol }, MAX_FRAME_FROM_CHROME),
        encodeFrame({ type: "observation", observation: FOCUS }, MAX_FRAME_FROM_CHROME),
      ]),
    );
    await c.closed;
    expect(c.frames).toEqual([{ type: "upgrade_required", protocol: BRIDGE_PROTOCOL }]);
    expect(clients).toHaveLength(0);
    expect(events).toContainEqual({ name: "bridge_rejected", fields: { conn: 1, code: "upgrade_required", protocol } });
  });

  it("a protocol-4 hello reaches onClient", async () => {
    const clients: SocketClient[] = [];
    const { server: s } = await start((cl) => clients.push(cl));
    const c = await rawClient(s.socketPath);
    extra.push(c.sock);
    c.send({ type: "hello", protocol: BRIDGE_PROTOCOL });
    await until(() => clients.length === 1);
    expect(c.frames).toEqual([]);
  });

  it("relays observation frames after hello, drops bad ones, and sends frames back", async () => {
    const received: unknown[] = [];
    let client: SocketClient | null = null;
    const { server: s, events } = await start((cl) => {
      client = cl;
      cl.onFrame((f) => {
        if (f.type === "observation") received.push(f.observation);
        cl.send({ type: "ack", seq: 42 } satisfies ToChromeFrame);
      });
    });
    const c = await rawClient(s.socketPath);
    // hello and the first observation in one write: both must be handled.
    c.sock.write(
      Buffer.concat([
        encodeFrame({ type: "hello", protocol: BRIDGE_PROTOCOL }, MAX_FRAME_FROM_CHROME),
        encodeFrame({ type: "observation", observation: FOCUS }, MAX_FRAME_FROM_CHROME),
      ]),
    );
    c.send({ type: "observation", observation: { kind: "bogus" } });
    c.send({ type: "hello", protocol: BRIDGE_PROTOCOL });
    c.sock.write(Buffer.concat([frameHeader(2), Buffer.from("[]")]));
    c.send({ type: "observation", observation: { ...FOCUS, seq: 2 } });
    await until(() => received.length === 2 && c.frames.length === 2);
    expect(received).toEqual([FOCUS, { ...FOCUS, seq: 2 }]);
    expect(c.frames).toEqual([
      { type: "ack", seq: 42 },
      { type: "ack", seq: 42 },
    ]);
    expect(client).not.toBeNull();
    const drops = events.filter((e) => e.name === "bridge_frame_dropped").map((e) => e.fields.code);
    expect(drops).toEqual(["schema", "repeat-hello", "not-object"]);
  });

  it("accepts observation frames larger than MAX_FRAME_TO_CHROME, up to MAX_FRAME_FROM_CHROME", async () => {
    const received: unknown[] = [];
    const { server: s } = await start((cl) => cl.onFrame((f) => received.push(f)));
    const c = await rawClient(s.socketPath);
    c.send({ type: "hello", protocol: BRIDGE_PROTOCOL });
    // Control characters JSON-escape to six bytes each: an 8 KiB body becomes a ~48 KiB frame.
    const text = "\u0001".repeat(8 * 1024);
    const obs = {
      kind: "page_text",
      seq: 1,
      at: 1,
      tabId: 3,
      documentId: "d",
      url: "https://linear.app/acme/issue/ENG-1",
      source: "page",
      title: "t",
      text,
      truncated: false,
    };
    const frame = encodeFrame({ type: "observation", observation: obs }, MAX_FRAME_FROM_CHROME);
    expect(frame.length).toBeGreaterThan(MAX_FRAME_TO_CHROME);
    expect(frame.length).toBeLessThanOrEqual(MAX_FRAME_FROM_CHROME + 4);
    c.sock.write(frame);
    await until(() => received.length === 1);
    expect(received[0]).toEqual({ type: "observation", observation: obs });
  });

  it("reports close to the client handler and accepts several connections", async () => {
    const clients: SocketClient[] = [];
    const closed: number[] = [];
    const { server: s } = await start((cl) => {
      clients.push(cl);
      cl.onClose(() => closed.push(cl.id));
    });
    const a = await rawClient(s.socketPath);
    const b = await rawClient(s.socketPath);
    a.send({ type: "hello", protocol: BRIDGE_PROTOCOL });
    b.send({ type: "hello", protocol: BRIDGE_PROTOCOL });
    await until(() => clients.length === 2);
    a.sock.end();
    await until(() => closed.length === 1);
    b.sock.destroy();
    await until(() => closed.length === 2);
    expect(closed.toSorted()).toEqual(clients.map((c) => c.id).toSorted());
  });

  it("hands window commands to the client, refuses frontmost/shutdown as refused_command frames, and drops invalid ones", async () => {
    const received: unknown[] = [];
    const { server: s, events } = await start((cl) => cl.onFrame((f) => received.push(f)));
    const c = await rawClient(s.socketPath);
    c.send({ type: "hello", protocol: BRIDGE_PROTOCOL });
    c.send({ type: "command", command: { type: "pause", extra: 1 } });
    c.send({ type: "command", command: { type: "frontmost", bundleId: "com.google.Chrome", at: 1 } });
    c.send({ type: "command", command: { type: "shutdown", commandId: "sp-9" } });
    c.send({ type: "command", command: { type: "shutdown", commandId: "not valid!" } });
    c.send({ type: "command", command: { type: "approve", commandId: "a" } }); // incomplete
    c.send({ type: "command", command: { type: "refresh_capabilities", commandId: "sp-1" } });
    await until(() => received.length === 4);
    expect(received).toEqual([
      { type: "command", command: { type: "pause" } },
      { type: "refused_command", command: "frontmost" },
      { type: "refused_command", command: "shutdown", commandId: "sp-9" },
      { type: "command", command: { type: "refresh_capabilities", commandId: "sp-1" } },
    ]);
    expect(events.filter((e) => e.name === "bridge_command_refused").map((e) => e.fields.type)).toEqual(["frontmost", "shutdown"]);
    // An invalid commandId and an incomplete command are neither commands nor refusals.
    expect(events.filter((e) => e.name === "bridge_frame_dropped").map((e) => e.fields.code)).toEqual(["schema", "schema"]);
  });

  it("sends panel frames up to 1 MiB and refuses other frames over 16 KiB", async () => {
    let client: SocketClient | null = null;
    const { server: s, events } = await start((cl) => (client = cl));
    const c = await rawClient(s.socketPath);
    c.send({ type: "hello", protocol: BRIDGE_PROTOCOL });
    await until(() => client !== null);
    const audit = (n: number) => ({ type: "audit" as const, entries: Array.from({ length: n }, (_, i) => ({ at: i, role: "job" as const, method: "current_site" as const, outcome: "ok" as const, origin: `https://${"o".repeat(200)}.example` })) });
    const big = { type: "panel" as const, state: audit(200) }; // ~50 KiB: over the 16 KiB default
    client!.send(big);
    client!.send({ type: "capture_policy", revision: 1, paused: false, captureEnabled: false, pad: "x".repeat(MAX_FRAME_TO_CHROME) } as unknown as ToChromeFrame);
    client!.send({ type: "ack", seq: 1 });
    await until(() => c.frames.length === 2);
    expect(c.frames.map((f) => f.type)).toEqual(["panel", "ack"]);
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_FRAME_TO_CHROME);
    expect(events.filter((e) => e.name === "bridge_send_failed").map((e) => e.fields.type)).toEqual(["capture_policy"]);
  });
});

describe("client writer backpressure", () => {
  /** A socket whose buffer only grows until the test drains it. */
  class FakeSocket extends EventEmitter {
    writableLength = 0;
    destroyed = false;
    writable = true;
    written: Buffer[] = [];
    write(b: Buffer) {
      this.written.push(b);
      this.writableLength += b.length;
      return this.writableLength < 16 * 1024;
    }
    drain() {
      this.writableLength = 0;
      this.emit("drain");
    }
    types() {
      const d = toChromeDecoder();
      return d.push(Buffer.concat(this.written)).map((r) => (r.ok ? (r.value["type"] === "panel" ? `panel:${(r.value["state"] as { type: string }).type}` : (r.value["type"] as string)) : r.code));
    }
  }
  const setup = () => {
    const sock = new FakeSocket();
    const { events, diagnostics } = spyDiagnostics();
    let drained = 0;
    const send = createClientWriter({ sock, conn: 7, diagnostics, onDrained: () => void drained++ });
    return { sock, events, send, drained: () => drained };
  };
  const grant = { type: "panel", state: { type: "grant", agentBrowserContext: false } } as const;
  const ack = { type: "panel", state: { type: "ack", commandId: "a1", ok: false, code: "invalid" } } as const;
  const capabilities = (bytes: number) =>
    ({
      type: "panel",
      state: { type: "capabilities", coreInstanceId: "core", revision: 1, approvalRevision: 0, offers: [], library: [], conflicts: [], origins: [], truncated: false, pad: "x".repeat(bytes) },
    }) as unknown as ToChromeFrame;

  it("over the mark: window frames are dropped (once marked stale), answers and bridge frames still go, and one repaint follows the drain", () => {
    const s = setup();
    s.sock.writableLength = RELAY_HIGH_WATER_BYTES + 1;
    s.send(grant);
    s.send(grant);
    s.send(ack);
    s.send({ type: "capture_policy", revision: 1, paused: false, captureEnabled: false });
    s.send({ type: "ack", seq: 3 });
    expect(s.sock.types()).toEqual(["panel:ack", "capture_policy", "ack"]);
    expect(s.events.filter((e) => e.name === "panel_frame_dropped").map((e) => e.fields)).toEqual([
      { conn: 7, type: "grant", reason: "backpressure" },
      { conn: 7, type: "grant", reason: "backpressure" },
    ]);
    expect(s.drained()).toBe(0);
    s.sock.drain();
    expect(s.drained()).toBe(1);
    expect(s.events.filter((e) => e.name === "panel_repaint")).toEqual([{ name: "panel_repaint", fields: { conn: 7, reason: "drained" } }]);
    s.sock.drain(); // no new drop: no second repaint
    expect(s.drained()).toBe(1);
    s.send(grant);
    expect(s.sock.types().at(-1)).toBe("panel:grant");
  });

  it("a 512 KiB capabilities frame alone, or several in a row, never trips it", () => {
    const s = setup();
    for (let i = 0; i < 4; i++) s.send(capabilities(512 * 1024 - 300));
    expect(s.sock.writableLength).toBeLessThanOrEqual(RELAY_HIGH_WATER_BYTES);
    expect(s.sock.types()).toEqual(["panel:capabilities", "panel:capabilities", "panel:capabilities", "panel:capabilities"]);
    expect(s.events.filter((e) => e.name === "panel_frame_dropped")).toEqual([]);
  });

  it("a destroyed socket gets nothing and its drain repaints nothing", () => {
    const s = setup();
    s.sock.writableLength = RELAY_HIGH_WATER_BYTES + 1;
    s.send(grant);
    s.sock.destroyed = true;
    s.sock.emit("drain");
    expect(s.drained()).toBe(0);
    s.send(ack);
    expect(s.sock.written).toEqual([]);
  });
});
