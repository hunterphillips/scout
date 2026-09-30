// The HTTP service in-process (runServer) and as a child (dist/server.js), against the
// fake CLI wrapper from test-support/serverFixture.ts. No real claude, no network beyond
// 127.0.0.1, temp homes only.

import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextStatusSchema, RankResponseSchema, type RankResponse } from "./api.js";
import { portInUseMessage, runServer, ServerStartError } from "./server.js";
import { MESSAGES, readServerInfo, serverFilePath } from "./serviceFiles.js";
import {
  cleanupAll,
  connect,
  makeServerFixture,
  observation,
  rankRequest,
  SERVER_JS,
  startServer,
  token,
  type ServerFixture,
} from "./test-support/serverFixture.js";

afterEach(cleanupAll);

async function rawFetch(port: number, init: { path?: string; headers?: Record<string, string>; method?: string; body?: string } = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${init.path ?? "/mcp"}`, {
    method: init.method ?? "POST",
    headers: init.headers ?? {},
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
});
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

function parseRank(result: unknown): RankResponse {
  return RankResponseSchema.parse((result as { structuredContent: unknown }).structuredContent);
}

// ---------- HTTP gate ----------

describe("server: HTTP gate", () => {
  it("rejects a missing or wrong token (401), accepts the right one", async () => {
    const fx = makeServerFixture();
    const { server } = await startServer(fx);
    const port = server.port;
    expect((await rawFetch(port, { headers: MCP_HEADERS, body: INIT_BODY })).status).toBe(401);
    expect((await rawFetch(port, { headers: { ...MCP_HEADERS, authorization: `Bearer ${"0".repeat(64)}` }, body: INIT_BODY })).status).toBe(401);
    expect((await rawFetch(port, { headers: { ...MCP_HEADERS, authorization: `Basic ${token(fx)}` }, body: INIT_BODY })).status).toBe(401);
    const ok = await rawFetch(port, { headers: { ...MCP_HEADERS, authorization: `Bearer ${token(fx)}` }, body: INIT_BODY });
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
  });

  it("checks Host and refuses any Origin before auth", async () => {
    const fx = makeServerFixture();
    const { server } = await startServer(fx);
    const port = server.port;
    const auth = { ...MCP_HEADERS, authorization: `Bearer ${token(fx)}` };
    const http = await import("node:http");
    const status = (headers: Record<string, string>): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end(INIT_BODY);
      });
    expect(await status({ ...auth, host: "evil.example:47821" })).toBe(403);
    expect(await status({ ...auth, host: `evil.example:${port}` })).toBe(403);
    expect(await status({ ...auth, host: `127.0.0.1:${port + 1}` })).toBe(403);
    expect(await status({ ...auth, host: `localhost:${port}` })).toBe(200);
    expect(await status({ ...auth, host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })).toBe(403);
    expect(await status({ ...auth, host: `127.0.0.1:${port}`, origin: "null" })).toBe(403);
  });

  it("serves only /mcp", async () => {
    const fx = makeServerFixture();
    const { server } = await startServer(fx);
    const res = await rawFetch(server.port, { path: "/other", headers: { ...MCP_HEADERS, authorization: `Bearer ${token(fx)}` }, body: INIT_BODY });
    expect(res.status).toBe(404);
  });

  it("creates the token 0600 on first start and never logs it", async () => {
    const fx = makeServerFixture();
    const { logs } = await startServer(fx);
    const st = statSync(join(fx.pcmHome, "token"));
    expect(st.mode & 0o777).toBe(0o600);
    expect(token(fx)).toMatch(/^[0-9a-f]{64}$/);
    expect(logs.join("\n")).not.toContain(token(fx));
  });

  it("refuses a 0644 token file with the fixed message", async () => {
    const fx = makeServerFixture();
    writeFileSync(join(fx.pcmHome, "token"), "a".repeat(64) + "\n", { mode: 0o644 });
    chmodSync(join(fx.pcmHome, "token"), 0o644);
    await expect(runServer({ env: fx.env, log: () => {} })).rejects.toThrow(MESSAGES.tokenUnsafe);
  });

  it("port in use: fails with the fixed message (in process and as a process exit)", async () => {
    const fx = makeServerFixture();
    const blocker: NetServer = createNetServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const port = (blocker.address() as { port: number }).port;
    try {
      const err = await runServer({ env: { ...fx.env, PCM_PORT: String(port) }, log: () => {} }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServerStartError);
      expect((err as Error).message).toBe(portInUseMessage(port));
      expect(existsSync(serverFilePath(fx.pcmHome))).toBe(false);

      const child = spawn(process.execPath, [SERVER_JS], { env: { ...fx.env, PCM_PORT: String(port) }, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
      const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
      expect(code).not.toBe(0);
      expect(stderr.trim().split("\n").at(-1)).toBe(`port ${port} in use; set PCM_PORT`);
    } finally {
      blocker.close();
    }
  });
});

// ---------- tools ----------

describe("server: tools", () => {
  it("lists exactly three tools", async () => {
    const fx = makeServerFixture();
    const { server } = await startServer(fx);
    const { client } = await connect(fx, server.port);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["context_status", "observe_activity", "rank_site_links"]);
  });

  it("context_status returns the three fields; activityRevision bumps after observe_activity", async () => {
    const fx = makeServerFixture();
    const { server } = await startServer(fx);
    const { client } = await connect(fx, server.port);
    const before = ContextStatusSchema.parse((await client.callTool({ name: "context_status", arguments: {} })).structuredContent);
    expect(Object.keys(before).sort()).toEqual(["activityRevision", "serviceInstanceId", "sourceGrantRevision"]);
    expect(before.serviceInstanceId).toBe(server.serviceInstanceId);
    const obs = await client.callTool({ name: "observe_activity", arguments: observation });
    expect(obs.structuredContent).toEqual({ accepted: true, observationId: "o1" });
    expect(JSON.parse((obs.content as Array<{ text: string }>)[0]!.text)).toEqual({ accepted: true, observationId: "o1" });
    const after = ContextStatusSchema.parse((await client.callTool({ name: "context_status", arguments: {} })).structuredContent);
    expect(after.activityRevision).toBe(before.activityRevision + 1);
    expect(after.sourceGrantRevision).toBe(before.sourceGrantRevision);
  });

  it("rank_site_links in ok mode returns ok plus the ContextStatus fields", async () => {
    const fx = makeServerFixture({ mode: "ok" });
    const { server, logs } = await startServer(fx);
    const { client } = await connect(fx, server.port);
    await client.callTool({ name: "observe_activity", arguments: observation });
    const res = await client.callTool({ name: "rank_site_links", arguments: rankRequest() });
    const out = parseRank(res);
    expect(out.status).toBe("ok");
    expect(out).toMatchObject({ serviceInstanceId: server.serviceInstanceId, activityRevision: 1, sourceGrantRevision: server.sourceGrantRevision });
    expect(JSON.parse((res.content as Array<{ text: string }>)[0]!.text)).toEqual(res.structuredContent);
    const logText = logs.join("\n");
    expect(logText).not.toMatch(/Billing issue|usage billing|github\.com|Usage billing guide/);
  });

  it("an unavailable runner result still arrives as a tool result", async () => {
    const fx = makeServerFixture({ mode: "ok" });
    // A home whose settings make the real preflight ambiguous: the run is refused.
    mkdirSync(join(fx.home, ".claude"), { recursive: true });
    writeFileSync(join(fx.home, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "SENTINEL-HELPER-CMD-44d0" }));
    const { server, logs } = await startServer(fx);
    const { client } = await connect(fx, server.port);
    const res = await client.callTool({ name: "rank_site_links", arguments: rankRequest() });
    expect(res.isError).toBeFalsy();
    expect(parseRank(res)).toMatchObject({ status: "unavailable", reason: "billing route unverified", serviceInstanceId: server.serviceInstanceId });
    expect(existsSync(fx.fakeLog)).toBe(false); // the fake CLI never ran
    expect(logs.join("\n")).not.toContain("SENTINEL");
    expect(logs.some((l) => JSON.parse(l).code === "preflight" && JSON.parse(l).verdict === "ambiguous")).toBe(true);
  });
});

// ---------- server.json ----------

describe("server: server.json", () => {
  it("is written after listening (0600 in a 0700 dir) and removed on shutdown", async () => {
    const fx = makeServerFixture();
    const { server } = await startServer(fx);
    const info = readServerInfo(fx.pcmHome);
    expect(info).toMatchObject({ pid: process.pid, port: server.port, serviceInstanceId: server.serviceInstanceId });
    expect(statSync(serverFilePath(fx.pcmHome)).mode & 0o777).toBe(0o600);
    expect(statSync(join(fx.pcmHome, "run")).mode & 0o777).toBe(0o700);
    const raw = readFileSync(serverFilePath(fx.pcmHome), "utf8");
    expect(raw).not.toContain(token(fx));
    await server.shutdown("sigterm");
    expect(existsSync(serverFilePath(fx.pcmHome))).toBe(false);
  });

  it("overwrites a stale server.json with a dead pid", async () => {
    const fx = makeServerFixture();
    mkdirSync(join(fx.pcmHome, "run"), { mode: 0o700 });
    const dead = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => dead.once("exit", r));
    writeFileSync(serverFilePath(fx.pcmHome), JSON.stringify({ pid: dead.pid, port: 1, serviceInstanceId: "old", startedAt: "x" }), { mode: 0o600 });
    const { server } = await startServer(fx);
    expect(readServerInfo(fx.pcmHome)).toMatchObject({ pid: process.pid, serviceInstanceId: server.serviceInstanceId });
  });

  it("refuses to start when server.json names a live pid", async () => {
    const fx = makeServerFixture();
    mkdirSync(join(fx.pcmHome, "run"), { mode: 0o700 });
    const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    try {
      writeFileSync(serverFilePath(fx.pcmHome), JSON.stringify({ pid: live.pid, port: 1, serviceInstanceId: "other", startedAt: "x" }), { mode: 0o600 });
      await expect(runServer({ env: fx.env, log: () => {} })).rejects.toThrow(MESSAGES.alreadyRunning);
      expect(readServerInfo(fx.pcmHome)?.pid).toBe(live.pid);
    } finally {
      live.kill("SIGKILL");
    }
  });
});

export type { ServerFixture };
