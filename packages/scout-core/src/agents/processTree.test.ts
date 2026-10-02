import { spawn } from "node:child_process";
import { OwnedTree as LegacyOwnedTree } from "personal-context-mcp";
import { afterEach, describe, expect, it } from "vitest";
import { jobTreeRecord, killRecordedTree, OwnedTree, parseJobTreeRecord, parsePsOutput, ProcessTracker, psSnapshot, psSnapshotAsync, type PsEntry, type PsSnapshot } from "./processTree.js";

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

  it("the async query sees the same processes as the blocking one", async () => {
    const snap = await psSnapshotAsync();
    const pick = (e: PsEntry | undefined) => e && { pid: e.pid, ppid: e.ppid, pgid: e.pgid, start: e.start };
    expect(pick(snap.get(process.pid))).toEqual(pick(psSnapshot().get(process.pid)));
    expect(snap.get(process.pid)).toBeDefined();
  });

  it("signalAll with a given snapshot never takes its own", async () => {
    const { leader } = await startFamily();
    let own = 0;
    const tree = new OwnedTree(leader, () => {
      own++;
      return new Map();
    });
    const snap = await psSnapshotAsync();
    tree.poll(snap);
    expect(tree.signalAll("SIGKILL", snap)).toEqual({ groupSignalled: true, escapedSignalled: 1 });
    expect(own).toBe(0);
    await sleep(300);
    expect(tree.alive(await psSnapshotAsync()).map((i) => i.pid)).toEqual([]);
  });

  it("parses ps output and skips lines it cannot read", () => {
    const snap = parsePsOutput("  12   1  12 Ss   Mon Sep 30 10:00:00 2026\ngarbage\n\n 13 12 12 Z+ Mon Sep 30 10:00:01 2026\n");
    expect([...snap.keys()]).toEqual([12, 13]);
    expect(snap.get(13)).toEqual({ pid: 13, ppid: 12, pgid: 12, state: "Z+", start: "Mon Sep 30 10:00:01 2026" });
  });
});

describe("ProcessTracker (the core's registry of job trees)", () => {
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  };

  it("killAll SIGKILLs a tracked family, the escaped child included, and empties the registry", async () => {
    const fam = await startFamily();
    cleanup.push(fam.inGroup, fam.escaped);
    const tree = new OwnedTree(fam.leader).poll(await psSnapshotAsync());
    const tracker = new ProcessTracker();
    tracker.add(tree);
    expect(tracker.alive(await psSnapshotAsync()).map((i) => i.pid).sort()).toEqual([fam.leader, fam.inGroup, fam.escaped].sort());
    const left = await tracker.killAll(Date.now() + 3000);
    expect(left).toEqual([]);
    expect(tracker.size).toBe(0);
    for (const pid of [fam.leader, fam.inGroup, fam.escaped]) {
      for (let i = 0; i < 40 && isAlive(pid); i++) await sleep(25);
      expect(isAlive(pid)).toBe(false);
    }
  });

  it("alive() drops trees with nothing left; the untrack function removes one at once", async () => {
    const tracker = new ProcessTracker();
    const gone = new OwnedTree(999_999_1, () => new Map());
    const untrack = tracker.add(gone);
    expect(tracker.size).toBe(1);
    expect(tracker.alive(new Map())).toEqual([]);
    expect(tracker.size).toBe(0);
    tracker.add(gone);
    untrack();
    expect(tracker.size).toBe(0);
    expect(await tracker.killAll(Date.now() + 100, { snapshot: async () => new Map() })).toEqual([]);
  });

  it("killAll gives up at the deadline and reports what is still alive (never signals what it does not own)", async () => {
    const entry: PsEntry = { pid: 424242, ppid: 1, pgid: 424242, state: "Ss", start: "Mon Sep 30 10:00:00 2026" };
    const snap: PsSnapshot = new Map([[entry.pid, entry]]);
    const tree = new OwnedTree(entry.pid, () => snap).poll(snap);
    // The signal itself goes to a pid nobody here owns; stub kill so nothing real is touched.
    const kill = process.kill;
    const sent: Array<[number, string | number | undefined]> = [];
    process.kill = ((pid: number, sig?: string | number) => {
      sent.push([pid, sig]);
      return true;
    }) as typeof process.kill;
    try {
      const tracker = new ProcessTracker();
      tracker.add(tree);
      const left = await tracker.killAll(Date.now() + 150, { snapshot: async () => snap, pollMs: 50 });
      expect(left.map((i) => i.pid)).toEqual([424242]);
      expect(sent.every(([pid, sig]) => pid === -424242 && sig === "SIGKILL")).toBe(true);
      expect(sent.length).toBeGreaterThan(0);
    } finally {
      process.kill = kill;
    }
  });
});

describe("the job tree record (tree.json) and the start-time kill", () => {
  const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await sleep(20);
    }
  };
  const alive = (pid: number): boolean => {
    const p = psSnapshot().get(pid);
    return p !== undefined && !p.state.startsWith("Z");
  };

  it("parses only exactly-shaped records", () => {
    const ok = jobTreeRecord(4242, 1000, [{ pid: 4242, ppid: 1, pgid: 4242, start: "Thu Oct  1 12:00:00 2026" }]);
    expect(parseJobTreeRecord(JSON.stringify(ok))).toEqual(ok);
    for (const bad of [
      "not json",
      "null",
      JSON.stringify({ ...ok, schemaVersion: 2 }),
      JSON.stringify({ ...ok, pgid: 1 }), // not its own group leader
      JSON.stringify({ ...ok, pid: 1, pgid: 1 }),
      JSON.stringify({ ...ok, startedAt: "x" }),
      JSON.stringify({ ...ok, members: [{ pid: 7, start: "" }] }),
      JSON.stringify({ ...ok, members: [{ pid: -3, start: "x" }] }),
      JSON.stringify({ ...ok, members: "x" }),
    ]) {
      expect(parseJobTreeRecord(bad), bad).toBeUndefined();
    }
  });

  it("kills a recorded family whose leader still matches: the group and the escaped member", async () => {
    const f = await startFamily();
    const tree = new OwnedTree(f.leader);
    await until(() => tree.poll().identities().length === 3);
    const record = jobTreeRecord(f.leader, Date.now(), tree.identities());
    const killed = killRecordedTree(parseJobTreeRecord(JSON.stringify(record))!, psSnapshot());
    expect(killed).toBe(3);
    await until(() => ![f.leader, f.inGroup, f.escaped].some(alive));
  });

  it("before ps saw the CLI, its start must sit near the spawn time", async () => {
    const f = await startFamily();
    const snap = psSnapshot();
    // Spawned "an hour later" than it really was: a reused pid, never signalled.
    expect(killRecordedTree(jobTreeRecord(f.leader, Date.now() + 3_600_000, []), snap)).toBe(0);
    await sleep(100);
    expect(alive(f.leader)).toBe(true);
    // Within the slack: the group goes.
    expect(killRecordedTree(jobTreeRecord(f.leader, Date.parse(snap.get(f.leader)!.start), []), snap)).toBe(2);
    await until(() => !alive(f.leader) && !alive(f.inGroup));
    expect(alive(f.escaped)).toBe(true); // never recorded, outside the group: not ours to guess
  });

  it("a member whose start time changed (a reused pid) is never signalled", async () => {
    const f = await startFamily();
    const tree = new OwnedTree(f.leader);
    await until(() => tree.poll().identities().length === 3);
    const members = tree.identities().map((m) => ({ ...m, start: "Mon Jan  1 00:00:00 2001" }));
    expect(killRecordedTree(jobTreeRecord(f.leader, Date.now(), members), psSnapshot())).toBe(0);
    await sleep(100);
    expect([f.leader, f.inGroup, f.escaped].every(alive)).toBe(true);
  });

  it("never this process or its own group", () => {
    const snap = psSnapshot();
    const me = snap.get(process.pid)!;
    expect(killRecordedTree(jobTreeRecord(process.pid, Date.now(), [{ pid: process.pid, ppid: me.ppid, pgid: me.pgid, start: me.start }]), snap)).toBe(0);
  });
});
