import type { Candidate } from "@scout/contracts";
import { ContextStatusSchema, type RankRequest, type RankResponse } from "personal-context-mcp/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "../clock.js";
import { createAckTracker } from "./ackTracker.js";
import { createRankJob, type RankCall, type RankJobOptions, type RankJobOutcome, type RankJobState } from "./rankJob.js";
import type { TransportResult } from "./transport.js";

const STATUS = { serviceInstanceId: "svc-1", activityRevision: 7, sourceGrantRevision: "grant-a" };
const SITE = { origin: "https://docs.stripe.com" };
const CANDIDATES: Candidate[] = [
  { id: "c0", sourceUrl: "https://docs.stripe.com/a", title: "A", labelQuality: "published", provenance: "llms.txt" },
  {
    id: "c1",
    sourceUrl: "https://docs.stripe.com/b",
    title: "B",
    description: "about b",
    labelQuality: "slug",
    provenance: "sitemap",
  },
];

const ok = (id: string): TransportResult<RankResponse> => ({
  ok: true,
  value: { status: "ok", items: [{ id, reason: "fits", evidence: [{ id: "e1", kind: "note", label: "n" }] }], droppedCount: 0, ...STATUS },
});

interface Call {
  req: RankRequest;
  signal: AbortSignal;
  at: number;
  resolve: (r: TransportResult<RankResponse>) => void;
  reject: (e: unknown) => void;
}

function fakeRank(): { rank: RankCall; calls: Call[] } {
  const calls: Call[] = [];
  const rank: RankCall = (req, signal) =>
    new Promise((resolve, reject) => {
      calls.push({ req, signal, at: Date.now(), resolve, reject });
    });
  return { rank, calls };
}

const clock: Clock = { now: () => Date.now() };
let t0: number;
let revision: number;

function makeJob(overrides: Partial<RankJobOptions> = {}) {
  const fake = fakeRank();
  const states: RankJobState[] = [];
  let n = 0;
  const job = createRankJob({
    epoch: 3,
    visitStartedAt: t0,
    clock,
    rank: fake.rank,
    getContextRevision: () => revision,
    waitForAcks: async () => {},
    onState: (s) => states.push(s),
    newRequestId: () => `r${++n}`,
    ...overrides,
  });
  return { job, ...fake, states };
}

/** Let the job's microtasks run (ack wait, rank start) without moving time. */
const flush = () => vi.advanceTimersByTimeAsync(0);

function expectContextStatus(outcome: RankJobOutcome): void {
  if (outcome.kind !== "result") throw new Error("expected a result");
  expect(ContextStatusSchema.safeParse(outcome.response).success).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  t0 = Date.now();
  revision = 1;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ack wait", () => {
  it("waits for an activity ack that arrives within 1 s", async () => {
    const acks = createAckTracker();
    acks.track(new Promise((resolve) => setTimeout(resolve, 800)));
    const { job, calls } = makeJob({ waitForAcks: (ms) => acks.waitForAcks(ms) });
    void job.run(SITE, CANDIDATES);
    await vi.advanceTimersByTimeAsync(799);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.at - t0).toBe(800);
  });

  it("stops waiting at 1 s for an ack that arrives later", async () => {
    const acks = createAckTracker();
    acks.track(new Promise((resolve) => setTimeout(resolve, 1500)));
    const { job, calls } = makeJob({ waitForAcks: (ms) => acks.waitForAcks(ms) });
    void job.run(SITE, CANDIDATES);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.at - t0).toBe(1000);
  });

  it("clears the cap's timer once every ack has arrived", async () => {
    const acks = createAckTracker();
    acks.track(new Promise((resolve) => setTimeout(resolve, 100)));
    const waited = acks.waitForAcks(1000);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    await waited;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records the revision after the ack wait, not before", async () => {
    const { job, calls } = makeJob({
      waitForAcks: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            revision = 2;
            resolve();
          }, 300),
        ),
    });
    void job.run(SITE, CANDIDATES);
    await vi.advanceTimersByTimeAsync(300);
    expect(job.state).toEqual({ kind: "ranking", rev: 2, requestId: calls[0]!.req.requestId });
  });
});

describe("deadline", () => {
  it("sends deadlineMs = visitDeadline - now - 4000, capped at 26000", async () => {
    for (const [elapsed, deadlineMs] of [
      [0, 26_000],
      [10_000, 16_000],
      [20_999, 5_001],
    ] as const) {
      const { job, calls } = makeJob({ visitStartedAt: Date.now() - elapsed });
      void job.run(SITE, CANDIDATES);
      await flush();
      const visitDeadline = Date.now() - elapsed + 30_000;
      expect(calls[0]!.req.deadlineMs).toBe(deadlineMs);
      expect(calls[0]!.req.deadlineMs).toBe(Math.min(visitDeadline - Date.now() - 4000, 26_000));
      job.cancel();
    }
  });

  it("caps deadlineMs at 26000 even with a longer visit budget", async () => {
    const { job, calls } = makeJob({ visitDeadlineMs: 60_000 });
    void job.run(SITE, CANDIDATES);
    await flush();
    expect(calls[0]!.req.deadlineMs).toBe(26_000);
    job.cancel();
  });

  it("never exceeds the visit's remaining time minus 4 s after the ack wait", async () => {
    const { job, calls } = makeJob({
      visitStartedAt: t0 - 3_000,
      waitForAcks: () => new Promise((resolve) => setTimeout(resolve, 1000)),
    });
    void job.run(SITE, CANDIDATES);
    await vi.advanceTimersByTimeAsync(1000);
    const remaining = t0 - 3_000 + 30_000 - calls[0]!.at;
    expect(calls[0]!.req.deadlineMs).toBe(remaining - 4000);
    job.cancel();
  });

  it("skips the rank with `no time left` under 5 s", async () => {
    const { job, calls } = makeJob({ visitStartedAt: t0 - 21_500 });
    const outcome = await job.run(SITE, CANDIDATES);
    expect(calls).toHaveLength(0);
    expect(outcome).toMatchObject({ kind: "result", source: "local", response: { status: "unavailable", reason: "no time left" } });
    expectContextStatus(outcome);
    expect(job.finished).toBe(true);
  });

  it("aborts a call that runs past its budget and reports `timed out`, never empty", async () => {
    const { job, calls } = makeJob();
    const result = job.run(SITE, CANDIDATES);
    await flush();
    await vi.advanceTimersByTimeAsync(26_000);
    expect(calls[0]!.signal.aborted).toBe(true);
    const outcome = await result;
    expect(outcome).toMatchObject({ kind: "result", response: { status: "unavailable", reason: "timed out" } });
    expectContextStatus(outcome);
  });

  it("reports the service's own deadline cancel as `timed out`", async () => {
    const { job, calls } = makeJob();
    const result = job.run(SITE, CANDIDATES);
    await flush();
    calls[0]!.resolve({ ok: true, value: { status: "cancelled", reason: "deadline", ...STATUS } });
    expect(await result).toMatchObject({ response: { status: "unavailable", reason: "timed out", ...STATUS } });
  });
});

describe("request", () => {
  it("maps candidates and asks for at most 3 results", async () => {
    const { job, calls } = makeJob();
    void job.run(SITE, CANDIDATES);
    await flush();
    expect(calls[0]!.req).toEqual({
      requestId: "r1",
      site: { origin: "https://docs.stripe.com" },
      candidates: [
        { id: "c0", title: "A", labelQuality: "published" },
        { id: "c1", title: "B", description: "about b", labelQuality: "slug" },
      ],
      maxResults: 3,
      deadlineMs: 26_000,
    });
    job.cancel();
  });
});

describe("dirty re-rank", () => {
  it("one page_text during ranking discards the old result and starts exactly one re-rank", async () => {
    const { job, calls, states } = makeJob();
    const result = job.run(SITE, CANDIDATES);
    await flush();
    revision = 2;
    job.notifyContextChanged();
    expect(job.state.kind).toBe("dirty");
    calls[0]!.resolve(ok("c0"));
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.req.supersedes).toBe(calls[0]!.req.requestId);
    expect(states).toContainEqual({ kind: "ranking", rev: 2, requestId: "r2" });
    calls[1]!.resolve(ok("c1"));
    const outcome = await result;
    expect(outcome).toMatchObject({ kind: "result", source: "service", rev: 2, response: { items: [{ id: "c1" }] } });
    expect(calls).toHaveLength(2);
  });

  it("three arrivals during one rank still start one re-rank", async () => {
    const { job, calls } = makeJob();
    const result = job.run(SITE, CANDIDATES);
    await flush();
    for (let i = 0; i < 3; i++) {
      revision += 1;
      job.notifyContextChanged();
    }
    calls[0]!.resolve(ok("c0"));
    await flush();
    expect(calls).toHaveLength(2);
    calls[1]!.resolve(ok("c1"));
    await result;
    expect(calls).toHaveLength(2);
  });

  it("an arrival during the re-rank chains one more, superseding the re-rank", async () => {
    const { job, calls } = makeJob();
    const result = job.run(SITE, CANDIDATES);
    await flush();
    revision = 2;
    job.notifyContextChanged();
    calls[0]!.resolve(ok("c0"));
    await flush();
    revision = 3;
    job.notifyContextChanged();
    calls[1]!.resolve(ok("c1"));
    await flush();
    expect(calls).toHaveLength(3);
    expect(calls[2]!.req.supersedes).toBe(calls[1]!.req.requestId);
    calls[2]!.resolve(ok("c0"));
    expect(await result).toMatchObject({ rev: 3 });
  });

  it("a revision bump without a notification is also caught when the rank returns", async () => {
    const { job, calls } = makeJob();
    void job.run(SITE, CANDIDATES);
    await flush();
    revision = 2;
    calls[0]!.resolve(ok("c0"));
    await flush();
    expect(calls).toHaveLength(2);
    job.cancel();
  });

  it("skips the re-rank when under 5 s remain and ends `timed out`", async () => {
    const { job, calls } = makeJob();
    const result = job.run(SITE, CANDIDATES);
    await flush();
    revision = 2;
    job.notifyContextChanged();
    await vi.advanceTimersByTimeAsync(21_500);
    calls[0]!.resolve(ok("c0"));
    const outcome = await result;
    expect(calls).toHaveLength(1);
    expect(outcome).toMatchObject({ kind: "result", source: "local", response: { status: "unavailable", reason: "timed out" } });
    expectContextStatus(outcome);
    expect(job.finished).toBe(true);
  });

  it("a notification while idle does nothing", () => {
    const { job, states } = makeJob();
    job.notifyContextChanged();
    expect(job.state).toEqual({ kind: "idle" });
    expect(states).toHaveLength(0);
  });
});

describe("cancel and failure", () => {
  it("cancel() aborts the signal and emits nothing", async () => {
    const { job, calls } = makeJob();
    const result = job.run(SITE, CANDIDATES);
    await flush();
    job.cancel();
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(await result).toEqual({ kind: "cancelled" });
    expect(job.state).toEqual({ kind: "idle" });
    calls[0]!.resolve(ok("c0"));
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("cancel() emits idle once", async () => {
    const { job, states } = makeJob();
    const result = job.run(SITE, CANDIDATES);
    await flush();
    job.cancel();
    await result;
    expect(states.map((s) => s.kind)).toEqual(["ranking", "idle"]);
  });

  // cancel() can land in any microtask after the ack wait settles; at no depth may a rank
  // call be left running for the dead visit.
  it("a cancel right after the ack wait never leaves a live rank call", async () => {
    for (let depth = 0; depth < 10; depth++) {
      let ackResolve!: () => void;
      const { job, calls } = makeJob({ waitForAcks: () => new Promise<void>((resolve) => (ackResolve = resolve)) });
      const result = job.run(SITE, CANDIDATES);
      await flush();
      ackResolve();
      let q = Promise.resolve();
      for (let i = 0; i < depth; i++) q = q.then(() => {});
      void q.then(() => job.cancel());
      expect(await result).toEqual({ kind: "cancelled" });
      expect(calls.length).toBeLessThanOrEqual(1);
      for (const call of calls) expect(call.signal.aborted).toBe(true);
    }
  });

  it("cancel() before run() ends the job without calling the service", async () => {
    const { job, calls } = makeJob();
    job.cancel();
    expect(await job.run(SITE, CANDIDATES)).toEqual({ kind: "cancelled" });
    expect(calls).toHaveLength(0);
  });

  it("a rejecting ack wait still finishes the job as unavailable", async () => {
    const { job, calls } = makeJob({ waitForAcks: async () => Promise.reject(new Error("boom")) });
    const outcome = await job.run(SITE, CANDIDATES);
    expect(calls).toHaveLength(0);
    expect(outcome).toMatchObject({ kind: "result", source: "local", response: { status: "unavailable", reason: "service unreachable" } });
    expectContextStatus(outcome);
    expect(job.finished).toBe(true);
    expect(job.state).toEqual({ kind: "idle" });
  });

  it("cancel() during the ack wait ends the job without calling the service", async () => {
    const { job, calls } = makeJob({ waitForAcks: () => new Promise((resolve) => setTimeout(resolve, 1000)) });
    const result = job.run(SITE, CANDIDATES);
    await vi.advanceTimersByTimeAsync(200);
    job.cancel();
    expect(await result).toEqual({ kind: "cancelled" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(0);
  });

  it("a rank that rejects finishes the job as unavailable", async () => {
    const { job, calls } = makeJob();
    const result = job.run(SITE, CANDIDATES);
    await flush();
    calls[0]!.reject(new Error("boom"));
    const outcome = await result;
    expect(outcome).toMatchObject({ kind: "result", source: "local", response: { status: "unavailable", reason: "service unreachable" } });
    expectContextStatus(outcome);
    expect(job.finished).toBe(true);
  });

  it("a transport failure passes its status through with the last known ContextStatus", async () => {
    const { job, calls } = makeJob({ lastContextStatus: () => STATUS });
    const result = job.run(SITE, CANDIDATES);
    await flush();
    calls[0]!.resolve({ ok: false, status: "unavailable", reason: "bad token" });
    expect(await result).toMatchObject({ response: { status: "unavailable", ...STATUS } });
  });

  it("run() may be called only once", () => {
    const { job } = makeJob();
    void job.run(SITE, CANDIDATES);
    expect(() => job.run(SITE, CANDIDATES)).toThrow();
    job.cancel();
  });
});

describe("ContextStatus on every response", () => {
  it("service results keep the service's fields", async () => {
    const { job, calls } = makeJob();
    const result = job.run(SITE, CANDIDATES);
    await flush();
    calls[0]!.resolve({ ok: true, value: { status: "empty", ...STATUS } });
    const outcome = await result;
    expectContextStatus(outcome);
    expect(outcome).toMatchObject({ response: STATUS });
  });
});
