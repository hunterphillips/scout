import type {
  BrowserObservation,
  FocusObservation,
  ObservationFrame,
  PageTextObservation,
  PanelState,
  ToChromeFrame,
} from "@scout/contracts";
import { describe, expect, it } from "vitest";
import type { DiscoveryResult } from "./capabilities/discovery.js";
import type { IngestReport } from "./capabilities/store.js";
import type { CatalogResolution } from "./catalog/resolveCatalog.js";
import type { Timers } from "./clock.js";
import { type ActivityStore, createActivityStore } from "./activity/store.js";
import { type CoordinatorCapabilities, type CoordinatorOptions, createCoordinator } from "./coordinator.js";
import type { DiagnosticFields, Diagnostics } from "./diagnostics.js";
import { DWELL_MS } from "./dwell.js";
import type { GuardedFetchResult } from "./fetch/guardedFetch.js";
import { createOriginFetchSession, type OriginFetchSession } from "./fetch/originSession.js";
import type { SocketClient } from "./socketServer.js";

const STRIPE = "https://docs.stripe.com/payments/checkout";
const ISSUE = "https://github.com/o/r/issues/1";
const DEFAULT_GRANTS = ["https://docs.stripe.com/*", "https://www.peakdesign.com/*", "https://github.com/*"];

/** One-shot timers on a manual clock. */
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued promise callbacks and pending I/O callbacks run. */
const flushMacro = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Let queued promise callbacks run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const discoveryFor = (origin: string): DiscoveryResult => ({
  origin,
  checkedAt: 0,
  robots: "not_fetched",
  items: [],
  externalReferences: [],
  skillsOverCap: 0,
  acceptedBytes: 0,
  stats: { requests: 0, refused: 0, ms: 0 },
});

/** Fake discovery wiring: each pass waits on a deferred the test resolves. */
function fakeCapabilities() {
  const passes: Array<{ origin: string; discover: ReturnType<typeof deferred<DiscoveryResult>> }> = [];
  const sessions: Array<{ origin: string; windows: number; cancels: number }> = [];
  const catalogCalls: Array<{ origin: string; session: OriginFetchSession }> = [];
  const ingests: Array<{ origin: string; chromePermitted: boolean }> = [];
  const capabilities: CoordinatorCapabilities = {
    store: {
      ingest: async (discovery, context) => {
        ingests.push({ origin: discovery.origin, chromePermitted: context.chromePermitted });
        return { origin: discovery.origin, results: [], skipped: 0, cleanup: Promise.resolve({ ok: true }) } satisfies IngestReport;
      },
    },
    createFetchSession: (origin) => {
      const rec = { origin, windows: 0, cancels: 0 };
      sessions.push(rec);
      return {
        origin,
        fetch: undefined as unknown as OriginFetchSession["fetch"],
        startWindow: () => void (rec.windows += 1),
        cancel: () => void (rec.cancels += 1),
        isCancelled: () => rec.cancels > 0,
        stats: () => ({ requests: 0, refused: 0, bytesReceived: 0 }),
      };
    },
    resolveCatalog: async (origin, session) => {
      catalogCalls.push({ origin, session });
      return { result: { ok: false }, stats: { requests: 0, refused: 0, bytesReceived: 0, ms: 0 } } as unknown as CatalogResolution;
    },
    discover: (origin, session) => {
      const d = deferred<DiscoveryResult>();
      expect(session.origin).toBe(origin);
      passes.push({ origin, discover: d });
      return d.promise;
    },
  };
  return { capabilities, passes, sessions, catalogCalls, ingests };
}

function fakeClient(id: number) {
  const frameHandlers: Array<(f: ObservationFrame) => void> = [];
  const closeHandlers: Array<() => void> = [];
  const sent: ToChromeFrame[] = [];
  let closed = false;
  const client: SocketClient = {
    id,
    send: (f) => void sent.push(f),
    onFrame: (h) => void frameHandlers.push(h),
    onClose: (h) => void closeHandlers.push(h),
    close: () => void (closed = true),
  };
  return {
    client,
    sent,
    get closed() {
      return closed;
    },
    observe: (observation: BrowserObservation) => {
      for (const h of frameHandlers) h({ type: "observation", observation });
    },
    disconnect: () => {
      for (const h of closeHandlers) h();
    },
  };
}

function setup(extra: Partial<CoordinatorOptions> = {}) {
  const clock = { t: 1_000, now: () => clock.t };
  const timers = fakeTimers();
  const panel: PanelState[] = [];
  const events: Array<{ name: string; fields: DiagnosticFields }> = [];
  const diagnostics: Diagnostics = { failures: 0, event: (name, fields = {}) => void events.push({ name, fields }) };
  const coordinator = createCoordinator({
    config: {},
    clock,
    timers: timers.timers,
    diagnostics,
    emitPanel: (s) => void panel.push(s),
    ...extra,
  });
  let seq = 0;
  let permissionsRevision = 100;
  let lastClient: ReturnType<typeof fakeClient> | null = null;
  /** The revision of the last capture_policy the latest sensor received, as the extension stamps it. */
  const policyRevision = (): number | undefined => {
    const p = lastClient?.sent.filter((f) => f.type === "capture_policy").at(-1);
    return p?.type === "capture_policy" ? p.revision : undefined;
  };
  const focus = (overrides: Partial<FocusObservation> = {}): FocusObservation => ({
    kind: "focus",
    seq: ++seq,
    at: clock.t,
    browserFocused: true,
    windowId: 1,
    tabId: 10,
    url: STRIPE,
    documentId: "doc-a",
    ...overrides,
  });
  const pageText = (overrides: Partial<PageTextObservation> = {}): PageTextObservation => ({
    kind: "page_text",
    seq: ++seq,
    at: clock.t,
    tabId: 20,
    documentId: "doc-issue",
    url: ISSUE,
    source: "github_issue",
    title: "An issue",
    text: "Issue body",
    truncated: false,
    ...(policyRevision() !== undefined ? { policyRevision: policyRevision()! } : {}),
    ...overrides,
  });
  const chrome = () => coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.google.Chrome", at: clock.t });
  /** Attach a sensor without a permissions snapshot. */
  const attach = (id = 1) => {
    const c = fakeClient(id);
    coordinator.attachClient(c.client);
    lastClient = c;
    return c;
  };
  /** A permissions snapshot with the next revision. */
  const grant = (c: ReturnType<typeof attach>, granted: string[] = DEFAULT_GRANTS, githubCapture = true) =>
    c.observe({ kind: "permissions", revision: ++permissionsRevision, at: clock.t, granted, githubCapture });
  /** Attach a sensor and send the usual snapshot (Stripe, Peak Design, GitHub; GitHub capture on). */
  const connect = (id = 1) => {
    const c = attach(id);
    grant(c);
    return c;
  };
  const acks = (c: ReturnType<typeof attach>) => c.sent.filter((f) => f.type === "ack");
  const policies = (c: ReturnType<typeof attach>) => c.sent.filter((f) => f.type === "capture_policy");
  return { coordinator, clock, panel, events, focus, pageText, chrome, attach, grant, connect, acks, policies, timers: timers.timers, advance: timers.advance };
}

describe("coordinator", () => {
  it("a configured chromeBundleId is the one that counts as Chrome frontmost", () => {
    const { coordinator, focus, connect } = setup({
      config: { chromeBundleId: "com.google.chrome.for.testing" },
    });
    const c = connect();
    coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.google.Chrome", at: 1 });
    c.observe(focus());
    expect(coordinator.tracker.current()).toBeNull();
    coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.google.chrome.for.testing", at: 2 });
    expect(coordinator.tracker.current()).not.toBeNull();
    expect(new URL(coordinator.tracker.current()!.origin).hostname).toBe("docs.stripe.com");
  });

  it("starts disconnected and goes idle when a sensor says hello", () => {
    const { panel, connect } = setup();
    expect(panel).toEqual([{ type: "state", status: "disconnected" }]);
    connect();
    expect(panel.at(-1)).toEqual({ type: "state", status: "idle", visitEpoch: 0, permitted: false });
  });

  it("an active visit's idle state carries the permitted hostname only; leaving drops it", () => {
    const { coordinator, panel, focus, chrome, connect } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ url: "https://docs.stripe.com/payments/checkout?q=secret#frag" }));
    const state = panel.at(-1);
    expect(state).toEqual({ type: "state", status: "idle", visitEpoch: coordinator.tracker.epoch, detail: "docs.stripe.com", permitted: true });
    expect(JSON.stringify(state)).not.toContain("payments");
    coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.apple.Terminal", at: 1 });
    expect(panel.at(-1)).toEqual({ type: "state", status: "idle", visitEpoch: coordinator.tracker.epoch, permitted: false });
    expect(panel.at(-1)).not.toHaveProperty("detail");
  });

  it("agentView shows the focused permitted visit and the pause state, nothing else", () => {
    const { coordinator, focus, chrome, connect } = setup();
    expect(coordinator.agentView()).toEqual({ currentSite: null, paused: false });
    const c = connect();
    chrome();
    c.observe(focus());
    expect(coordinator.agentView()).toEqual({
      currentSite: { origin: "https://docs.stripe.com", url: STRIPE, visitEpoch: coordinator.tracker.epoch },
      paused: false,
    });
    coordinator.handleNativeCommand({ type: "pause" });
    expect(coordinator.agentView().paused).toBe(true);
    c.observe(focus({ url: "https://example.com/" }));
    expect(coordinator.agentView().currentSite).toBeNull();
  });

  it("a permitted focus while Chrome is frontmost emits idle with the new epoch; a repeat emits nothing", () => {
    const { coordinator, panel, focus, chrome, connect } = setup();
    const c = connect();
    chrome(); // idle -> idle: no emission
    const before = panel.length;
    c.observe(focus());
    expect(coordinator.tracker.current()).not.toBeNull();
    const epoch = coordinator.tracker.epoch;
    expect(panel.slice(before)).toEqual([{ type: "state", status: "idle", visitEpoch: epoch, detail: "docs.stripe.com", permitted: true }]);

    c.observe(focus({ title: "retitled" }));
    chrome();
    expect(panel.length).toBe(before + 1);
    expect(coordinator.tracker.epoch).toBe(epoch);
  });

  it("idle-to-idle changes emit nothing", () => {
    const { coordinator, panel, focus, chrome, connect } = setup();
    const c = connect();
    chrome();
    const before = panel.length;
    const epoch = coordinator.tracker.epoch;
    c.observe(focus({ url: "https://example.com/a", tabId: 1 }));
    c.observe(focus({ url: "https://example.com/b", tabId: 2 }));
    coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.apple.Terminal", at: 1 });
    expect(coordinator.tracker.epoch).toBeGreaterThan(epoch);
    expect(panel.length).toBe(before);
  });

  it("leaving a permitted page emits idle with the new epoch", () => {
    const { coordinator, panel, focus, chrome, connect } = setup();
    const c = connect();
    chrome();
    c.observe(focus());
    coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.apple.Terminal", at: 1 });
    expect(coordinator.tracker.current()).toBeNull();
    expect(panel.at(-1)).toEqual({ type: "state", status: "idle", visitEpoch: coordinator.tracker.epoch, permitted: false });
  });

  it("page_text from the focused tab is accepted into the activity store and acked to the host", () => {
    const { coordinator, events, focus, pageText, chrome, connect, acks } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue" }));
    const obs = pageText();
    c.observe(obs);
    expect(coordinator.activity.revision).toBe(1);
    expect(acks(c)).toEqual([{ type: "ack", seq: obs.seq }]);
    expect(events.find((e) => e.name === "activity_accepted")?.fields).toEqual({ bytes: 10, truncated: false, duplicate: false });
    expect(coordinator.activity.entries()).toMatchObject([{ url: ISSUE, title: "An issue", text: "Issue body", source: "github_issue" }]);
  });

  it("new visits carry the bumped contextRevision", () => {
    const { coordinator, focus, pageText, chrome, connect } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue" }));
    c.observe(pageText());
    c.observe(focus());
    expect(coordinator.tracker.current()?.contextRevision).toBe(1);
  });

  it("page_text from another tab, an unfocused browser, or with Chrome in back is dropped and not acked", () => {
    const { coordinator, events, focus, pageText, chrome, connect, acks } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue" }));
    c.observe(pageText({ tabId: 21 }));
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue", browserFocused: false, windowId: -1 }));
    c.observe(pageText());
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue" }));
    coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.apple.Terminal", at: 1 });
    c.observe(pageText());
    expect(acks(c)).toEqual([]);
    expect(coordinator.activity.revision).toBe(0);
    expect(events.filter((e) => e.name === "page_text_dropped").map((e) => e.fields.reason)).toEqual([
      "not-focused-tab",
      "browser-not-focused",
      "chrome-not-frontmost",
    ]);
  });

  it("page_text is dropped while the focused tab is incognito", () => {
    const { coordinator, events, focus, pageText, chrome, connect, acks } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue", incognito: true }));
    c.observe(pageText());
    expect(acks(c)).toEqual([]);
    expect(coordinator.activity.revision).toBe(0);
    expect(events.filter((e) => e.name === "page_text_dropped").map((e) => e.fields.reason)).toEqual(["incognito"]);
  });

  it("page_text from a document the focused tab has left is dropped; no focus documentId skips the check", () => {
    const { coordinator, events, focus, pageText, chrome, connect, acks } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-next" }));
    c.observe(pageText());
    expect(acks(c)).toEqual([]);
    expect(events.filter((e) => e.name === "page_text_dropped").map((e) => e.fields.reason)).toEqual([
      "not-focused-document",
    ]);
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: undefined }));
    const obs = pageText();
    c.observe(obs);
    expect(acks(c)).toEqual([{ type: "ack", seq: obs.seq }]);
    expect(coordinator.activity.revision).toBe(1);
  });

  it("page_text whose URL is not the focused tab's issue is dropped as url-mismatch", () => {
    const { coordinator, events, focus, pageText, chrome, connect, acks } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: "https://github.com/o/r/issues/2", documentId: "doc-issue" }));
    c.observe(pageText());
    c.observe(focus({ tabId: 20, url: "https://github.com/o/r/pulls", documentId: "doc-issue" }));
    c.observe(pageText());
    expect(acks(c)).toEqual([]);
    expect(coordinator.activity.revision).toBe(0);
    expect(events.filter((e) => e.name === "page_text_dropped").map((e) => e.fields.reason)).toEqual([
      "url-mismatch",
      "url-mismatch",
    ]);
  });

  it("the URL gate ignores query, fragment, trailing slash, and owner/repo case", () => {
    const { coordinator, focus, pageText, chrome, connect, acks } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: "https://github.com/O/R/issues/1/?tab=x#issuecomment-5", documentId: "doc-issue" }));
    const obs = pageText();
    c.observe(obs);
    expect(acks(c)).toEqual([{ type: "ack", seq: obs.seq }]);
    expect(coordinator.activity.revision).toBe(1);
  });

  it("pause emits paused and suppresses forwarding and visit states; resume emits idle", () => {
    const { coordinator, panel, focus, pageText, chrome, connect, acks } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue" }));
    coordinator.handleNativeCommand({ type: "pause" });
    expect(panel.at(-1)).toEqual({ type: "state", status: "paused" });
    const before = panel.length;
    c.observe(pageText());
    c.observe(focus());
    expect(panel.length).toBe(before);
    expect(acks(c)).toEqual([]);
    expect(coordinator.activity.revision).toBe(0);
    coordinator.handleNativeCommand({ type: "resume" });
    // The visit to docs.stripe.com (tracked while paused) is still active.
    expect(panel.at(-1)).toEqual({
      type: "state",
      status: "idle",
      visitEpoch: coordinator.tracker.epoch,
      detail: "docs.stripe.com",
      permitted: true,
    });
  });

  it("the most recent hello is the live sensor; an older connection's frames and close are ignored", () => {
    const { coordinator, panel, focus, chrome, connect, events } = setup();
    const old = connect(1);
    const live = connect(2);
    chrome();
    old.observe(focus());
    expect(coordinator.tracker.current()).toBeNull();
    expect(events.some((e) => e.name === "stale_sensor_frame")).toBe(true);
    old.disconnect();
    expect((panel.at(-1) as { status?: string } | undefined)?.status).toBe("idle");
    live.observe(focus());
    expect(coordinator.tracker.current()).not.toBeNull();
  });

  it("a new sensor ends the previous sensor's visit", () => {
    const { coordinator, panel, focus, chrome, connect } = setup();
    const first = connect(1);
    chrome();
    first.observe(focus());
    expect(coordinator.tracker.current()).not.toBeNull();
    connect(2);
    expect(coordinator.tracker.current()).toBeNull();
    expect(panel.at(-1)).toEqual({ type: "state", status: "idle", visitEpoch: coordinator.tracker.epoch, permitted: false });
  });

  it("losing the live sensor ends the visit and emits disconnected", () => {
    const { coordinator, panel, focus, chrome, connect } = setup();
    const c = connect();
    chrome();
    c.observe(focus());
    c.disconnect();
    expect(coordinator.tracker.current()).toBeNull();
    expect(panel.at(-1)).toEqual({ type: "state", status: "disconnected" });
    const again = connect(2);
    expect(panel.at(-1)).toEqual({ type: "state", status: "idle", visitEpoch: coordinator.tracker.epoch, permitted: false });
    expect(again.closed).toBe(false);
  });

  it("shutdown stops handling input and asks the owner to shut down once", () => {
    let requests = 0;
    const { coordinator, panel, focus, chrome, connect } = setup({ onShutdownRequested: () => void (requests += 1) });
    const c = connect();
    coordinator.handleNativeCommand({ type: "shutdown" });
    coordinator.handleNativeCommand({ type: "shutdown" });
    expect(coordinator.stopped).toBe(true);
    expect(requests).toBe(1);
    const before = panel.length;
    chrome();
    c.observe(focus());
    expect(panel.length).toBe(before);
    expect(coordinator.tracker.epoch).toBe(0);
    const late = connect(2);
    expect(late.closed).toBe(true);
  });
});

describe("coordinator capture policy and permissions", () => {
  it("answers a new sensor with a capture-disabled policy before any other frame", () => {
    const { attach } = setup();
    const c = attach();
    expect(c.sent).toEqual([{ type: "capture_policy", revision: 0, paused: false, captureEnabled: false }]);
  });

  it("the initial policy carries the pause state", () => {
    const { coordinator, attach } = setup();
    coordinator.handleNativeCommand({ type: "pause" });
    const c = attach();
    expect(c.sent).toEqual([{ type: "capture_policy", revision: 0, paused: true, captureEnabled: false }]);
  });

  it("enables capture only for a snapshot with the GitHub toggle and the GitHub grant, and only on change", () => {
    const { attach, grant, policies } = setup();
    const c = attach();
    grant(c, ["https://docs.stripe.com/*"], true);
    grant(c, ["https://github.com/*"], false);
    expect(policies(c)).toHaveLength(1);
    grant(c, ["https://github.com/*"], true);
    expect(policies(c)).toEqual([
      { type: "capture_policy", revision: 0, paused: false, captureEnabled: false },
      { type: "capture_policy", revision: 1, paused: false, captureEnabled: true },
    ]);
    grant(c, ["https://github.com/*", "https://docs.stripe.com/*"], true);
    expect(policies(c)).toHaveLength(2);
    grant(c, ["https://docs.stripe.com/*"], true);
    expect(policies(c).at(-1)).toEqual({ type: "capture_policy", revision: 2, paused: false, captureEnabled: false });
  });

  it("pause sends a disabling policy and resume re-enables it, each with the next revision", () => {
    const { coordinator, connect, policies } = setup();
    const c = connect();
    coordinator.handleNativeCommand({ type: "pause" });
    coordinator.handleNativeCommand({ type: "pause" });
    coordinator.handleNativeCommand({ type: "resume" });
    expect(policies(c)).toEqual([
      { type: "capture_policy", revision: 0, paused: false, captureEnabled: false },
      { type: "capture_policy", revision: 1, paused: false, captureEnabled: true },
      { type: "capture_policy", revision: 2, paused: true, captureEnabled: false },
      { type: "capture_policy", revision: 3, paused: false, captureEnabled: true },
    ]);
  });

  it("pause and resume without a snapshot still send a policy (paused changes)", () => {
    const { coordinator, attach, policies } = setup();
    const c = attach();
    coordinator.handleNativeCommand({ type: "pause" });
    coordinator.handleNativeCommand({ type: "resume" });
    expect(policies(c).map((p) => [p.revision, p.paused, p.captureEnabled])).toEqual([
      [0, false, false],
      [1, true, false],
      [2, false, false],
    ]);
  });

  it("before a snapshot (e.g. an old extension whose snapshot failed validation) focus forms no visit and page_text is dropped", () => {
    const { coordinator, events, focus, pageText, chrome, attach, acks, policies } = setup();
    const c = attach();
    chrome();
    c.observe(focus());
    expect(coordinator.tracker.current()).toBeNull();
    c.observe(focus({ tabId: 20, url: ISSUE }));
    c.observe(pageText());
    expect(acks(c)).toEqual([]);
    expect(policies(c)).toHaveLength(1);
    expect(coordinator.activity.revision).toBe(0);
    expect(events.filter((e) => e.name === "page_text_dropped").map((e) => e.fields.reason)).toEqual(["no_permissions_snapshot"]);
  });

  it("page_text is refused when the snapshot turns GitHub capture off or lacks the GitHub grant", () => {
    const { coordinator, events, focus, pageText, chrome, attach, grant, acks } = setup();
    const c = attach();
    chrome();
    grant(c, ["https://github.com/*"], false);
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue" }));
    c.observe(pageText());
    grant(c, ["https://docs.stripe.com/*"], true);
    c.observe(pageText());
    expect(acks(c)).toEqual([]);
    expect(coordinator.activity.revision).toBe(0);
    expect(events.filter((e) => e.name === "page_text_dropped").map((e) => e.fields.reason)).toEqual([
      "capture_disabled",
      "capture_disabled",
    ]);
  });

  it("a focus on an origin the snapshot does not grant forms no visit until it is granted", () => {
    const { coordinator, focus, chrome, attach, grant } = setup();
    const c = attach();
    chrome();
    grant(c, ["https://docs.stripe.com/*"]);
    c.observe(focus({ url: "https://example.com/page" }));
    expect(coordinator.tracker.current()).toBeNull();
    grant(c, ["https://docs.stripe.com/*", "https://example.com/*"]);
    expect(coordinator.tracker.current()).toMatchObject({ origin: "https://example.com" });
  });

  it("losing the current origin's grant ends the visit and its dwell", () => {
    const { coordinator, events, focus, chrome, connect, grant, advance } = setup({ capabilities: fakeCapabilities().capabilities });
    const c = connect();
    chrome();
    c.observe(focus());
    expect(coordinator.tracker.current()).not.toBeNull();
    advance(DWELL_MS - 1);
    grant(c, ["https://github.com/*"]);
    expect(coordinator.tracker.current()).toBeNull();
    advance(DWELL_MS);
    expect(events.filter((e) => e.name === "dwell_cancelled").map((e) => e.fields.reason)).toEqual(["permission_lost"]);
    expect(events.some((e) => e.name === "discovery_start")).toBe(false);
  });

  it("drops a focus stamped with an older permissions revision", () => {
    const { coordinator, events, focus, chrome, attach } = setup();
    const c = attach();
    chrome();
    c.observe({ kind: "permissions", revision: 10, at: 1, granted: ["https://docs.stripe.com/*"], githubCapture: false });
    c.observe(focus({ permissionsRevision: 9 }));
    expect(coordinator.tracker.current()).toBeNull();
    expect(events.at(-1)).toMatchObject({ name: "focus_dropped", fields: { reason: "stale_permissions_revision" } });
    c.observe(focus({ permissionsRevision: 10 }));
    expect(coordinator.tracker.current()).not.toBeNull();
  });

  it("drops a focus stamped ahead of the current snapshot until that snapshot arrives", () => {
    const { coordinator, events, focus, chrome, attach } = setup();
    const c = attach();
    chrome();
    c.observe({ kind: "permissions", revision: 10, at: 1, granted: ["https://docs.stripe.com/*"], githubCapture: false });
    // Snapshot 11 revoked Stripe but was lost on the way; the focus sent under it must not use grant 10.
    c.observe(focus({ permissionsRevision: 11 }));
    expect(coordinator.tracker.current()).toBeNull();
    expect(events.at(-1)).toMatchObject({ name: "focus_dropped", fields: { reason: "permissions_ahead" } });
    c.observe({ kind: "permissions", revision: 11, at: 1, granted: ["https://docs.stripe.com/*"], githubCapture: false });
    expect(coordinator.tracker.current()).toBeNull();
    c.observe(focus({ permissionsRevision: 11 }));
    expect(coordinator.tracker.current()).toMatchObject({ origin: "https://docs.stripe.com" });
  });

  it("drops a snapshot older than the current one", () => {
    const { coordinator, focus, chrome, attach } = setup();
    const c = attach();
    chrome();
    c.observe({ kind: "permissions", revision: 10, at: 1, granted: ["https://docs.stripe.com/*"], githubCapture: false });
    c.observe(focus());
    c.observe({ kind: "permissions", revision: 9, at: 1, granted: [], githubCapture: false });
    expect(coordinator.tracker.current()).not.toBeNull();
  });

  it("a new connection starts with no grants and its own revision-0 disabled policy", () => {
    const { coordinator, focus, chrome, connect, attach, grant, policies } = setup();
    const first = connect(1);
    chrome();
    first.observe(focus());
    expect(policies(first).at(-1)?.captureEnabled).toBe(true);
    const second = attach(2);
    expect(second.sent).toEqual([{ type: "capture_policy", revision: 0, paused: false, captureEnabled: false }]);
    second.observe(focus());
    expect(coordinator.tracker.current()).toBeNull();
    expect(coordinator.permissions.received).toBe(false);
    // The old connection's late snapshot changes nothing.
    grant(first);
    expect(coordinator.permissions.received).toBe(false);
    grant(second);
    expect(coordinator.tracker.current()).not.toBeNull();
    expect(policies(second).at(-1)).toEqual({ type: "capture_policy", revision: 1, paused: false, captureEnabled: true });
  });

  it("a disconnect forgets the grants", () => {
    const { coordinator, connect } = setup();
    const c = connect();
    expect(coordinator.permissions.isPermitted("https://github.com")).toBe(true);
    c.disconnect();
    expect(coordinator.permissions.received).toBe(false);
    expect(coordinator.permissions.isPermitted("https://github.com")).toBe(false);
  });
});

describe("coordinator dwell and discovery", () => {
  /** Connected, Chrome frontmost, focused on Stripe: a permitted visit whose dwell is running. */
  function visiting(extra: Partial<CoordinatorOptions> = {}) {
    const caps = fakeCapabilities();
    const s = setup({ capabilities: caps.capabilities, ...extra });
    const c = s.connect();
    s.chrome();
    c.observe(s.focus());
    return { ...s, ...caps, c };
  }

  it("a visit that stays put for DWELL_MS runs one pass: one session, one window, catalog and discovery on it, then ingest", async () => {
    const s = visiting();
    s.advance(DWELL_MS - 1);
    expect(s.passes).toHaveLength(0);
    s.advance(1);
    expect(s.sessions).toEqual([{ origin: "https://docs.stripe.com", windows: 1, cancels: 0 }]);
    expect(s.catalogCalls.map((c) => c.origin)).toEqual(["https://docs.stripe.com"]);
    expect(s.passes.map((p) => p.origin)).toEqual(["https://docs.stripe.com"]);
    s.passes[0]!.discover.resolve(discoveryFor("https://docs.stripe.com"));
    await flush();
    expect(s.ingests).toEqual([{ origin: "https://docs.stripe.com", chromePermitted: true }]);
    expect(s.events.some((e) => e.name === "discovery_ingested")).toBe(true);
    s.advance(DWELL_MS * 5);
    expect(s.passes).toHaveLength(1);
  });

  it.each<[string, (s: ReturnType<typeof visiting>) => void, string]>([
    ["pause", (s) => s.coordinator.handleNativeCommand({ type: "pause" }), "paused"],
    ["navigation", (s) => s.c.observe(s.focus({ url: "https://docs.stripe.com/billing" })), "visit_changed"],
    ["Chrome losing the foreground", (s) => s.coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.apple.Terminal", at: 1 }), "visit_ended"],
    ["permission loss", (s) => s.grant(s.c, ["https://github.com/*"]), "permission_lost"],
    ["disconnect", (s) => s.c.disconnect(), "disconnected"],
    ["shutdown", (s) => s.coordinator.stop(), "stopped"],
  ])("%s cancels the dwell", (_name, act, reason) => {
    const s = visiting();
    s.advance(DWELL_MS - 1);
    act(s);
    s.advance(1);
    expect(s.events.filter((e) => e.name === "dwell_cancelled").map((e) => e.fields.reason)[0]).toBe(reason);
    // Navigation re-arms for the new page; nothing else settles.
    if (reason !== "visit_changed") {
      s.advance(DWELL_MS * 2);
      expect(s.passes).toHaveLength(0);
    } else {
      expect(s.passes).toHaveLength(0);
      s.advance(DWELL_MS);
      expect(s.passes).toHaveLength(1);
    }
  });

  it("resume starts a fresh dwell for the visit tracked while paused", () => {
    const s = visiting();
    s.coordinator.handleNativeCommand({ type: "pause" });
    s.advance(DWELL_MS * 2);
    expect(s.passes).toHaveLength(0);
    s.coordinator.handleNativeCommand({ type: "resume" });
    s.advance(DWELL_MS);
    expect(s.passes).toHaveLength(1);
  });

  it.each<[string, (s: ReturnType<typeof visiting>) => void, string]>([
    ["the visit changes", (s) => s.c.observe(s.focus({ url: "https://docs.stripe.com/billing" })), "epoch_changed"],
    ["the origin loses its grant", (s) => s.grant(s.c, ["https://github.com/*"]), "permission_lost"],
    ["Scout is paused", (s) => s.coordinator.handleNativeCommand({ type: "pause" }), "paused"],
    ["the coordinator stops", (s) => s.coordinator.stop(), "stopped"],
    ["the connection closes", (s) => s.c.disconnect(), "disconnected"],
    [
      "a new connection attaches, re-grants, and refocuses the same URL",
      (s) => {
        const next = s.connect(2);
        next.observe(s.focus());
        expect(s.coordinator.tracker.current()).toMatchObject({ origin: "https://docs.stripe.com" });
      },
      "disconnected",
    ],
  ])("a pass whose result arrives after %s is discarded", async (_name, act, reason) => {
    const s = visiting();
    s.advance(DWELL_MS);
    act(s);
    s.passes[0]!.discover.resolve(discoveryFor("https://docs.stripe.com"));
    await flush();
    expect(s.ingests).toEqual([]);
    expect(s.events.find((e) => e.name === "discovery_discarded")?.fields).toMatchObject({ reason });
  });

  it.each<[string, (s: ReturnType<typeof visiting>) => void]>([
    ["the visit changes", (s) => s.c.observe(s.focus({ url: "https://docs.stripe.com/billing" }))],
    ["another origin loses its grant", (s) => s.grant(s.c, ["https://docs.stripe.com/*"])],
  ])("the running pass keeps its session when %s", (_name, act) => {
    const s = visiting();
    s.advance(DWELL_MS);
    act(s);
    expect(s.sessions[0]!.cancels).toBe(0);
  });

  it.each<[string, (s: ReturnType<typeof setup>, c: ReturnType<ReturnType<typeof setup>["connect"]>) => void, string]>([
    ["pause", (s) => s.coordinator.handleNativeCommand({ type: "pause" }), "paused"],
    ["permission loss", (s, c) => s.grant(c, ["https://github.com/*"]), "permission_lost"],
    ["disconnect", (_s, c) => c.disconnect(), "disconnected"],
    ["a new sensor", (s) => void s.connect(2), "disconnected"],
    ["stop", (s) => s.coordinator.stop(), "stopped"],
  ])("%s cancels the running pass's session: no further fetches, then discovery_discarded", async (_name, act, reason) => {
    const fetched: string[] = [];
    const settled = { fetches: 0 };
    let s!: ReturnType<typeof setup>;
    const capabilities: CoordinatorCapabilities = {
      store: { ingest: async () => expect.unreachable("a cancelled pass must not ingest") },
      createFetchSession: (origin) =>
        createOriginFetchSession({
          origin,
          clock: { now: () => s.clock.t },
          // The crawl-delay wait runs on the test's fake timers.
          sleep: (ms) => new Promise<void>((resolve) => void s.timers.setTimeout(resolve, ms)),
          guardedFetch: async (url): Promise<GuardedFetchResult> => {
            fetched.push(new URL(url).pathname);
            return { kind: "absent", status: 404 };
          },
        }),
      resolveCatalog: async () => ({ result: { ok: false }, stats: { requests: 0, refused: 0, bytesReceived: 0, ms: 0 } }) as unknown as CatalogResolution,
      discover: async (origin, session) => {
        session.fetch.setCrawlDelay(1_000);
        for (const path of ["/robots.txt", "/llms.txt", "/AGENTS.md", "/.well-known/agent-skills/index.json"]) {
          await session.fetch(`${origin}${path}`);
          settled.fetches += 1;
        }
        return discoveryFor(origin);
      },
    };
    s = setup({ capabilities });
    const c = s.connect();
    s.chrome();
    c.observe(s.focus());
    s.advance(DWELL_MS);
    await flushMacro();
    expect(fetched).toEqual(["/robots.txt"]);
    s.advance(1_000);
    await flushMacro();
    expect(fetched).toEqual(["/robots.txt", "/llms.txt"]);

    act(s, c);
    s.advance(10_000);
    await flushMacro();
    expect(fetched).toEqual(["/robots.txt", "/llms.txt"]);
    expect(settled.fetches).toBe(4);
    expect(s.events.filter((e) => e.name === "discovery_discarded").map((e) => e.fields.reason)).toEqual([reason]);
    expect(s.events.some((e) => e.name === "discovery_ingested")).toBe(false);
  });

  it("a pass paused and resumed before it finishes never ingests; the re-armed dwell runs a fresh pass", async () => {
    const s = visiting();
    s.advance(DWELL_MS);
    expect(s.passes).toHaveLength(1);
    s.coordinator.handleNativeCommand({ type: "pause" });
    s.coordinator.handleNativeCommand({ type: "resume" });
    s.passes[0]!.discover.resolve(discoveryFor("https://docs.stripe.com"));
    await flush();
    expect(s.ingests).toEqual([]);
    expect(s.events.find((e) => e.name === "discovery_discarded")?.fields).toMatchObject({ reason: "paused" });
    s.advance(DWELL_MS);
    expect(s.passes).toHaveLength(2);
    s.passes[1]!.discover.resolve(discoveryFor("https://docs.stripe.com"));
    await flush();
    expect(s.ingests).toEqual([{ origin: "https://docs.stripe.com", chromePermitted: true }]);
  });

  it("a fresh settle while the paused pass is still running queues and runs after it", async () => {
    const s = visiting();
    s.advance(DWELL_MS);
    s.coordinator.handleNativeCommand({ type: "pause" });
    s.coordinator.handleNativeCommand({ type: "resume" });
    s.advance(DWELL_MS);
    expect(s.passes).toHaveLength(1);
    s.passes[0]!.discover.resolve(discoveryFor("https://docs.stripe.com"));
    await flush();
    expect(s.passes).toHaveLength(2);
    s.passes[1]!.discover.resolve(discoveryFor("https://docs.stripe.com"));
    await flush();
    expect(s.ingests).toHaveLength(1);
  });

  it("honors a configured dwellMs", () => {
    const s = visiting({ dwellMs: 50 });
    s.advance(49);
    expect(s.passes).toHaveLength(0);
    s.advance(1);
    expect(s.passes).toHaveLength(1);
  });

  it("runs one pass at a time; settles meanwhile queue with the latest winning", async () => {
    const s = visiting();
    s.advance(DWELL_MS);
    s.c.observe(s.focus({ url: "https://www.peakdesign.com/a" }));
    s.advance(DWELL_MS);
    s.c.observe(s.focus({ url: "https://github.com/o/r" }));
    s.advance(DWELL_MS);
    expect(s.passes.map((p) => p.origin)).toEqual(["https://docs.stripe.com"]);
    expect(s.events.filter((e) => e.name === "discovery_discarded").map((e) => e.fields)).toEqual([
      { origin: "https://www.peakdesign.com", epoch: expect.any(Number), reason: "superseded" },
    ]);
    s.passes[0]!.discover.resolve(discoveryFor("https://docs.stripe.com"));
    await flush();
    expect(s.passes.map((p) => p.origin)).toEqual(["https://docs.stripe.com", "https://github.com"]);
    expect(s.sessions.map((x) => x.origin)).toEqual(["https://docs.stripe.com", "https://github.com"]);
    s.passes[1]!.discover.resolve(discoveryFor("https://github.com"));
    await flush();
    expect(s.ingests.map((i) => i.origin)).toEqual(["https://github.com"]);
  });

  it("a queued settle whose visit is gone by the time the running pass ends is not started", async () => {
    const s = visiting();
    s.advance(DWELL_MS);
    s.c.observe(s.focus({ url: "https://www.peakdesign.com/a" }));
    s.advance(DWELL_MS);
    s.coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.apple.Terminal", at: 1 });
    s.passes[0]!.discover.resolve(discoveryFor("https://docs.stripe.com"));
    await flush();
    expect(s.passes).toHaveLength(1);
    expect(s.events.filter((e) => e.name === "discovery_discarded").map((e) => e.fields.reason)).toEqual([
      "epoch_changed",
      "epoch_changed",
    ]);
  });

  it("a failing discovery or catalog is logged as a code and the next settle still runs", async () => {
    const s = visiting();
    s.advance(DWELL_MS);
    s.passes[0]!.discover.reject(Object.assign(new Error("https://docs.stripe.com/secret"), { code: "ECONNRESET" }));
    await flush();
    const failed = s.events.find((e) => e.name === "discovery_failed");
    expect(failed?.fields).toMatchObject({ code: "ECONNRESET" });
    expect(JSON.stringify(s.events)).not.toContain("secret");
    s.c.observe(s.focus({ url: "https://docs.stripe.com/billing" }));
    s.advance(DWELL_MS);
    expect(s.passes).toHaveLength(2);
  });

  it("a catalog failure does not block ingesting the discovery", async () => {
    const caps = fakeCapabilities();
    caps.capabilities.resolveCatalog = async () => {
      throw new TypeError("bad");
    };
    const s = setup({ capabilities: caps.capabilities });
    const c = s.connect();
    s.chrome();
    c.observe(s.focus());
    s.advance(DWELL_MS);
    caps.passes[0]!.discover.resolve(discoveryFor("https://docs.stripe.com"));
    await flush();
    expect(caps.ingests).toHaveLength(1);
    expect(s.events.find((e) => e.name === "discovery_catalog_failed")?.fields).toMatchObject({ code: "TypeError" });
  });

  it("without capabilities a settle is only logged", () => {
    const s = setup();
    const c = s.connect();
    s.chrome();
    c.observe(s.focus());
    s.advance(DWELL_MS);
    expect(s.events.find((e) => e.name === "discovery_skipped")?.fields).toMatchObject({ reason: "not_wired" });
  });
});

describe("coordinator panel wiring", () => {
  const RES = `res_${"a".repeat(64)}`;
  const HASH = "b".repeat(64);

  function withPanel(capabilities?: CoordinatorCapabilities) {
    const handled: unknown[] = [];
    let changes = 0;
    const s = setup({
      panel: { handle: async (cmd) => void handled.push(cmd), capabilitiesChanged: () => void (changes += 1) },
      ...(capabilities ? { capabilities } : {}),
    });
    return { ...s, handled, changes: () => changes };
  }

  it("routes window commands to the panel channel and leaves the old commands alone", () => {
    const s = withPanel();
    const approve = { type: "approve", commandId: "a1", resourceId: RES, version: HASH, expectedRevision: 1 } as const;
    s.coordinator.handleNativeCommand(approve);
    s.coordinator.handleNativeCommand({ type: "preview", commandId: "p1", resourceId: RES, version: HASH });
    s.coordinator.handleNativeCommand({ type: "pause" });
    expect(s.handled).toEqual([approve, { type: "preview", commandId: "p1", resourceId: RES, version: HASH }]);
  });

  it("without a panel channel a window command gets an unavailable ack", () => {
    const s = setup();
    s.coordinator.handleNativeCommand({ type: "refresh_capabilities", commandId: "r1" });
    expect(s.panel.at(-1)).toEqual({ type: "ack", commandId: "r1", ok: false, code: "unavailable" });
  });

  it("tells the channel when grants are applied or cleared and when the visit changes", () => {
    const s = withPanel();
    const c = s.connect();
    const afterConnect = s.changes();
    expect(afterConnect).toBeGreaterThanOrEqual(2); // cleared on attach, then the snapshot
    s.chrome();
    c.observe(s.focus());
    expect(s.changes()).toBeGreaterThan(afterConnect);
    const beforeLoss = s.changes();
    s.grant(c, ["https://github.com/*"]);
    expect(s.changes()).toBeGreaterThan(beforeLoss);
    const beforeDisconnect = s.changes();
    c.disconnect();
    expect(s.changes()).toBeGreaterThan(beforeDisconnect);
  });

  it("tells the channel after an ingest commits and again when its export sync settles", async () => {
    const caps = fakeCapabilities();
    const cleanup = deferred<{ ok: boolean }>();
    caps.capabilities.store.ingest = async (discovery) => ({ origin: discovery.origin, results: [], skipped: 0, cleanup: cleanup.promise });
    const s = withPanel(caps.capabilities);
    const c = s.connect();
    s.chrome();
    c.observe(s.focus());
    s.advance(DWELL_MS);
    const before = s.changes();
    caps.passes[0]!.discover.resolve(discoveryFor("https://docs.stripe.com"));
    await flush();
    expect(s.changes()).toBe(before + 1);
    cleanup.resolve({ ok: true });
    await flush();
    expect(s.changes()).toBe(before + 2);
  });
});

describe("coordinator: page_text into the activity store", () => {
  /** An activity store that records when it was called, relative to the host's acks. */
  function recordingStore(order: string[]) {
    const real = createActivityStore({ clock: { now: () => 1_000 } });
    const store: ActivityStore = {
      accept: (obs, conn) => {
        order.push(`accept:${obs.seq}`);
        return real.accept(obs, conn);
      },
      entries: () => real.entries(),
      get revision() {
        return real.revision;
      },
      clear: () => real.clear(),
      prune: () => real.prune(),
    };
    return store;
  }

  it("acks only after the store accepted the text", () => {
    const order: string[] = [];
    const { focus, pageText, chrome, connect } = setup({ activity: recordingStore(order) });
    const c = connect();
    const send = c.client.send;
    c.client.send = (f) => {
      if (f.type === "ack") order.push(`ack:${f.seq}`);
      send(f);
    };
    chrome();
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue" }));
    const obs = pageText();
    c.observe(obs);
    expect(order).toEqual([`accept:${obs.seq}`, `ack:${obs.seq}`]);
  });

  it("drops text with a missing or stale policy revision as policy_revision, unacked", () => {
    const { coordinator, events, focus, pageText, chrome, connect, acks, grant } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue" }));
    const missing = pageText();
    delete (missing as { policyRevision?: number }).policyRevision;
    c.observe(missing);
    // Capture off then on again: the policy moves on, and text stamped with the old revision is refused.
    const stale = pageText();
    grant(c, ["https://github.com/*"], false);
    grant(c, ["https://github.com/*"], true);
    c.observe(stale);
    expect(acks(c)).toEqual([]);
    expect(coordinator.activity.revision).toBe(0);
    expect(events.filter((e) => e.name === "page_text_dropped").map((e) => e.fields.reason)).toEqual(["policy_revision", "policy_revision"]);
    const fresh = pageText();
    c.observe(fresh);
    expect(acks(c)).toEqual([{ type: "ack", seq: fresh.seq }]);
  });

  it("acks a re-sent seq or the same text again without a second change, and refreshes on new text", () => {
    const { coordinator, events, focus, pageText, chrome, connect, acks } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue" }));
    const obs = pageText();
    c.observe(obs);
    c.observe(obs);
    c.observe(pageText());
    expect(coordinator.activity.revision).toBe(1);
    c.observe(pageText({ text: "Edited body" }));
    expect(coordinator.activity.revision).toBe(2);
    expect(acks(c)).toHaveLength(4);
    expect(events.filter((e) => e.name === "activity_accepted").map((e) => e.fields.duplicate)).toEqual([false, true, true, false]);
    expect(coordinator.activity.entries()).toHaveLength(1);
  });

  it("logs no text, title or issue URL", () => {
    const { events, focus, pageText, chrome, connect } = setup();
    const c = connect();
    chrome();
    c.observe(focus({ tabId: 20, url: ISSUE, documentId: "doc-issue" }));
    c.observe(pageText());
    const logged = JSON.stringify(events);
    expect(logged).not.toContain("Issue body");
    expect(logged).not.toContain("An issue");
    expect(logged).not.toContain("issues/1");
  });

  it("calls onPause after a pause command", () => {
    let paused = 0;
    const { coordinator } = setup({ onPause: () => void paused++ });
    coordinator.handleNativeCommand({ type: "pause" });
    expect(paused).toBe(1);
  });
});
