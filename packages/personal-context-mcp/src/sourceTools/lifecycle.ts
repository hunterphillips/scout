// When the source-tools server stops: stdin EOF or close, SIGTERM/SIGINT/SIGHUP, or
// orphaned. Orphaned means the parent PID has become 1 or has otherwise changed from the
// one seen at start (a subreaper can adopt the process instead of launchd), checked every
// second on an unref'd timer so the check never keeps the process alive by itself.

export const ORPHAN_CHECK_MS = 1_000;

export type ExitReason = "stdin_eof" | "orphaned" | "SIGTERM" | "SIGINT" | "SIGHUP";

interface Listenable {
  on(event: string, fn: () => void): unknown;
}

export interface LifecycleDeps {
  stdin: Listenable;
  /** Signal source; defaults to none (tests), the entrypoint passes `process`. */
  signals?: Listenable;
  getppid: () => number;
  /** Called once, with the first reason seen. */
  onExit: (reason: ExitReason) => void;
  intervalMs?: number;
}

export function watchLifecycle(deps: LifecycleDeps): { stop(): void } {
  const initialPpid = deps.getppid();
  let done = false;
  const exit = (reason: ExitReason): void => {
    if (done) return;
    done = true;
    clearInterval(timer);
    deps.onExit(reason);
  };
  const timer = setInterval(() => {
    const ppid = deps.getppid();
    if (ppid === 1 || ppid !== initialPpid) exit("orphaned");
  }, deps.intervalMs ?? ORPHAN_CHECK_MS);
  timer.unref();
  deps.stdin.on("end", () => exit("stdin_eof"));
  deps.stdin.on("close", () => exit("stdin_eof"));
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) deps.signals?.on(sig, () => exit(sig));
  return {
    stop() {
      done = true;
      clearInterval(timer);
    },
  };
}
