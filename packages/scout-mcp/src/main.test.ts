// The real stdio adapter (dist/main.js, built by global setup) as a child process, driven by
// the SDK's stdio client, talking to the fixture backend over a temp Unix socket.

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureBackend } from "./client.js";
import { parseAdapterArgs } from "./main.js";
import { STATUS_EXPLANATIONS } from "./tools.js";
import { serveFixture, type FixtureSocket } from "./test-support/fixtureSocket.js";
import { LONG_TEXT, seed } from "./test-support/seed.js";

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));
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

async function serve(socketPath: string, coreInstanceId: string): Promise<FixtureSocket> {
  const s = await serveFixture(await createFixtureBackend(seed({ coreInstanceId, token: TOKEN })), socketPath);
  cleanups.push(() => s.close());
  return s;
}

async function adapter(home: { socketPath: string; tokenFile: string }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MAIN, "--socket", home.socketPath, "--token-file", home.tokenFile],
    stderr: "pipe",
  });
  const errors: unknown[] = [];
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  // Set after connect: Client.connect installs its own handler. Any non-protocol stdout line surfaces here.
  const prior = transport.onerror;
  transport.onerror = (e) => {
    errors.push(e);
    prior?.(e);
  };
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]!.text;
    const meta = res.isError ? undefined : JSON.parse(text.slice(6).split("\n")[0]!);
    return { isError: res.isError === true, text, meta };
  };
  return { client, call, errors, stderr: () => stderr };
}

describe("stdio adapter", () => {
  it("serves the five tools from the core over the agent socket", async () => {
    const home = tempHome();
    const core = await serve(home.socketPath, "core-a");
    const a = await adapter(home);
    expect(a.client.getServerVersion()?.name).toBe("scout");
    expect((await a.client.listTools()).tools).toHaveLength(5);

    const listed = await a.call("list_resources");
    const llms = listed.meta.resources.find((r: { kind: string }) => r.kind === "llms_txt");
    let text = "";
    let cursor: string | undefined;
    do {
      const r = await a.call("read_resource", { resourceId: llms.resourceId, ...(cursor ? { cursor } : {}) });
      expect(r.meta.coreInstanceId).toBe("core-a");
      text += /<website-authored ([0-9a-f]+)>\n([\s\S]*)\n<\/website-authored \1>$/.exec(r.text)![2];
      cursor = r.meta.nextCursor;
    } while (cursor);
    expect(text).toBe(LONG_TEXT);

    // One connection, authenticated by hello before anything else.
    expect(core.requests[0]).toMatchObject({ method: "hello" });
    expect(core.requests.filter((r) => r.method === "hello")).toHaveLength(1);
    expect(a.errors).toEqual([]);
    expect(a.stderr()).toBe("");
  });

  it("reports unavailable without a core, never starts one, and recovers when a core appears", async () => {
    const home = tempHome();
    const a = await adapter(home);
    const missing = await a.call("current_site");
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain(STATUS_EXPLANATIONS.unavailable);
    await serve(home.socketPath, "core-a");
    expect((await a.call("current_site")).meta.coreInstanceId).toBe("core-a");
  });

  it("re-authenticates against a restarted core", async () => {
    const home = tempHome();
    const first = await serve(home.socketPath, "core-a");
    const a = await adapter(home);
    expect((await a.call("current_site")).meta.coreInstanceId).toBe("core-a");
    await first.close();
    rmSync(home.socketPath, { force: true });
    expect((await a.call("current_site")).text).toContain(STATUS_EXPLANATIONS.unavailable);
    const second = await serve(home.socketPath, "core-b");
    expect((await a.call("current_site")).meta.coreInstanceId).toBe("core-b");
    expect(second.requests[0]).toMatchObject({ method: "hello", params: { token: TOKEN } });
  });

  it("refuses a token file others can read, and a wrong token", async () => {
    const home = tempHome();
    await serve(home.socketPath, "core-a");
    chmodSync(home.tokenFile, 0o644);
    const a = await adapter(home);
    expect((await a.call("list_resources")).text).toContain(STATUS_EXPLANATIONS.unavailable);
    chmodSync(home.tokenFile, 0o600);
    writeFileSync(home.tokenFile, "wrong-token");
    expect((await a.call("list_resources")).text).toContain(STATUS_EXPLANATIONS.not_granted);
    expect(a.stderr()).not.toContain("wrong-token");
  });

  it("exits 0 on stdin EOF and writes nothing to stdout", async () => {
    const home = tempHome();
    const child = spawn(process.execPath, [MAIN, "--socket", home.socketPath, "--token-file", home.tokenFile], { stdio: "pipe" });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits 2 on bad arguments", async () => {
    const child = spawn(process.execPath, [MAIN, "--socket", "relative.sock"], { stdio: "pipe" });
    expect(await new Promise((resolve) => child.on("exit", resolve))).toBe(2);
  });
});

describe("parseAdapterArgs", () => {
  it("prefers argv, then env, then SCOUT_HOME defaults", () => {
    expect(parseAdapterArgs(["--socket", "/a.sock", "--token-file", "/t"], { SCOUT_AGENT_SOCKET: "/env.sock" })).toEqual({ socketPath: "/a.sock", tokenFile: "/t" });
    expect(parseAdapterArgs([], { SCOUT_AGENT_SOCKET: "/env.sock", SCOUT_HOME: "/h" })).toEqual({ socketPath: "/env.sock", tokenFile: "/h/run/agent-token" });
    expect(parseAdapterArgs([], { SCOUT_HOME: "/h" })).toEqual({ socketPath: "/h/run/agent.sock", tokenFile: "/h/run/agent-token" });
    expect(parseAdapterArgs(["--socket"], {})).toBeUndefined();
    expect(parseAdapterArgs(["--port", "1"], {})).toBeUndefined();
    expect(parseAdapterArgs(["--socket", "/a", "--socket", "/b"], {})).toBeUndefined();
  });
});
