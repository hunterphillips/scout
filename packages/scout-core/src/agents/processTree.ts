// Provenance: copied from packages/personal-context-mcp/src/processTree.ts (itself lifted
// from scripts/spikes/process-tree.mjs). Temporary duplicate until Phase 4 removes the
// legacy service. OwnedTree's tracking and signalling rules are unchanged, and
// processTree.test.ts checks them against the legacy copy. Differences, all additive:
//   - psSnapshotAsync(): the same ps query through execFile, so the job runtime never
//     blocks the coordinator's event loop on ps. psSnapshot() is kept for OwnedTree's
//     default and the tests; both parse through parsePsOutput().
//   - signalAll() takes an optional snapshot, as poll() and alive() already did, so a caller
//     holding a fresh async snapshot never falls back to the blocking default.
//
// Track and clean up the process tree one spawned `claude` owns.
//
// Lifted from the Phase 0 spike `scripts/spikes/process-tree.mjs` without changing its
// invariants; only types were added. Only the caller's own tree is ever signalled: the
// detached process group it created, plus descendants seen leaving that group.
// Identities are pid + start time, so a reused pid is never signalled. ps is asked for
// pid/ppid/pgid/state/start only, never command lines or environments.

import { execFile, spawnSync } from "node:child_process";

export interface PsEntry {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  start: string;
}

export type PsSnapshot = Map<number, PsEntry>;

export interface ProcessIdentity {
  pid: number;
  ppid: number;
  pgid: number;
  start: string;
}

const PS_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="];
const PS_OPTS = { encoding: "utf8", env: { PATH: "/bin:/usr/bin", LC_ALL: "C" }, timeout: 5000 } as const;

/** Blocking: ~20 ms per call. Not for the job runtime's hot path; see psSnapshotAsync. */
export function psSnapshot(): PsSnapshot {
  const r = spawnSync("/bin/ps", PS_ARGS, PS_OPTS);
  if (r.status !== 0 || typeof r.stdout !== "string") return new Map();
  return parsePsOutput(r.stdout);
}

/** The same query without blocking; an empty map when ps fails, as psSnapshot. */
export function psSnapshotAsync(): Promise<PsSnapshot> {
  return new Promise((resolve) => {
    execFile("/bin/ps", PS_ARGS, { ...PS_OPTS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err || typeof stdout !== "string" ? new Map() : parsePsOutput(stdout));
    });
  });
}

export function parsePsOutput(stdout: string): PsSnapshot {
  const out: PsSnapshot = new Map();
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    out.set(pid, { pid, ppid: Number(m[2]), pgid: Number(m[3]), state: m[4]!, start: m[5]!.trim() });
  }
  return out;
}

const key = (p: { pid: number; start: string }): string => `${p.pid}@${p.start}`;
const isLive = (p: PsEntry | undefined): p is PsEntry => p !== undefined && !p.state.startsWith("Z");

export class OwnedTree {
  readonly pgid: number;
  private readonly known = new Map<string, ProcessIdentity>();

  /** `rootPid`: a process spawned detached, so it leads its own group. */
  constructor(
    readonly rootPid: number,
    private readonly snapshot: () => PsSnapshot = psSnapshot,
  ) {
    this.pgid = rootPid;
  }

  private add(p: PsEntry): void {
    this.known.set(key(p), { pid: p.pid, ppid: p.ppid, pgid: p.pgid, start: p.start });
  }

  /** Record every live group member and every descendant of an owned process. */
  poll(snap: PsSnapshot = this.snapshot()): this {
    const root = snap.get(this.rootPid);
    if (isLive(root) && (this.known.size === 0 || this.known.has(key(root)))) this.add(root);
    if (this.known.size === 0) return this; // never saw our root: own nothing
    for (const p of snap.values()) if (p.pgid === this.pgid && isLive(p)) this.add(p);
    for (let grew = true; grew; ) {
      grew = false;
      const owned = new Set(this.alive(snap).map((i) => i.pid));
      for (const p of snap.values()) {
        if (owned.has(p.ppid) && isLive(p) && !this.known.has(key(p))) {
          this.add(p);
          grew = true;
        }
      }
    }
    return this;
  }

  identities(): ProcessIdentity[] {
    return [...this.known.values()];
  }

  /** Owned identities that left the process group. */
  escaped(): ProcessIdentity[] {
    return this.identities().filter((i) => i.pgid !== this.pgid);
  }

  /** Owned identities still alive (same pid AND same start time, not a zombie). */
  alive(snap: PsSnapshot = this.snapshot()): ProcessIdentity[] {
    return this.identities().filter((i) => {
      const p = snap.get(i.pid);
      return isLive(p) && p.start === i.start;
    });
  }

  /**
   * Signal the owned group only if a fresh snapshot shows at least one live OWNED
   * identity still in it; then each live owned process outside the group individually.
   * An empty or reused group id is never signalled, and there is never a broad kill.
   */
  signalAll(signal: NodeJS.Signals, snap: PsSnapshot = this.snapshot()): { groupSignalled: boolean; escapedSignalled: number } {
    const live = this.alive(snap);
    const inGroup = live.filter((i) => snap.get(i.pid)?.pgid === this.pgid);
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
      if (snap.get(i.pid)?.pgid === this.pgid) continue; // covered by the group signal
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
