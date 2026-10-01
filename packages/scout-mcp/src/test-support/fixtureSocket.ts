// Test-only (exported as `@scout/scout-mcp/testing` for scout-core's job tests): serve a fixture backend on a Unix socket with the agent framing, so the real
// stdio adapter can be driven end to end. The first frame must be an accepted `hello`;
// anything else closes the connection. The socket is chmod 0600, as the core publishes it. Phase 2's core owns the production server.

import { chmodSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { AGENT_PROTOCOL_VERSION, AGENT_REQUEST_MAX_BYTES, AGENT_RESPONSE_MAX_BYTES, type AgentRequestOf } from "@scout/contracts";
import { encodeFrame, FrameDecoder } from "@scout/contracts/frame";
import type { FixtureBackend } from "../fixture.js";

export interface FixtureSocket {
  /** Frames received, hello included. */
  readonly requests: Record<string, unknown>[];
  /** Client connections still open. */
  readonly openConnections: number;
  close(): Promise<void>;
}

export async function serveFixture(backend: FixtureBackend, socketPath: string): Promise<FixtureSocket> {
  const requests: Record<string, unknown>[] = [];
  const server: Server = createServer((socket) => {
    const decoder = new FrameDecoder({ maxBytes: AGENT_REQUEST_MAX_BYTES });
    let authed = false;
    let chain = Promise.resolve();
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (!frame.ok) return void socket.destroy();
        requests.push(frame.value);
        chain = chain.then(async () => {
          const isHello = frame.value.method === "hello";
          if (authed === isHello) return void socket.destroy();
          const res = await backend.call(frame.value as unknown as AgentRequestOf<"hello">);
          if (isHello && (res.status !== "ok" || res.protocol !== AGENT_PROTOCOL_VERSION)) {
            socket.end(encodeFrame(res, AGENT_RESPONSE_MAX_BYTES));
            return;
          }
          if (isHello) authed = true;
          socket.write(encodeFrame(res, AGENT_RESPONSE_MAX_BYTES));
        }).catch(() => void socket.destroy());
      }
    });
  });
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  // The client sends its token only to a socket with no group or other bits, as the core publishes it.
  chmodSync(socketPath, 0o600);
  return {
    requests,
    get openConnections() {
      return sockets.size;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
