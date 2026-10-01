import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_PROTOCOL_VERSION, AGENT_REQUEST_MAX_BYTES, AGENT_RESPONSE_MAX_BYTES } from "@scout/contracts";
import { encodeFrame, FrameDecoder, frameHeader, MAX_FRAME_FROM_CHROME } from "@scout/contracts/frame";
import { BackendError, createSocketBackend } from "@scout/scout-mcp/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentAuth, type InteractiveTokenFile, writeInteractiveTokenFile } from "./agentApi/auth.js";
import { createAgentHandlers } from "./agentApi/handlers.js";
import { createReadAudit } from "./agentApi/readAudit.js";
import { AGENT_SOCKET_NAME, type AgentSocketServer, createAgentSocketServer } from "./agentSocketServer.js";
import { type CapabilityStore, createCapabilityStore } from "./capabilities/store.js";
import { createCatalogCache } from "./catalog/cache.js";
import type { Diagnostics } from "./diagnostics.js";
import { createSocketServer } from "./socketServer.js";

const diagnostics: Diagnostics = { failures: 0, event: () => {} };
const clock = { now: () => Date.now() };
const until = async (cond: () => boolean, ms = 3_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

let root: string;
let runDir: string;
let store: CapabilityStore;
const running: Array<{ server: AgentSocketServer; token: InteractiveTokenFile }> = [];
const extra: Server[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "scout-agent-sock-"));
  runDir = join(root, "run");
  store = await createCapabilityStore({ scoutHome: root, clock });
});
afterEach(async () => {
  for (const r of running.splice(0)) {
    await r.server.close();
    r.token.remove();
  }
  for (const s of extra.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

/** The production stack main.ts builds: token file, auth, handlers, server. */
async function startAgent(coreInstanceId = "core-a", opts: { helloTimeoutMs?: number; chmod?: (p: string, m: number) => void } = {}) {
  const token = writeInteractiveTokenFile(runDir);
  const auth = createAgentAuth({ interactiveToken: token.token });
  const audit = createReadAudit();
  const handlers = createAgentHandlers({
    coreInstanceId,
    auth,
    store,
    view: () => ({ currentSite: null, paused: false }),
    catalog: createCatalogCache({ clock, dir: join(root, "cache", "catalog") }),
    browserContextGranted: () => false,
    audit,
    clock,
  });
  const server = createAgentSocketServer({ runDir, handlers, auth, audit, diagnostics, ...opts });
  await server.start();
  running.push({ server, token });
  return { server, token };
}

/** A raw client that collects decoded response frames. */
async function rawClient(path: string) {
  const sock: Socket = connect({ path });
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  const frames: Record<string, unknown>[] = [];
  const decoder = new FrameDecoder({ maxBytes: AGENT_RESPONSE_MAX_BYTES });
  sock.on("data", (c: Buffer) => {
    for (const r of decoder.push(c)) if (r.ok) frames.push(r.value);
  });
  let closed = false;
  sock.on("close", () => void (closed = true));
  sock.on("error", () => {});
  return {
    frames,
    send: (o: object, max = AGENT_REQUEST_MAX_BYTES) => sock.write(encodeFrame(o, max)),
    sock,
    get closed() {
      return closed;
    },
  };
}

let seq = 0;
const hello = (token: string) => ({ protocol: AGENT_PROTOCOL_VERSION, requestId: `h${++seq}`, method: "hello", params: { token } });
const list = () => ({ protocol: AGENT_PROTOCOL_VERSION, requestId: `l${++seq}`, method: "list_resources", params: {} });

describe("agent socket files", () => {
  it("publishes agent.sock already 0600, only after the chmod, with no temp name left", async () => {
    const seen: boolean[] = [];
    const old = process.umask(0o000);
    try {
      await startAgent("core-a", {
        chmod: (path, mode) => {
          seen.push(existsSync(join(runDir, AGENT_SOCKET_NAME)));
          expect(path).toBe(join(runDir, `${AGENT_SOCKET_NAME}.${process.pid}.tmp`));
          chmodSync(path, mode);
        },
      });
    } finally {
      process.umask(old);
    }
    expect(seen).toEqual([false]);
    const st = lstatSync(join(runDir, AGENT_SOCKET_NAME));
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(readdirSync(runDir).sort()).toEqual(["agent-token", AGENT_SOCKET_NAME]);
  });

  it("on close removes its own socket but not one another core published under the name", async () => {
    const { server } = await startAgent();
    await server.close();
    expect(existsSync(server.socketPath)).toBe(false);

    const again = await startAgent();
    // Another core took the name (ours was unlinked by someone else, theirs bound in its place).
    rmSync(again.server.socketPath);
    const other = createServer();
    extra.push(other);
    await new Promise<void>((r) => other.listen(again.server.socketPath, () => r()));
    await again.server.close();
    expect(lstatSync(again.server.socketPath).isSocket()).toBe(true);
  });
});

describe("agent socket connections", () => {
  it("answers a bad token with not_granted and closes", async () => {
    const { server } = await startAgent();
    const c = await rawClient(server.socketPath);
    c.send(hello("wrong-token"));
    await until(() => c.closed);
    expect(c.frames).toEqual([expect.objectContaining({ status: "error", error: expect.objectContaining({ code: "not_granted" }), coreInstanceId: "core-a" })]);
  });

  it("closes a connection that does not say hello in time", async () => {
    const { server } = await startAgent("core-a", { helloTimeoutMs: 50 });
    const c = await rawClient(server.socketPath);
    await until(() => c.closed);
    expect(c.frames).toEqual([]);
  });

  it("closes the connection on a second hello", async () => {
    const { server, token } = await startAgent();
    const c = await rawClient(server.socketPath);
    c.send(hello(token.token));
    await until(() => c.frames.length === 1);
    expect(c.frames[0]).toMatchObject({ status: "ok", result: { role: "interactive" } });
    c.send(hello(token.token));
    await until(() => c.closed);
    expect(c.frames).toHaveLength(1);
  });

  it("answers an oversized or malformed frame after hello and keeps serving", async () => {
    const { server, token } = await startAgent();
    const c = await rawClient(server.socketPath);
    c.send(hello(token.token));
    c.send({ ...list(), pad: "x".repeat(AGENT_REQUEST_MAX_BYTES) }, AGENT_REQUEST_MAX_BYTES * 2);
    c.sock.write(Buffer.concat([frameHeader(3), Buffer.from("{x}")]));
    c.send(list());
    await until(() => c.frames.length === 4);
    expect(c.frames.slice(1).map((f) => (f.status === "ok" ? "ok" : (f.error as { code: string }).code))).toEqual(["limit_exceeded", "protocol_mismatch", "ok"]);
    expect(c.closed).toBe(false);
  });

  it("closes a browser frame sent to agent.sock without answering", async () => {
    const { server } = await startAgent();
    const c = await rawClient(server.socketPath);
    c.send({ type: "hello", protocol: 1 }, MAX_FRAME_FROM_CHROME);
    await until(() => c.closed);
    expect(c.frames).toEqual([]);
  });

  it("an agent frame sent to core.sock is closed too", async () => {
    const core = createSocketServer({ runDir, onClient: () => expect.fail("agent hello accepted on core.sock"), diagnostics });
    await core.start();
    try {
      const c = await rawClient(core.socketPath);
      c.send(hello("anything"));
      await until(() => c.closed);
      expect(c.frames).toEqual([]);
    } finally {
      await core.close();
    }
  });
});

describe("the production adapter client against the agent socket", () => {
  it("serves calls, reports one unavailable across a core restart, then reauthenticates against the new instance", async () => {
    const first = await startAgent("core-a");
    const backend = createSocketBackend({ socketPath: first.server.socketPath, tokenFile: first.token.path, timeoutMs: 2_000 });
    try {
      const a = await backend.call(list() as never);
      expect(a).toMatchObject({ status: "ok", coreInstanceId: "core-a" });

      // The core stops: the socket and the token file go away.
      running.splice(0);
      await first.server.close();
      first.token.remove();
      await expect(backend.call(list() as never)).rejects.toEqual(new BackendError("unavailable"));

      // A new core starts with a new instance id and a rotated token.
      const second = await startAgent("core-b");
      expect(second.token.token).not.toBe(first.token.token);
      const b = await backend.call(list() as never);
      expect(b).toMatchObject({ status: "ok", coreInstanceId: "core-b" });
      expect(second.server.openConnections).toBe(1);
    } finally {
      backend.close();
    }
  });
});
