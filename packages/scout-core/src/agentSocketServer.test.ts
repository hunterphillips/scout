import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_CURSOR_TTL_MS, AGENT_PROTOCOL_VERSION, AGENT_REQUEST_MAX_BYTES, AGENT_RESPONSE_MAX_BYTES } from "@scout/contracts";
import { encodeFrame, FrameDecoder, frameHeader, MAX_FRAME_FROM_CHROME } from "@scout/contracts/frame";
import { BackendError, createSocketBackend } from "@scout/scout-mcp/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentAuth, type InteractiveTokenFile, writeInteractiveTokenFile } from "./agentApi/auth.js";
import { createAgentHandlers } from "./agentApi/handlers.js";
import { createReadAudit } from "./agentApi/readAudit.js";
import { AGENT_SOCKET_NAME, type AgentSocketServer, createAgentSocketServer } from "./agentSocketServer.js";
import type { DiscoveryResult } from "./capabilities/discovery.js";
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
async function startAgent(
  coreInstanceId = "core-a",
  { clock: handlerClock = clock, ...opts }: { helloTimeoutMs?: number; chmod?: (p: string, m: number) => void; clock?: { now: () => number } } = {},
) {
  const token = writeInteractiveTokenFile(runDir);
  const auth = createAgentAuth({ interactiveToken: token.token });
  const audit = createReadAudit();
  const handlers = createAgentHandlers({
    coreInstanceId,
    auth,
    store,
    view: () => ({ currentSite: null, paused: false }),
    catalog: createCatalogCache({ clock: handlerClock, dir: join(root, "cache", "catalog") }),
    browserContextGranted: () => false,
    audit,
    clock: handlerClock,
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
const read = (resourceId: string, cursor?: string) => ({
  protocol: AGENT_PROTOCOL_VERSION,
  requestId: `r${++seq}`,
  method: "read_resource",
  params: { resourceId, ...(cursor !== undefined ? { cursor } : {}) },
});

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

describe("agent socket close", () => {
  it("resolves promptly when a client connects and says hello while it is closing, and closes that client", async () => {
    const { server, token } = await startAgent();
    const before = await rawClient(server.socketPath);
    before.send(hello(token.token));
    await until(() => before.frames.length === 1);

    // A reconnect in flight as close starts: it is accepted (or refused) only after close began.
    const late = connect({ path: server.socketPath });
    let lateClosed = false;
    late.on("close", () => void (lateClosed = true));
    late.on("error", () => {});
    late.on("connect", () => void late.write(encodeFrame(hello(token.token), AGENT_REQUEST_MAX_BYTES)));
    const lateFrames: unknown[] = [];
    const decoder = new FrameDecoder({ maxBytes: AGENT_RESPONSE_MAX_BYTES });
    late.on("data", (c: Buffer) => void lateFrames.push(...decoder.push(c)));

    running.splice(0);
    const started = Date.now();
    await Promise.race([server.close(), new Promise((_, reject) => setTimeout(() => reject(new Error("close() hung")), 1_000))]);
    expect(Date.now() - started).toBeLessThan(1_000);
    token.remove();
    await until(() => before.closed && lateClosed);
    expect(lateFrames).toEqual([]);
    expect(server.openConnections).toBe(0);
    expect(existsSync(server.socketPath)).toBe(false);
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

describe("read sessions over the socket", () => {
  const SITE = "https://docs.example.com";
  const LONG_TEXT = Array.from({ length: 2500 }, (_, i) => `line ${i}: café\n`).join("");
  let now: number;
  let agent: AgentSocketServer | null;

  beforeEach(async () => {
    // A store on a fake clock whose revocations reach the socket server, as main wires it.
    await store.close();
    now = 1_800_000_000_000;
    agent = null;
    store = await createCapabilityStore({ scoutHome: root, clock: { now: () => now }, onRevoked: (id) => agent?.resourceRevoked(id) });
  });

  async function ingestApproved(text: string, resourceId?: string): Promise<{ id: string; version: string }> {
    const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
    const sourceUrl = `${SITE}/llms.txt`;
    const found = {
      kind: "llms_txt" as const, siteOrigin: SITE, publisherOrigin: SITE, sourceUrl, finalUrl: sourceUrl,
      text, sha256, byteLength: Buffer.byteLength(text), fetchedAt: now,
    };
    const discovery: DiscoveryResult = {
      origin: SITE, checkedAt: now, robots: "not_fetched",
      items: [{ kind: "llms_txt", sourceUrl, status: "found", source: "network", resource: found }],
      externalReferences: [], skillsOverCap: 0, acceptedBytes: 0, stats: { requests: 0, refused: 0, ms: 0 },
    };
    const r = (await store.ingest(discovery, { chromePermitted: false })).results[0]!;
    const id = resourceId ?? r.resourceId;
    await store.approve({ resourceId: id, version: r.version, expectedRevision: store.getResource(id)!.revision });
    return { id, version: r.version };
  }

  async function openRead() {
    const { server, token } = await startAgent("core-a", { clock: { now: () => now } });
    agent = server;
    const v1 = await ingestApproved(LONG_TEXT);
    const c = await rawClient(server.socketPath);
    c.send(hello(token.token));
    c.send(read(v1.id));
    await until(() => c.frames.length === 2);
    const first = c.frames[1] as { status: string; result: { nextCursor?: string } };
    expect(first.status).toBe("ok");
    expect(first.result.nextCursor).toBeDefined();
    return { server, c, v1, cursor: first.result.nextCursor! };
  }

  it("a revocation answers revoked to the next chunk on an open connection", async () => {
    const { c, v1, cursor } = await openRead();
    await store.revoke(v1.id);
    c.send(read(v1.id, cursor));
    await until(() => c.frames.length === 3);
    expect(c.frames[2]).toMatchObject({ status: "error", error: { code: "revoked" } });
    expect(c.closed).toBe(false);
  });

  it("sweepExpired releases an abandoned read's pin on a quiet open connection, so collection takes the version", async () => {
    const { server, c, v1 } = await openRead();
    // More newer versions than collection retains.
    for (let i = 2; i <= 8; i++) {
      now += 1000;
      await ingestApproved(`guide v${i}\n`, v1.id);
    }
    await store.collectGarbage();
    expect(store.resolveRead(v1.id, v1.version).ok).toBe(true);

    now += AGENT_CURSOR_TTL_MS;
    server.sweepExpired();
    await store.collectGarbage();
    expect(store.resolveRead(v1.id, v1.version)).toEqual({ ok: false, code: "not_found" });
    expect(c.closed).toBe(false);
    expect(server.openConnections).toBe(1);
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
