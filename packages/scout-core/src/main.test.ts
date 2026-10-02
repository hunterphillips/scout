// Drives the built dist/main.js as the native app would: a child process on pipes.
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, Server } from "node:net";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { encodeFrame, FrameDecoder, MAX_FRAME_FROM_CHROME } from "@scout/contracts/frame";
import { AGENT_PROTOCOL_VERSION, NATIVE_COMMAND_MAX_BYTES } from "@scout/contracts";
import { createSocketBackend } from "@scout/scout-mcp/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SnapshotRegistry } from "./activity/snapshots.js";
import { type CapabilityStore, createCapabilityStore } from "./capabilities/store.js";
import { DEFAULT_DESTINATIONS, readConfig, readDestinations } from "./config.js";
import type { Diagnostics } from "./diagnostics.js";
import { DWELL_MS } from "./dwell.js";
import { dwellMsFromEnv, runStdio, SHUTDOWN_DEADLINE_MS } from "./main.js";

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

function spawnCore(home: string, env: NodeJS.ProcessEnv = process.env): Core {
  // A 10-minute dwell: the real visits these tests form never settle into real fetches.
  const child = spawn(process.execPath, [mainJs, "--stdio"], { env: { ...env, SCOUT_HOME: home, SCOUT_DWELL_MS: "600000" } });
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

describe("dwellMsFromEnv", () => {
  it("honors a positive integer SCOUT_DWELL_MS", () => {
    expect(dwellMsFromEnv({ SCOUT_DWELL_MS: "600000" })).toBe(600_000);
    expect(dwellMsFromEnv({ SCOUT_DWELL_MS: "1" })).toBe(1);
  });

  it.each([undefined, "", "0", "-5", "1.5", "1e3", " 50", "abc", "2147483648", "99999999999999999999"])(
    "falls back to DWELL_MS for %j",
    (raw) => {
      expect(dwellMsFromEnv(raw === undefined ? {} : { SCOUT_DWELL_MS: raw })).toBe(DWELL_MS);
    },
  );
});

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

  it("sends Scout's window the browser-context grant, the capability view, and the audit on start", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ agentBrowserContext: true }));
    const c = await startReady();
    await until(() => ["grant", "capabilities", "audit"].every((t) => c.lines.some((l) => (l as { type?: string }).type === t)));
    expect(c.lines.find((l) => (l as { type?: string }).type === "grant")).toEqual({ type: "grant", agentBrowserContext: true });
    expect(c.lines.find((l) => (l as { type?: string }).type === "capabilities")).toMatchObject({ offers: [], library: [], truncated: false });
    c.child.stdin.end();
    expect((await c.exited).code).toBe(0);
  });

  it("answers open_link from the result registry: with no result held, its identity is stale", async () => {
    const c = await startReady();
    await until(() => c.lines.some((l) => (l as { type?: string }).type === "capabilities"));
    const caps = c.lines.find((l) => (l as { type?: string }).type === "capabilities") as { coreInstanceId: string };
    const cmd = { type: "open_link", commandId: "o1", coreInstanceId: caps.coreInstanceId, visitEpoch: 0, jobId: "job-1", candidateId: "c1" };
    c.child.stdin.write(`${JSON.stringify(cmd)}\n`);
    await until(() => c.lines.some((l) => (l as { type?: string }).type === "ack"));
    expect(c.lines.find((l) => (l as { type?: string }).type === "ack")).toEqual({ type: "ack", commandId: "o1", ok: false, code: "stale_revision" });
    c.child.stdin.end();
    expect((await c.exited).code).toBe(0);
  });

  it("streams a stored version's preview chunk by chunk through the real core", async () => {
    // A pending llms.txt (40 000 bytes of multi-byte text) in a store seeded before start.
    const text = "aé😀".repeat(5000);
    const origin = "https://s.example";
    const sourceUrl = `${origin}/llms.txt`;
    const sha = createHash("sha256").update(text, "utf8").digest("hex");
    // Seen just now, so the core's startup collection keeps the pending version.
    const seed = await createCapabilityStore({ scoutHome: home, clock: { now: () => Date.now() } });
    const report = await seed.ingest(
      {
        origin,
        checkedAt: 1,
        robots: "not_fetched",
        items: [
          {
            kind: "llms_txt",
            sourceUrl,
            status: "found",
            source: "network",
            resource: { kind: "llms_txt", siteOrigin: origin, publisherOrigin: origin, sourceUrl, finalUrl: sourceUrl, text, sha256: sha, byteLength: Buffer.byteLength(text), fetchedAt: 1 },
          },
        ],
        externalReferences: [],
        skillsOverCap: 0,
        acceptedBytes: 0,
        stats: { requests: 0, refused: 0, ms: 0 },
      },
      { chromePermitted: false },
    );
    await seed.close();
    const { resourceId, version } = report.results[0]!;

    const c = await startReady();
    const chunks: Array<{ seq: number; text: string; sha256: string; nextCursor?: string }> = [];
    let cursor: string | undefined;
    for (let i = 0; ; i++) {
      const commandId = `p${i}`;
      c.child.stdin.write(`${JSON.stringify({ type: "preview", commandId, resourceId, version, ...(cursor ? { cursor } : {}) })}\n`);
      await until(() => c.lines.some((l) => (l as { commandId?: string }).commandId === commandId));
      const chunk = c.lines.find((l) => (l as { commandId?: string }).commandId === commandId) as (typeof chunks)[number] & { type: string };
      expect(chunk.type).toBe("preview");
      chunks.push(chunk);
      cursor = chunk.nextCursor;
      if (cursor === undefined) break;
    }
    expect(chunks.map((ch) => ch.seq)).toEqual([0, 1, 2]);
    expect(chunks.every((ch) => ch.sha256 === sha)).toBe(true);
    expect(chunks.map((ch) => ch.text).join("")).toBe(text);
    expect(chunks.at(-1)!.nextCursor).toBeUndefined();

    c.child.stdin.end();
    expect((await c.exited).code).toBe(0);
    const log = readFileSync(join(home, "logs", "diagnostics.jsonl"), "utf8");
    expect(log).toContain('"event":"preview_chunk"');
    expect(log).not.toContain("s.example/llms.txt");
    expect(log).not.toContain("😀");
  });

  it("refuses a stdin line whose bytes with the newline reach the command size limit: counted, never answered", async () => {
    // A valid command padded with JSON whitespace to exactly `bytes` before the newline.
    const padded = (commandId: string, bytes: number): string => {
      const head = `{"type":"refresh_capabilities","commandId":"${commandId}"`;
      return `${head}${" ".repeat(bytes - head.length - 1)}}`;
    };
    const c = await startReady();
    const atLimit = padded("atlimit", NATIVE_COMMAND_MAX_BYTES - 1); // + newline = NATIVE_COMMAND_MAX_BYTES
    const under = padded("under", NATIVE_COMMAND_MAX_BYTES - 2); // + newline = one byte under
    expect(Buffer.byteLength(atLimit)).toBe(NATIVE_COMMAND_MAX_BYTES - 1);
    c.child.stdin.write(`${atLimit}\n`);
    c.child.stdin.write(`${under}\n`);
    await until(() => c.lines.some((l) => (l as { commandId?: string }).commandId === "under"));
    expect(c.lines.some((l) => (l as { commandId?: string }).commandId === "atlimit")).toBe(false);
    c.child.stdin.end();
    expect((await c.exited).code).toBe(0);
    const log = readFileSync(join(home, "logs", "diagnostics.jsonl"), "utf8");
    const invalid = log.trim().split("\n").map((l) => JSON.parse(l) as { event: string; count?: number }).filter((e) => e.event === "native_command_invalid");
    expect(invalid.map((e) => e.count)).toEqual([1]);
  });

  it("relays host frames into panel states, answers hello with a policy, and acks page_text back to the host", async () => {
    const c = await startReady();
    // Scout's window frames (grant, capabilities, audit) interleave; this test follows the states.
    const states = () => c.lines.filter((l) => (l as { type?: string }).type === "state");
    expect(states()[0]).toEqual({ type: "state", status: "disconnected" });
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
    await until(() => states().length >= 2 && received.length >= 1);
    expect(states()[1]).toEqual({ type: "state", status: "idle", visitEpoch: 0, permitted: false });
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
    await until(() => states().length >= 3);
    expect(states()[2]).toEqual({ type: "state", status: "idle", visitEpoch: 2, detail: "docs.stripe.com", permitted: true });

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
        policyRevision: 1,
      },
    });
    await until(() => acks().length === 1);
    expect(acks()).toEqual([{ type: "ack", seq: 3 }]);
    // GitHub is granted, so the issue tab is a visit too.
    expect(states().slice(3)).toEqual([{ type: "state", status: "idle", visitEpoch: 3, detail: "github.com", permitted: true }]);

    sock.destroy();
    await until(() => (states().at(-1) as { status?: string }).status === "disconnected");
    c.child.stdin.end();
    expect((await c.exited).code).toBe(0);

    const log = readFileSync(join(home, "logs", "diagnostics.jsonl"), "utf8");
    expect(log).toContain('"event":"native_command_invalid"');
    expect(log).toContain('"event":"activity_accepted"');
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

  describe("with an agent profile whose CLI hangs (the billing preflight's `claude` never answers)", () => {
    /** A temp user home, a profile, and a `claude` that records its PID and sleeps: the preflight blocks on it. */
    const hangingAgent = (destinations: string[]) => {
      const userHome = join(home, "u");
      mkdirSync(join(userHome, ".claude"), { recursive: true });
      mkdirSync(join(home, "bin"));
      const pids = join(home, "claude-pids");
      const claudePath = join(home, "bin", "claude");
      writeFileSync(claudePath, `#!/bin/sh\necho $$ >> '${pids}'\nexec sleep 30\n`);
      chmodSync(claudePath, 0o755);
      writeFileSync(join(home, "config.json"), JSON.stringify({ destinations }));
      writeFileSync(join(home, "agent-profile.json"), JSON.stringify({ schemaVersion: 1, adapter: "claude-code", claudePath, model: "claude-sonnet-5-5" }), { mode: 0o600 });
      // Only what the launch profile and the preflight read: no gateway, a throwaway HOME.
      const env = { PATH: "/usr/bin:/bin", HOME: userHome, USER: "someone", LOGNAME: "someone", LANG: "en_US.UTF-8", TMPDIR: tmpdir() };
      const started = (): number[] => (existsSync(pids) ? readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number) : []);
      return { env, started };
    };
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    };

    it("shutdown with the preflight in flight kills it first and exits well within the deadline", async () => {
      const agent = hangingAgent(["docs.example.com"]);
      core = spawnCore(home, agent.env);
      const c = core;
      await until(() => c.stderr().includes("listening on"));
      // The eager preflight (an enabled host exists) is blocked on the hanging CLI.
      await until(() => agent.started().length > 0);
      const closedAt = Date.now();
      c.child.stdin.end();
      const { code, at } = await c.exited;
      expect(code).toBe(0);
      // SHUTDOWN_DEADLINE_MS is 2 s; a preflight that held the exit would take the CLI's 20 s.
      expect(at - closedAt).toBeLessThan(1_000);
      await until(() => !agent.started().some(alive), 2_000);
    }, 20_000);

    it("with no enabled host, no `claude` runs at start", async () => {
      const agent = hangingAgent([]);
      core = spawnCore(home, agent.env);
      const c = core;
      await until(() => c.stderr().includes("listening on"));
      await new Promise((r) => setTimeout(r, 1_000));
      expect(agent.started()).toEqual([]);
      c.child.stdin.end();
      expect((await c.exited).code).toBe(0);
      const log = existsSync(join(home, "logs", "diagnostics.jsonl")) ? readFileSync(join(home, "logs", "diagnostics.jsonl"), "utf8") : "";
      expect(log).not.toContain('"event":"agent_preflight"');
      expect(log).not.toContain('"event":"agent_profile_unavailable"');
    }, 20_000);
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
    const fields: Array<{ name: string; fields: Record<string, unknown> }> = [];
    const diagnostics: Diagnostics = {
      failures: 0,
      event: (name, f = {}) => {
        events.push(name);
        fields.push({ name, fields: f });
      },
    };
    const socketPath = join(home, "run", "core.sock");
    let agent: { store: CapabilityStore; snapshots: SnapshotRegistry } | null = null;
    let jobs: Parameters<NonNullable<Parameters<typeof runStdio>[0]["onJobsStarted"]>>[0] | null = null;
    const run = () =>
      runStdio({
        stdin,
        stdout,
        env: { SCOUT_HOME: home },
        log: (l) => void logs.push(l),
        exit: (code) => void exits.push({ code, socketLeft: existsSync(socketPath) }),
        diagnostics,
        onAgentStarted: (a) => void (agent = a),
        onJobsStarted: (j) => void (jobs = j),
      });
    return {
      stdin,
      stdout,
      logs,
      exits,
      socketPath,
      run,
      events,
      fields,
      get agent() {
        return agent!;
      },
      get jobs() {
        return jobs!;
      },
    };
  };
  const settle = () => new Promise((r) => setTimeout(r, 50));

  /** A job snapshot over the store's approvals, and a production adapter client holding its token. */
  const startJob = (h: ReturnType<typeof harness>, jobId = "job-1") => {
    const { token } = h.agent.snapshots.take({
      jobId, origin: "https://docs.example.com", visitEpoch: 1, activity: [], candidates: [], catalogHash: "cat",
      permissionsRevision: 1, profileFingerprint: "fp", deadline: Date.now() + 60_000,
    });
    const tokenFile = join(home, `${jobId}-token`);
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    const backend = createSocketBackend({ socketPath: join(home, "run", "agent.sock"), tokenFile, timeoutMs: 2_000 });
    let n = 0;
    const list = () => backend.call({ protocol: AGENT_PROTOCOL_VERSION, requestId: `j${++n}`, method: "list_resources", params: {} } as never);
    return { backend, list };
  };

  /** Ingest and approve `text` at `path` (a new version of the resource there), fetched at `fetchedAt`. */
  async function approvedVersion(store: CapabilityStore, path: string, text: string, fetchedAt: number) {
    const origin = "https://docs.example.com";
    const sourceUrl = `${origin}${path}`;
    const kind = path === "/llms.txt" ? ("llms_txt" as const) : ("agents_md" as const);
    const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
    const report = await store.ingest(
      {
        origin, checkedAt: fetchedAt, robots: "not_fetched",
        items: [{ kind, sourceUrl, status: "found", source: "network", resource: { kind, siteOrigin: origin, publisherOrigin: origin, sourceUrl, finalUrl: sourceUrl, text, sha256, byteLength: Buffer.byteLength(text), fetchedAt } }],
        externalReferences: [], skillsOverCap: 0, acceptedBytes: 0, stats: { requests: 0, refused: 0, ms: 0 },
      },
      { chromePermitted: false },
    );
    const { resourceId: id, version } = report.results[0]!;
    await store.approve({ resourceId: id, version, expectedRevision: store.getResource(id)!.revision });
    return { id, version };
  }

  it("pause refuses a connected job's next call and blocks new snapshots", async () => {
    const h = harness();
    await h.run();
    const job = startJob(h);
    try {
      expect(await job.list()).toMatchObject({ status: "ok" });
      h.stdin.write(`${JSON.stringify({ type: "pause" })}\n`);
      await until(() => h.events.includes("paused"));
      expect(await job.list()).toMatchObject({ status: "error", error: { code: "not_granted" } });
      expect(h.agent.snapshots.size).toBe(0);
      expect(() => startJob(h, "job-2")).toThrow("paused");
    } finally {
      job.backend.close();
    }
    h.stdin.end();
    await until(() => h.exits.length > 0);
  });

  it("shutdown releases every snapshot before agent.sock closes its connections", async () => {
    const h = harness();
    await h.run();
    const job = startJob(h);
    try {
      expect(await job.list()).toMatchObject({ status: "ok" });
      h.stdin.end();
      await until(() => h.exits.length > 0);
    } finally {
      job.backend.close();
    }
    const revoked = h.fields.findIndex((e) => e.name === "job_token_revoked" && e.fields.reason === "shutdown");
    const closed = h.events.indexOf("agent_close");
    expect(revoked).toBeGreaterThanOrEqual(0);
    expect(closed).toBeGreaterThan(revoked);
    expect(h.exits.map((e) => e.code)).toEqual([0]);
  });

  it("a store revocation reaches a connected job through onRevoked and resourceRevoked: refused, and its pins released", async () => {
    const h = harness();
    await h.run();
    const { store, snapshots } = h.agent;
    const kept = await approvedVersion(store, "/llms.txt", "guide v1\n", 1);
    const revoked = await approvedVersion(store, "/AGENTS.md", "agents\n", 1);
    const job = startJob(h);
    try {
      // Newer approvals than collection retains: only the snapshot's pin keeps the first version.
      for (let i = 2; i <= 8; i++) await approvedVersion(store, "/llms.txt", `guide v${i}\n`, i);
      expect(await job.list()).toMatchObject({ status: "ok" });
      await store.collectGarbage();
      expect(store.resolveRead(kept.id, kept.version).ok).toBe(true);

      await store.revoke(revoked.id);
      expect(await job.list()).toMatchObject({ status: "error", error: { code: "not_granted" } });
      expect(snapshots.size).toBe(0);
      await store.collectGarbage();
      expect(store.resolveRead(kept.id, kept.version)).toEqual({ ok: false, code: "not_found" });
    } finally {
      job.backend.close();
    }
    h.stdin.end();
    await until(() => h.exits.length > 0);
  });

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

  it("without an agent profile jobs are wired but have no agent; a browser-context grant toggle reaches the scheduler", async () => {
    const h = harness();
    await h.run();
    expect(h.fields.find((f) => f.name === "agent_profile_unavailable")?.fields).toEqual({ code: "profile: missing" });
    expect(h.jobs.adapter).toBeNull();
    const seen: boolean[] = [];
    h.jobs.scheduler.onGrantChanged = (enabled) => void seen.push(enabled);
    h.stdin.write(`${JSON.stringify({ type: "set_agent_browser_context", commandId: "g1", enabled: true, expectedEnabled: false })}\n`);
    await until(() => seen.length > 0);
    h.stdin.write(`${JSON.stringify({ type: "set_agent_browser_context", commandId: "g2", enabled: false, expectedEnabled: true })}\n`);
    await until(() => seen.length > 1);
    expect(seen).toEqual([true, false]);
    h.stdin.end();
    await until(() => h.exits.length > 0);
  });

  it("without configured destinations no origin is recommendation-enabled: a settled visit never begins a job", async () => {
    const h = harness();
    await h.run();
    const { scheduler } = h.jobs;
    expect(scheduler.isEnabled("https://docs.stripe.com")).toBe(false);
    expect(scheduler.isEnabled("https://www.peakdesign.com")).toBe(false);
    const visit = { epoch: 7, origin: "https://docs.stripe.com" } as never;
    const catalog = { result: { ok: true, catalog: { candidates: [{ id: "c1", url: "https://docs.stripe.com/a", label: "A" }], version: "cat" } } } as never;
    scheduler.onSettled(visit, catalog, Date.now());
    expect(scheduler.running).toBeNull();
    expect(h.fields.filter((f) => f.name === "job_skipped").map((f) => f.fields)).toEqual([{ epoch: 7, reason: "not_enabled" }]);
    expect(h.events).not.toContain("job_started");
    h.stdin.end();
    await until(() => h.exits.length > 0);
  });

  it("removes leftover run/jobs dirs before agent.sock is published, never following a link out of the jobs root", async () => {
    const jobs = join(home, "run", "jobs");
    mkdirSync(join(jobs, "j-stale", "nested"), { recursive: true, mode: 0o700 });
    chmodSync(join(home, "run"), 0o700);
    writeFileSync(join(jobs, "j-stale", "mcp.json"), "{}");
    const outside = join(home, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "x");
    symlinkSync(outside, join(jobs, "j-link"));
    const h = harness();
    await h.run();
    expect(readdirSync(jobs)).toEqual([]);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("x");
    const swept = h.fields.findIndex((f) => f.name === "jobs_swept");
    expect(h.fields[swept]?.fields).toEqual({ count: 2 });
    expect(swept).toBeLessThan(h.events.indexOf("agent_socket_listening"));
    h.stdin.end();
    await until(() => h.exits.length > 0);
  });

  it("holds agent-profile.lock while running; shutdown releases it and reports each step's duration", async () => {
    const h = harness();
    await h.run();
    expect(existsSync(join(home, "agent-profile.lock"))).toBe(true);
    h.stdin.end();
    await until(() => h.exits.length > 0);
    expect(existsSync(join(home, "agent-profile.lock"))).toBe(false);
    expect(h.fields.find((f) => f.name === "shutdown_begin")?.fields).toEqual({ reason: "stdin-closed" });
    const done = h.fields.find((f) => f.name === "shutdown")!.fields;
    expect(Object.keys(done).sort()).toEqual(["descendantsMs", "jobsMs", "parsersMs", "reason", "socketsMs", "stopMs", "storeMs", "totalMs"]);
    expect(Object.values(done).every((v) => typeof v === "number" || v === "stdin-closed")).toBe(true);
    expect(h.events).not.toContain("shutdown_deadline");
  });

  it("a step that never finishes: exit 0 at the 5 s deadline, the pending step named", async () => {
    const h = harness();
    await h.run();
    h.agent.store.close = () => new Promise<void>(() => {});
    const t0 = Date.now();
    h.stdin.end();
    await until(() => h.exits.length > 0, 8_000);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(SHUTDOWN_DEADLINE_MS - 50);
    expect(took).toBeLessThan(SHUTDOWN_DEADLINE_MS + 1_000);
    expect(h.exits.map((e) => e.code)).toEqual([0]);
    expect(h.fields.find((f) => f.name === "shutdown_deadline")?.fields).toEqual({ pending: "store" });
    // The lock and the token went before the store's close.
    expect(existsSync(join(home, "agent-profile.lock"))).toBe(false);
    expect(existsSync(join(home, "run", "agent-token"))).toBe(false);
  }, 15_000);

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

  it("the default is empty: recommendations start off for every origin", () => {
    expect(DEFAULT_DESTINATIONS).toEqual([]);
  });

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
