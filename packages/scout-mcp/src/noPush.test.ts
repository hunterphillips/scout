// Phase 3 verification, B8/B9 "no chat-push path": Scout's MCP server only answers. A client
// session that calls every tool (paging through a multi-chunk read) receives responses and
// nothing else: no notification, no server-to-client request (sampling, elicitation, roots,
// ping), no log message. The server declares no capability that would let it push (logging,
// prompts, resources, completions), and its source has no call that sends one.
//
// The real stdio adapter (dist/main.js) runs as a child process against the fixture core socket,
// as an agent harness would start it. The raw stdout is captured too, so a message the SDK client
// might swallow still shows up.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CreateMessageRequestSchema, ElicitRequestSchema, type JSONRPCMessage, ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AGENT_METHODS } from "@scout/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureBackend } from "./fixture.js";
import { serveFixture } from "./test-support/fixtureSocket.js";
import { seed } from "./test-support/seed.js";
import { TOOL_NAMES } from "./tools.js";

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const SRC = fileURLToPath(new URL(".", import.meta.url));
const TOKEN = "fixture-token";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("no chat-push path (B8/B9)", () => {
  it("a session calling every tool gets responses only: no notification or request from the server, ever", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smcp-push-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tokenFile = join(dir, "agent-token");
    writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    const socketPath = join(dir, "agent.sock");
    const core = await serveFixture(await createFixtureBackend(seed({ token: TOKEN })), socketPath);
    cleanups.push(() => core.close());

    const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN, "--socket", socketPath, "--token-file", tokenFile], stderr: "pipe" });
    const client = new Client({ name: "push-probe", version: "0" }, { capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: true } } });
    const unprompted: unknown[] = [];
    client.fallbackNotificationHandler = async (n) => void unprompted.push(n);
    await client.connect(transport);
    cleanups.push(() => client.close());
    // Every message from the server, below the SDK's dispatch.
    const fromServer: JSONRPCMessage[] = [];
    const onmessage = transport.onmessage!;
    transport.onmessage = (m) => {
      fromServer.push(m);
      onmessage(m);
    };
    // Server-to-client requests the SDK would route to a handler (sampling, elicitation, roots): record any that arrive.
    const refuse = async (req: unknown): Promise<never> => {
      unprompted.push(req);
      throw new Error("refused");
    };
    client.setRequestHandler(CreateMessageRequestSchema, refuse);
    client.setRequestHandler(ElicitRequestSchema, refuse);
    client.setRequestHandler(ListRootsRequestSchema, refuse);

    // The server declares tools only: nothing that would let it push logs, prompts or resource updates.
    const caps = client.getServerCapabilities() ?? {};
    expect(Object.keys(caps).filter((k) => k !== "tools")).toEqual([]);

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return (r.content as { text: string }[])[0]!.text;
    };
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools.sort()).toEqual([...TOOL_NAMES].sort());
    for (const name of ["current_site", "recent_activity", "site_links"]) await call(name);
    const listed = JSON.parse((await call("list_resources")).slice(6).split("\n")[0]!);
    for (const r of listed.resources as { resourceId: string }[]) {
      let cursor: string | undefined;
      do {
        const text = await call("read_resource", { resourceId: r.resourceId, ...(cursor ? { cursor } : {}) });
        cursor = text.startsWith("Scout {") ? JSON.parse(text.slice(6).split("\n")[0]!).nextCursor : undefined;
      } while (cursor);
    }
    // A refused call too (an error path must not push anything either).
    await call("read_resource", { resourceId: "r".repeat(64) });
    // Give a late push a moment to arrive.
    await new Promise((r) => setTimeout(r, 200));

    expect(unprompted).toEqual([]);
    // Every server message answered one of ours: it has an id and a result or error, never a method.
    expect(fromServer.length).toBeGreaterThan(5);
    for (const m of fromServer) {
      expect("method" in m, JSON.stringify(m).slice(0, 200)).toBe(false);
      expect("id" in m).toBe(true);
    }
  });

  it("the agent protocol is hello plus five reads: no method writes to a session, a chat or the browser", () => {
    expect([...AGENT_METHODS]).toEqual(["hello", "current_site", "recent_activity", "site_links", "list_resources", "read_resource"]);
    expect([...TOOL_NAMES]).toEqual(AGENT_METHODS.filter((m) => m !== "hello"));
  });

  it("the server's source sends nothing unprompted: no notification, log, sampling, elicitation or roots call", () => {
    const sources = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("test-support"));
    expect(sources).toContain("tools.ts");
    const PUSH = /\b(sendLoggingMessage|createMessage|elicitInput|listRoots|sendResourceUpdated|sendResourceListChanged|sendToolListChanged|sendPromptListChanged|notification\s*\(|\.request\s*\(|registerPrompt|registerResource|server\.ping)\b/;
    for (const f of sources) {
      const text = readFileSync(join(SRC, f), "utf8");
      expect(PUSH.exec(text)?.[0], f).toBeUndefined();
    }
  });
});
