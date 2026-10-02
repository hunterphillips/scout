import type { ActiveVisit } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import type { DiscoveryResult } from "./capabilities/discovery.js";
import type { CatalogResolution } from "./catalog/resolveCatalog.js";
import type { DiagnosticFields } from "./diagnostics.js";
import { createDiscoveryRunner, type DiscoveryCapabilities } from "./discoveryRunner.js";
import type { OriginFetchSession } from "./fetch/originSession.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const visit = (epoch: number, origin = "https://docs.stripe.com"): ActiveVisit => ({ epoch, origin, url: `${origin}/`, tabId: 1, startedAt: 0, contextRevision: 0 }) as ActiveVisit;
const discoveryFor = (origin: string): DiscoveryResult => ({ origin, checkedAt: 0, robots: "not_fetched", items: [], externalReferences: [], skillsOverCap: 0, acceptedBytes: 0, stats: { requests: 0, refused: 0, ms: 0 } });
const catalog = { result: { ok: false }, stats: { requests: 0, refused: 0, bytesReceived: 0, ms: 0 } } as unknown as CatalogResolution;

function harness() {
  const passes: Array<{ epoch: number; discover: ReturnType<typeof deferred<DiscoveryResult>> }> = [];
  const events: Array<{ name: string; fields: DiagnosticFields }> = [];
  const ingested: string[] = [];
  let current = 1;
  let n = 0;
  const caps: DiscoveryCapabilities = {
    store: {
      ingest: async (d) => {
        ingested.push(d.origin);
        return { origin: d.origin, results: [], skipped: 0, cleanup: Promise.resolve({ ok: true }) } as never;
      },
    },
    createFetchSession: (origin) => ({ origin, cancel: () => {}, startWindow: () => {} }) as unknown as OriginFetchSession,
    resolveCatalog: async () => catalog,
    discover: () => {
      const d = deferred<DiscoveryResult>();
      passes.push({ epoch: ++n, discover: d });
      return d.promise;
    },
  };
  const runner = createDiscoveryRunner({
    clock: { now: () => 0 },
    diagnostics: { failures: 0, event: (name, fields = {}) => void events.push({ name, fields }) },
    capabilities: caps,
    blocker: (v) => (v.epoch === current ? null : "epoch_changed"),
    isPermitted: () => true,
    onIngested: () => {},
  });
  return { runner, passes, events, ingested, setCurrent: (e: number) => (current = e) };
}

describe("discovery runner", () => {
  it("settles behind a live pass queue with the latest winning, and the queued one runs when it ends", async () => {
    const h = harness();
    h.runner.settle(visit(1));
    h.setCurrent(2);
    h.runner.settle(visit(2));
    h.setCurrent(3);
    h.runner.settle(visit(3));
    expect(h.passes).toHaveLength(1);
    expect(h.events.filter((e) => e.name === "discovery_discarded").map((e) => e.fields)).toEqual([{ origin: "https://docs.stripe.com", epoch: 2, reason: "superseded" }]);
    h.passes[0]!.discover.resolve(discoveryFor("https://docs.stripe.com"));
    await flush();
    expect(h.passes).toHaveLength(2);
    h.passes[1]!.discover.resolve(discoveryFor("https://docs.stripe.com"));
    await flush();
    expect(h.ingested).toHaveLength(1);
  });

  it("a cancelled pass no longer holds the slot: the next settle starts at once, and the cancelled pass's end starts nothing", async () => {
    const h = harness();
    h.runner.settle(visit(1));
    h.runner.cancel("visit_changed");
    h.setCurrent(2);
    h.runner.settle(visit(2));
    expect(h.passes).toHaveLength(2);
    h.passes[0]!.discover.resolve(discoveryFor("https://docs.stripe.com"));
    await flush();
    // The live pass still holds the slot after the cancelled one unwound.
    h.setCurrent(3);
    h.runner.settle(visit(3));
    expect(h.passes).toHaveLength(2);
    h.passes[1]!.discover.resolve(discoveryFor("https://docs.stripe.com"));
    await flush();
    expect(h.passes).toHaveLength(3);
  });
});
