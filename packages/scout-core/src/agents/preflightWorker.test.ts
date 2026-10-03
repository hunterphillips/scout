import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PreflightInput } from "./claudeJob.js";
import { createPreflightFacade, preflightFingerprint, runPreflightInChild, type PreflightReportLike } from "./preflightWorker.js";
import { installFakeCli } from "./testing/fakeCli.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The PIDs the slow CLI wrapper recorded (the shell and its sleep), once it has started. */
const pidsIn = (input: PreflightInput): number[] => {
  const file = join(input.claudePath, "..", "pids");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : [];
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function sandbox(delaySeconds: number): PreflightInput {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "spw-")));
  dirs.push(base);
  chmodSync(base, 0o700);
  const userHome = join(base, "u");
  const scoutHome = join(base, "h");
  mkdirSync(join(userHome, ".claude"), { recursive: true });
  mkdirSync(scoutHome, { mode: 0o700 });
  const fake = installFakeCli(base, "ok", "2.1.286");
  // Each allowlisted call sleeps first: a slow CLI the main thread must not wait on. It records
  // its own PID and its sleep's, so a test can see the whole tree go.
  const slow = join(base, "bin", "slow-claude");
  const pids = join(base, "bin", "pids");
  writeFileSync(slow, `#!/bin/sh\necho $$ >> '${pids}'\nsleep ${delaySeconds} &\necho $! >> '${pids}'\nwait $!\nexec '${fake.path}' "$@"\n`);
  chmodSync(slow, 0o755);
  return {
    parentEnv: { HOME: userHome, PATH: "/usr/bin:/bin", USER: "someone", LOGNAME: "someone", LANG: "en_US.UTF-8", TMPDIR: tmpdir() },
    claudePath: slow,
    model: "claude-sonnet-5-5",
    jobsRoot: join(scoutHome, "run", "jobs"),
  };
}

describe("runPreflightInChild", () => {
  it("runs the blocking preflight off the event loop: timers keep firing while a slow CLI answers", async () => {
    const input = sandbox(0.4);
    let last = Date.now();
    let worstGap = 0;
    const tick = setInterval(() => {
      const now = Date.now();
      worstGap = Math.max(worstGap, now - last);
      last = now;
    }, 5);
    const started = Date.now();
    const report = await runPreflightInChild(input);
    clearInterval(tick);
    // Four CLI calls at 0.4 s each: the preflight itself took over a second.
    expect(Date.now() - started).toBeGreaterThan(1000);
    expect(worstGap).toBeLessThan(50);
    expect(report.cliVersion).toBe("2.1.286");
    expect(report.reasons.every((r) => typeof r === "string")).toBe(true);
  }, 20_000);

  it("a child that overruns its bound is killed with the CLI it waits on, and reported ambiguous", async () => {
    const input = sandbox(30);
    // 2 s: under load the child's own start and its spawn of the slow CLI must fit inside the bound.
    const report = await runPreflightInChild(input, { maxMs: 2_000 });
    expect(report).toEqual({ verdict: "ambiguous", reasons: ["internal: preflight child timed out"] });
    expect(pidsIn(input)).toHaveLength(2);
    await until(() => !pidsIn(input).some(alive), 2_000);
  }, 20_000);

  it("a cancel kills a child stuck in a slow CLI at once: ambiguous within 200 ms, its whole tree gone", async () => {
    const input = sandbox(30);
    const ac = new AbortController();
    const run = runPreflightInChild(input, { signal: ac.signal });
    // The child is blocked in spawnSync on the slow CLI.
    await until(() => pidsIn(input).length === 2);
    const at = Date.now();
    ac.abort();
    const report = await run;
    expect(Date.now() - at).toBeLessThan(200);
    expect(report).toEqual({ verdict: "ambiguous", reasons: ["internal: preflight cancelled"] });
    await until(() => !pidsIn(input).some(alive), 2_000);
    // Already aborted: no child at all.
    expect(await runPreflightInChild(sandbox(0), { signal: ac.signal })).toEqual({ verdict: "ambiguous", reasons: ["internal: preflight cancelled"] });
  }, 20_000);

  it("a missing entrypoint is ambiguous, never a throw", async () => {
    const report = await runPreflightInChild(sandbox(0), { entrypoint: "/nonexistent/child.js" });
    expect(report.verdict).toBe("ambiguous");
  });
});

describe("createPreflightFacade", () => {
  const input: PreflightInput = { parentEnv: { HOME: "/h", PATH: "/bin" }, claudePath: "/c", model: "claude-sonnet-5-5", jobsRoot: "/j" };

  function counted(reports: PreflightReportLike[]) {
    const calls: PreflightInput[] = [];
    const run = async (i: PreflightInput): Promise<PreflightReportLike> => {
      calls.push(i);
      return reports[Math.min(calls.length - 1, reports.length - 1)]!;
    };
    return { run, calls };
  }

  it("caches per environment fingerprint and shares one run between concurrent calls", async () => {
    const { run, calls } = counted([{ verdict: "subscription", reasons: [], cliVersion: "2.1.286" }]);
    const facade = createPreflightFacade({ run });
    const [a, b] = await Promise.all([facade(input), facade(input)]);
    expect(a).toEqual(b);
    expect(await facade(input)).toMatchObject({ verdict: "subscription" });
    expect(calls).toHaveLength(1);
    // Another environment is another key.
    await facade({ ...input, parentEnv: { ...input.parentEnv, ANTHROPIC_BASE_URL: "http://127.0.0.1:1" } });
    expect(calls).toHaveLength(2);
    expect(facade.runs).toBe(2);
  });

  it("re-runs when a job saw another CLI version, then caches the new one", async () => {
    const { run, calls } = counted([
      { verdict: "subscription", reasons: [], cliVersion: "2.1.286" },
      { verdict: "subscription", reasons: [], cliVersion: "2.1.300" },
    ]);
    const facade = createPreflightFacade({ run });
    await facade(input);
    expect(await facade(input, "2.1.286")).toMatchObject({ cliVersion: "2.1.286" });
    expect(calls).toHaveLength(1);
    expect(await facade(input, "2.1.300")).toMatchObject({ cliVersion: "2.1.300" });
    expect(calls).toHaveLength(2);
    expect(await facade(input, "2.1.300")).toMatchObject({ cliVersion: "2.1.300" });
    expect(calls).toHaveLength(2);
  });

  it("a report without a CLI version is not cached, and a failed run is ambiguous", async () => {
    let n = 0;
    const facade = createPreflightFacade({
      run: async () => {
        n += 1;
        if (n === 2) throw new Error("boom /secret/path");
        return { verdict: "ambiguous", reasons: ["cli: claude not reachable"] };
      },
    });
    await facade(input);
    expect(await facade(input)).toEqual({ verdict: "ambiguous", reasons: ["internal: preflight failed unexpectedly"] });
    expect(n).toBe(2);
  });

  it("cancelAll kills the run in flight (ambiguous, never cached) and refuses every later run", async () => {
    const signals: AbortSignal[] = [];
    const facade = createPreflightFacade({
      run: (_i, signal) =>
        new Promise((resolve) => {
          signals.push(signal);
          signal.addEventListener("abort", () => resolve({ verdict: "subscription", reasons: [], cliVersion: "2.1.286" }));
        }),
    });
    const pending = facade(input);
    facade.cancelAll();
    expect(signals[0]!.aborted).toBe(true);
    await pending;
    expect(await facade(input)).toEqual({ verdict: "ambiguous", reasons: ["internal: preflight cancelled"] });
    expect(facade.runs).toBe(1);
  });

  it("the fingerprint ignores key order and undefined values", () => {
    const a = preflightFingerprint({ ...input, parentEnv: { A: "1", B: "2", C: undefined } });
    const b = preflightFingerprint({ ...input, parentEnv: { B: "2", A: "1" } });
    expect(a).toBe(b);
    expect(preflightFingerprint({ ...input, model: "claude-opus-5-5" })).not.toBe(a);
  });
});
