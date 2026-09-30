// Lifecycle: the orphan timer in-process on fake time, then the built entrypoint as a real
// child process (stdin EOF, orphaned, bad run files, protocol-only stdout).

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFixture, mdSource, snapshot, type Fixture } from "../test-support/sourceFixture.js";
import { watchLifecycle } from "./lifecycle.js";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(pkgDir, "dist", "sourceTools.js");

describe("watchLifecycle (in process)", () => {
  afterEach(() => void vi.useRealTimers());

  it("exits as orphaned once the parent pid becomes 1, checking every second", () => {
    vi.useFakeTimers();
    let ppid = 4242;
    const onExit = vi.fn();
    watchLifecycle({ stdin: new EventEmitter(), getppid: () => ppid, onExit });
    vi.advanceTimersByTime(3000);
    expect(onExit).not.toHaveBeenCalled();
    ppid = 1;
    vi.advanceTimersByTime(999);
    expect(onExit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExit).toHaveBeenCalledWith("orphaned");
    vi.advanceTimersByTime(5000);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("exits as orphaned when a subreaper adopts it", () => {
    vi.useFakeTimers();
    let ppid = 4242;
    const onExit = vi.fn();
    watchLifecycle({ stdin: new EventEmitter(), getppid: () => ppid, onExit });
    ppid = 777;
    vi.advanceTimersByTime(1000);
    expect(onExit).toHaveBeenCalledWith("orphaned");
  });

  it("exits once on stdin end or close, and on signals", () => {
    const stdin = new EventEmitter();
    const signals = new EventEmitter();
    const onExit = vi.fn();
    const w = watchLifecycle({ stdin, signals, getppid: () => 5, onExit });
    stdin.emit("end");
    stdin.emit("close");
    signals.emit("SIGTERM");
    expect(onExit.mock.calls).toEqual([["stdin_eof"]]);
    w.stop();
    const onExit2 = vi.fn();
    watchLifecycle({ stdin: new EventEmitter(), signals, getppid: () => 5, onExit: onExit2 }).stop();
    const onExit3 = vi.fn();
    watchLifecycle({ stdin: new EventEmitter(), signals, getppid: () => 5, onExit: onExit3 });
    signals.emit("SIGHUP");
    expect(onExit3).toHaveBeenCalledWith("SIGHUP");
    expect(onExit2).not.toHaveBeenCalled();
  });
});

// ---------- the built entrypoint ----------

const fixtures: Fixture[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  for (const f of fixtures.splice(0)) f.cleanup();
});

// dist/ is built once by the vitest global setup (test/global-setup.mjs).

function runDirFixture(snap: unknown = snapshot()): Fixture {
  const f = makeFixture();
  fixtures.push(f);
  writeFileSync(join(f.runDir, "snapshot.json"), typeof snap === "string" ? snap : JSON.stringify(snap));
  writeFileSync(join(f.runDir, "sources.json"), JSON.stringify({ sources: [mdSource(f.notes)] }));
  return f;
}

function audit(f: Fixture): Record<string, unknown>[] {
  const p = join(f.runDir, "audit.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
}

function waitExit(child: ChildProcess, ms: number): Promise<{ code: number | null } | undefined> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve({ code: child.exitCode });
    const t = setTimeout(() => resolve(undefined), ms);
    child.once("exit", (code) => {
      clearTimeout(t);
      resolve({ code });
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const env = (f: Fixture) => ({ PATH: process.env.PATH ?? "", HOME: f.home });
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

describe("sourceTools entrypoint (child process)", () => {
  it("importing the module does nothing", async () => {
    const log = console.log;
    const listeners = process.listenerCount("SIGTERM");
    const mod = await import("../sourceTools.js");
    expect(typeof mod.createSourceToolsServer).toBe("function");
    expect(console.log).toBe(log);
    expect(process.listenerCount("SIGTERM")).toBe(listeners);
  });

  it("serves protocol-only stdout and exits 0 within 2 s of stdin EOF", async () => {
    const f = runDirFixture();
    const child = spawn(process.execPath, [entry, "--run-dir", f.runDir], { stdio: ["pipe", "pipe", "pipe"], env: env(f) });
    children.push(child);
    let out = "";
    child.stdout!.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stdin!.write(JSON.stringify(INIT) + "\n");
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_source", arguments: { sourceId: "notes", query: "billing" } } }) + "\n",
    );
    const until = Date.now() + 5000;
    while (out.split("\n").filter(Boolean).length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    child.stdin!.end();
    const exit = await waitExit(child, 2000);
    expect(exit).toEqual({ code: 0 });
    expect(Date.now() - t0).toBeLessThan(2000);
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(JSON.parse(l).jsonrpc).toBe("2.0");
    expect(JSON.parse(lines[1]!).result.structuredContent.hits.length).toBeGreaterThan(0);
    const a = audit(f);
    expect(a[0]).toMatchObject({ type: "lifecycle", event: "start" });
    expect(a.at(-1)).toMatchObject({ type: "lifecycle", event: "exit", reason: "stdin_eof" });
  });

  it("exits when orphaned even though its stdin stays open", async () => {
    const f = runDirFixture();
    // An intermediate parent starts a holder (sleep) whose stdout feeds the server's
    // stdin, prints both pids, and exits. Only orphan detection can end the server.
    const launcher = `const {spawn}=require("node:child_process");
const h=spawn("/bin/sleep",["10"],{stdio:["ignore","pipe","ignore"],detached:true});
const c=spawn(process.execPath,${JSON.stringify([entry, "--run-dir", f.runDir])},{stdio:[h.stdout,"ignore","ignore"],detached:true,env:${JSON.stringify(env(f))}});
console.log(c.pid+" "+h.pid);h.unref();c.unref();setTimeout(()=>process.exit(0),500);`;
    const mid = spawn(process.execPath, ["-e", launcher], { stdio: ["ignore", "pipe", "ignore"] });
    let pidText = "";
    mid.stdout.on("data", (d: Buffer) => (pidText += d.toString("utf8")));
    await waitExit(mid, 5000);
    const [pid, holder] = pidText.trim().split(" ").map(Number) as [number, number];
    expect(pid).toBeGreaterThan(0);
    const deadline = Date.now() + 4000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const stillAlive = alive(pid);
    if (stillAlive) process.kill(pid, "SIGKILL");
    const holderAlive = alive(holder);
    if (holderAlive) process.kill(holder, "SIGKILL");
    expect(holderAlive).toBe(true); // stdin really stayed open
    expect(stillAlive).toBe(false);
    expect(audit(f).at(-1)).toMatchObject({ type: "lifecycle", event: "exit", reason: "orphaned" });
  }, 15_000);

  it.each([
    ["a bad snapshot.json", (f: Fixture) => writeFileSync(join(f.runDir, "snapshot.json"), '{"observations":"nope"}'), "snapshot-invalid"],
    ["an unparseable sources.json", (f: Fixture) => writeFileSync(join(f.runDir, "sources.json"), "{"), "sources-invalid"],
  ])("exits 2 without serving on %s", async (_l, spoil, code) => {
    const f = runDirFixture();
    spoil(f);
    const child = spawn(process.execPath, [entry, "--run-dir", f.runDir], { stdio: ["pipe", "pipe", "pipe"], env: env(f) });
    children.push(child);
    let out = "";
    let err = "";
    child.stdout!.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr!.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.stdin!.write(JSON.stringify(INIT) + "\n");
    expect(await waitExit(child, 5000)).toEqual({ code: 2 });
    expect(out).toBe("");
    expect(err).toContain(code);
    expect(err).not.toContain(f.runDir);
    expect(existsSync(join(f.runDir, "audit.jsonl"))).toBe(false);
  });

  it.each([
    ["a symlinked run dir", (f: Fixture) => (symlinkSync(f.runDir, join(f.base, "run-link")), join(f.base, "run-link")), "run-dir-symlink"],
    ["a group-readable run dir", (f: Fixture) => (chmodSync(f.runDir, 0o750), f.runDir), "run-dir-not-private"],
  ])("exits 2 without serving on %s", async (_l, prepare, code) => {
    const f = runDirFixture();
    const dir = prepare(f);
    const child = spawn(process.execPath, [entry, "--run-dir", dir], { stdio: ["pipe", "pipe", "pipe"], env: env(f) });
    children.push(child);
    let out = "";
    let err = "";
    child.stdout!.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr!.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.stdin!.write(JSON.stringify(INIT) + "\n");
    expect(await waitExit(child, 5000)).toEqual({ code: 2 });
    expect(out).toBe("");
    expect(err.trim()).toBe(`source-tools: ${code}`);
    expect(existsSync(join(f.runDir, "audit.jsonl"))).toBe(false);
  });

  it("exits 2 on bad arguments", async () => {
    const f = runDirFixture();
    for (const args of [[], ["--run-dir"], ["--run-dir", "relative/dir"], ["--other", f.runDir]]) {
      const child = spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "pipe", "pipe"], env: env(f) });
      children.push(child);
      expect(await waitExit(child, 5000)).toEqual({ code: 2 });
    }
  });
});
