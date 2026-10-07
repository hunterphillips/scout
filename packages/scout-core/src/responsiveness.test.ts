// The coordinator stays responsive while a worst-case bounded catalog parses. The real
// coordinator runs real discovery passes (real dwell timers, the real catalog resolver on a
// real origin fetch session, sitemap and llms.txt parsed in the real parse worker through
// per-pass scopes, as main.ts wires them) against a fake site that serves the largest
// catalog the caps allow: a sitemap index with ten ~2 MiB children holding 50,000 entries with
// image titles (the parser's heaviest path), and a robots.txt at the rule cap with wildcards.
//
// While a pass's sitemap is in the worker, a focus change (another tab) and then a pause arrive
// through the coordinator's own input paths; each must reach the side panel (its state) within
// 100 ms of arriving. A separate pass is left to run to the end while a 5 ms ticker measures the
// longest the event loop is held at any point of the resolve (worker hand-off, the resolver's
// dedupe/robots pass, the cache write): input would wait that long. The dedupe/robots pass stays
// on the main thread, time-sliced (resolver.ts PASS_SLICE_MS; resolver.test.ts bounds
// its adversarial shapes under 50 ms).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { BrowserObservation, ObservationFrame, PanelState, ToChromeFrame } from "@scout/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { DiscoveryResult } from "./capabilities/discovery.js";
import { createParsePool, type ParsePool } from "./catalog/parseWorker.js";
import { createCatalogResolver, type CatalogResolution } from "./catalog/resolveCatalog.js";
import { MAX_RULES } from "./catalog/robots.js";
import type { CatalogParsers } from "./catalog/resolver.js";
import { MAX_SITEMAP_ENTRIES, MAX_SITEMAP_INDEX_CHILDREN } from "./catalog/sitemap.js";
import { SITEMAP_MAX_BYTES } from "./catalog/catalogFetch.js";
import { systemClock, systemTimers } from "./clock.js";
import { createCoordinator } from "./coordinator.js";
import type { DiagnosticFields, Diagnostics } from "./diagnostics.js";
import type { GuardedFetchOptions, GuardedFetchResult } from "./fetch/guardedFetch.js";
import { createOriginFetchSession, type OriginFetchSession } from "./fetch/originSession.js";
import type { PanelSink } from "./panelSinks.js";
import type { SocketClient } from "./socketServer.js";

/** The native app's stdio sink: the sender of every command these tests hand in. */
const STDIO: PanelSink = { id: "stdio", kind: "stdio", send: () => {} };

const ORIGIN = "https://docs.example.com";
const BOUND_MS = 100;
/** A long caption with entities, so each child file sits just under the per-file cap. */
const CAPTION = "How to set up metered billing, invoices &amp; usage records for teams; ".repeat(2) + "step by step";

/** Ten index children, each just under the per-file cap, together exactly at the entry cap. */
function worstCaseSite() {
  const perChild = MAX_SITEMAP_ENTRIES / MAX_SITEMAP_INDEX_CHILDREN;
  const files: Record<string, string> = {};
  const children: string[] = [];
  for (let c = 0; c < MAX_SITEMAP_INDEX_CHILDREN; c++) {
    const urls: string[] = [];
    for (let i = 0; i < perChild; i++) {
      const n = c * perChild + i;
      urls.push(
        `<url><loc>${ORIGIN}/guides/section-${c}/page-${n}?a=1&amp;b=2</loc><image:image><image:loc>${ORIGIN}/i/${n}.png</image:loc><image:title>Guide ${n} &amp; more</image:title><image:caption>${CAPTION}</image:caption></image:image></url>`,
      );
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${urls.join("")}</urlset>`;
    files[`/sitemap-${c}.xml`] = xml;
    children.push(`<sitemap><loc>${ORIGIN}/sitemap-${c}.xml</loc></sitemap>`);
  }
  files["/sitemap.xml"] = `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children.join("")}</sitemapindex>`;
  // The rule cap, each rule with wildcards that never match (every entry is checked against all of them).
  const rules = Array.from({ length: MAX_RULES - 1 }, (_, i) => `Disallow: /*/nomatch-${i}/*/x*.pdf$`);
  files["/robots.txt"] = `User-agent: *\n${rules.join("\n")}\nAllow: /\n`;
  files["/llms.txt"] = "# Docs\n\n- [Billing](/billing): invoices\n";
  for (const [path, body] of Object.entries(files)) {
    if (Buffer.byteLength(body) > SITEMAP_MAX_BYTES) throw new Error(`${path} is over the per-file cap`);
  }
  const guardedFetch = async (url: string, _options: GuardedFetchOptions): Promise<GuardedFetchResult> => {
    const body = files[new URL(url).pathname];
    if (body === undefined) return { kind: "absent", status: 404 };
    return { kind: "ok", status: 200, body, bytes: new TextEncoder().encode(body), finalUrl: url, contentType: "application/xml" } as GuardedFetchResult;
  };
  return { guardedFetch, files };
}

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

function sensor() {
  const handlers: Array<(f: ObservationFrame) => void> = [];
  const sent: ToChromeFrame[] = [];
  const client: SocketClient = {
    id: 1,
    send: (f) => void sent.push(f),
    onFrame: (h) => void handlers.push(h),
    onClose: () => {},
    onDrained: () => {},
    close: () => {},
  };
  return { client, observe: (observation: BrowserObservation) => handlers.forEach((h) => h({ type: "observation", observation })) };
}

let home: string | null = null;
let pool: ParsePool | null = null;
afterEach(async () => {
  await pool?.close();
  pool = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

/** The real coordinator over the worst-case site, wired as main.ts wires a pass's catalog resolve. */
function coreUnderLoad() {
  home = mkdtempSync(join(tmpdir(), "scout-responsive-"));
  pool = createParsePool();
  const site = worstCaseSite();
  const events: Array<{ name: string; fields: DiagnosticFields }> = [];
  const diagnostics: Diagnostics = { failures: 0, event: (name, fields = {}) => void events.push({ name, fields }) };
  const panel: Array<{ state: PanelState; at: number }> = [];
  /** Sitemap parses submitted, with when each settled (undefined while in the worker). */
  const parses: Array<{ startedAt: number; settledAt?: number }> = [];
  /** Called as each sitemap file goes to the worker. */
  const hooks: { onParse: (index: number) => void } = { onParse: () => {} };
  const resolves: Array<Promise<CatalogResolution>> = [];
  const scoped = (session: OriginFetchSession): CatalogParsers => {
    const scope = pool!.scope(() => session.isCancelled());
    return {
      llmsTxt: scope.parsers.llmsTxt,
      sitemap: (xml, origin) => {
        const rec: { startedAt: number; settledAt?: number } = { startedAt: performance.now() };
        parses.push(rec);
        const p = scope.parsers.sitemap(xml, origin);
        hooks.onParse(parses.length - 1);
        p.then(
          () => (rec.settledAt = performance.now()),
          () => (rec.settledAt = performance.now()),
        );
        return p;
      },
    };
  };
  const coordinator = createCoordinator({
    config: {},
    dwellMs: 20,
    clock: systemClock,
    timers: systemTimers,
    diagnostics,
    emitPanel: (state) => void panel.push({ state, at: performance.now() }),
    capabilities: {
      store: { ingest: async (d) => ({ origin: d.origin, results: [], skipped: 0, cleanup: Promise.resolve({ ok: true }) }) as never },
      createFetchSession: (origin) => createOriginFetchSession({ origin, clock: systemClock, guardedFetch: site.guardedFetch, sleep: async () => undefined }),
      resolveCatalog: (origin, session) => {
        const r = createCatalogResolver({ scoutHome: home!, clock: systemClock, diagnostics, parsers: scoped(session) }).resolve(origin, { session });
        resolves.push(r);
        return r;
      },
      discover: async (origin) => discoveryFor(origin),
    },
  });
  const s = sensor();
  coordinator.attachClient(s.client);
  s.observe({ kind: "permissions", revision: 1, at: Date.now(), granted: [`${ORIGIN}/*`] });
  coordinator.handleNativeCommand({ type: "frontmost", bundleId: "com.google.Chrome", at: Date.now() }, STDIO);
  let seq = 0;
  const focus = (tabId: number, path: string) =>
    s.observe({ kind: "focus", seq: ++seq, at: Date.now(), browserFocused: true, windowId: 1, tabId, url: `${ORIGIN}${path}`, title: "Docs", incognito: false, permissionsRevision: 1 });
  return { coordinator, focus, panel, parses, resolves, events, hooks };
}

const until = async (cond: () => boolean, what: string, ms = 20_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};

/**
 * Deliver `input` as a timer due `afterMs` from now (the way a socket frame or stdin line reaches
 * the coordinator: a callback on the event loop), and resolve with how long it took from when it
 * was due until the side panel got the state `isAnswer` recognizes.
 */
function deliver(afterMs: number, input: () => void, panel: Array<{ state: PanelState; at: number }>, isAnswer: (s: PanelState) => boolean) {
  const dueAt = performance.now() + afterMs;
  const before = panel.length;
  return new Promise<{ latency: number; handledAt: number }>((resolve, reject) => {
    setTimeout(() => {
      input();
      const answer = panel.slice(before).find((p) => isAnswer(p.state));
      if (answer === undefined) reject(new Error("the input reached no panel state"));
      else resolve({ latency: answer.at - dueAt, handledAt: answer.at });
    }, afterMs);
  });
}

describe("coordinator responsiveness under a worst-case bounded catalog", () => {
  it("the site is the bounded worst case: ten ~2 MiB index children, 50,000 image-titled entries, robots at the rule cap", () => {
    const { files } = worstCaseSite();
    const children = Object.keys(files).filter((p) => /^\/sitemap-\d+\.xml$/.test(p));
    expect(children).toHaveLength(MAX_SITEMAP_INDEX_CHILDREN);
    for (const c of children) expect(Buffer.byteLength(files[c]!)).toBeGreaterThan(0.8 * SITEMAP_MAX_BYTES);
    expect(children.reduce((n, c) => n + files[c]!.split("<url>").length - 1, 0)).toBe(MAX_SITEMAP_ENTRIES);
    expect(files["/robots.txt"]!.split("\n").filter((l) => l.startsWith("Disallow") || l.startsWith("Allow"))).toHaveLength(MAX_RULES);
  });

  it(`a focus change and then a pause, each arriving while a sitemap is in the parse worker, reach the side panel within ${BOUND_MS} ms`, async () => {
    const c = coreUnderLoad();
    c.focus(10, "/billing");
    const firstEpoch = c.coordinator.tracker.epoch;
    // As the first pass's third sitemap file (an index child) goes to the worker, another tab is focused.
    const tab = new Promise<{ latency: number; handledAt: number; parsing: number }>((resolve, reject) => {
      c.hooks.onParse = (i) => {
        if (i !== 2) return;
        deliver(1, () => c.focus(11, "/pricing"), c.panel, (s) => s.type === "state" && s.status === "idle" && (s.visitEpoch ?? 0) > firstEpoch).then((r) => resolve({ ...r, parsing: i }), reject);
      };
    });
    const t = await tab;
    // It arrived while that parse was still in the worker (the parse ends after the input was handled, here by its cancel).
    expect(c.parses[t.parsing]!.settledAt === undefined || c.parses[t.parsing]!.settledAt! > t.handledAt).toBe(true);
    expect(c.coordinator.tracker.epoch).toBeGreaterThan(firstEpoch);
    expect(t.latency).toBeLessThan(BOUND_MS);

    // The new visit's pass (after its dwell) parses again; as its third file goes to the worker, Scout is paused.
    const base = c.parses.length;
    const pause = await new Promise<{ latency: number; handledAt: number; parsing: number }>((resolve, reject) => {
      c.hooks.onParse = (i) => {
        if (i !== base + 2) return;
        deliver(1, () => c.coordinator.handleNativeCommand({ type: "pause" }, STDIO), c.panel, (s) => s.type === "state" && s.status === "paused").then((r) => resolve({ ...r, parsing: i }), reject);
      };
    });
    expect(c.parses[pause.parsing]!.settledAt === undefined || c.parses[pause.parsing]!.settledAt! > pause.handledAt).toBe(true);
    expect(pause.latency).toBeLessThan(BOUND_MS);
    expect(c.coordinator.agentView().paused).toBe(true);
    // Both passes were cancelled by the inputs and never ingested.
    expect(c.events.some((e) => e.name === "discovery_ingested")).toBe(false);
    c.coordinator.stop();
  }, 60_000);

  it(`a full worst-case pass, left to finish, never holds the event loop ${BOUND_MS} ms (worker hand-off, resolver dedupe and robots, cache write)`, async () => {
    const c = coreUnderLoad();
    let last = performance.now();
    let worstGap = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      worstGap = Math.max(worstGap, now - last);
      last = now;
    }, 5);
    try {
      c.focus(10, "/billing");
      await until(() => c.resolves.length > 0, "the pass's catalog resolve");
      const resolved = await c.resolves[0]!;
      expect(resolved.result.ok).toBe(true);
      expect(resolved.result.ok && resolved.result.catalog.candidates.length).toBeGreaterThan(0);
      // The index and its ten children, each in the worker.
      expect(c.parses.length).toBe(MAX_SITEMAP_INDEX_CHILDREN + 1);
    } finally {
      clearInterval(tick);
    }
    expect(worstGap).toBeLessThan(BOUND_MS);
    c.coordinator.stop();
  }, 60_000);
});
