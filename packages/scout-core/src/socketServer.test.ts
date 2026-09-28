import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect, createServer, type Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToChromeFrame } from "@scout/contracts";
import { encodeFrame, FrameDecoder, frameHeader, MAX_FRAME_FROM_CHROME, MAX_FRAME_TO_CHROME } from "@scout/contracts/frame";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiagnosticFields, Diagnostics } from "./diagnostics.js";
import { createSocketServer, type SocketClient, type SocketServer, SocketServerError } from "./socketServer.js";

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
  const dec = new FrameDecoder({ maxBytes: MAX_FRAME_FROM_CHROME });
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
    const staleIno = lstatSync(path).ino;
    expect(lstatSync(path).isSocket()).toBe(true);

    const clients: SocketClient[] = [];
    const { server: s } = await start((c) => clients.push(c));
    const st = lstatSync(s.socketPath);
    expect(st.ino).not.toBe(staleIno);
    expect(st.mode & 0o777).toBe(0o600);
    const c = await rawClient(s.socketPath);
    extra.push(c.sock);
    c.send({ type: "hello", protocol: 1 });
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

  it("rejects a hello with the wrong protocol", async () => {
    const { server: s } = await start();
    const c = await rawClient(s.socketPath);
    c.send({ type: "hello", protocol: 2 });
    await c.closed;
  });

  it("relays observation frames after hello, drops bad ones, and sends frames back", async () => {
    const received: unknown[] = [];
    let client: SocketClient | null = null;
    const { server: s, events } = await start((cl) => {
      client = cl;
      cl.onFrame((f) => {
        received.push(f.observation);
        cl.send({ type: "ack", seq: 42 } satisfies ToChromeFrame);
      });
    });
    const c = await rawClient(s.socketPath);
    // hello and the first observation in one write: both must be handled.
    c.sock.write(
      Buffer.concat([
        encodeFrame({ type: "hello", protocol: 1 }, MAX_FRAME_FROM_CHROME),
        encodeFrame({ type: "observation", observation: FOCUS }, MAX_FRAME_FROM_CHROME),
      ]),
    );
    c.send({ type: "observation", observation: { kind: "bogus" } });
    c.send({ type: "hello", protocol: 1 });
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
    c.send({ type: "hello", protocol: 1 });
    // Control characters JSON-escape to six bytes each: an 8 KiB body becomes a ~48 KiB frame.
    const text = "\u0001".repeat(8 * 1024);
    const obs = {
      kind: "page_text",
      seq: 1,
      at: 1,
      tabId: 3,
      documentId: "d",
      url: "https://github.com/o/r/issues/1",
      source: "github_issue",
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
    a.send({ type: "hello", protocol: 1 });
    b.send({ type: "hello", protocol: 1 });
    await until(() => clients.length === 2);
    a.sock.end();
    await until(() => closed.length === 1);
    b.sock.destroy();
    await until(() => closed.length === 2);
    expect(closed.toSorted()).toEqual(clients.map((c) => c.id).toSorted());
  });
});
