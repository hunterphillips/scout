import type { ActiveVisit, Candidate, HostJobResult, JobRequest, PanelState } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import { createSnapshotRegistry, type SnapshotReleaseReason } from "./activity/snapshots.js";
import type { StoredActivity } from "./activity/store.js";
import { createAgentAuth } from "./agentApi/auth.js";
import { MIN_LAUNCH_MS, type JobDetails, type JobOutcome, type JobRunOptions } from "./agents/adapter.js";
import type { Ending } from "./agents/jobStop.js";
import type { PromptActivity } from "./agents/prompt.js";
import { emptyState } from "./capabilities/decisions.js";
import type { CatalogResolution } from "./catalog/resolveCatalog.js";
import type { DiagnosticFields, Diagnostics } from "./diagnostics.js";
import { createJobScheduler, type JobSchedulerOptions, MIN_JOB_MS } from "./jobScheduler.js";
import { createPanelChannel, type PanelStore } from "./panelChannel.js";
import { type JobAnswer, VERIFY_RESERVE_MS, type VerifyFn } from "./pipeline.js";
import { createResultRegistry } from "./results.js";
import { createJobResumeCache } from "./resumeCache.js";

const ORIGIN = "https://docs.stripe.com";
const CORE = "core-test";

const CANDIDATES: Candidate[] = ["a", "b", "c", "d"].map((p, i) => ({
  id: `c${i}`,
  sourceUrl: `${ORIGIN}/${p}`,
  title: `Title ${p}`,
  labelQuality: "published" as const,
  provenance: "llms.txt" as const,
}));

const catalog = (candidates: Candidate[] = CANDIDATES): CatalogResolution => ({
  result: { ok: true, source: "fresh", stale: false, catalog: { origin: ORIGIN, version: "cat-v1", fetchedAt: 0, candidates, truncated: false, errors: [] } },
  stats: { requests: 0, refused: 0, bytesReceived: 0, ms: 0 },
});

const ISSUE: StoredActivity = {
  origin: "https://github.com",
  url: "https://github.com/o/r/issues/1",
  observedAt: 1,
  source: "github_issue",
  title: "Metered billing",
  text: "We need usage-based billing",
  textTruncated: false,
  revision: 1,
};

const emptyStore = {
  snapshot: () => emptyState(),
  getResource: () => undefined,
  originPolicy: () => undefined,
  readBlob: () => Buffer.alloc(0),
  pinForPreview: () => false,
  releasePins: () => {},
  approve: async () => {
    throw new Error("unused");
  },
  decline: async () => {
    throw new Error("unused");
  },
  revoke: async () => {
    throw new Error("unused");
  },
  setOriginPolicy: async () => {
    throw new Error("unused");
  },
  approvalRevision: 0,
} satisfies PanelStore;

const details = (extra: Partial<JobDetails> = {}): JobDetails => ({
  adapter: "fake",
  termination: "completed",
  toolUses: [],
  optionalTools: [],
  droppedPicks: 0,
  cutPicks: 0,
  toolErrors: {},
  optionalToolFailed: false,
  timings: { totalMs: 10, apiMs: 7 },
  usage: { turns: 2 },
  ...extra,
});

interface AgentCall {
  request: JobRequest;
  options: JobRunOptions & { activity?: readonly PromptActivity[] };
  answer(ending: Ending, extra?: Partial<JobDetails>): void;
}

/** A controllable agent. A cancel answers `cancelled` with the signal's reason, unless `drainOk` (the adapter's ~1.5 s window). */
function fakeAgent() {
  const calls: AgentCall[] = [];
  let drainOk = false;
  const agent = {
    run(request: JobRequest, options: JobRunOptions & { activity?: readonly PromptActivity[] }): Promise<JobOutcome> {
      return new Promise((resolve) => {
        const identity = { requestId: request.requestId, coreInstanceId: request.coreInstanceId, visitEpoch: request.visitEpoch };
        const answer = (ending: Ending, extra: Partial<JobDetails> = {}): void => resolve({ result: { ...identity, ...ending } as HostJobResult, details: details(extra) });
        calls.push({ request, options, answer });
        options.signal?.addEventListener("abort", () => {
          if (drainOk) answer({ status: "ok", items: [{ id: "c0", reason: "late" }] });
          else answer({ status: "cancelled", reason: options.signal!.reason } as Ending);
        });
      });
    },
  };
  return { agent, calls, setDrainOk: (v: boolean) => (drainOk = v) };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function harness(overrides: Partial<JobSchedulerOptions> & { coreInstanceId?: string; registryInstanceId?: string } = {}) {
  const clock = { t: 100_000, now: () => clock.t };
  const world = {
    visit: { origin: ORIGIN, url: `${ORIGIN}/billing`, epoch: 3, at: 0, tabId: 1, contextRevision: 0 } as unknown as ActiveVisit | null,
    paused: false,
    permissionsRevision: 7 as number | null,
    permitted: new Set([ORIGIN, "https://github.com"]),
    capture: true,
    grant: true,
    grantRevision: 0,
    activity: [ISSUE] as StoredActivity[],
    approved: [] as { resource: { id: string }; version: { hash: string } }[],
  };
  const events: { name: string; fields: DiagnosticFields }[] = [];
  const diagnostics: Diagnostics = { failures: 0, event: (name, fields = {}) => void events.push({ name, fields }) };
  const frames: PanelState[] = [];
  const results = createResultRegistry({
    coreInstanceId: overrides.registryInstanceId ?? CORE,
    activeVisit: () => (world.visit === null || world.paused ? null : { visitEpoch: world.visit.epoch, origin: world.visit.origin }),
    isPermitted: (o) => world.permitted.has(o),
    diagnostics,
  });
  // Frames as the window gets them: the coordinator's state frames and the channel's results frames on one stream.
  const channel = createPanelChannel({
    store: emptyStore,
    coreInstanceId: CORE,
    exportConflicts: () => [],
    readBrowserContextGrant: () => world.grant,
    writeBrowserContextGrant: () => ({ restore: () => {} }),
    getAudit: () => [],
    isPermitted: (o) => world.permitted.has(o),
    currentOrigin: () => world.visit?.origin ?? null,
    emit: (f) => void frames.push(f),
    results,
    resendState: () => {},
    clock,
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    diagnostics,
  });
  const releases: { id: string; reason: SnapshotReleaseReason | undefined }[] = [];
  const auth = createAgentAuth({ interactiveToken: "interactive-token", clock });
  const registry = createSnapshotRegistry({
    store: {
      listApproved: () => world.approved as never,
      pinVersion: () => ({ ok: true }) as never,
      releasePins: () => {},
      approvalRevision: 0,
    },
    auth,
    clock,
    paused: () => world.paused,
  });
  const snapshots = {
    take: registry.take,
    get: registry.get,
    release: (id: string, reason?: SnapshotReleaseReason) => {
      releases.push({ id, reason });
      registry.release(id, reason);
    },
  };
  const verified: Candidate[][] = [];
  const verify: VerifyFn = async (candidates) => {
    verified.push([...candidates]);
    return { verified: candidates.map((c) => ({ ...c, humanHref: c.sourceUrl })), dropped: [], ms: 1 };
  };
  const a = fakeAgent();
  let ids = 0;
  const scheduler = createJobScheduler({
    coreInstanceId: CORE,
    clock,
    diagnostics,
    destinations: ["docs.stripe.com"],
    results,
    snapshots: () => snapshots,
    view: {
      visit: () => (world.paused ? null : world.visit),
      permissionsRevision: () => world.permissionsRevision,
      isPermitted: (o) => world.permitted.has(o),
      captureAllowed: () => world.capture && !world.paused,
    },
    window: {
      working: (visitEpoch, jobId) => {
        if (world.visit?.epoch === visitEpoch && !world.paused) frames.push({ type: "state", status: "working", visitEpoch, jobId });
      },
      idle: (visitEpoch) => {
        if (world.visit?.epoch === visitEpoch && !world.paused) frames.push({ type: "state", status: "idle", visitEpoch, permitted: true });
      },
    },
    activity: () => world.activity,
    browserContextGranted: () => world.grant,
    grantRevision: () => world.grantRevision,
    approvalRevision: () => 0,
    agent: a.agent,
    profile: { fingerprint: "fp-1", toolsRevision: 0, hasUserTools: false },
    socketPath: "/tmp/agent.sock",
    verify,
    newJobId: () => `job${++ids}`,
    ...overrides,
  });
  const settle = (at = clock.t, c: CatalogResolution = catalog()) => scheduler.onSettled(world.visit!, c, at);
  const named = (name: string) => events.filter((e) => e.name === name).map((e) => e.fields);
  const states = () => frames.filter((f) => f.type === "state" || f.type === "results").map((f) => (f.type === "state" ? `${f.status}${f.jobId ? `:${f.jobId}` : ""}` : `results:${f.status}:${f.jobId}`));
  return { clock, world, events, named, frames, states, results, scheduler, channel, settle, agent: a, releases, registry, verified };
}

const ok = (ids: string[]): Ending => ({ status: "ok", items: ids.map((id) => ({ id, reason: `fits ${id}` })) });

describe("job scheduler: one job, its order, and its answer", () => {
  it("working{jobId} → idle → results, and never an idle after the results (frames as the window gets them)", async () => {
    const h = harness();
    h.settle();
    expect(h.states()).toEqual(["working:job1"]);
    expect(h.agent.calls).toHaveLength(1);
    const { request, options } = h.agent.calls[0]!;
    // Explicit field mapping: the model never sees a link.
    expect(JSON.stringify(request.candidates)).not.toContain("https://");
    expect(request).toMatchObject({ requestId: "job1", coreInstanceId: CORE, visitEpoch: 3, origin: ORIGIN, catalogHash: "cat-v1", maxPicks: 3, profileFingerprint: "fp-1" });
    expect(options.activity).toEqual([{ title: ISSUE.title, text: ISSUE.text }]);
    h.agent.calls[0]!.answer(ok(["c2", "c0"]));
    await flush();
    expect(h.states()).toEqual(["working:job1", "idle", "results:ok:job1"]);
    const results = h.frames.at(-1)!;
    expect(results).toMatchObject({ type: "results", status: "ok", items: [{ candidateId: "c2", title: "Title c", reason: "fits c2", hostname: "docs.stripe.com" }, { candidateId: "c0" }] });
    expect(JSON.stringify(results)).not.toContain(`${ORIGIN}/`);
    expect(h.results.current()).toMatchObject({ status: "ok", items: [{ href: `${ORIGIN}/c` }, { href: `${ORIGIN}/a` }] });
    expect(h.verified).toEqual([[CANDIDATES[2], CANDIDATES[0]]]);
    expect(h.releases).toEqual([{ id: expect.any(String), reason: "released" }]);
    expect(h.registry.size).toBe(0);
    expect(h.named("job_started")).toEqual([{ epoch: 3, candidates: 4, activity: 1, deadlineMs: 30_000, replacement: false }]);
    expect(h.named("job_finished")).toEqual([{ status: "ok", epoch: 3, durationMs: 0, termination: "completed", apiMs: 7, turns: 2 }]);
    expect(h.named("verify")).toEqual([{ epoch: 3, picked: 2, verified: 2 }]);
    // Nothing a model wrote reaches diagnostics.
    expect(JSON.stringify(h.events)).not.toContain("fits");
  });

  it("only recommendation-enabled hosts get a job; no candidates is no job", () => {
    const h = harness({ destinations: ["www.peakdesign.com"] });
    h.settle();
    expect(h.agent.calls).toHaveLength(0);
    expect(h.frames).toEqual([]);
    expect(h.named("job_skipped")).toEqual([{ epoch: 3, reason: "not_enabled" }]);
    expect(h.scheduler.isEnabled(ORIGIN)).toBe(false);
    const g = harness();
    g.settle(g.clock.t, catalog([]));
    expect(g.named("job_skipped")).toEqual([{ epoch: 3, reason: "no_candidates" }]);
  });

  it("one job at a time: a second settle for the same visit is skipped", () => {
    const h = harness();
    h.settle();
    h.settle();
    expect(h.agent.calls).toHaveLength(1);
    expect(h.named("job_skipped")).toEqual([{ epoch: 3, reason: "busy" }]);
  });

  it("under 5 s of the visit budget left: unavailable no_time_left, nothing launched", () => {
    const h = harness();
    h.settle(h.clock.t - (30_000 - MIN_JOB_MS + 1));
    expect(h.agent.calls).toHaveLength(0);
    expect(h.states()).toEqual(["working:job1", "idle", "results:unavailable:job1"]);
    expect(h.frames.at(-1)).toMatchObject({ reason: "no_time_left" });
  });

  it("one launch threshold: exactly MIN_JOB_MS left starts a job the adapter's launch floor accepts; a millisecond less starts none", () => {
    expect(MIN_JOB_MS).toBe(MIN_LAUNCH_MS + VERIFY_RESERVE_MS);
    const h = harness();
    h.settle(h.clock.t - (30_000 - MIN_JOB_MS));
    expect(h.agent.calls).toHaveLength(1);
    const { request, options } = h.agent.calls[0]!;
    // What the adapter checks against its floor: exactly MIN_LAUNCH_MS, never less.
    expect(options.deadline! - h.clock.t).toBe(MIN_LAUNCH_MS);
    expect(request.deadlineMs).toBe(MIN_LAUNCH_MS);
    const g = harness();
    g.settle(g.clock.t - (30_000 - MIN_JOB_MS + 1));
    expect(g.agent.calls).toHaveLength(0);
    expect(g.frames.at(-1)).toMatchObject({ type: "results", status: "unavailable", reason: "no_time_left" });
  });

  it("the job gets what remains of the visit budget, less the verification reserve", () => {
    const h = harness();
    h.settle(h.clock.t - 10_000);
    expect(h.agent.calls[0]!.request.deadlineMs).toBe(20_000 - 4_000);
    expect(h.agent.calls[0]!.options.deadline).toBe(h.clock.t + 16_000);
  });

  it("the snapshot carries activity only with the browser-context grant on and GitHub capture allowed", () => {
    for (const [grant, capture, expected] of [
      [true, true, 1],
      [false, true, 0],
      [true, false, 0],
    ] as const) {
      const h = harness();
      h.world.grant = grant;
      h.world.capture = capture;
      h.settle();
      expect(h.agent.calls[0]!.options.activity).toHaveLength(expected);
      expect(h.named("job_started")[0]).toMatchObject({ activity: expected });
    }
  });

  it("an intentional empty is published as empty, distinct from a failure", async () => {
    const h = harness();
    h.settle();
    h.agent.calls[0]!.answer({ status: "empty" });
    await flush();
    expect(h.states()).toEqual(["working:job1", "idle", "results:empty:job1"]);
    expect(h.verified).toEqual([]);
  });

  it("picks whose targets all fail verification: error agent_failed and verifyAllFailed, never empty", async () => {
    const h = harness({ verify: async (c) => ({ verified: [], dropped: c.map((x) => ({ candidateId: x.id, reason: "not_found" as const })), ms: 1 }) });
    h.settle();
    h.agent.calls[0]!.answer(ok(["c0", "c1"]));
    await flush();
    expect(h.frames.at(-1)).toMatchObject({ type: "results", status: "error", reason: "agent_failed" });
    expect(h.named("job_finished")[0]).toMatchObject({ status: "error", reason: "agent_failed", verifyAllFailed: true });
  });
});

describe("job scheduler: cancellation", () => {
  it.each<[string, (h: ReturnType<typeof harness>) => void, string]>([
    [
      "a visit change",
      (h) => {
        h.world.visit = { ...h.world.visit!, epoch: 4 } as ActiveVisit;
        h.scheduler.onVisitChanged();
      },
      "visit_changed",
    ],
    [
      "pause",
      (h) => {
        h.world.paused = true;
        h.scheduler.onPause();
      },
      "paused",
    ],
    [
      "sensor loss",
      (h) => {
        h.world.visit = null;
        h.scheduler.onSensorLost();
      },
      "visit_changed",
    ],
    [
      "the origin's grant lost",
      (h) => {
        h.world.permitted.delete(ORIGIN);
        h.world.permissionsRevision = 8;
        h.scheduler.onPermissionsChanged();
      },
      "revoked",
    ],
    ["shutdown", (h) => h.scheduler.stop(), "shutdown"],
  ])("%s cancels with its reason, releases the snapshot at once, and publishes nothing", async (_name, act, reason) => {
    const h = harness();
    h.settle();
    const call = h.agent.calls[0]!;
    act(h);
    expect(call.options.signal?.aborted).toBe(true);
    expect(call.options.signal?.reason).toBe(reason);
    expect(h.releases[0]).toMatchObject({ reason: "cancelled" });
    expect(h.registry.size).toBe(0);
    await flush();
    expect(h.frames.some((f) => f.type === "results")).toBe(false);
    expect(h.named("job_cancelled")).toEqual([{ reason, epoch: 3 }]);
    expect(h.named("job_finished")[0]).toMatchObject({ status: "cancelled", reason });
    expect(h.agent.calls).toHaveLength(1);
  });

  it("a profile change cancels as superseded and publishes it", async () => {
    const h = harness();
    h.settle();
    h.scheduler.onProfileChanged("fp-2");
    expect(h.agent.calls[0]!.options.signal?.reason).toBe("superseded");
    await flush();
    expect(h.frames.at(-1)).toMatchObject({ type: "results", status: "cancelled", reason: "superseded" });
  });

  it("a profile change with new tools: the next job runs on the agent the getter returns now, and a cached answer from the old profile never hits", async () => {
    const cache = createJobResumeCache<JobAnswer>({ clock: { now: () => 0 } });
    const next = fakeAgent();
    let current: ReturnType<typeof fakeAgent>["agent"] | null = null;
    const h = harness({ resumeCache: cache, agent: () => current });
    current = h.agent.agent;
    h.settle();
    h.agent.calls[0]!.answer(ok(["c0"]));
    await flush();
    expect(cache.size).toBe(1);
    // The profile is edited: a new fingerprint and tools revision, and a new adapter for the next job.
    current = next.agent;
    h.scheduler.onProfileChanged({ fingerprint: "fp-2", toolsRevision: 2, hasUserTools: false });
    h.world.visit = { ...h.world.visit!, epoch: 4 } as ActiveVisit;
    h.scheduler.onVisitChanged();
    h.settle();
    expect(h.agent.calls).toHaveLength(1);
    expect(next.calls).toHaveLength(1);
    expect(next.calls[0]!.request.profileFingerprint).toBe("fp-2");
    // An unusable profile: no agent, the job is unavailable without a launch.
    current = null;
    h.scheduler.onProfileChanged({ fingerprint: "none", toolsRevision: 0, hasUserTools: false });
    h.world.visit = { ...h.world.visit!, epoch: 5 } as ActiveVisit;
    h.scheduler.onVisitChanged();
    h.settle();
    await flush();
    expect(h.frames.at(-1)).toMatchObject({ type: "results", status: "unavailable", reason: "agent_unavailable" });
  });

  it("a cancel in the adapter's drain window (it still answers ok) is never published as ok", async () => {
    const h = harness();
    h.agent.setDrainOk(true);
    h.settle();
    h.world.paused = true;
    h.scheduler.onPause();
    await flush();
    expect(h.frames.some((f) => f.type === "results")).toBe(false);
    expect(h.results.current()).toBeNull();
  });
});

describe("job scheduler: replacement", () => {
  it("an activity accept the job could see cancels it (superseded) and starts ONE replacement with a fresh snapshot; a second accept is ignored", async () => {
    const h = harness();
    h.settle();
    const first = h.agent.calls[0]!;
    h.world.activity = [{ ...ISSUE, title: "Newer issue" }, ISSUE];
    h.scheduler.onActivityAccepted(2);
    expect(first.options.signal?.reason).toBe("superseded");
    await flush();
    expect(h.agent.calls).toHaveLength(2);
    const second = h.agent.calls[1]!;
    expect(second.request.requestId).toBe("job2");
    expect(second.request.browserSnapshot.id).not.toBe(first.request.browserSnapshot.id);
    expect(second.options.activity?.[0]?.title).toBe("Newer issue");
    expect(h.named("job_replaced")).toEqual([{ reason: "superseded", epoch: 3 }]);
    expect(h.scheduler.running).toMatchObject({ jobId: "job2", replacementUsed: true });

    h.scheduler.onActivityAccepted(3);
    expect(second.options.signal?.aborted).toBe(false);
    second.answer(ok(["c1"]));
    await flush();
    expect(h.states()).toEqual(["working:job1", "working:job2", "idle", "results:ok:job2"]);
    expect(h.agent.calls).toHaveLength(2);
    // The replacement's own snapshot, and the first's, are both released.
    expect(h.releases.map((r) => r.reason)).toEqual(["cancelled", "released", "released"]);
  });

  it("an activity accept the job could not see (grant off) changes nothing", () => {
    const h = harness();
    h.world.grant = false;
    h.settle();
    h.scheduler.onActivityAccepted(2);
    expect(h.agent.calls[0]!.options.signal?.aborted).toBe(false);
  });

  it("no replacement once the budget is under MIN_JOB_MS: the job keeps running", () => {
    const h = harness();
    h.settle(h.clock.t - (30_000 - MIN_JOB_MS));
    h.clock.t += 1;
    h.scheduler.onActivityAccepted(2);
    expect(h.agent.calls[0]!.options.signal?.aborted).toBe(false);
  });

  it("the grant turned off while the snapshot carried activity: revoked, one replacement without activity; turned off without activity: nothing", async () => {
    const h = harness();
    h.settle();
    h.world.grant = false;
    h.world.grantRevision = 1;
    h.scheduler.onGrantChanged(false);
    expect(h.agent.calls[0]!.options.signal?.reason).toBe("revoked");
    await flush();
    expect(h.agent.calls[1]!.options.activity).toEqual([]);
    expect(h.agent.calls[1]!.request.grantRevision).toBe(1);

    const g = harness();
    g.world.grant = false;
    g.settle();
    g.world.grantRevision = 1;
    g.scheduler.onGrantChanged(false);
    expect(g.agent.calls[0]!.options.signal?.aborted).toBe(false);
    // Its baseline moved: the answer still counts.
    g.agent.calls[0]!.answer({ status: "empty" });
    await flush();
    expect(g.frames.at(-1)).toMatchObject({ type: "results", status: "empty" });
  });

  it("capture disallowed while the snapshot carried activity: revoked and replaced; a second revocation publishes cancelled revoked", async () => {
    const h = harness();
    h.world.approved = [{ resource: { id: "r1" }, version: { hash: "v1" } }];
    h.settle();
    h.world.capture = false;
    h.world.permissionsRevision = 8;
    h.scheduler.onPermissionsChanged();
    expect(h.agent.calls[0]!.options.signal?.reason).toBe("revoked");
    await flush();
    expect(h.agent.calls).toHaveLength(2);
    // An unrelated permissions change: the baseline moves, the job goes on.
    h.world.permissionsRevision = 9;
    h.scheduler.onPermissionsChanged();
    expect(h.agent.calls[1]!.options.signal?.aborted).toBe(false);
    // The replacement used, a revoked resource it pinned publishes cancelled revoked.
    h.registry.release(h.scheduler.running!.snapshotId!, "revoked");
    h.scheduler.onResourceRevoked("r1");
    await flush();
    expect(h.agent.calls[1]!.options.signal?.reason).toBe("revoked");
    expect(h.frames.at(-1)).toMatchObject({ type: "results", status: "cancelled", reason: "revoked", jobId: "job2" });
    expect(h.agent.calls).toHaveLength(2);
  });

  it("a revoked resource the snapshot pinned: revoked and replaced; one it did not pin: nothing", async () => {
    const h = harness();
    h.world.approved = [{ resource: { id: "r1" }, version: { hash: "v1" } }];
    h.settle();
    h.scheduler.onResourceRevoked("r2");
    expect(h.agent.calls[0]!.options.signal?.aborted).toBe(false);
    h.scheduler.onResourceRevoked("r1");
    expect(h.agent.calls[0]!.options.signal?.reason).toBe("revoked");
    await flush();
    expect(h.agent.calls).toHaveLength(2);
  });
});

describe("job scheduler: more cancellation paths", () => {
  it("a replacement cancelled by a visit change publishes nothing and starts no third job", async () => {
    const h = harness();
    h.settle();
    h.scheduler.onActivityAccepted(2);
    await flush();
    const replacement = h.agent.calls[1]!;
    expect(replacement.request.requestId).toBe("job2");
    h.world.visit = { ...h.world.visit!, epoch: 4 } as ActiveVisit;
    h.scheduler.onVisitChanged();
    expect(replacement.options.signal?.reason).toBe("visit_changed");
    await flush();
    expect(h.agent.calls).toHaveLength(2);
    expect(h.frames.some((f) => f.type === "results")).toBe(false);
    expect(h.scheduler.running).toBeNull();
    expect(h.named("job_cancelled").map((f) => f.reason)).toEqual(["superseded", "visit_changed"]);
    expect(h.releases.map((r) => r.reason)).toEqual(["cancelled", "released", "cancelled", "released"]);
  });

  it("shutdown during verification ends the job at once: verification gets the job's signal, nothing is published", async () => {
    let verifySignal: AbortSignal | undefined;
    const h = harness({
      verify: (_c, o) =>
        new Promise((resolve) => {
          verifySignal = o.signal;
          // A checker that honours the signal (as verifyTargets does) and otherwise never ends.
          o.signal.addEventListener("abort", () => resolve({ verified: [], dropped: [], ms: 0 }));
        }),
    });
    h.settle();
    h.agent.calls[0]!.answer(ok(["c0"]));
    await flush();
    expect(verifySignal?.aborted).toBe(false);
    h.scheduler.stop();
    expect(verifySignal?.aborted).toBe(true);
    await h.scheduler.settled();
    expect(h.scheduler.running).toBeNull();
    expect(h.frames.some((f) => f.type === "results")).toBe(false);
    expect(h.named("job_finished")).toEqual([expect.objectContaining({ status: "cancelled", reason: "shutdown" })]);
  });

  it("pause, resume, and a second settle of the same visit start a fresh budget and a fresh replacement allowance", async () => {
    const h = harness();
    h.settle(h.clock.t - 10_000);
    h.scheduler.onActivityAccepted(2);
    await flush();
    expect(h.scheduler.running).toMatchObject({ jobId: "job2", replacementUsed: true });
    h.world.paused = true;
    h.scheduler.onPause();
    await flush();
    expect(h.scheduler.running).toBeNull();
    // Resume: the same visit (same epoch) settles again after its dwell.
    h.world.paused = false;
    h.clock.t += 3_000;
    h.settle();
    expect(h.agent.calls).toHaveLength(3);
    expect(h.named("job_started").at(-1)).toMatchObject({ epoch: 3, deadlineMs: 30_000, replacement: false });
    expect(h.agent.calls[2]!.request.deadlineMs).toBe(30_000 - VERIFY_RESERVE_MS);
    expect(h.scheduler.running).toMatchObject({ jobId: "job3", replacementUsed: false });
    // The replacement allowance is back.
    h.scheduler.onActivityAccepted(3);
    await flush();
    expect(h.agent.calls).toHaveLength(4);
    expect(h.named("job_replaced")).toHaveLength(2);
  });
});

describe("job scheduler: discards", () => {
  it.each<[string, (h: ReturnType<typeof harness>) => void, string]>([
    ["the visit epoch moved", (h) => void (h.world.visit = { ...h.world.visit!, epoch: 9 } as ActiveVisit), "visit"],
    ["the snapshot was released", (h) => h.registry.release(h.scheduler.running!.snapshotId!, "expired"), "snapshot"],
    ["the permissions revision moved unannounced", (h) => void (h.world.permissionsRevision = 99), "permissions"],
    ["the grant revision moved unannounced", (h) => void (h.world.grantRevision = 5), "grant"],
  ])("%s while the agent drains: the ok answer is discarded after the agent, never published", async (_name, mutate, why) => {
    const h = harness();
    h.settle();
    mutate(h);
    h.agent.calls[0]!.answer(ok(["c0"]));
    await flush();
    expect(h.named("job_discarded")).toEqual([{ stage: "agent", why, epoch: 3 }]);
    expect(h.frames.some((f) => f.type === "results")).toBe(false);
    expect(h.results.current()).toBeNull();
  });

  it("a change during verification discards at the verify stage", async () => {
    const h = harness({
      verify: async (c) => {
        h.world.permissionsRevision = 50;
        return { verified: c.map((x) => ({ ...x, humanHref: x.sourceUrl })), dropped: [], ms: 1 };
      },
    });
    h.settle();
    h.agent.calls[0]!.answer(ok(["c0"]));
    await flush();
    expect(h.named("job_discarded")).toEqual([{ stage: "verify", why: "permissions", epoch: 3 }]);
    // The spinner still ends.
    expect(h.states()).toEqual(["working:job1", "idle"]);
  });

  it("another core instance's registry refuses the answer (stale_instance)", async () => {
    const h = harness({ registryInstanceId: "other-core" });
    h.settle();
    h.agent.calls[0]!.answer(ok(["c0"]));
    await flush();
    expect(h.results.current()).toBeNull();
    expect(h.named("results_refused")[0]).toMatchObject({ code: "stale_instance" });
  });
});

describe("job scheduler: resume cache", () => {
  it("a replacement whose key hits the cache publishes the cached answer once the cancelled run ends, in order: working, idle, results", async () => {
    const cache = createJobResumeCache<JobAnswer>({ clock: { now: () => 0 } });
    const h = harness({ resumeCache: cache });
    // An earlier job answered for the newer activity (same page, same everything else).
    const newer = [{ ...ISSUE, title: "Newer issue" }, ISSUE];
    h.world.activity = newer;
    h.settle();
    h.agent.calls[0]!.answer(ok(["c3"]));
    await flush();
    // A new visit to the same page with the older activity: a model call (another key).
    h.world.activity = [ISSUE];
    h.world.visit = { ...h.world.visit!, epoch: 4 } as ActiveVisit;
    h.scheduler.onVisitChanged();
    h.settle();
    expect(h.agent.calls).toHaveLength(2);
    const before = h.states().length;
    // The newer issue is read again: the job is replaced, and the replacement's key hits.
    h.world.activity = newer;
    h.scheduler.onActivityAccepted(5);
    await flush();
    expect(h.agent.calls).toHaveLength(2);
    expect(h.states().slice(before)).toEqual(["working:job3", "idle", "results:ok:job3"]);
    expect(h.frames.at(-1)).toMatchObject({ type: "results", status: "ok", jobId: "job3", items: [{ candidateId: "c3" }] });
    expect(h.named("job_finished").at(-1)).toMatchObject({ cached: true });
    // The cancelled run published nothing.
    expect(h.frames.some((f) => f.type === "results" && f.jobId === "job2")).toBe(false);
  });

  // Phase 3 verification: the key alone keeps the answers apart. The profile watcher also clears
  // the cache on a change; this cache is never cleared, so only the tools dimension can cause the miss.
  it("a job with extra user tools never reuses a browser-only answer, even with the cache never cleared and the same fingerprint", async () => {
    const cache = createJobResumeCache<JobAnswer>({ clock: { now: () => 0 } });
    const h = harness({ resumeCache: cache });
    // A browser-only job (no user tools) answers and is cached.
    h.settle();
    h.agent.calls[0]!.answer(ok(["c0"]));
    await flush();
    expect(cache.size).toBe(1);
    // The user adds a retrieval tool: only the tools revision changes (fingerprint kept on purpose).
    h.scheduler.onProfileChanged({ fingerprint: "fp-1", toolsRevision: 1, hasUserTools: true });
    expect(cache.size).toBe(1);
    h.world.visit = { ...h.world.visit!, epoch: 4 } as ActiveVisit;
    h.scheduler.onVisitChanged();
    h.settle();
    // Same page, same activity, same catalog: still a fresh model call.
    expect(h.agent.calls).toHaveLength(2);
    expect(h.named("job_finished").some((f) => f.cached === true)).toBe(false);
    // That job's optional tool failed: its answer is browser-only, cached under the tools revision.
    h.agent.calls[1]!.answer(ok(["c1"]), { optionalToolFailed: true });
    await flush();
    expect(h.frames.at(-1)).toMatchObject({ type: "results", status: "ok", items: [{ candidateId: "c1" }] });
    // Back to the same page with the same tools: the browser-only entry is refused, the model runs again.
    h.world.visit = { ...h.world.visit!, epoch: 5 } as ActiveVisit;
    h.scheduler.onVisitChanged();
    h.settle();
    expect(h.agent.calls).toHaveLength(3);
    expect(h.named("job_finished").some((f) => f.cached === true)).toBe(false);
    // Back to no user tools (revision 0): the first browser-only answer is reused.
    h.agent.calls[2]!.answer(ok(["c2"]));
    await flush();
    h.scheduler.onProfileChanged({ fingerprint: "fp-1", toolsRevision: 0, hasUserTools: false });
    h.world.visit = { ...h.world.visit!, epoch: 6 } as ActiveVisit;
    h.scheduler.onVisitChanged();
    h.settle();
    await flush();
    expect(h.agent.calls).toHaveLength(3);
    expect(h.frames.at(-1)).toMatchObject({ type: "results", status: "ok", items: [{ candidateId: "c0" }] });
    expect(h.named("job_finished").at(-1)).toMatchObject({ cached: true });
  });

  it("an answer is reused within 30 s for the same key, through the same order; extra user tools never reuse a browser-only answer", async () => {
    const cache = createJobResumeCache<JobAnswer>({ clock: { now: () => 0 } });
    const h = harness({ resumeCache: cache });
    h.settle();
    h.agent.calls[0]!.answer(ok(["c0"]));
    await flush();
    // Back to the same page (a new visit epoch, same key): no second model call.
    h.world.visit = { ...h.world.visit!, epoch: 4 } as ActiveVisit;
    h.scheduler.onVisitChanged();
    h.settle();
    expect(h.agent.calls).toHaveLength(1);
    expect(h.states().slice(-3)).toEqual(["working:job2", "idle", "results:ok:job2"]);
    expect(h.named("job_finished").at(-1)).toMatchObject({ cached: true });
    // New activity is another key.
    h.world.activity = [{ ...ISSUE, text: "changed" }];
    h.world.visit = { ...h.world.visit!, epoch: 5 } as ActiveVisit;
    h.scheduler.onVisitChanged();
    h.settle();
    expect(h.agent.calls).toHaveLength(2);

    const toolsCache = createJobResumeCache<JobAnswer>({ clock: { now: () => 0 } });
    const t = harness({ resumeCache: toolsCache, profile: { fingerprint: "fp-1", toolsRevision: 2, hasUserTools: true } });
    t.settle();
    t.agent.calls[0]!.answer(ok(["c0"]), { optionalToolFailed: true });
    await flush();
    t.world.visit = { ...t.world.visit!, epoch: 4 } as ActiveVisit;
    t.scheduler.onVisitChanged();
    t.settle();
    expect(t.agent.calls).toHaveLength(2);
  });
});
