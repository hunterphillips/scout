// Scout Phase 0: track and clean up the process tree a spawned `claude` owns.
//
// Only this module's caller's own tree is ever signalled: the detached process
// group it created, plus descendants seen leaving that group. Identities are
// pid + start time, so a reused pid is never signalled. ps is asked for
// pid/ppid/pgid/state/start only, never command lines or environments.

import { spawnSync } from "node:child_process";

/** @returns {Map<number, {pid:number, ppid:number, pgid:number, state:string, start:string}>} */
export function psSnapshot() {
  const r = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], {
    encoding: "utf8",
    env: { PATH: "/bin:/usr/bin", LC_ALL: "C" },
    timeout: 5000,
  });
  const out = new Map();
  if (r.status !== 0 || typeof r.stdout !== "string") return out;
  for (const line of r.stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    out.set(pid, { pid, ppid: Number(m[2]), pgid: Number(m[3]), state: m[4], start: m[5].trim() });
  }
  return out;
}

const key = (p) => `${p.pid}@${p.start}`;
const isLive = (p) => p && !p.state.startsWith("Z");

export class OwnedTree {
  /** @param {number} rootPid  a process spawned detached, so it leads its own group */
  constructor(rootPid, { snapshot = psSnapshot } = {}) {
    this.rootPid = rootPid;
    this.pgid = rootPid;
    this.snapshot = snapshot;
    this.known = new Map();
  }

  add(p) {
    this.known.set(key(p), { pid: p.pid, ppid: p.ppid, pgid: p.pgid, start: p.start });
  }

  /** Record every live group member and every descendant of an owned process. */
  poll(snap = this.snapshot()) {
    const root = snap.get(this.rootPid);
    if (isLive(root) && (this.known.size === 0 || this.known.has(key(root)))) this.add(root);
    if (this.known.size === 0) return this; // never saw our root: own nothing
    for (const p of snap.values()) if (p.pgid === this.pgid && isLive(p)) this.add(p);
    const liveOwned = () => new Set(this.alive(snap).map((i) => i.pid));
    for (let grew = true; grew; ) {
      grew = false;
      const owned = liveOwned();
      for (const p of snap.values()) {
        if (owned.has(p.ppid) && isLive(p) && !this.known.has(key(p))) {
          this.add(p);
          grew = true;
        }
      }
    }
    return this;
  }

  identities() {
    return [...this.known.values()];
  }

  /** Owned identities that left the process group. */
  escaped() {
    return this.identities().filter((i) => i.pgid !== this.pgid);
  }

  /** Owned identities still alive (same pid AND same start time, not a zombie). */
  alive(snap = this.snapshot()) {
    return this.identities().filter((i) => {
      const p = snap.get(i.pid);
      return isLive(p) && p.start === i.start;
    });
  }

  /**
   * Signal the owned group only if a fresh snapshot shows at least one live
   * OWNED identity (pid + start time) still in it; then each live owned
   * process outside the group individually. An empty or reused group id is
   * never signalled, and there is never a broad kill.
   */
  signalAll(signal) {
    const snap = this.snapshot();
    const live = this.alive(snap);
    const inGroup = live.filter((i) => snap.get(i.pid).pgid === this.pgid);
    let groupSignalled = false;
    if (inGroup.length) {
      try {
        process.kill(-this.pgid, signal);
        groupSignalled = true;
      } catch {
        // group gone
      }
    }
    let escapedSignalled = 0;
    for (const i of live) {
      if (snap.get(i.pid).pgid === this.pgid) continue; // covered by the group signal
      try {
        process.kill(i.pid, signal);
        escapedSignalled++;
      } catch {
        // gone
      }
    }
    return { groupSignalled, escapedSignalled };
  }
}
