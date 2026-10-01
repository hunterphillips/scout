// The socket client against hand-rolled servers on temp Unix sockets.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_PROTOCOL_VERSION, AGENT_REQUEST_MAX_BYTES, AGENT_RESPONSE_MAX_BYTES } from "@scout/contracts";
import { encodeFrame, FrameDecoder, frameHeader } from "@scout/contracts/frame";
import { afterEach, describe, expect, it } from "vitest";
import { BackendError, createSocketBackend } from "./client.js";
import { req } from "./test-support/seed.js";

const TOKEN = "fixture-token";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempHome(): { dir: string; socketPath: string; tokenFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "smcp-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, "agent-token");
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  return { dir, socketPath: join(dir, "agent.sock"), tokenFile };
}

/**
 * A core that accepts `hello`, then answers every later request with the raw bytes
 * `reply(requestId)` returns. Records the hello tokens it receives.
 */
async function rawCore(socketPath: string, reply: (requestId: string) => Buffer, helloProtocol = AGENT_PROTOCOL_VERSION) {
  const tokens: unknown[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const decoder = new FrameDecoder({ maxBytes: AGENT_REQUEST_MAX_BYTES });
    socket.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (!frame.ok) return void socket.destroy();
        const { requestId, method, params } = frame.value as { requestId: string; method: string; params: { token?: string } };
        if (method === "hello") {
          tokens.push(params.token);
          const res = { protocol: helloProtocol, requestId, coreInstanceId: "core-raw", status: "ok", result: { role: "interactive" } };
          socket.write(encodeFrame(res, AGENT_RESPONSE_MAX_BYTES));
        } else socket.write(reply(requestId));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  chmodSync(socketPath, 0o600);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  );
  return { tokens };
}

function backend(home: { socketPath: string; tokenFile: string }) {
  const b = createSocketBackend({ socketPath: home.socketPath, tokenFile: home.tokenFile, timeoutMs: 2_000 });
  cleanups.push(() => b.close());
  return b;
}

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BackendError) return e.code;
    throw e;
  }
  return "ok";
}

const okSite = (requestId: string) =>
  encodeFrame({ protocol: AGENT_PROTOCOL_VERSION, requestId, coreInstanceId: "core-raw", status: "ok", result: { site: null } }, AGENT_RESPONSE_MAX_BYTES);

describe("socket client", () => {
  it("talks to a core on a private socket", async () => {
    const home = tempHome();
    const core = await rawCore(home.socketPath, okSite);
    const res = await backend(home).call(req("current_site", {}));
    expect(res.status).toBe("ok");
    expect(core.tokens).toEqual([TOKEN]);
  });

  it("sends no token when the socket's directory is open to others", async () => {
    const home = tempHome();
    const core = await rawCore(home.socketPath, okSite);
    chmodSync(home.dir, 0o755);
    expect(await failure(backend(home).call(req("current_site", {})))).toBe("unavailable");
    expect(core.tokens).toEqual([]);
  });

  it("sends no token to a socket others can connect to", async () => {
    const home = tempHome();
    const core = await rawCore(home.socketPath, okSite);
    chmodSync(home.socketPath, 0o666);
    expect(await failure(backend(home).call(req("current_site", {})))).toBe("unavailable");
    expect(core.tokens).toEqual([]);
  });

  it("drops the connection with limit_exceeded on an oversized response frame", async () => {
    const home = tempHome();
    const big = AGENT_RESPONSE_MAX_BYTES + 1;
    await rawCore(home.socketPath, () => Buffer.concat([frameHeader(big), Buffer.alloc(big, 0x20)]));
    expect(await failure(backend(home).call(req("current_site", {})))).toBe("limit_exceeded");
  });

  it("drops the connection with protocol_mismatch on a malformed frame", async () => {
    const home = tempHome();
    const body = Buffer.from("{not json", "utf8");
    await rawCore(home.socketPath, () => Buffer.concat([frameHeader(body.length), body]));
    expect(await failure(backend(home).call(req("current_site", {})))).toBe("protocol_mismatch");
  });

  it("reports protocol_mismatch for a core that speaks a newer protocol", async () => {
    const home = tempHome();
    await rawCore(home.socketPath, okSite, AGENT_PROTOCOL_VERSION + 1);
    expect(await failure(backend(home).call(req("current_site", {})))).toBe("protocol_mismatch");
  });
});
