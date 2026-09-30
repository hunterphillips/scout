// Every HTTP-level abort trigger, end to end: a real MCP client (or raw HTTP) against the
// service, the fake CLI in `hang` mode running the real source-tools server, and a check
// that the whole process tree is gone within 3 s and the run dir removed.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextStatusSchema, RankResponseSchema, type RankResponse } from "./api.js";
import { pidAlive, readServerInfo, serverFilePath } from "./serviceFiles.js";
import {
  alive,
  cleanupAll,
  connect,
  fakePids,
  makeServerFixture,
  notesSource,
  rankRequest,
  runLines,
  scratchEntries,
  spawnServer,
  startServer,
  token,
  waitAllGone,
  waitFor,
  waitForRuns,
  type ServerFixture,
} from "./test-support/serverFixture.js";

afterEach(cleanupAll);

function parseRank(result: unknown): RankResponse {
  return RankResponseSchema.parse((result as { structuredContent: unknown }).structuredContent);
}

/** The tree is gone within 3 s, the run dir is removed, and runs.jsonl names the reason. */
async function expectCleanCancel(fx: ServerFixture, pids: number[], reason: string): Promise<void> {
  expect(pids.length).toBeGreaterThanOrEqual(2); // the fake CLI and its source-tools server
  expect(await waitAllGone(pids, 3000)).toEqual([]);
  await waitFor(() => runLines(fx).some((l) => l.cancelReason === reason), 5000);
  await waitFor(() => scratchEntries(fx).length === 0, 3000);
}

describe("server: cancellation triggers", () => {
  it("notifications/cancelled (the client aborts its call) -> notifications_cancelled", async () => {
    const fx = makeServerFixture({ mode: "hang" });
    const { server } = await startServer(fx);
    const { client } = await connect(fx, server.port);
    const ac = new AbortController();
    const call = client.callTool({ name: "rank_site_links", arguments: rankRequest() }, undefined, { signal: ac.signal, timeout: 60_000 });
    call.catch(() => {});
    await waitForRuns(fx);
    const pids = fakePids(fx);
    ac.abort();
    await expect(call).rejects.toThrow();
    await expectCleanCancel(fx, pids, "notifications_cancelled");
  });

  it("supersedes from the same session cancels the first; the second proceeds", async () => {
    const fx = makeServerFixture({ mode: "hang" });
    const { server } = await startServer(fx);
    const { client } = await connect(fx, server.port);
    const first = client.callTool({ name: "rank_site_links", arguments: rankRequest({ requestId: "r1" }) }, undefined, { timeout: 60_000 });
    await waitForRuns(fx);
    const pids = fakePids(fx);
    fx.setMode("empty");
    const second = await client.callTool({ name: "rank_site_links", arguments: rankRequest({ requestId: "r2", supersedes: "r1" }) }, undefined, { timeout: 60_000 });
    expect(parseRank(await first)).toMatchObject({ status: "cancelled", reason: "supersedes" });
    expect(parseRank(second).status).toBe("empty");
    await expectCleanCancel(fx, pids, "supersedes");
  });

  it("supersedes from a different session does not cancel", async () => {
    const fx = makeServerFixture({ mode: "hang" });
    const { server } = await startServer(fx);
    const a = await connect(fx, server.port);
    const b = await connect(fx, server.port);
    const ac = new AbortController();
    const first = a.client.callTool({ name: "rank_site_links", arguments: rankRequest({ requestId: "r1" }) }, undefined, { signal: ac.signal, timeout: 60_000 });
    first.catch(() => {});
    await waitForRuns(fx);
    const pids = fakePids(fx);
    fx.setMode("empty");
    const other = await b.client.callTool({ name: "rank_site_links", arguments: rankRequest({ requestId: "r2", supersedes: "r1" }) }, undefined, { timeout: 60_000 });
    expect(parseRank(other).status).toBe("empty");
    expect(pids.every(alive)).toBe(true);
    expect(runLines(fx).some((l) => l.status === "cancelled")).toBe(false);
    ac.abort();
    await expectCleanCancel(fx, pids, "notifications_cancelled");
  });

  it("a second unrelated request completing normally does not abort a running one", async () => {
    const fx = makeServerFixture({ mode: "hang" });
    const { server } = await startServer(fx);
    const a = await connect(fx, server.port);
    const ac = new AbortController();
    const first = a.client.callTool({ name: "rank_site_links", arguments: rankRequest({ requestId: "r1" }) }, undefined, { signal: ac.signal, timeout: 60_000 });
    first.catch(() => {});
    await waitForRuns(fx);
    const pids = fakePids(fx);
    fx.setMode("empty");
    // Same session and a fresh one; a rank, a status call, and a closed second session.
    const same = await a.client.callTool({ name: "rank_site_links", arguments: rankRequest({ requestId: "r2" }) }, undefined, { timeout: 60_000 });
    expect(parseRank(same).status).toBe("empty");
    const b = await connect(fx, server.port);
    const other = await b.client.callTool({ name: "rank_site_links", arguments: rankRequest({ requestId: "r3" }) }, undefined, { timeout: 60_000 });
    expect(parseRank(other).status).toBe("empty");
    ContextStatusSchema.parse((await a.client.callTool({ name: "context_status", arguments: {} })).structuredContent);
    await b.transport.terminateSession();
    await b.client.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(pids.every(alive)).toBe(true);
    expect(runLines(fx).filter((l) => l.status === "cancelled")).toEqual([]);
    ac.abort();
    await expectCleanCancel(fx, pids, "notifications_cancelled");
  });

  it("session DELETE -> session_closed", async () => {
    const fx = makeServerFixture({ mode: "hang" });
    const { server } = await startServer(fx);
    const { client, transport } = await connect(fx, server.port);
    const call = client.callTool({ name: "rank_site_links", arguments: rankRequest() }, undefined, { timeout: 60_000 });
    call.catch(() => {});
    await waitForRuns(fx);
    const pids = fakePids(fx);
    await transport.terminateSession();
    await expectCleanCancel(fx, pids, "session_closed");
  });

  it("the rank's HTTP response dropped mid-request -> response_closed", async () => {
    const fx = makeServerFixture({ mode: "hang" });
    const { server } = await startServer(fx);
    const url = `http://127.0.0.1:${server.port}/mcp`;
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token(fx)}` };
    const init = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } }),
    });
    const sid = init.headers.get("mcp-session-id")!;
    await init.text();
    const sessionHeaders = { ...headers, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" };
    const notified = await fetch(url, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    await notified.text();
    const ac = new AbortController();
    const res = await fetch(url, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "rank_site_links", arguments: rankRequest() } }),
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    await waitForRuns(fx);
    const pids = fakePids(fx);
    ac.abort(); // drops the socket carrying the response stream
    await expectCleanCancel(fx, pids, "response_closed");
  });
});

describe("server: as a process", () => {
  it("SIGTERM aborts the run, removes server.json and exits 0", async () => {
    const fx = makeServerFixture({ mode: "hang" });
    const { child, port, exited } = await spawnServer(fx);
    const { client } = await connect(fx, port);
    const call = client.callTool({ name: "rank_site_links", arguments: rankRequest() }, undefined, { timeout: 60_000 });
    call.catch(() => {});
    await waitForRuns(fx);
    const pids = fakePids(fx);
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(existsSync(serverFilePath(fx.pcmHome))).toBe(false);
    expect(await waitAllGone(pids, 3000)).toEqual([]);
    expect(runLines(fx).some((l) => l.cancelReason === "sigterm")).toBe(true);
    expect(scratchEntries(fx)).toEqual([]);
  });

  it("SIGHUP reload: a new sourceGrantRevision, the run in flight cancelled; a malformed config keeps the old one", async () => {
    const fx = makeServerFixture({ mode: "hang" });
    const extra = join(fx.home, "more-notes");
    mkdirSync(extra);
    writeFileSync(join(extra, "a.md"), "billing\n");
    const { child, port, stderr } = await spawnServer(fx);
    const { client } = await connect(fx, port);
    const status = async () => ContextStatusSchema.parse((await client.callTool({ name: "context_status", arguments: {} })).structuredContent);
    const before = await status();
    const call = client.callTool({ name: "rank_site_links", arguments: rankRequest() }, undefined, { timeout: 60_000 });
    await waitForRuns(fx);
    const pids = fakePids(fx);

    fx.writeConfig({ sources: [notesSource(fx.notes), { id: "more", kind: "markdown_dir", enabled: true, root: extra, exclude: [] }] });
    child.kill("SIGHUP");
    expect(parseRank(await call)).toMatchObject({ status: "cancelled", reason: "grant_changed", sourceGrantRevision: before.sourceGrantRevision });
    expect(await waitAllGone(pids, 3000)).toEqual([]);
    await waitFor(() => scratchEntries(fx).length === 0, 3000);
    await waitFor(() => stderr().includes('"code":"reload"'), 10_000);
    const after = await status();
    expect(after.sourceGrantRevision).not.toBe(before.sourceGrantRevision);
    expect(after.serviceInstanceId).toBe(before.serviceInstanceId);

    writeFileSync(join(fx.pcmHome, "config.json"), "{ not json", { mode: 0o600 });
    child.kill("SIGHUP");
    await waitFor(() => stderr().includes('"code":"reload_rejected"'), 10_000);
    expect(stderr()).toContain('"reason":"config-malformed"');
    expect(pidAlive(child.pid!)).toBe(true);
    expect((await status()).sourceGrantRevision).toBe(after.sourceGrantRevision);
    expect(readServerInfo(fx.pcmHome)?.pid).toBe(child.pid);
  });
});
