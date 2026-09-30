// The HTTP service in-process (runServer) and as a child (dist/server.js), against the
// fake CLI wrapper from test-support/serverFixture.ts. No real claude, no network beyond
// 127.0.0.1, temp homes only.

import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextStatusSchema, RankResponseSchema, type RankResponse } from "./api.js";
import { MAX_BODY_BYTES, MAX_SESSIONS, portInUseMessage, runServer, ServerStartError, WATCH_GRACE_MS } from "./server.js";
import { MESSAGES, readServerInfo, serverFilePath } from "./serviceFiles.js";
import { probeService } from "./serviceProbe.js";
import {
  alive,
  cleanupAll,
  connect,
  fakePids,
  makeServerFixture,
  observation,
  rankRequest,
  SERVER_JS,
  spawnServer,
  startServer,
  token,
  waitFor,
  waitForRuns,
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

  it("refuses to start when server.json names a live service that answers as itself", async () => {
    const fx = makeServerFixture();
    const { child } = await spawnServer(fx);
    await expect(runServer({ env: fx.env, log: () => {} })).rejects.toThrow(MESSAGES.alreadyRunning);
    expect(readServerInfo(fx.pcmHome)?.pid).toBe(child.pid);
  });

  it("treats a live but unrelated pid with a bogus port as stale and overwrites the file", async () => {
    const fx = makeServerFixture();
    mkdirSync(join(fx.pcmHome, "run"), { mode: 0o700 });
    const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    try {
      writeFileSync(serverFilePath(fx.pcmHome), JSON.stringify({ pid: live.pid, port: 1, serviceInstanceId: "other", startedAt: "x" }), { mode: 0o600 });
      const { server, logs } = await startServer(fx);
      expect(readServerInfo(fx.pcmHome)).toMatchObject({ pid: process.pid, serviceInstanceId: server.serviceInstanceId });
      expect(logs.some((l) => JSON.parse(l).code === "stale_server_json")).toBe(true);
      expect(alive(live.pid!)).toBe(true);
    } finally {
      live.kill("SIGKILL");
    }
  });

  it("a child server starts over a file naming another live pid (this test process) and a bogus port", async () => {
    const fx = makeServerFixture();
    mkdirSync(join(fx.pcmHome, "run"), { mode: 0o700 });
    writeFileSync(serverFilePath(fx.pcmHome), JSON.stringify({ pid: process.pid, port: 1, serviceInstanceId: "reused", startedAt: "x" }), { mode: 0o600 });
    const { child } = await spawnServer(fx);
    expect(readServerInfo(fx.pcmHome)).toMatchObject({ pid: child.pid });
    expect(readServerInfo(fx.pcmHome)?.serviceInstanceId).not.toBe("reused");
  });

  it("the ownership probe rejects a listener with another instance id, and gives up on a silent one within its timeout", async () => {
    const fx = makeServerFixture();
    const { server } = await startServer(fx);
    const info = readServerInfo(fx.pcmHome)!;
    expect(await probeService(info, token(fx))).toMatchObject({ serviceInstanceId: server.serviceInstanceId });
    expect(await probeService({ ...info, serviceInstanceId: "other" }, token(fx))).toBeUndefined();
    const silent: NetServer = createNetServer(() => {}); // accepts, never answers
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    try {
      const t0 = Date.now();
      expect(await probeService({ ...info, port: (silent.address() as { port: number }).port }, token(fx), 500)).toBeUndefined();
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      silent.close();
    }
  });
});

// ---------- sessions, watches, body limit ----------

async function initSession(port: number, tok: string): Promise<string> {
  const res = await rawFetch(port, { headers: { ...MCP_HEADERS, authorization: `Bearer ${tok}` }, body: INIT_BODY });
  expect(res.status).toBe(200);
  await res.text();
  return res.headers.get("mcp-session-id")!;
}

async function sessionAlive(port: number, tok: string, sid: string): Promise<boolean> {
  const res = await rawFetch(port, {
    headers: { ...MCP_HEADERS, authorization: `Bearer ${tok}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }),
  });
  await res.text();
  return res.status !== 404;
}

describe("server: sessions", () => {
  it(`at ${MAX_SESSIONS} abandoned sessions, a new one evicts the least recently seen`, async () => {
    const fx = makeServerFixture();
    const { server } = await startServer(fx);
    const tok = token(fx);
    const ids: string[] = [];
    for (let i = 0; i < MAX_SESSIONS; i++) ids.push(await initSession(server.port, tok));
    expect(server.counts().sessions).toBe(MAX_SESSIONS);
    const newest = await initSession(server.port, tok);
    expect(server.counts().sessions).toBe(MAX_SESSIONS);
    expect(await sessionAlive(server.port, tok, ids[0]!)).toBe(false);
    expect(await sessionAlive(server.port, tok, ids[1]!)).toBe(true);
    expect(await sessionAlive(server.port, tok, newest)).toBe(true);
  });

  it("never evicts a session whose rank is running", async () => {
    const fx = makeServerFixture({ mode: "hang" });
    const { server } = await startServer(fx);
    const tok = token(fx);
    const { client } = await connect(fx, server.port);
    const call = client.callTool({ name: "rank_site_links", arguments: rankRequest() }, undefined, { timeout: 60_000 });
    call.catch(() => {});
    await waitForRuns(fx);
    const pids = fakePids(fx);
    // The ranking session is the oldest; filling past the cap evicts idle ones instead.
    const ids: string[] = [];
    for (let i = 0; i < MAX_SESSIONS + 3; i++) ids.push(await initSession(server.port, tok));
    expect(server.counts()).toMatchObject({ sessions: MAX_SESSIONS, runs: 1 });
    expect(pids.every(alive)).toBe(true);
    expect(await sessionAlive(server.port, tok, ids[0]!)).toBe(false);
    expect(ContextStatusSchema.parse((await client.callTool({ name: "context_status", arguments: {} })).structuredContent).serviceInstanceId).toBe(
      server.serviceInstanceId,
    );
  });
});

describe("server: response watches", () => {
  it("200 observe_activity calls leave no watch behind", async () => {
    const fx = makeServerFixture();
    const { server } = await startServer(fx);
    const { client } = await connect(fx, server.port);
    for (let i = 0; i < 200; i++) await client.callTool({ name: "observe_activity", arguments: { ...observation, observedAt: `2026-09-30T12:00:${String(i % 60).padStart(2, "0")}Z` } });
    await waitFor(() => server.counts().watches === 0, 3000);
  });

  it("an observe_activity whose response closed early is dropped after the grace period", async () => {
    const fx = makeServerFixture();
    const { server } = await startServer(fx);
    const tok = token(fx);
    const sid = await initSession(server.port, tok);
    const http = await import("node:http");
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((resolve) => {
        const req = http.request({
          host: "127.0.0.1",
          port: server.port,
          path: "/mcp",
          method: "POST",
          headers: { ...MCP_HEADERS, authorization: `Bearer ${tok}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" },
        });
        req.on("error", () => resolve());
        req.end(JSON.stringify({ jsonrpc: "2.0", id: 100 + i, method: "tools/call", params: { name: "observe_activity", arguments: observation } }), () => {
          req.destroy();
          resolve();
        });
      });
    }
    await waitFor(() => server.counts().watches === 0, WATCH_GRACE_MS + 3000);
  });
});

describe("server: body limit", () => {
  it("answers 413 from content-length alone, without waiting for the body", async () => {
    const fx = makeServerFixture();
    const { server } = await startServer(fx);
    const http = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/mcp",
          method: "POST",
          headers: { ...MCP_HEADERS, authorization: `Bearer ${token(fx)}`, "content-length": String(MAX_BODY_BYTES + 1) },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.write("{"); // the rest never arrives
    });
    expect(status).toBe(413);
  });

  it("answers 413 once a chunked body passes the limit, without reading to the end", async () => {
    const fx = makeServerFixture();
    const { server } = await startServer(fx);
    const http = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/mcp",
          method: "POST",
          headers: { ...MCP_HEADERS, authorization: `Bearer ${token(fx)}`, "transfer-encoding": "chunked" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      const chunk = Buffer.alloc(64 * 1024, "x");
      for (let sent = 0; sent <= MAX_BODY_BYTES; sent += chunk.length) req.write(chunk);
      // never ended: a server that drained to the end would never answer
    });
    expect(status).toBe(413);
  });
});

export type { ServerFixture };
