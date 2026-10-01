// One spawned CLI and the process tree it owns: spawn (detached, so it leads its own process
// group), terminate, wait for exit, reap stragglers, and always clean up.
//
// Stop = SIGTERM to the CLI's process group (directly, while it is unreaped), SIGKILL after
// the grace period, then any straggler from the ps-recorded tree; the exit wait is capped at
// grace + 2 s (`reap_timeout`). Adapted from the legacy agentRunner (temporary duplicate until
// Phase 4). Differences: ps runs asynchronously (psSnapshotAsync), at most one query at a
// time, every TREE_POLL_MS while the CLI runs and fresh on terminate and reap, instead of a
// blocking spawnSync every 150 ms; this runtime lives in the coordinator process, so it must
// never stall its event loop. The process-group signal covers the CLI and every in-group
// descendant without ps; the polled tree only adds descendants that left the group.
// dispose() always clears the timers and SIGKILLs the group if the CLI is still unreaped.

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { OwnedTree, psSnapshotAsync, type PsSnapshot } from "./processTree.js";

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export type SnapshotFn = () => PsSnapshot | Promise<PsSnapshot>;

/** How often the tree is refreshed while the CLI runs. */
export const TREE_POLL_MS = 1000;
/** How long the exit wait may outlast the kill grace. */
export const REAP_CAP_EXTRA_MS = 2000;
/** How long to wait for stdout to end after exit. */
export const DRAIN_MS = 500;

export interface ChildSupervisorOptions {
  spawn: SpawnFn;
  command: string;
  args: readonly string[];
  /** `detached: true` is forced. */
  options: SpawnOptions;
  killGraceMs: number;
  snapshot?: SnapshotFn;
  pollMs?: number;
}

export type ExitWait = { spawnError: boolean } | "reap_timeout";

export interface SupervisedChild {
  readonly child: ChildProcess;
  /** Whether terminate() has run. */
  readonly terminating: boolean;
  /** The CLI exited (or failed to spawn), or terminate()'s cap passed first. */
  waitExit(): Promise<ExitWait>;
  /** SIGTERM now, SIGKILL after the grace. Idempotent. */
  terminate(): void;
  /** Wait (bounded) for stdout to end, then close both output pipes. */
  drainOutput(): Promise<void>;
  /** Wait until no owned process is alive, signalling stragglers. */
  reap(): Promise<void>;
  /** Clear every timer; SIGKILL the group if the CLI is still unreaped. Idempotent. */
  dispose(): void;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Spawn and supervise. Throws when `spawn` itself throws; a failed exec arrives as `spawnError`. */
export function startChild(o: ChildSupervisorOptions): SupervisedChild {
  const child = o.spawn(o.command, o.args, { ...o.options, detached: true });
  const snapshotFn = o.snapshot ?? psSnapshotAsync;
  const exited = new Promise<{ spawnError: boolean }>((resolve) => {
    child.once("exit", () => resolve({ spawnError: false }));
    child.once("error", () => resolve({ spawnError: true }));
  });
  let resolveCap: (v: "reap_timeout") => void = () => {};
  const capped = new Promise<"reap_timeout">((r) => (resolveCap = r));

  let last: PsSnapshot = new Map();
  const tree = child.pid === undefined ? undefined : new OwnedTree(child.pid, () => last);
  let inFlight: Promise<PsSnapshot> | undefined;
  /** The running query, or a new one; at most one ps at a time. */
  const refresh = (): Promise<PsSnapshot> => {
    inFlight ??= Promise.resolve()
      .then(snapshotFn)
      .then(
        (s) => {
          last = s;
          tree?.poll(s);
          return s;
        },
        () => last,
      )
      .finally(() => (inFlight = undefined));
    return inFlight;
  };
  /** A query started after this call. */
  const fresh = async (): Promise<PsSnapshot> => {
    if (inFlight) await inFlight;
    return refresh();
  };

  let disposed = false;
  let terminating = false;
  let killTimer: NodeJS.Timeout | undefined;
  let capTimer: NodeJS.Timeout | undefined;
  const poller = tree ? setInterval(() => void refresh(), o.pollMs ?? TREE_POLL_MS) : undefined;
  if (tree) void refresh();

  const unreaped = (): boolean => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  // The CLI's own group, signalled without ps; safe only while the child is unreaped.
  const signalGroup = (sig: NodeJS.Signals): void => {
    if (!unreaped()) return;
    try {
      process.kill(-child.pid!, sig);
    } catch {
      // group gone
    }
  };
  const signalTree = (sig: NodeJS.Signals, onlyIfAlive: boolean): void => {
    if (!tree) return;
    void fresh().then((s) => {
      if (disposed) return;
      if (!onlyIfAlive || tree.alive(s).length) tree.signalAll(sig, s);
    });
  };

  return {
    child,
    get terminating() {
      return terminating;
    },
    waitExit: () => Promise.race([exited, capped]),
    terminate() {
      if (terminating || disposed) return;
      terminating = true;
      signalGroup("SIGTERM");
      signalTree("SIGTERM", false);
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        signalTree("SIGKILL", true);
      }, o.killGraceMs);
      capTimer = setTimeout(() => resolveCap("reap_timeout"), o.killGraceMs + REAP_CAP_EXTRA_MS);
    },
    async drainOutput() {
      const stdout = child.stdout;
      if (stdout) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          new Promise<void>((r) => (stdout.readableEnded ? r() : stdout.once("end", () => r()))),
          new Promise<void>((r) => (timer = setTimeout(r, DRAIN_MS))),
        ]);
        clearTimeout(timer);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
    // Verbatim from the legacy agentRunner, with async snapshots.
    async reap() {
      if (!tree) return;
      const waitGone = async (ms: number): Promise<boolean> => {
        const until = Date.now() + ms;
        for (;;) {
          const s = await fresh();
          if (tree.alive(s).length === 0) return true;
          if (Date.now() >= until) return false;
          await delay(100);
        }
      };
      if (await waitGone(terminating ? o.killGraceMs : 1000)) return;
      if (!terminating) {
        tree.signalAll("SIGTERM", await fresh());
        if (await waitGone(o.killGraceMs)) return;
      }
      tree.signalAll("SIGKILL", await fresh());
      await waitGone(1000);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(poller);
      clearTimeout(killTimer);
      clearTimeout(capTimer);
      signalGroup("SIGKILL");
    },
  };
}
