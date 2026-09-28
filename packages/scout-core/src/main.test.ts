// Drives the built dist/main.js as the native app would: a child process on pipes.
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, FrameDecoder, MAX_FRAME_FROM_CHROME } from "@scout/contracts/frame";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DESTINATIONS, readDestinations } from "./main.js";

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
    sock.write(encodeFrame({ type: "hello", protocol: 1 }, MAX_FRAME_FROM_CHROME));
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

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
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

  it("exits 0 on a shutdown command", async () => {
    const c = await startReady();
    c.child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
    const { code } = await c.exited;
    expect(code).toBe(0);
    expect(existsSync(socketPath())).toBe(false);
  });

  it("relays host frames into panel states and acks page_text back to the host", async () => {
    const c = await startReady();
    expect(c.lines[0]).toEqual({ type: "state", status: "disconnected" });
    c.child.stdin.write("not json\n");

    const sock = connect({ path: socketPath() });
    sock.on("error", () => {});
    await new Promise<void>((r) => sock.once("connect", () => r()));
    const acks: unknown[] = [];
    const dec = new FrameDecoder({ maxBytes: MAX_FRAME_FROM_CHROME });
    sock.on("data", (chunk: Buffer) => {
      for (const r of dec.push(chunk)) if (r.ok) acks.push(r.value);
    });
    const send = (o: object) => sock.write(encodeFrame(o, MAX_FRAME_FROM_CHROME));
    send({ type: "hello", protocol: 1 });
    await until(() => c.lines.length >= 2);
    expect(c.lines[1]).toEqual({ type: "state", status: "idle", visitEpoch: 0 });

    // Either arrival order ends at epoch 2 with one emission: the first is idle to idle.
    c.child.stdin.write(`${JSON.stringify({ type: "frontmost", bundleId: "com.google.Chrome", at: 1 })}\n`);
    send({
      type: "observation",
      observation: { kind: "focus", seq: 1, at: 1, browserFocused: true, windowId: 1, tabId: 7, url: "https://docs.stripe.com/x" },
    });
    await until(() => c.lines.length >= 3);
    expect(c.lines[2]).toEqual({ type: "state", status: "idle", visitEpoch: 2 });

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
    await until(() => acks.length === 1);
    expect(acks).toEqual([{ type: "ack", seq: 3 }]);
    expect(c.lines.slice(3)).toEqual([{ type: "state", status: "idle", visitEpoch: 3 }]);

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
});
