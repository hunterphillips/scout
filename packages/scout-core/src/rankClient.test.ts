import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActiveVisit, PageTextObservation, SiteCatalog } from "@scout/contracts";
import type { ActivityObservation, ObserveActivityResult, RankRequest, RankResponse } from "personal-context-mcp/api";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDiagnostics } from "./diagnostics.js";
import { createRankClient, type RankClientOptions, SCOUT_SENSOR } from "./rankClient.js";
import type { ServiceTransport, TransportResult } from "./rankClient/transport.js";
import { createResumeCache } from "./resumeCache.js";

const STATUS = { serviceInstanceId: "svc-1", activityRevision: 9, sourceGrantRevision: "grant-a" };
const OK: RankResponse = {
  status: "ok",
  items: [{ id: "c0", reason: "fits", evidence: [{ id: "e1", kind: "note", label: "n" }] }],
  droppedCount: 0,
  ...STATUS,
};
const CATALOG: SiteCatalog = {
  origin: "https://docs.stripe.com",
  version: "v1",
  fetchedAt: 0,
  candidates: [{ id: "c0", sourceUrl: "https://docs.stripe.com/a", title: "A", labelQuality: "published", provenance: "llms.txt" }],
  truncated: false,
  errors: [],
};
const PAGE: PageTextObservation = {
  kind: "page_text",
  seq: 1,
  at: Date.UTC(2026, 8, 30, 12, 0, 0),
  tabId: 5,
  documentId: "doc",
  url: "https://github.com/o/r/issues/1",
  source: "github_issue",
  title: "Issue title",
  text: "issue body",
  truncated: true,
};

function visit(epoch: number, extra: Partial<ActiveVisit> = {}): ActiveVisit {
  return { epoch, tabId: 5, origin: "https://docs.stripe.com", url: "https://docs.stripe.com/x#frag", startedAt: Date.now(), contextRevision: 0, ...extra };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeTransport() {
  const ranks: { req: RankRequest; signal: AbortSignal | undefined; reply: Deferred<TransportResult<RankResponse>> }[] = [];
  const observed: ActivityObservation[] = [];
  let observeReply: () => Promise<TransportResult<ObserveActivityResult>> = async () => ({
    ok: true,
    value: { accepted: true, observationId: "o1" },
  });
  let statusReply: TransportResult<typeof STATUS> = { ok: true, value: STATUS };
  const transport: ServiceTransport = {
    rankSiteLinks(req, opts) {
      const reply = deferred<TransportResult<RankResponse>>();
      ranks.push({ req, signal: opts?.signal, reply });
      return reply.promise;
    },
    observeActivity(obs) {
      observed.push(obs);
      return observeReply();
    },
    contextStatus: async () => statusReply,
    lastContextStatus: () => STATUS,
    close: async () => {},
  };
  return {
    transport,
    ranks,
    observed,
    setObserve: (f: typeof observeReply) => {
      observeReply = f;
    },
    setStatus: (r: typeof statusReply) => {
      statusReply = r;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeClient(overrides: Partial<RankClientOptions> = {}) {
  const fake = fakeTransport();
  let revision = 0;
  let n = 0;
  const client = createRankClient({
    transport: fake.transport,
    clock: { now: () => Date.now() },
    getContextRevision: () => revision,
    newRequestId: () => `r${++n}`,
    ...overrides,
  });
  return { client, ...fake, bump: () => (revision += 1) };
}

describe("rank client epochs", () => {
  it("drops a response whose epoch is no longer current", async () => {
    let current = true;
    const events: [string, Record<string, unknown>][] = [];
    const store = vi.fn();
    const { client, ranks } = makeClient({
      isCurrentEpoch: () => current,
      diagnostics: { event: (name, fields = {}) => void events.push([name, fields]), failures: 0 },
      resumeCache: { store, restore: async () => null, clear: () => {}, size: 0 },
    });
    const result = client.rankForVisit(visit(1), CATALOG);
    await flush();
    current = false;
    ranks[0]!.reply.resolve({ ok: true, value: OK });
    expect(await result).toBeNull();
    expect(store).not.toHaveBeenCalled();
    expect(events).toContainEqual(["rank_result", expect.objectContaining({ epoch: 1, status: "ok", dropped: true })]);
  });

  it("a new epoch cancels the old epoch's job and aborts its call", async () => {
    const { client, ranks } = makeClient();
    const first = client.rankForVisit(visit(1), CATALOG);
    await flush();
    const second = client.rankForVisit(visit(2), CATALOG);
    expect(await first).toBeNull();
    expect(ranks[0]!.signal?.aborted).toBe(true);
    await flush();
    ranks[1]!.reply.resolve({ ok: true, value: OK });
    expect(await second).toMatchObject({ epoch: 2, source: "service", response: OK });
  });

  it("an older epoch does not take over from the current one", async () => {
    const events: [string, Record<string, unknown>][] = [];
    const { client, ranks } = makeClient({ diagnostics: { event: (name, fields = {}) => void events.push([name, fields]), failures: 0 } });
    const current = client.rankForVisit(visit(6), CATALOG);
    await flush();
    expect(await client.rankForVisit(visit(5), CATALOG)).toBeNull();
    await flush();
    expect(ranks).toHaveLength(1);
    expect(ranks[0]!.signal?.aborted).toBe(false);
    expect(events).toContainEqual(["rank_skipped", { epoch: 5, reason: "stale" }]);
    ranks[0]!.reply.resolve({ ok: true, value: OK });
    expect(await current).toMatchObject({ epoch: 6, source: "service", response: OK });
  });

  it("setCurrentEpoch cancels jobs for other epochs", async () => {
    const { client, ranks } = makeClient();
    const first = client.rankForVisit(visit(1), CATALOG);
    await flush();
    client.setCurrentEpoch(2);
    expect(await first).toBeNull();
    expect(ranks[0]!.signal?.aborted).toBe(true);
  });

  it("keeps one job per epoch", async () => {
    const { client, ranks } = makeClient();
    const a = client.rankForVisit(visit(1), CATALOG);
    const b = client.rankForVisit(visit(1), CATALOG);
    expect(b).toBe(a);
    await flush();
    expect(ranks).toHaveLength(1);
    ranks[0]!.reply.resolve({ ok: true, value: OK });
    await a;
  });

  it("turns a missing service or bad token into unavailable", async () => {
    const { client, ranks } = makeClient();
    const result = client.rankForVisit(visit(1), CATALOG);
    await flush();
    ranks[0]!.reply.resolve({ ok: false, status: "unavailable", reason: "bad token" });
    expect(await result).toMatchObject({ source: "local", response: { status: "unavailable", reason: "bad token", ...STATUS } });
  });
});

describe("resume cache", () => {
  it("passes the response's ContextStatus to the resume cache", async () => {
    const clock = { now: () => Date.now() };
    const cache = createResumeCache<RankResponse>({ clock });
    const { client, ranks } = makeClient({ resumeCache: cache });
    const v = visit(1, { documentId: "d1" });
    const result = client.rankForVisit(v, CATALOG);
    await flush();
    ranks[0]!.reply.resolve({ ok: true, value: OK });
    await result;
    expect(cache.size).toBe(1);
    const key = { tabId: 5, documentId: "d1", url: "https://docs.stripe.com/x", catalogVersion: "v1", contextRevision: 0 };
    expect(await cache.restore(key, () => client.fetchContextStatus())).toEqual(OK);
    // A different activityRevision from the service means the stored status no longer matches.
    expect(await cache.restore(key, async () => ({ ...STATUS, activityRevision: 10 }))).toBeNull();
  });

  it("does not store results Scout wrote itself", async () => {
    const store = vi.fn();
    const { client, ranks } = makeClient({ resumeCache: { store, restore: async () => null, clear: () => {}, size: 0 } });
    const result = client.rankForVisit(visit(1), CATALOG);
    await flush();
    ranks[0]!.reply.resolve({ ok: false, status: "unavailable", reason: "service unreachable" });
    await result;
    expect(store).not.toHaveBeenCalled();
  });

  it("fetchContextStatus rejects when the service cannot answer", async () => {
    const { client, setStatus } = makeClient();
    setStatus({ ok: false, status: "unavailable", reason: "service unreachable" });
    await expect(client.fetchContextStatus()).rejects.toThrow();
  });
});

describe("sendObservation", () => {
  it("maps a page_text observation to observe_activity and resolves on accepted", async () => {
    const { client, observed } = makeClient();
    await expect(client.sendObservation(PAGE)).resolves.toBeUndefined();
    expect(observed).toEqual([
      {
        sensor: SCOUT_SENSOR,
        kind: "viewed_page",
        observedAt: "2026-09-30T12:00:00.000Z",
        url: PAGE.url,
        title: PAGE.title,
        text: PAGE.text,
        truncated: true,
      },
    ]);
  });

  it("rejects when the service does not accept, or cannot be reached", async () => {
    const { client, setObserve } = makeClient();
    setObserve(async () => ({ ok: true, value: { accepted: false, observationId: "" } }));
    await expect(client.sendObservation(PAGE)).rejects.toThrow();
    setObserve(async () => ({ ok: false, status: "unavailable", reason: "service unreachable" }));
    await expect(client.sendObservation(PAGE)).rejects.toThrow();
  });

  it("a rank waits for an in-flight observation ack before starting", async () => {
    const { client, ranks, setObserve } = makeClient();
    const ack = deferred<TransportResult<ObserveActivityResult>>();
    setObserve(() => ack.promise);
    const sent = client.sendObservation(PAGE);
    const result = client.rankForVisit(visit(1), CATALOG);
    await flush();
    expect(ranks).toHaveLength(0);
    ack.resolve({ ok: true, value: { accepted: true, observationId: "o1" } });
    await sent;
    await flush();
    expect(ranks).toHaveLength(1);
    ranks[0]!.reply.resolve({ ok: true, value: OK });
    await result;
  });

  it("an observation during ranking discards the result and re-ranks once", async () => {
    const { client, ranks, bump } = makeClient();
    const result = client.rankForVisit(visit(1), CATALOG);
    await flush();
    bump();
    await client.sendObservation(PAGE);
    ranks[0]!.reply.resolve({ ok: true, value: OK });
    await flush();
    expect(ranks).toHaveLength(2);
    expect(ranks[1]!.req.supersedes).toBe("r1");
    ranks[1]!.reply.resolve({ ok: true, value: { status: "empty", ...STATUS } });
    expect(await result).toMatchObject({ contextRevision: 1, response: { status: "empty" } });
  });
});

describe("close", () => {
  it("cancels the running job, and later calls fail cleanly", async () => {
    const { client, ranks, setObserve } = makeClient();
    const running = client.rankForVisit(visit(1), CATALOG);
    await flush();
    let closed = false;
    const unavailable = async (): Promise<TransportResult<ObserveActivityResult>> =>
      closed ? { ok: false, status: "unavailable", reason: "service unreachable" } : { ok: true, value: { accepted: true, observationId: "o" } };
    setObserve(unavailable);
    await client.close();
    closed = true;
    expect(await running).toBeNull();
    expect(ranks[0]!.signal?.aborted).toBe(true);
    await expect(client.sendObservation(PAGE)).rejects.toThrow(/observe_activity failed/);
  });
});

describe("diagnostics", () => {
  it("every rank event survives the real diagnostics filter", async () => {
    const warn = vi.fn();
    const lines: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "scout-rank-diag-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const diagnostics = createDiagnostics({
      path: join(dir, "logs", "diagnostics.jsonl"),
      clock: { now: () => 0 },
      appendFile: (_p, data) => void lines.push(data),
      warn,
    });
    // One controllable clock for the client and the visits, so the deadline is exact.
    const now = Date.UTC(2026, 8, 30, 12, 0, 0);
    const { client, ranks, bump } = makeClient({ diagnostics, clock: { now: () => now } });
    // rank_start, rank_discarded, rank_start, rank_result
    const result = client.rankForVisit(visit(1, { startedAt: now }), CATALOG);
    await flush();
    bump();
    client.notifyContextChanged();
    ranks[0]!.reply.resolve({ ok: true, value: OK });
    await flush();
    ranks[1]!.reply.resolve({ ok: true, value: OK });
    await result;
    // rank_skipped, then a local rank_result with its reason
    await client.rankForVisit(visit(2, { startedAt: now - 29_000 }), CATALOG);

    expect(warn).not.toHaveBeenCalled();
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.map((e) => e.event)).toEqual(["rank_start", "rank_discarded", "rank_start", "rank_result", "rank_skipped", "rank_result"]);
    expect(events[0]).toMatchObject({ epoch: 1, rev: 0, deadlineMs: 26_000 });
    expect(events[3]).toMatchObject({ epoch: 1, status: "ok", dropped: false });
    expect(typeof events[3]!.ms).toBe("number");
    expect(events[4]).toMatchObject({ epoch: 2, reason: "no time left" });
    for (const e of events) {
      for (const value of Object.values(e)) expect(String(value)).not.toContain("://");
    }
  });
});
