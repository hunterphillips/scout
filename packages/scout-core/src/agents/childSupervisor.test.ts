import { spawn as nodeSpawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startChild, type SupervisedChild } from "./childSupervisor.js";
import { psSnapshotAsync, type JobTreeRecord, type PsSnapshot } from "./processTree.js";

const started: SupervisedChild[] = [];
afterEach(() => {
  for (const s of started.splice(0)) {
    s.dispose();
    try {
      if (s.child.pid) process.kill(s.child.pid, "SIGKILL");
    } catch {
      // gone
    }
  }
});

const spawn = (c: string, a: readonly string[], o: Parameters<typeof nodeSpawn>[2]) => nodeSpawn(c, [...a], o);

function start(script: string, extra: Partial<Parameters<typeof startChild>[0]> = {}): SupervisedChild {
  const s = startChild({ spawn, command: process.execPath, args: ["-e", script], options: { stdio: ["ignore", "pipe", "ignore"] }, killGraceMs: 300, ...extra });
  started.push(s);
  return s;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("childSupervisor", () => {
  it("runs at most one ps query at a time, never on the caller's stack", async () => {
    let calls = 0;
    let running = 0;
    let maxRunning = 0;
    const snapshot = async (): Promise<PsSnapshot> => {
      calls++;
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 80));
      running--;
      return new Map();
    };
    const s = start("setInterval(()=>{},1000)", { snapshot, pollMs: 10 });
    expect(calls).toBe(0); // scheduled, not run synchronously
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toBeGreaterThan(0);
    expect(maxRunning).toBe(1);
    s.terminate();
    expect(await s.waitExit()).toEqual({ spawnError: false });
  });

  it("terminate takes its tree snapshot before the group SIGTERM", async () => {
    const order: string[] = [];
    const s = start("setInterval(()=>{},1000)", {
      snapshot: async () => {
        order.push("snapshot");
        return new Map();
      },
      pollMs: 60_000,
    });
    await until(() => order.length === 1); // the initial snapshot
    const realKill = process.kill.bind(process);
    const spy = vi.spyOn(process, "kill").mockImplementation((pid: number, sig?: string | number) => {
      if (pid === -s.child.pid! && sig === "SIGTERM") order.push("group SIGTERM");
      return realKill(pid, sig);
    });
    try {
      s.terminate();
      expect(await s.waitExit()).toEqual({ spawnError: false });
    } finally {
      spy.mockRestore();
    }
    expect(order).toEqual(["snapshot", "snapshot", "group SIGTERM"]);
  });

  it("the kill timer takes a fresh snapshot before the group SIGKILL", async () => {
    const order: string[] = [];
    const s = start("process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)", {
      snapshot: async () => {
        order.push("snapshot");
        return new Map();
      },
      pollMs: 60_000,
    });
    let ready = false;
    s.child.stdout!.once("data", () => (ready = true));
    await until(() => ready && order.length === 1); // SIGTERM is ignored; the initial snapshot ran
    const realKill = process.kill.bind(process);
    const spy = vi.spyOn(process, "kill").mockImplementation((pid: number, sig?: string | number) => {
      if (pid === -s.child.pid!) order.push(`group ${String(sig)}`);
      return realKill(pid, sig);
    });
    try {
      s.terminate();
      expect(await s.waitExit()).toEqual({ spawnError: false });
    } finally {
      spy.mockRestore();
    }
    expect(order).toEqual(["snapshot", "snapshot", "group SIGTERM", "snapshot", "group SIGKILL"]);
  });

  it("hands over the tree's record at spawn and whenever ps shows a new owned process", async () => {
    const records: JobTreeRecord[] = [];
    const s = start("require('node:child_process').spawn('/bin/sleep',['30'],{stdio:'ignore'});setInterval(()=>{},1000)", {
      snapshot: psSnapshotAsync,
      pollMs: 50,
      onTree: (r) => void records.push(r),
    });
    const pid = s.child.pid!;
    expect(records[0]).toEqual({ schemaVersion: 1, pid, pgid: pid, startedAt: expect.any(Number), members: [] });
    await until(() => (records.at(-1)?.members.length ?? 0) >= 2);
    const last = records.at(-1)!;
    expect(last.members.map((m) => m.pid)).toContain(pid);
    expect(last.members.every((m) => typeof m.start === "string" && m.start.length > 0)).toBe(true);
    const count = records.length;
    await new Promise((r) => setTimeout(r, 200)); // polls with nothing new hand nothing over
    expect(records.length).toBe(count);
    s.terminate();
    await s.waitExit();
    await s.reap();
  });

  it("dispose kills a CLI that is still running", async () => {
    const s = start("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)", { snapshot: () => new Map() });
    const pid = s.child.pid!;
    await until(() => alive(pid));
    s.dispose();
    await until(() => !alive(pid));
    expect(await s.waitExit()).toEqual({ spawnError: false });
  });

  it("a missing binary arrives as spawnError, not a throw", async () => {
    const s = startChild({ spawn, command: "/nonexistent/claude", args: [], options: { stdio: ["ignore", "pipe", "ignore"] }, killGraceMs: 300 });
    started.push(s);
    expect(await s.waitExit()).toEqual({ spawnError: true });
    await s.reap();
  });
});
