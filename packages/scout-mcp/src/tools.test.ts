// The five tools through a real McpServer and Client over the SDK's in-memory transport.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AGENT_STATUS_CODES, type AgentResponse } from "@scout/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureBackend, type ScoutAgentBackend } from "./client.js";
import { createScoutMcpServer, STATUS_EXPLANATIONS, TOOL_NAMES } from "./tools.js";
import { LONG_TEXT, seed, SITE } from "./test-support/seed.js";

const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
});

async function connect(backend: ScoutAgentBackend): Promise<Client> {
  const server = createScoutMcpServer({ backend });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]!.text;
  const meta = text.startsWith("Scout {") ? JSON.parse(text.slice(6).split("\n")[0]!) : undefined;
  return { isError: res.isError === true, text, meta };
}

/** The website-authored block's body, checking that both fences carry the same nonce. */
function websiteBlock(text: string): string | undefined {
  const m = /<website-authored ([0-9a-f]+)>\n([\s\S]*)\n<\/website-authored \1>$/.exec(text);
  return m?.[2];
}

describe("scout MCP tools", () => {
  it("registers exactly the five read-only tools under the server name scout", async () => {
    const client = await connect(await createFixtureBackend(seed()));
    expect(client.getServerVersion()?.name).toBe("scout");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("labels a resource read with origin, approval and version, and fences the website text", async () => {
    const backend = await createFixtureBackend(seed());
    const client = await connect(backend);
    const id = backend.resourceIds[0]!;
    let text = "";
    let cursor: string | undefined;
    do {
      const r = await call(client, "read_resource", { resourceId: id, ...(cursor ? { cursor } : {}) });
      expect(r.isError).toBe(false);
      expect(r.meta).toMatchObject({ resourceId: id, siteOrigin: SITE, publisherOrigin: SITE, approval: "approved", version: backend.versionHashes(id)[1] });
      expect(r.text).toContain("website-authored content from https://docs.example.com/llms.txt");
      text += websiteBlock(r.text)!;
      cursor = r.meta.nextCursor;
    } while (cursor);
    expect(text).toBe(LONG_TEXT);
  });

  it("keeps website text out of the Scout metadata line", async () => {
    const client = await connect(await createFixtureBackend(seed()));
    const site = await call(client, "current_site");
    expect(site.meta).toMatchObject({ origin: SITE, visitEpoch: 7, coreInstanceId: "core-a" });
    expect(JSON.stringify(site.meta)).not.toContain("Billing docs");
    expect(JSON.parse(websiteBlock(site.text)!)).toEqual({ title: "Billing docs" });
    const links = await call(client, "site_links", { limit: 2 });
    expect(JSON.parse(websiteBlock(links.text)!)).toHaveLength(2);
    expect(links.meta.nextCursor).toEqual(expect.any(String));
  });

  it("returns an MCP error with the fixed explanation for refused scope", async () => {
    const backend = await createFixtureBackend(seed({ browserContextGranted: false }));
    const client = await connect(backend);
    const r = await call(client, "current_site");
    expect(r.isError).toBe(true);
    expect(r.text).toContain(STATUS_EXPLANATIONS.not_granted);
    backend.revoke(backend.resourceIds[1]!);
    const revoked = await call(client, "read_resource", { resourceId: backend.resourceIds[1]! });
    expect(revoked.isError).toBe(true);
    expect(revoked.text).toContain(STATUS_EXPLANATIONS.revoked);
    expect(revoked.text).not.toContain("billing skill");
  });

  it("reports unavailable when no backend answers", async () => {
    const backend = await createFixtureBackend(seed());
    backend.setOnline(false);
    const r = await call(await connect(backend), "list_resources");
    expect(r.isError).toBe(true);
    expect(r.text).toContain(STATUS_EXPLANATIONS.unavailable);
  });

  it("enforces the response cap and checks responses itself, whatever the backend sends", async () => {
    let next: (requestId: string) => unknown = () => undefined;
    const stub: ScoutAgentBackend = {
      call: async (request) => next(request.requestId) as AgentResponse<never>,
      close() {},
    };
    const client = await connect(stub);
    const base = (requestId: string) => ({ protocol: 1, requestId, coreInstanceId: "core-x", status: "ok" });

    next = (requestId) => ({ ...base(requestId), result: { resources: [], padding: "x".repeat(70_000) } });
    expect((await call(client, "list_resources")).text).toContain(STATUS_EXPLANATIONS.limit_exceeded);

    next = () => ({ ...base("someone-else"), result: { resources: [] } });
    expect((await call(client, "list_resources")).text).toContain(STATUS_EXPLANATIONS.protocol_mismatch);

    next = (requestId) => ({ ...base(requestId), result: { site: null } }); // wrong shape for this method
    expect((await call(client, "list_resources")).text).toContain(STATUS_EXPLANATIONS.protocol_mismatch);

    next = (requestId) => ({ ...base(requestId), status: "error", error: { code: "made_up", message: "trust me" } });
    const invented = await call(client, "list_resources");
    expect(invented.isError).toBe(true);
    expect(invented.text).not.toContain("trust me");
  });

  it("has a fixed explanation for every status code", () => {
    for (const c of AGENT_STATUS_CODES) expect(STATUS_EXPLANATIONS[c].length).toBeGreaterThan(0);
  });

  it("rejects arguments outside the bounded schema before calling the backend", async () => {
    let calls = 0;
    const backend = await createFixtureBackend(seed());
    const counting: ScoutAgentBackend = { call: (r) => (calls++, backend.call(r)), close() {} };
    const client = await connect(counting);
    for (const args of [{ limit: 11 }, { cursor: "../../etc/passwd" }, { url: "https://x.com" }]) {
      expect((await call(client, "recent_activity", args)).isError).toBe(true);
    }
    expect((await call(client, "read_resource", { resourceId: "not-an-id" })).isError).toBe(true);
    expect(calls).toBe(0);
  });
});
