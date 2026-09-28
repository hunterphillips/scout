import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { OwnedTree, psSnapshot } from "./process-tree.mjs";

const cleanup = [];
afterEach(() => {
  for (const pid of cleanup.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A detached group leader that starts one in-group child and one child in its own group. */
function startFamily() {
  const script = `const {spawn}=require("node:child_process");
const a=spawn("/bin/sleep",["30"],{stdio:"ignore"});
const b=spawn("/bin/sleep",["30"],{stdio:"ignore",detached:true});
console.log(a.pid+" "+b.pid);setInterval(()=>{},1000);`;
  const leader = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  cleanup.push(leader.pid);
  return new Promise((resolve) => {
    let out = "";
    leader.stdout.on("data", (d) => {
      out += d;
      if (out.includes("\n")) {
        const [inGroup, escaped] = out.trim().split(" ").map(Number);
        cleanup.push(inGroup, escaped);
        resolve({ leader, inGroup, escaped });
      }
    });
  });
}

describe("process tree", () => {
  it("snapshots pid, ppid, pgid and start time without command lines", () => {
    const snap = psSnapshot();
    const me = snap.get(process.pid);
    expect(me).toMatchObject({ pid: process.pid, ppid: process.ppid });
    expect(typeof me.start).toBe("string");
    expect(Object.keys(me).sort()).toEqual(["pgid", "pid", "ppid", "start", "state"]);
  });

  it("tracks group members and descendants that left the group, and kills only them", async () => {
    const { leader, inGroup, escaped } = await startFamily();
    const tree = new OwnedTree(leader.pid);
    tree.poll();
    expect(tree.identities().map((i) => i.pid).sort()).toEqual([leader.pid, inGroup, escaped].sort());
    expect(tree.escaped().map((i) => i.pid)).toEqual([escaped]);
    const signalled = tree.signalAll("SIGKILL");
    expect(signalled.escapedSignalled).toBe(1);
    await sleep(300);
    expect(tree.alive()).toEqual([]);
  });

  it("does not signal a pid whose start time no longer matches (pid reuse guard)", () => {
    const tree = new OwnedTree(2 ** 22 + 12345); // a root that does not exist
    // A recorded identity for this pid, but from an earlier process lifetime.
    tree.add({ pid: process.pid, ppid: process.ppid, pgid: process.pid, start: "Thu Jan  1 00:00:00 1970" });
    expect(tree.alive()).toEqual([]);
    expect(tree.signalAll("SIGCONT").escapedSignalled).toBe(0);
  });
});

describe("process tree: group signal guard", () => {
  it("never signals a group id whose members are not owned identities (reused PGID)", async () => {
    // An unrelated live group leader whose pgid equals the tree's group id.
    const other = spawn("/bin/sleep", ["30"], { stdio: "ignore", detached: true });
    cleanup.push(other.pid);
    await sleep(100);
    const tree = new OwnedTree(other.pid);
    // The tree only knows an earlier process lifetime with that pid.
    tree.add({ pid: other.pid, ppid: process.pid, pgid: other.pid, start: "Thu Jan  1 00:00:00 1970" });
    const r = tree.signalAll("SIGKILL");
    expect(r).toEqual({ groupSignalled: false, escapedSignalled: 0 });
    await sleep(100);
    expect(() => process.kill(other.pid, 0)).not.toThrow();
  });

  it("with only escaped owned descendants left, signals them individually and not the group", async () => {
    const { leader, inGroup, escaped } = await startFamily();
    const tree = new OwnedTree(leader.pid);
    tree.poll();
    process.kill(-leader.pid, "SIGKILL"); // the owned group is gone
    await sleep(300);
    const r = tree.signalAll("SIGKILL");
    expect(r).toEqual({ groupSignalled: false, escapedSignalled: 1 });
    await sleep(200);
    expect(tree.alive()).toEqual([]);
    expect(inGroup).toBeGreaterThan(0);
  });
});
