import { spawn } from "node:child_process";
import { OwnedTree as LegacyOwnedTree } from "personal-context-mcp";
import { afterEach, describe, expect, it } from "vitest";
import { OwnedTree, psSnapshot, type PsEntry, type PsSnapshot } from "./processTree.js";

const cleanup: number[] = [];
afterEach(() => {
  for (const pid of cleanup.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A detached group leader with one in-group child and one child in its own group. */
function startFamily(): Promise<{ leader: number; inGroup: number; escaped: number }> {
  const script = `const {spawn}=require("node:child_process");
const a=spawn("/bin/sleep",["30"],{stdio:"ignore"});
const b=spawn("/bin/sleep",["30"],{stdio:"ignore",detached:true});
console.log(a.pid+" "+b.pid);setInterval(()=>{},1000);`;
  const leader = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  cleanup.push(leader.pid!);
  return new Promise((resolve) => {
    let out = "";
    leader.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.includes("\n")) {
        const [inGroup, escaped] = out.trim().split(" ").map(Number) as [number, number];
        cleanup.push(inGroup, escaped);
        resolve({ leader: leader.pid!, inGroup, escaped });
      }
    });
  });
}

describe("OwnedTree", () => {
  it("tracks group members and escaped descendants, and kills only them", async () => {
    const { leader, inGroup, escaped } = await startFamily();
    const tree = new OwnedTree(leader).poll();
    expect(tree.identities().map((i) => i.pid).sort()).toEqual([leader, inGroup, escaped].sort());
    expect(tree.escaped().map((i) => i.pid)).toEqual([escaped]);
    expect(tree.signalAll("SIGKILL").escapedSignalled).toBe(1);
    await sleep(300);
    expect(tree.alive()).toEqual([]);
  });

  it("never signals a pid whose start time changed (pid reuse)", () => {
    const snap = (start: string): PsSnapshot => new Map([[999_999, { pid: 999_999, ppid: 1, pgid: 999_999, state: "S", start }]]);
    let current = snap("Mon Sep 30 10:00:00 2026");
    const tree = new OwnedTree(999_999, () => current).poll();
    expect(tree.alive()).toHaveLength(1);
    current = snap("Mon Sep 30 11:00:00 2026");
    expect(tree.alive()).toEqual([]);
    expect(tree.signalAll("SIGKILL")).toEqual({ groupSignalled: false, escapedSignalled: 0 });
  });

  it("matches the legacy copy over a synthetic process table", () => {
    const e = (pid: number, ppid: number, pgid: number, state = "S"): [number, PsEntry] => [pid, { pid, ppid, pgid, state, start: `t${pid}` }];
    const steps: PsSnapshot[] = [
      new Map([e(100, 1, 100), e(101, 100, 100), e(102, 101, 102), e(200, 1, 200)]),
      new Map([e(100, 1, 100), e(101, 100, 100, "Z"), e(102, 1, 102), e(103, 102, 102), e(200, 1, 200)]),
      new Map([e(102, 1, 102), e(103, 102, 102), e(200, 1, 200)]),
    ];
    const ours = new OwnedTree(100, () => steps[0]!);
    const legacy = new LegacyOwnedTree(100, () => steps[0]!);
    for (const snap of steps) {
      ours.poll(snap);
      legacy.poll(snap);
      expect(ours.identities()).toEqual(legacy.identities());
      expect(ours.escaped()).toEqual(legacy.escaped());
      expect(ours.alive(snap)).toEqual(legacy.alive(snap));
    }
    expect(ours.alive(steps[2]!).map((i) => i.pid).sort()).toEqual([102, 103]);
    expect(psSnapshot().get(process.pid)).toMatchObject({ pid: process.pid });
  });
});
