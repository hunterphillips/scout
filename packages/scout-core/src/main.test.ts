// Drives the built dist/main.js as the native app would: a child process on pipes.
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, Server } from "node:net";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, FrameDecoder, MAX_FRAME_FROM_CHROME } from "@scout/contracts/frame";
import { createSocketBackend } from "@scout/scout-mcp/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DESTINATIONS, readConfig, readDestinations } from "./config.js";
import type { Diagnostics } from "./diagnostics.js";
import { runStdio } from "./main.js";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const mainJs = join(pkgDir, "dist", "main.js");

beforeAll(() => {
  // Build so the test always exercises the current source.
  const tsPkg = createRequire(import.meta.url).resolve("typescript/package.json");
  const tsc = join(dirname(tsPkg), "bin", "tsc");
  execFileSync(process.execPath, [tsc, "-p", join(pkgDir, "tsconfig.build.json")], { stdio: "inherit" });
}, 60_000);

interface Core {
  child: ChildProcessWithoutNullStreams;
  lines: unknown[];
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
}

function spawnCore(home: string): Core {
  const child = spawn(process.execPath, [mainJs, "--stdio"], { env: { ...process.env, SCOUT_HOME: home } });
  const lines: unknown[] = [];
  let out = "";
  let err = "";
  child.stdout.on("data", (c: Buffer) => {
    out += c.toString("utf8");
    let i: number;
    while ((i = out.indexOf("\n")) !== -1) {
      lines.push(JSON.parse(out.slice(0, i)));
      out = out.slice(i + 1);
    }
  });
  child.stderr.on("data", (c: Buffer) => void (err += c.toString("utf8")));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() })),
  );
  return { child, lines, stderr: () => err, exited };
}

const until = async (cond: () => boolean, ms = 5_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("main --stdio", () => {
  let home: string;
  let core: Core | null = null;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "scm-"));
  });
  afterEach(async () => {
    if (core !== null && core.child.exitCode === null && core.child.signalCode === null) {
      core.child.kill("SIGKILL");
      await core.exited;
    }
    core = null;
    rmSync(home, { recursive: true, force: true });
  });

  const startReady = async (): Promise<Core> => {
    core = spawnCore(home);
    const c = core;
    await until(() => c.stderr().includes("listening on"));
    return c;
  };
  const socketPath = () => join(home, "run", "core.sock");

  it("exits 0 within 1 s of stdin closing and removes its socket", async () => {
    const c = await startReady();
    expect(existsSync(socketPath())).toBe(true);
    const closedAt = Date.now();
    c.child.stdin.end();
    const { code, at } = await c.exited;
    expect(code).toBe(0);
    expect(at - closedAt).toBeLessThan(1_000);
    expect(existsSync(socketPath())).toBe(false);
  });

  it("exits 0 within 1 s of stdin closing even with a native host connected", async () => {
    const c = await startReady();
    const sock = connect({ path: socketPath() });
    sock.on("error", () => {});
    await new Promise<void>((r) => sock.once("connect", () => r()));
    // The core answers hello with a capture_policy; read it so the socket can see its close.
    sock.resume();
    sock.write(encodeFrame({ type: "hello", protocol: 2 }, MAX_FRAME_FROM_CHROME));
    await until(() => c.lines.some((l) => (l as { status?: string }).status === "idle"));
    const hostClosed = new Promise<void>((r) => sock.once("close", () => r()));
    const closedAt = Date.now();
    c.child.stdin.end();
    const { code, at } = await c.exited;
    expect(code).toBe(0);
    expect(at - closedAt).toBeLessThan(1_000);
    await hostClosed;
    expect(existsSync(socketPath())).toBe(false);
  });

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    it(`exits 0 on ${sig} and removes its socket`, async () => {
      const c = await startReady();
      const sentAt = Date.now();
      c.child.kill(sig);
      const { code, at } = await c.exited;
      expect(code).toBe(0);
      expect(at - sentAt).toBeLessThan(1_000);
      expect(existsSync(socketPath())).toBe(false);
    });
  }

  it("publishes core.sock, agent.sock and a 0600 token; shutdown removes the agent files and releases the store", async () => {
    const c = await startReady();
    const run = join(home, "run");
    expect(lstatSync(join(run, "agent.sock")).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(run, "agent-token")).mode & 0o777).toBe(0o600);
    expect(existsSync(socketPath())).toBe(true);
    expect(existsSync(join(home, "capabilities", "store.lock"))).toBe(true);
    // The token works against the running core's agent socket.
    const backend = createSocketBackend({ socketPath: join(run, "agent.sock"), tokenFile: join(run, "agent-token") });
    const res = await backend.call({ protocol: 1, requestId: "r1", method: "list_resources", params: {} });
    backend.close();
    expect(res).toMatchObject({ status: "ok", result: { resources: [] } });

    c.child.stdin.end();
    expect((await c.exited).code).toBe(0);
    expect(existsSync(join(run, "agent.sock"))).toBe(false);
    expect(existsSync(join(run, "agent-token"))).toBe(false);
    expect(existsSync(join(home, "capabilities", "store.lock"))).toBe(false);
  });

  it("exits 0 on a shutdown command", async () => {
    const c = await startReady();
    c.child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
    const { code } = await c.exited;
    expect(code).toBe(0);
    expect(existsSync(socketPath())).toBe(false);
  });

  it("relays host frames into panel states, answers hello with a policy, and acks page_text back to the host", async () => {
    const c = await startReady();
    expect(c.lines[0]).toEqual({ type: "state", status: "disconnected" });
    c.child.stdin.write("not json\n");

    const sock = connect({ path: socketPath() });
    sock.on("error", () => {});
    await new Promise<void>((r) => sock.once("connect", () => r()));
    const received: Array<{ type: string }> = [];
    const dec = new FrameDecoder({ maxBytes: MAX_FRAME_FROM_CHROME });
    sock.on("data", (chunk: Buffer) => {
      for (const r of dec.push(chunk)) if (r.ok) received.push(r.value as { type: string });
    });
    const acks = () => received.filter((f) => f.type === "ack");
    const send = (o: object) => sock.write(encodeFrame(o, MAX_FRAME_FROM_CHROME));
    send({ type: "hello", protocol: 2 });
    await until(() => c.lines.length >= 2 && received.length >= 1);
    expect(c.lines[1]).toEqual({ type: "state", status: "idle", visitEpoch: 0 });
    expect(received).toEqual([{ type: "capture_policy", revision: 0, paused: false, captureEnabled: false }]);
    send({
      type: "observation",
      observation: { kind: "permissions", revision: 1, at: 1, granted: ["https://docs.stripe.com/*", "https://github.com/*"], githubCapture: true },
    });
    await until(() => received.length >= 2);
    expect(received[1]).toEqual({ type: "capture_policy", revision: 1, paused: false, captureEnabled: true });

    // Either arrival order ends at epoch 2 with one emission: the first is idle to idle.
    c.child.stdin.write(`${JSON.stringify({ type: "frontmost", bundleId: "com.google.Chrome", at: 1 })}\n`);
    send({
      type: "observation",
      observation: { kind: "focus", seq: 1, at: 1, browserFocused: true, windowId: 1, tabId: 7, url: "https://docs.stripe.com/x" },
    });
    await until(() => c.lines.length >= 3);
    expect(c.lines[2]).toEqual({ type: "state", status: "idle", visitEpoch: 2, detail: "docs.stripe.com" });

    send({
      type: "observation",
      observation: { kind: "focus", seq: 2, at: 2, browserFocused: true, windowId: 1, tabId: 8, url: "https://github.com/o/r/issues/1" },
    });
    send({
      type: "observation",
      observation: {
        kind: "page_text",
        seq: 3,
        at: 3,
        tabId: 8,
        documentId: "d",
        url: "https://github.com/o/r/issues/1",
        source: "github_issue",
        title: "t",
        text: "body",
        truncated: false,
      },
    });
    await until(() => acks().length === 1);
    expect(acks()).toEqual([{ type: "ack", seq: 3 }]);
    // GitHub is granted, so the issue tab is a visit too.
    expect(c.lines.slice(3)).toEqual([{ type: "state", status: "idle", visitEpoch: 3, detail: "github.com" }]);

    sock.destroy();
    await until(() => (c.lines.at(-1) as { status?: string }).status === "disconnected");
    c.child.stdin.end();
    expect((await c.exited).code).toBe(0);

    const log = readFileSync(join(home, "logs", "diagnostics.jsonl"), "utf8");
    expect(log).toContain('"event":"native_command_invalid"');
    expect(log).toContain('"event":"activity_forwarded"');
    expect(log).not.toContain("github.com");
    expect(log).not.toContain("body");
  });

  it("refuses to start with a group-accessible run dir", async () => {
    mkdirSync(join(home, "run"));
    chmodSync(join(home, "run"), 0o750);
    core = spawnCore(home);
    const { code } = await core.exited;
    expect(code).toBe(1);
    expect(core.stderr()).toContain("runtime-dir-not-private");
  });

  it("refuses to start with invalid configured destinations", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ destinations: ["https://docs.stripe.com"] }));
    core = spawnCore(home);
    const { code } = await core.exited;
    expect(code).toBe(1);
    expect(core.stderr()).toContain("config-invalid-destinations");
  });

  it("exits 2 without --stdio", async () => {
    const child = spawn(process.execPath, [mainJs], { env: { ...process.env, SCOUT_HOME: home } });
    const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
    expect(code).toBe(2);
  });
});

describe("runStdio (in process)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sci-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const harness = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.resume();
    const logs: string[] = [];
    const exits: Array<{ code: number; socketLeft: boolean }> = [];
    const events: string[] = [];
    const diagnostics: Diagnostics = { failures: 0, event: (name) => void events.push(name) };
    const socketPath = join(home, "run", "core.sock");
    const run = () =>
      runStdio({
        stdin,
        stdout,
        env: { SCOUT_HOME: home },
        log: (l) => void logs.push(l),
        exit: (code) => void exits.push({ code, socketLeft: existsSync(socketPath) }),
        diagnostics,
      });
    return { stdin, stdout, logs, exits, socketPath, run, events };
  };
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it("a socket start failure exits once with 1 and no stdin-closed shutdown", async () => {
    mkdirSync(join(home, "run"));
    chmodSync(join(home, "run"), 0o750);
    const h = harness();
    await h.run();
    await settle();
    expect(h.exits.map((e) => e.code)).toEqual([1]);
    expect(h.logs.join("\n")).toContain("runtime-dir-not-private");
    expect(h.logs.some((l) => l.includes("shutdown ("))).toBe(false);
  });

  it("exports skill wrappers only when installed.json records a skills root", async () => {
    const plain = harness();
    await plain.run();
    plain.stdin.end();
    await until(() => plain.exits.length > 0);
    expect(plain.events).not.toContain("capability_export");

    // The skills root must be a real path (tmpdir is behind a symlink on macOS).
    mkdirSync(join(home, "skills"));
    const skills = realpathSync(join(home, "skills"));
    writeFileSync(join(home, "installed.json"), JSON.stringify({ skillsRoot: skills }));
    const wired = harness();
    await wired.run();
    wired.stdin.end();
    await until(() => wired.exits.length > 0);
    expect(wired.events).toContain("capability_export");
    expect(wired.exits.map((e) => e.code)).toEqual([0]);
  });

  it("a malformed installed.json is reported and treated as absent", async () => {
    writeFileSync(join(home, "installed.json"), JSON.stringify({ skillsRoot: 42 }));
    const h = harness();
    await h.run();
    expect(existsSync(join(home, "run", "agent.sock"))).toBe(true);
    h.stdin.end();
    await until(() => h.exits.length > 0);
    expect(h.events).toContain("installed_record_invalid");
    expect(h.events).not.toContain("capability_export");
    expect(h.exits.map((e) => e.code)).toEqual([0]);
  });

  it("a stdout error (EPIPE) shuts down with 0 after removing the socket", async () => {
    const h = harness();
    await h.run();
    expect(existsSync(h.socketPath)).toBe(true);
    h.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    await until(() => h.exits.length > 0);
    await settle();
    expect(h.exits).toEqual([{ code: 0, socketLeft: false }]);
    expect(h.logs).toContain("scout-core: shutdown (stdout-error)");
  });

  it("stdin closing while the socket is still binding closes the new listener before exiting", async () => {
    const h = harness();
    const listen = Server.prototype.listen;
    Server.prototype.listen = function (this: Server, ...args: unknown[]) {
      h.stdin.end();
      setTimeout(() => (listen as (...a: unknown[]) => Server).apply(this, args), 50);
      return this;
    } as typeof listen;
    try {
      await h.run();
    } finally {
      Server.prototype.listen = listen;
    }
    await settle();
    expect(h.exits).toEqual([{ code: 0, socketLeft: false }]);
    expect(h.logs).toContain("scout-core: shutdown (stdin-closed)");
    expect(h.logs.some((l) => l.includes("listening on"))).toBe(false);
    expect(existsSync(h.socketPath)).toBe(false);
  });
});

describe("readDestinations", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "scd-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("defaults when config.json or its destinations field is missing", () => {
    expect(readDestinations(home)).toBe(DEFAULT_DESTINATIONS);
    writeFileSync(join(home, "config.json"), JSON.stringify({ nodePath: "/usr/bin/node" }));
    expect(readDestinations(home)).toBe(DEFAULT_DESTINATIONS);
  });

  it("reads configured destinations", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ destinations: ["docs.stripe.com"] }));
    expect(readDestinations(home)).toEqual(["docs.stripe.com"]);
  });

  it("throws on malformed JSON or a non-string-array field", () => {
    writeFileSync(join(home, "config.json"), "{");
    expect(() => readDestinations(home)).toThrow("config-unreadable");
    writeFileSync(join(home, "config.json"), JSON.stringify({ destinations: "docs.stripe.com" }));
    expect(() => readDestinations(home)).toThrow("config-invalid-destinations");
  });

  it.each(["https://docs.stripe.com", "Docs.Stripe.com", "docs.stripe.com/payments", "", "bad host"])(
    "throws on the invalid destination host %j",
    (d) => {
      writeFileSync(join(home, "config.json"), JSON.stringify({ destinations: ["docs.stripe.com", d] }));
      expect(() => readDestinations(home)).toThrow("config-invalid-destinations");
    },
  );
});

describe("readConfig chromeBundleId", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "scd-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("defaults to stable Chrome when config.json or the field is missing", () => {
    expect(readConfig(home).chromeBundleId).toBe("com.google.Chrome");
    writeFileSync(join(home, "config.json"), JSON.stringify({ destinations: ["docs.stripe.com"] }));
    expect(readConfig(home)).toEqual({ destinations: ["docs.stripe.com"], chromeBundleId: "com.google.Chrome", agentBrowserContext: false });
  });

  it("reads a configured bundle id", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ chromeBundleId: "com.google.chrome.for.testing" }));
    expect(readConfig(home)).toEqual({ destinations: DEFAULT_DESTINATIONS, chromeBundleId: "com.google.chrome.for.testing", agentBrowserContext: false });
  });

  it("reads the agent browser-context grant and refuses a non-boolean one", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ agentBrowserContext: true }));
    expect(readConfig(home).agentBrowserContext).toBe(true);
    writeFileSync(join(home, "config.json"), JSON.stringify({ agentBrowserContext: "yes" }));
    expect(() => readConfig(home)).toThrow("config-invalid-agent-browser-context");
  });

  it.each([[""], ["com.google.Chrome;rm"], ["com google"], [42], [null], [["com.google.Chrome"]]])(
    "throws on an invalid bundle id %j",
    (value) => {
      writeFileSync(join(home, "config.json"), JSON.stringify({ chromeBundleId: value }));
      expect(() => readConfig(home)).toThrow("config-invalid-chrome-bundle-id");
    },
  );
});
