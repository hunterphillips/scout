// Provenance: copied from the removed personal-context package (see git history before
// 2026-10-02).
// OwnedTree's tracking and signalling rules are unchanged, and processTree.test.ts pins
// them against the legacy copy's results. Differences, all additive:
//   - psSnapshotAsync(): the same ps query through execFile, so the job runtime never
//     blocks the coordinator's event loop on ps. psSnapshot() is kept for OwnedTree's
//     default and the tests; both parse through parsePsOutput().
//   - signalAll() takes an optional snapshot, as poll() and alive() already did, so a caller
//     holding a fresh async snapshot never falls back to the blocking default.
//   - ProcessTracker (P3.4): the core's registry of every job tree it started, so its shutdown
//     waits for (and kills) any descendant a job's own reap left behind.
//   - psSnapshot() takes an optional timeout (the shutdown's last sweep bounds it at 1 s).
//   - The job tree record (P3.4): each job dir holds `tree.json` naming the CLI and every owned
//     process seen so far, so a core that was hard-killed mid-job can kill that tree on its next
//     start (killRecordedTree) instead of leaving it spending quota.
//
// Track and clean up the process tree one spawned `claude` owns.
//
// Lifted from the Phase 0 spike without changing its
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

/**
 * Blocking: ~20 ms per call. Not for the job runtime's hot path; see psSnapshotAsync.
 * `timeout` (ms, default 5000) bounds the wait; a ps that outlasts it yields an empty map.
 */
export function psSnapshot(options: { timeout?: number } = {}): PsSnapshot {
  const r = spawnSync("/bin/ps", PS_ARGS, { ...PS_OPTS, timeout: options.timeout ?? PS_OPTS.timeout });
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

// ---------- the core's registry of every job tree it started (P3.4) ----------

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Every OwnedTree the core started that is not yet known to be gone. A job's supervisor adds its
 * tree at spawn and removes it once its reap saw no owned process alive; a tree whose reap did
 * not get there stays, so the core's shutdown still waits for it and kills what is left.
 */
export class ProcessTracker {
  private readonly trees = new Set<OwnedTree>();

  /** Track `tree`; the returned function stops tracking it. */
  add(tree: OwnedTree): () => void {
    this.trees.add(tree);
    return () => void this.trees.delete(tree);
  }

  /** Trees still tracked (some may already be gone; `alive` prunes them). */
  get size(): number {
    return this.trees.size;
  }

  /** Live owned processes across every tracked tree in `snap`; trees with none left are dropped. */
  alive(snap: PsSnapshot): ProcessIdentity[] {
    const out: ProcessIdentity[] = [];
    for (const tree of this.trees) {
      tree.poll(snap);
      const live = tree.alive(snap);
      if (live.length === 0) this.trees.delete(tree);
      else out.push(...live);
    }
    return out;
  }

  /**
   * SIGKILL every live tracked process until none is left or `deadlineAt` (Date.now() time)
   * passes. Resolves with what is still alive (empty when all are gone). ps never blocks the
   * event loop here; `snapshot` is a test seam.
   */
  async killAll(deadlineAt: number, options: { snapshot?: () => Promise<PsSnapshot>; pollMs?: number } = {}): Promise<ProcessIdentity[]> {
    const snapshot = options.snapshot ?? psSnapshotAsync;
    const pollMs = options.pollMs ?? 100;
    for (;;) {
      if (this.trees.size === 0) return [];
      const snap = await snapshot();
      const live = this.alive(snap);
      if (live.length === 0) return [];
      for (const tree of this.trees) tree.signalAll("SIGKILL", snap);
      if (Date.now() >= deadlineAt) return live;
      await delay(Math.min(pollMs, Math.max(0, deadlineAt - Date.now())));
    }
  }
}

// ---------- the job tree record a hard-killed core leaves behind (P3.4) ----------

/** The record's file name in a job dir. */
export const JOB_TREE_FILE = "tree.json";
/** At most this many owned processes are recorded. */
export const JOB_TREE_MAX_MEMBERS = 256;
/** How far the CLI's ps start time may sit from `startedAt` (lstart has 1 s resolution). */
const START_SLACK_BEFORE_MS = 2000;
const START_SLACK_AFTER_MS = 1000;

/**
 * `tree.json` (0600, in the job's private dir): pids, the group, start times. No arguments,
 * environments, paths or tokens.
 */
export interface JobTreeRecord {
  schemaVersion: 1;
  /** The CLI's pid. It was spawned detached, so it leads its own group: `pgid === pid`. */
  pid: number;
  pgid: number;
  /** Date.now() right after the spawn returned. */
  startedAt: number;
  /** Every owned process ps has shown so far (pid and its ps `lstart`), the CLI among them once seen. */
  members: Array<{ pid: number; start: string }>;
}

/** The record for `tree`, or the CLI alone before ps has seen it. */
export function jobTreeRecord(pid: number, startedAt: number, members: readonly ProcessIdentity[]): JobTreeRecord {
  return { schemaVersion: 1, pid, pgid: pid, startedAt, members: members.slice(0, JOB_TREE_MAX_MEMBERS).map((m) => ({ pid: m.pid, start: m.start })) };
}

const isPid = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 1;

/** A record from untrusted bytes; undefined when it is not exactly one. */
export function parseJobTreeRecord(text: string): JobTreeRecord | undefined {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof j !== "object" || j === null) return undefined;
  const r = j as Record<string, unknown>;
  if (r.schemaVersion !== 1 || !isPid(r.pid) || r.pgid !== r.pid || typeof r.startedAt !== "number" || !Number.isFinite(r.startedAt)) return undefined;
  if (!Array.isArray(r.members) || r.members.length > JOB_TREE_MAX_MEMBERS) return undefined;
  const members: JobTreeRecord["members"] = [];
  for (const m of r.members as unknown[]) {
    const e = m as Record<string, unknown> | null;
    if (typeof e !== "object" || e === null || !isPid(e.pid) || typeof e.start !== "string" || e.start.length === 0 || e.start.length > 64) return undefined;
    members.push({ pid: e.pid, start: e.start });
  }
  return { schemaVersion: 1, pid: r.pid, pgid: r.pgid as number, startedAt: r.startedAt, members };
}

/** Whether a ps `lstart` (local time, 1 s resolution) fits a process spawned at `startedAt`. */
function startFits(lstart: string, startedAt: number): boolean {
  const t = Date.parse(lstart);
  return Number.isFinite(t) && t >= startedAt - START_SLACK_BEFORE_MS && t <= startedAt + START_SLACK_AFTER_MS;
}

/**
 * SIGKILL what is left of a recorded job tree; returns how many processes were signalled.
 * A process is ours only when its pid AND start time still match: a recorded member by its exact
 * ps start; the CLI by its recorded start, or (before ps ever saw it) by a start within a second
 * or two of `startedAt`. Only when the CLI itself still matches is its group signalled too (with
 * every live group member counted): a group whose leader is gone is never signalled as a whole.
 * Never this process or its own group.
 */
export function killRecordedTree(rec: JobTreeRecord, snap: PsSnapshot, self: number = process.pid): number {
  const ownGroup = snap.get(self)?.pgid;
  const targets = new Map<number, PsEntry>();
  for (const m of rec.members) {
    const p = snap.get(m.pid);
    if (isLive(p) && p.start === m.start) targets.set(p.pid, p);
  }
  const leader = snap.get(rec.pid);
  const recorded = rec.members.find((m) => m.pid === rec.pid);
  const leaderMatches = isLive(leader) && leader.pgid === rec.pgid && (recorded ? leader.start === recorded.start : startFits(leader.start, rec.startedAt));
  if (leaderMatches) for (const p of snap.values()) if (p.pgid === rec.pgid && isLive(p)) targets.set(p.pid, p);
  targets.delete(self);
  if (rec.pgid === self || rec.pgid === ownGroup) return 0;
  if (leaderMatches) {
    try {
      process.kill(-rec.pgid, "SIGKILL");
    } catch {
      // group gone
    }
  }
  let killed = 0;
  for (const p of targets.values()) {
    if (p.pgid === ownGroup) continue;
    try {
      process.kill(p.pid, "SIGKILL");
      killed++;
    } catch {
      // gone, or not ours to signal
    }
  }
  return killed;
}
