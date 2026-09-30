import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type CallToolResult, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { RankRequest } from "personal-context-mcp/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServiceTransport, type ServiceTransport } from "./transport.js";

const TOKEN = "stub-token-123";
const STATUS = { serviceInstanceId: "svc-1", activityRevision: 4, sourceGrantRevision: "grant-a" };
const REQUEST: RankRequest = {
  requestId: "r1",
  site: { origin: "https://docs.stripe.com" },
  candidates: [{ id: "c0", title: "A", labelQuality: "published" }],
  maxResults: 3,
  deadlineMs: 20_000,
};

type Answer = (args: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult> | CallToolResult;

interface Stub {
  url: string;
  port: number;
  authHeaders: string[];
  cancelledSeen: number;
  answers: Record<string, Answer>;
  /** Forget every session, as a restarted service would. */
  dropSessions(): void;
  close(): Promise<void>;
}

const structured = (value: Record<string, unknown>): CallToolResult => ({ content: [], structuredContent: value });

/** An in-test MCP service on a random loopback port: bearer check, three canned tools, one session map. */
async function startStub(port = 0): Promise<Stub> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const stub: Stub = {
    url: "",
    port: 0,
    authHeaders: [],
    cancelledSeen: 0,
    answers: {
      context_status: () => structured(STATUS),
      rank_site_links: () => structured({ status: "empty", ...STATUS }),
      observe_activity: () => structured({ accepted: true, observationId: "o1" }),
    },
    dropSessions: () => sessions.clear(),
    close: async () => {},
  };

  const http: HttpServer = createServer((req, res) => {
    void (async () => {
      stub.authHeaders.push(req.headers.authorization ?? "");
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      const sid = req.headers["mcp-session-id"];
      let transport = typeof sid === "string" ? sessions.get(sid) : undefined;
      if (transport === undefined) {
        if (typeof sid === "string") {
          res.writeHead(404).end();
          return;
        }
        const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => void sessions.set(id, created),
        });
        const server = new Server({ name: "stub", version: "0.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          extra.signal.addEventListener("abort", () => {
            stub.cancelledSeen += 1;
          });
          const answer = stub.answers[request.params.name];
          if (!answer) throw new Error("unknown tool");
          return answer(request.params.arguments ?? {}, extra.signal);
        });
        await server.connect(created as Transport);
        transport = created;
      }
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
  stub.port = (http.address() as AddressInfo).port;
  stub.url = `http://127.0.0.1:${stub.port}/mcp`;
  stub.close = () =>
    new Promise((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    });
  return stub;
}

let dir: string;
let tokenPath: string;
let stub: Stub;
let transport: ServiceTransport | null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "scout-transport-"));
  tokenPath = join(dir, "token");
  writeFileSync(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
  stub = await startStub();
  transport = null;
});

afterEach(async () => {
  await transport?.close();
  await stub.close();
  rmSync(dir, { recursive: true, force: true });
});

function connect(overrides: { baseUrl?: string; tokenPath?: string; connectTimeoutMs?: number; fetch?: typeof fetch } = {}): ServiceTransport {
  transport = createServiceTransport({ baseUrl: stub.url, tokenPath, ...overrides });
  return transport;
}

/**
 * A fetch that answers the next `tools/call` POSTs with the queued HTTP statuses instead of
 * reaching the stub; everything else goes through. `toolCalls` counts every tools/call POST.
 */
function scriptedFetch(): { fetch: typeof fetch; failNext: number[]; toolCalls: number } {
  const f = {
    failNext: [] as number[],
    toolCalls: 0,
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "POST" && typeof init.body === "string" && init.body.includes('"method":"tools/call"')) {
        f.toolCalls += 1;
        const status = f.failNext.shift();
        if (status !== undefined) return new Response(null, { status });
      }
      return fetch(input, init);
    }) as typeof fetch,
  };
  return f;
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("service transport", () => {
  it("sends the bearer token and parses all three tools", async () => {
    const t = connect();
    expect(t.lastContextStatus()).toBeNull();
    expect(await t.contextStatus()).toEqual({ ok: true, value: STATUS });
    expect(await t.rankSiteLinks(REQUEST)).toEqual({ ok: true, value: { status: "empty", ...STATUS } });
    expect(await t.observeActivity({ sensor: "s", kind: "viewed_page", observedAt: "x", url: "u", title: "t", truncated: false })).toEqual({
      ok: true,
      value: { accepted: true, observationId: "o1" },
    });
    expect(stub.authHeaders.length).toBeGreaterThan(0);
    expect(stub.authHeaders.every((h) => h === `Bearer ${TOKEN}`)).toBe(true);
    expect(t.lastContextStatus()).toEqual(STATUS);
  });

  it("reports a wrong token as unavailable `bad token`", async () => {
    writeFileSync(tokenPath, "wrong");
    expect(await connect().contextStatus()).toEqual({ ok: false, status: "unavailable", reason: "bad token" });
  });

  it("reports a missing or non-regular token file as unavailable `no token` without calling the service", async () => {
    expect(await connect({ tokenPath: join(dir, "missing") }).contextStatus()).toMatchObject({ status: "unavailable", reason: "no token" });
    mkdirSync(join(dir, "tokendir"));
    expect(await connect({ tokenPath: join(dir, "tokendir") }).contextStatus()).toMatchObject({ status: "unavailable", reason: "no token" });
    expect(stub.authHeaders).toHaveLength(0);
  });

  it("reports an unreachable port as unavailable `service unreachable`", async () => {
    const port = stub.port;
    await stub.close();
    const t = connect({ baseUrl: `http://127.0.0.1:${port}/mcp` });
    expect(await t.contextStatus()).toEqual({ ok: false, status: "unavailable", reason: "service unreachable" });
    stub = await startStub();
  });

  it("reports malformed structuredContent as error `bad response`", async () => {
    stub.answers.rank_site_links = () => structured({ status: "ok", items: [] });
    stub.answers.context_status = () => ({ content: [] });
    const t = connect();
    expect(await t.rankSiteLinks(REQUEST)).toEqual({ ok: false, status: "error", reason: "bad response" });
    expect(await t.contextStatus()).toEqual({ ok: false, status: "error", reason: "bad response" });
    expect(t.lastContextStatus()).toBeNull();
  });

  it("reports a tool error result as error `service error`", async () => {
    stub.answers.observe_activity = () => ({ content: [], isError: true });
    const r = await connect().observeActivity({ sensor: "s", kind: "viewed_page", observedAt: "x", url: "u", title: "t", truncated: false });
    expect(r).toMatchObject({ ok: false, status: "error" });
  });

  // Observed SDK behaviour (1.30.1): aborting the signal rejects the request at once and
  // sends `notifications/cancelled` for its id; the server aborts the handler's signal.
  it("an abort settles the call at once and the service sees the cancellation", async () => {
    stub.answers.rank_site_links = (_args, signal) =>
      new Promise((resolve) => signal.addEventListener("abort", () => resolve(structured({ status: "empty", ...STATUS }))));
    const t = connect();
    expect((await t.contextStatus()).ok).toBe(true);
    const controller = new AbortController();
    const pending = t.rankSiteLinks(REQUEST, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 50));
    const abortedAt = Date.now();
    controller.abort();
    expect(await pending).toEqual({ ok: false, status: "cancelled", reason: "aborted" });
    expect(Date.now() - abortedAt).toBeLessThan(500);
    await until(() => stub.cancelledSeen === 1);
    // The session survives our own abort.
    expect((await t.contextStatus()).ok).toBe(true);
  });

  it("maps the SDK's request timeout to unavailable `timed out`", async () => {
    stub.answers.rank_site_links = (_args, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(structured({}))));
    const r = await connect().rankSiteLinks(REQUEST, { timeoutMs: 100 });
    expect(r).toEqual({ ok: false, status: "unavailable", reason: "timed out" });
    await until(() => stub.cancelledSeen === 1);
  });

  it("reconnects on the next call after a bad token is fixed", async () => {
    writeFileSync(tokenPath, "wrong");
    const t = connect();
    expect(await t.contextStatus()).toMatchObject({ reason: "bad token" });
    writeFileSync(tokenPath, TOKEN);
    expect(await t.contextStatus()).toEqual({ ok: true, value: STATUS });
  });

  it("the first call after the service forgets the session succeeds on a fresh session", async () => {
    const t = connect();
    expect((await t.contextStatus()).ok).toBe(true);
    stub.dropSessions();
    const seen = stub.authHeaders.length;
    expect(await t.rankSiteLinks(REQUEST)).toEqual({ ok: true, value: { status: "empty", ...STATUS } });
    // The stale call (404), then initialize, initialized, and the retried call.
    expect(stub.authHeaders.length).toBeGreaterThan(seen + 2);
    expect(await t.contextStatus()).toEqual({ ok: true, value: STATUS });
  });

  it("retries a lost session once: a second consecutive 404 fails `service unreachable`", async () => {
    const f = scriptedFetch();
    const t = connect({ fetch: f.fetch });
    expect((await t.contextStatus()).ok).toBe(true);
    f.failNext.push(404, 404);
    f.toolCalls = 0;
    expect(await t.contextStatus()).toEqual({ ok: false, status: "unavailable", reason: "service unreachable" });
    expect(f.toolCalls).toBe(2);
    // The next call reconnects as before.
    expect(await t.contextStatus()).toEqual({ ok: true, value: STATUS });
  });

  it("does not retry a 401 on a call", async () => {
    const f = scriptedFetch();
    const t = connect({ fetch: f.fetch });
    expect((await t.contextStatus()).ok).toBe(true);
    f.failNext.push(401);
    f.toolCalls = 0;
    expect(await t.contextStatus()).toEqual({ ok: false, status: "unavailable", reason: "bad token" });
    expect(f.toolCalls).toBe(1);
  });

  it("does not retry a call timeout", async () => {
    const f = scriptedFetch();
    stub.answers.rank_site_links = (_args, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(structured({}))));
    const t = connect({ fetch: f.fetch });
    expect(await t.rankSiteLinks(REQUEST, { timeoutMs: 100 })).toEqual({ ok: false, status: "unavailable", reason: "timed out" });
    expect(f.toolCalls).toBe(1);
  });

  it("a caller abort during the lost-session retry yields `cancelled`", async () => {
    const f = scriptedFetch();
    stub.answers.rank_site_links = (_args, signal) =>
      new Promise((resolve) => signal.addEventListener("abort", () => resolve(structured({ status: "empty", ...STATUS }))));
    const t = connect({ fetch: f.fetch });
    expect((await t.contextStatus()).ok).toBe(true);
    f.failNext.push(404);
    f.toolCalls = 0;
    const controller = new AbortController();
    const pending = t.rankSiteLinks(REQUEST, { signal: controller.signal });
    await until(() => f.toolCalls === 2);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    expect(await pending).toEqual({ ok: false, status: "cancelled", reason: "aborted" });
    await until(() => stub.cancelledSeen === 1);
    expect(f.toolCalls).toBe(2);
  });

  it("an abort during a failing connect still drops the session, so the next call reconnects", async () => {
    const port = stub.port;
    await stub.close();
    const t = connect({ baseUrl: `http://127.0.0.1:${port}/mcp` });
    const controller = new AbortController();
    const pending = t.contextStatus({ signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, status: "cancelled", reason: "aborted" });
    stub = await startStub(port);
    expect(await t.contextStatus()).toEqual({ ok: true, value: STATUS });
  });

  it("fails a hung handshake at the connect timeout and retries it on the next call", async () => {
    let requests = 0;
    const hung = createServer(() => {
      requests += 1;
    });
    await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
    try {
      const t = connect({ baseUrl: `http://127.0.0.1:${(hung.address() as AddressInfo).port}/mcp`, connectTimeoutMs: 100 });
      const startedAt = Date.now();
      expect(await t.contextStatus()).toMatchObject({ ok: false, status: "unavailable" });
      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(requests).toBe(1);
      expect(await t.contextStatus()).toMatchObject({ ok: false, status: "unavailable" });
      expect(requests).toBe(2);
    } finally {
      hung.closeAllConnections();
      await new Promise<void>((resolve) => hung.close(() => resolve()));
    }
  });

  it("fails every call after close() without reconnecting", async () => {
    const t = connect();
    expect((await t.contextStatus()).ok).toBe(true);
    await t.close();
    const seen = stub.authHeaders.length;
    expect(await t.contextStatus()).toEqual({ ok: false, status: "unavailable", reason: "service unreachable" });
    expect(await t.rankSiteLinks(REQUEST)).toEqual({ ok: false, status: "unavailable", reason: "service unreachable" });
    expect(stub.authHeaders).toHaveLength(seen);
  });

  it("reconnects after the service comes back on the same port", async () => {
    const t = connect();
    expect((await t.contextStatus()).ok).toBe(true);
    const port = stub.port;
    await stub.close();
    expect(await t.contextStatus()).toMatchObject({ ok: false, reason: "service unreachable" });
    stub = await startStub(port);
    expect(await t.contextStatus()).toEqual({ ok: true, value: STATUS });
  });
});
