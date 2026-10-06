// Switching tab, document, or app during discovery, model execution, target checks, and click
// authorization. A tab or document switch refuses the old results and links at every stage. An
// app switch keeps them: the page is still the one focused in Chrome, the job carries on and
// publishes, and the return to the same page changes nothing; a navigation made before the
// return ends the visit like any other.
//
// Wired as main.ts wires the core: the real coordinator (dwell, visit tracker, permissions,
// discovery runner), the real job scheduler and pipeline, the real result registry, the real
// panel channel (`open_link` goes through `coordinator.handleNativeCommand` like a stdin line),
// and the real snapshot registry with job tokens. Only the edges are fakes: the catalog resolve
// and resource discovery (each waits on a deferred), the agent (answers when told; it still
// answers `ok` after a cancel, as the adapter can during its drain window), and target
// verification (resolves when told, ignoring the job's signal: the strictest case).
//
// The frames list is what the side panel receives (state frames, results frames and acks on
// one stream).

import type { ActiveVisit, BrowserObservation, Candidate, HostJobResult, JobRequest, ObservationFrame, PanelState, ToChromeFrame } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import { createSnapshotRegistry } from "./activity/snapshots.js";
import { createAgentAuth } from "./agentApi/auth.js";
import type { JobDetails, JobOutcome, JobRunOptions } from "./agents/adapter.js";
import type { DiscoveryResult } from "./capabilities/discovery.js";
import { emptyState } from "./capabilities/decisions.js";
import type { CatalogResolution } from "./catalog/resolveCatalog.js";
import type { VerifyResult } from "./catalog/verifyTargets.js";
import type { Timers } from "./clock.js";
import { createCoordinator } from "./coordinator.js";
import type { DiagnosticFields, Diagnostics } from "./diagnostics.js";
import { DWELL_MS } from "./dwell.js";
import { createJobScheduler } from "./jobScheduler.js";
import { createPanelChannel, type PanelStore } from "./panelChannel.js";
import { createResultRegistry } from "./results.js";
import type { PanelSink } from "./panelSinks.js";
import type { SocketClient } from "./socketServer.js";

/** The native app's stdio sink: the sender of every command these tests hand in. */
const STDIO: PanelSink = { id: "stdio", kind: "stdio", send: () => {} };

const ORIGIN = "https://docs.stripe.com";
const PAGE = `${ORIGIN}/billing`;
const CORE = "core-b11";

const CANDIDATES: Candidate[] = ["a", "b", "c"].map((p, i) => ({
  id: `c${i}`,
  sourceUrl: `${ORIGIN}/${p}`,
  title: `Title ${p}`,
  labelQuality: "published" as const,
  provenance: "llms.txt" as const,
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

function fakeTimers() {
  let now = 0;
  let nextId = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const id = ++nextId;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => void pending.delete(h as number),
  };
  const advance = (ms: number): void => {
    const until = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return { timers, advance };
}

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

const details = (): JobDetails => ({
  adapter: "fake",
  termination: "completed",
  toolUses: [],
  optionalTools: [],
  droppedPicks: 0,
  cutPicks: 0,
  toolErrors: {},
  optionalToolFailed: false,
  timings: { totalMs: 10 },
  usage: {},
});

function core() {
  const clock = { t: 1_000_000, now: () => clock.t };
  const t = fakeTimers();
  const frames: PanelState[] = [];
  const events: Array<{ name: string; fields: DiagnosticFields }> = [];
  const diagnostics: Diagnostics = { failures: 0, event: (name, fields = {}) => void events.push({ name, fields }) };

  // Edges: catalog and discovery wait on deferreds; the agent and verification answer when told.
  const catalogs: Array<ReturnType<typeof deferred<CatalogResolution>>> = [];
  const discoveries: Array<ReturnType<typeof deferred<DiscoveryResult>>> = [];
  const agentCalls: Array<{ request: JobRequest; signal: AbortSignal; answerOk: (ids: string[]) => void }> = [];
  const verifyCalls: Array<{ candidates: readonly Candidate[]; release: () => void }> = [];
  const agent = {
    run(request: JobRequest, options: JobRunOptions): Promise<JobOutcome> {
      return new Promise((resolve) => {
        const identity = { requestId: request.requestId, coreInstanceId: request.coreInstanceId, visitEpoch: request.visitEpoch };
        agentCalls.push({
          request,
          signal: options.signal!,
          // Answers ok even after a cancel: the adapter's drain window.
          answerOk: (ids) => resolve({ result: { ...identity, status: "ok", items: ids.map((id) => ({ id, reason: `fits ${id}` })) } as HostJobResult, details: details() }),
        });
      });
    },
  };

  // eslint-disable-next-line prefer-const
  let coordinator: ReturnType<typeof createCoordinator>;
  const activeVisit = () => {
    const visit = coordinator.shownVisit();
    return visit === null ? null : { visitEpoch: visit.epoch, origin: visit.origin };
  };
  const results = createResultRegistry({ coreInstanceId: CORE, activeVisit, isPermitted: (o) => coordinator.permissions.isPermitted(o), diagnostics });
  const panel = createPanelChannel({
    store: emptyStore,
    coreInstanceId: CORE,
    exportConflicts: () => [],
    readBrowserContextGrant: () => false,
    writeBrowserContextGrant: () => ({ restore: () => {} }),
    getAudit: () => [],
    isPermitted: (o) => coordinator.permissions.isPermitted(o),
    currentOrigin: () => coordinator.shownVisit()?.origin ?? null,
    emit: (f) => void frames.push(f),
    results,
    resendState: () => coordinator.resendState(),
    clock,
    timers: t.timers,
    diagnostics,
  });
  const auth = createAgentAuth({ interactiveToken: "interactive", clock });
  const snapshots = createSnapshotRegistry({
    store: { listApproved: () => [], pinVersion: () => ({ ok: true }) as never, releasePins: () => {}, approvalRevision: 0 },
    auth,
    clock,
    paused: () => coordinator.agentView().paused,
  });
  let ids = 0;
  const scheduler = createJobScheduler({
    coreInstanceId: CORE,
    clock,
    diagnostics,
    destinations: ["docs.stripe.com"],
    results,
    snapshots: () => snapshots,
    view: {
      visit: () => coordinator.shownVisit(),
      permissionsRevision: () => coordinator.permissions.revision,
      isPermitted: (o) => coordinator.permissions.isPermitted(o),
      captureAllowed: () => coordinator.captureAllowed(),
    },
    window: { working: (e, j) => coordinator.showWorking(e, j), idle: (e) => coordinator.showIdle(e) },
    activity: () => [],
    browserContextGranted: () => false,
    grantRevision: () => 0,
    approvalRevision: () => 0,
    agent,
    profile: { fingerprint: "fp", toolsRevision: 0, hasUserTools: false },
    socketPath: "/tmp/agent.sock",
    verify: (candidates) => {
      const d = deferred<VerifyResult>();
      verifyCalls.push({ candidates, release: () => d.resolve({ verified: candidates.map((c) => ({ ...c, humanHref: c.sourceUrl })), dropped: [], ms: 1 }) });
      return d.promise;
    },
    newJobId: () => `job${++ids}`,
  });
  coordinator = createCoordinator({
    config: {},
    clock,
    timers: t.timers,
    diagnostics,
    emitPanel: (s) => void frames.push(s),
    capabilities: {
      store: { ingest: async (d) => ({ origin: d.origin, results: [], skipped: 0, cleanup: Promise.resolve({ ok: true }) }) as never },
      createFetchSession: (origin) => ({
        origin,
        fetch: undefined as never,
        startWindow: () => {},
        cancel: () => {},
        isCancelled: () => false,
        stats: () => ({ requests: 0, refused: 0, bytesReceived: 0 }),
      }),
      resolveCatalog: () => {
        const d = deferred<CatalogResolution>();
        catalogs.push(d);
        return d.promise;
      },
      discover: () => {
        const d = deferred<DiscoveryResult>();
        discoveries.push(d);
        return d.promise;
      },
    },
    panel,
    results,
    jobs: scheduler,
  });

  // The sensor: GitHub and the docs site granted; Chrome frontmost; the docs page focused.
  const handlers: Array<(f: ObservationFrame) => void> = [];
  const sensor: SocketClient = { id: 1, send: (_f: ToChromeFrame) => {}, onFrame: (h) => void handlers.push(h), onClose: () => {}, onDrained: () => {}, close: () => {} };
  const observe = (o: BrowserObservation) => handlers.forEach((h) => h({ type: "observation", observation: o }));
  coordinator.attachClient(sensor);
  observe({ kind: "permissions", revision: 1, at: clock.t, granted: [`${ORIGIN}/*`], githubCapture: false });
  coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.google.Chrome", at: clock.t }, STDIO);
  let seq = 0;
  const focus = (tabId: number, documentId: string) =>
    observe({ kind: "focus", seq: ++seq, at: clock.t, browserFocused: true, windowId: 1, tabId, url: PAGE, documentId, title: "Billing", incognito: false, permissionsRevision: 1 });
  focus(10, "doc-a");
  /** Another app comes to the front: the Mac app's report, then Chrome's unfocused one. */
  const away = () => {
    coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.apple.Terminal", at: clock.t }, STDIO);
    observe({ kind: "focus", seq: ++seq, at: clock.t, browserFocused: false, windowId: -1, permissionsRevision: 1 });
  };
  /** Chrome back in front, its window focused on `tabId`/`documentId`. */
  const back = (tabId = 10, documentId = "doc-a") => {
    coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.google.Chrome", at: clock.t }, STDIO);
    focus(tabId, documentId);
  };

  let commands = 0;
  const openLink = async (identity: { visitEpoch: number; jobId: string; candidateId: string }) => {
    const commandId = `open-${++commands}`;
    coordinator.handleNativeCommand({ type: "open_link", commandId, coreInstanceId: CORE, ...identity }, STDIO);
    await flush();
    return frames.find((f) => f.type === "ack" && f.commandId === commandId);
  };
  const catalogReady = (): CatalogResolution => ({
    result: { ok: true, source: "fresh", stale: false, catalog: { origin: ORIGIN, version: "v1", fetchedAt: 0, candidates: CANDIDATES, truncated: false, errors: [] } },
    stats: { requests: 0, refused: 0, bytesReceived: 0, ms: 0 },
  });
  const named = (name: string) => events.filter((e) => e.name === name).map((e) => e.fields);
  return { clock, advance: t.advance, frames, events, named, coordinator, scheduler, results, snapshots, catalogs, discoveries, agentCalls, verifyCalls, focus, away, back, openLink, catalogReady };
}

type Core = ReturnType<typeof core>;

const SWITCHES: Array<[string, (c: Core) => void]> = [
  ["another tab (same URL)", (c) => c.focus(11, "doc-t")],
  ["another document in the same tab (same URL)", (c) => c.focus(10, "doc-b")],
  [
    "another app, then another document before coming back",
    (c) => {
      c.away();
      c.back(10, "doc-n");
    },
  ],
];

/** Drive the visit to the stage, recording the job identity a window could hold by then. */
async function reach(c: Core, stage: "discovery" | "model" | "verify" | "click") {
  c.advance(DWELL_MS);
  await flush();
  const epoch = c.coordinator.tracker.epoch;
  expect(c.catalogs).toHaveLength(1);
  if (stage === "discovery") return { epoch, jobId: undefined as string | undefined };
  c.catalogs[0]!.resolve(c.catalogReady());
  await flush();
  expect(c.agentCalls).toHaveLength(1);
  const jobId = c.agentCalls[0]!.request.requestId;
  expect(c.frames.at(-1)).toMatchObject({ type: "state", status: "working", jobId, visitEpoch: epoch });
  if (stage === "model") return { epoch, jobId };
  c.agentCalls[0]!.answerOk(["c0", "c1"]);
  await flush();
  expect(c.verifyCalls).toHaveLength(1);
  if (stage === "verify") return { epoch, jobId };
  c.verifyCalls[0]!.release();
  await flush();
  const shown = c.frames.filter((f) => f.type === "results");
  expect(shown).toHaveLength(1);
  expect(shown[0]).toMatchObject({ status: "ok", jobId, visitEpoch: epoch });
  // Click authorization works while the visit is current: the core's re-checked target.
  expect(await c.openLink({ visitEpoch: epoch, jobId, candidateId: "c0" })).toMatchObject({ ok: true, target: { href: `${ORIGIN}/a` } });
  return { epoch, jobId };
}

describe("B11: a tab or document switch at every stage refuses the old visit's results and links", () => {
  for (const [switchName, doSwitch] of SWITCHES) {
    describe(`switching to ${switchName}`, () => {
      it("during discovery: the late catalog starts no job and nothing is shown for the old visit", async () => {
        const c = core();
        const { epoch } = await reach(c, "discovery");
        const before = c.frames.length;
        doSwitch(c);
        expect(c.coordinator.tracker.epoch).toBeGreaterThan(epoch);
        // The cancelled pass's catalog arrives anyway.
        c.catalogs[0]!.resolve(c.catalogReady());
        c.discoveries[0]?.resolve({ origin: ORIGIN, checkedAt: 0, robots: "not_fetched", items: [], externalReferences: [], skillsOverCap: 0, acceptedBytes: 0, stats: { requests: 0, refused: 0, ms: 0 } });
        await flush();
        expect(c.agentCalls).toHaveLength(0);
        expect(c.named("job_started")).toEqual([]);
        expect(c.scheduler.running).toBeNull();
        expect(c.frames.slice(before).some((f) => f.type === "results" || (f.type === "state" && f.status === "working"))).toBe(false);
        expect(c.frames.slice(before).some((f) => f.type === "state" && f.visitEpoch === epoch)).toBe(false);
        expect(c.named("discovery_ingested")).toEqual([]);
      });

      it("during model execution: the job is cancelled visit_changed; its drain-window ok is never shown; its link is stale", async () => {
        const c = core();
        const { epoch, jobId } = await reach(c, "model");
        const before = c.frames.length;
        doSwitch(c);
        expect(c.agentCalls[0]!.signal.aborted).toBe(true);
        expect(c.agentCalls[0]!.signal.reason).toBe("visit_changed");
        expect(c.snapshots.size).toBe(0);
        c.agentCalls[0]!.answerOk(["c0"]);
        await flush();
        expect(c.verifyCalls).toHaveLength(0);
        expect(c.frames.slice(before).some((f) => f.type === "results")).toBe(false);
        expect(c.results.current()).toBeNull();
        expect(c.named("job_finished")).toEqual([expect.objectContaining({ status: "cancelled", reason: "visit_changed" })]);
        expect(await c.openLink({ visitEpoch: epoch, jobId: jobId!, candidateId: "c0" })).toMatchObject({ ok: false, code: "stale_revision" });
        expect(c.frames.slice(before).some((f) => f.type === "state" && f.visitEpoch === epoch)).toBe(false);
      });

      it("during target checks: verification finishing late shows nothing; the link is stale", async () => {
        const c = core();
        const { epoch, jobId } = await reach(c, "verify");
        const before = c.frames.length;
        doSwitch(c);
        expect(c.agentCalls[0]!.signal.aborted).toBe(true);
        expect(c.snapshots.size).toBe(0);
        c.verifyCalls[0]!.release();
        await flush();
        expect(c.frames.slice(before).some((f) => f.type === "results")).toBe(false);
        expect(c.results.current()).toBeNull();
        expect(c.named("job_finished")).toEqual([expect.objectContaining({ status: "cancelled", reason: "visit_changed" })]);
        expect(await c.openLink({ visitEpoch: epoch, jobId: jobId!, candidateId: "c0" })).toMatchObject({ ok: false, code: "stale_revision" });
        expect(c.frames.slice(before).some((f) => f.type === "state" && f.visitEpoch === epoch)).toBe(false);
      });

      it("at click authorization: the shown result is cleared and open_link with its identity is stale_revision", async () => {
        const c = core();
        const { epoch, jobId } = await reach(c, "click");
        const before = c.frames.length;
        doSwitch(c);
        expect(c.results.current()).toBeNull();
        // The side panel is told: the state for the new visit (or none) replaces the old one.
        const state = c.frames.slice(before).filter((f) => f.type === "state");
        expect(state.length).toBeGreaterThan(0);
        expect(state.every((f) => f.type === "state" && f.visitEpoch !== epoch)).toBe(true);
        for (const candidateId of ["c0", "c1"]) {
          expect(await c.openLink({ visitEpoch: epoch, jobId: jobId!, candidateId })).toMatchObject({ ok: false, code: "stale_revision" });
        }
        // The new visit's epoch with the old job is stale too: a job belongs to its visit.
        expect(await c.openLink({ visitEpoch: c.coordinator.tracker.epoch, jobId: jobId!, candidateId: "c0" })).toMatchObject({ ok: false, code: "stale_revision" });
        // No href ever reached a frame other than the one ok ack before the switch.
        const withHref = c.frames.filter((f) => JSON.stringify(f).includes(`${ORIGIN}/`));
        expect(withHref).toHaveLength(1);
        expect(withHref[0]).toMatchObject({ type: "ack", ok: true });
      });
    });
  }
});

describe("an app switch keeps the page's links: the job carries on, and the return to the same page changes nothing", () => {
  /** Nothing the side panel would act on, and no clear or job start, since `before`. */
  const quietSince = (c: Core, before: number, eventsBefore: number) => {
    expect(c.frames.slice(before).filter((f) => f.type !== "ack")).toEqual([]);
    const names = c.events.slice(eventsBefore).map((e) => e.name);
    for (const name of ["results_cleared", "job_started", "job_cancelled", "visit_change", "dwell_settled"]) expect(names).not.toContain(name);
  };

  it("at click authorization: away and back, the result stays and its links resolve throughout", async () => {
    const c = core();
    const { epoch, jobId } = await reach(c, "click");
    const before = c.frames.length;
    const eventsBefore = c.events.length;
    c.away();
    expect(c.coordinator.tracker.epoch).toBe(epoch);
    expect(c.results.current()).toMatchObject({ status: "ok", jobId, visitEpoch: epoch });
    expect(await c.openLink({ visitEpoch: epoch, jobId: jobId!, candidateId: "c1" })).toMatchObject({ ok: true, target: { href: `${ORIGIN}/b` } });
    c.clock.t += 60_000;
    c.advance(DWELL_MS * 3);
    c.back();
    c.advance(DWELL_MS * 3);
    await flush();
    quietSince(c, before, eventsBefore);
    expect(c.named("visit_suspended")).toEqual([{ epoch }]);
    expect(c.named("visit_resumed")).toEqual([{ epoch }]);
    expect(c.agentCalls).toHaveLength(1);
    expect(c.frames.filter((f) => f.type === "results")).toHaveLength(1);
    expect(await c.openLink({ visitEpoch: epoch, jobId: jobId!, candidateId: "c0" })).toMatchObject({ ok: true, target: { href: `${ORIGIN}/a` } });
  });

  it("during model execution: the job is not cancelled and publishes while away; the return repaints nothing", async () => {
    const c = core();
    const { epoch, jobId } = await reach(c, "model");
    c.away();
    expect(c.agentCalls[0]!.signal.aborted).toBe(false);
    expect(c.scheduler.running).toMatchObject({ jobId, visitEpoch: epoch });
    expect(c.snapshots.size).toBe(1);
    c.agentCalls[0]!.answerOk(["c2"]);
    await flush();
    c.verifyCalls[0]!.release();
    await flush();
    const shown = c.frames.filter((f) => f.type === "results");
    expect(shown).toEqual([expect.objectContaining({ status: "ok", jobId, visitEpoch: epoch, items: [expect.objectContaining({ candidateId: "c2" })] })]);
    expect(c.named("job_finished")).toEqual([expect.objectContaining({ status: "ok" })]);
    expect(await c.openLink({ visitEpoch: epoch, jobId: jobId!, candidateId: "c2" })).toMatchObject({ ok: true, target: { href: `${ORIGIN}/c` } });
    const before = c.frames.length;
    const eventsBefore = c.events.length;
    c.back();
    c.advance(DWELL_MS * 3);
    await flush();
    quietSince(c, before, eventsBefore);
    expect(c.results.current()).toMatchObject({ jobId, visitEpoch: epoch });
  });

  it("during target checks: verification finishing while away publishes for the still-focused page", async () => {
    const c = core();
    const { epoch, jobId } = await reach(c, "verify");
    c.away();
    c.verifyCalls[0]!.release();
    await flush();
    expect(c.frames.filter((f) => f.type === "results")).toEqual([expect.objectContaining({ status: "ok", jobId, visitEpoch: epoch })]);
    expect(c.named("results_cleared")).toEqual([]);
  });

  it("during discovery: the pass carries on while away and its job runs for the page", async () => {
    const c = core();
    const { epoch } = await reach(c, "discovery");
    c.away();
    c.catalogs[0]!.resolve(c.catalogReady());
    await flush();
    expect(c.agentCalls).toHaveLength(1);
    expect(c.agentCalls[0]!.request.visitEpoch).toBe(epoch);
    expect(c.named("discovery_discarded")).toEqual([]);
  });

  it("a navigation seen while away ends the visit: the result is cleared and its links refused", async () => {
    const c = core();
    const { epoch, jobId } = await reach(c, "click");
    c.away();
    c.back(10, "doc-n");
    expect(c.coordinator.tracker.epoch).toBeGreaterThan(epoch);
    expect(c.results.current()).toBeNull();
    expect(c.named("results_cleared")).toEqual([expect.objectContaining({ epoch, reason: "visit_changed" })]);
    expect(await c.openLink({ visitEpoch: epoch, jobId: jobId!, candidateId: "c0" })).toMatchObject({ ok: false, code: "stale_revision" });
    // The new page gets its own visit: idle at once, a pass after the dwell.
    expect(c.frames.some((f) => f.type === "state" && f.status === "idle" && f.visitEpoch === c.coordinator.tracker.epoch)).toBe(true);
    c.advance(DWELL_MS);
    expect(c.catalogs).toHaveLength(2);
  });
});
