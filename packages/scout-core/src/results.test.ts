import { PanelStateSchema } from "@scout/contracts";
import { describe, expect, it } from "vitest";
import type { DiagnosticFields, Diagnostics } from "./diagnostics.js";
import { verifyTargets } from "./catalog/verifyTargets.js";
import { checkTarget, createResultRegistry, type PublishedResult, type ResultsEvent, toFrame } from "./results.js";

const ORIGIN = "https://docs.example.com";
const CORE = "core-test";
const TITLE = "Webhook retries SECRET-TITLE";
const REASON = "You were reading issue 42 SECRET-REASON";

const ok = (over: Partial<PublishedResult> = {}): PublishedResult =>
  ({
    coreInstanceId: CORE,
    visitEpoch: 4,
    origin: ORIGIN,
    jobId: "job-1",
    status: "ok",
    items: [
      { candidateId: "c1", title: TITLE, reason: REASON, href: `${ORIGIN}/webhooks/retries`, hostname: "docs.example.com" },
      { candidateId: "c2", title: "Testing", reason: "r", href: `${ORIGIN}/testing?x=1#top`, hostname: "docs.example.com" },
    ],
    ...over,
  }) as PublishedResult;

function setup() {
  const state = { visit: { visitEpoch: 4, origin: ORIGIN } as { visitEpoch: number; origin: string } | null, permitted: true };
  const events: { name: string; fields: DiagnosticFields }[] = [];
  const diagnostics: Diagnostics = { failures: 0, event: (name, fields = {}) => void events.push({ name, fields }) };
  const registry = createResultRegistry({
    coreInstanceId: CORE,
    activeVisit: () => state.visit,
    isPermitted: () => state.permitted,
    diagnostics,
  });
  const heard: ResultsEvent[] = [];
  registry.subscribe((e) => void heard.push(e));
  // The job every `ok()` result names, begun for visit 4.
  registry.beginJob("job-1");
  return { registry, state, events, heard };
}

const link = (over: Partial<{ coreInstanceId: string; visitEpoch: number; jobId: string; candidateId: string }> = {}) => ({
  coreInstanceId: CORE,
  visitEpoch: 4,
  jobId: "job-1",
  candidateId: "c1",
  ...over,
});

describe("result registry", () => {
  it("publishes a result for the current visit and tells listeners with a frame that has no href", () => {
    const { registry, heard } = setup();
    expect(registry.publish(ok())).toEqual({ ok: true });
    expect(registry.current()).toEqual(ok());
    expect(heard).toHaveLength(1);
    const event = heard[0]!;
    if (event.kind !== "published") throw new Error("not published");
    expect(PanelStateSchema.safeParse(event.frame).success).toBe(true);
    expect(JSON.stringify(event.frame)).not.toContain("href");
    expect(JSON.stringify(event.frame)).not.toContain("/webhooks");
    expect(event.frame).toMatchObject({ type: "results", coreInstanceId: CORE, visitEpoch: 4, origin: ORIGIN, jobId: "job-1", status: "ok" });
  });

  it("publishes every status, each a valid frame", () => {
    const { registry } = setup();
    const id = { coreInstanceId: CORE, visitEpoch: 4, origin: ORIGIN, jobId: "job-2" };
    const results: PublishedResult[] = [
      { ...id, status: "empty" },
      { ...id, status: "unavailable", reason: "agent_unavailable" },
      { ...id, status: "error", reason: "timeout" },
      { ...id, status: "cancelled", reason: "superseded" },
    ];
    registry.beginJob("job-2");
    for (const r of results) {
      expect(registry.publish(r)).toEqual({ ok: true });
      expect(PanelStateSchema.parse(toFrame(r))).toEqual(toFrame(r));
    }
  });

  it("refuses another instance, a stale or absent visit, another origin, and an unpermitted origin", () => {
    const { registry, state, heard } = setup();
    expect(registry.publish(ok({ coreInstanceId: "core-old" }))).toEqual({ ok: false, code: "stale_instance" });
    expect(registry.publish(ok({ visitEpoch: 3 }))).toEqual({ ok: false, code: "stale_visit" });
    expect(registry.publish(ok({ origin: "https://other.example.com" }))).toEqual({ ok: false, code: "wrong_origin" });
    state.permitted = false;
    expect(registry.publish(ok())).toEqual({ ok: false, code: "not_permitted" });
    state.permitted = true;
    state.visit = null; // paused, disconnected, or no permitted visit
    expect(registry.publish(ok())).toEqual({ ok: false, code: "stale_visit" });
    expect(heard).toEqual([]);
    expect(registry.current()).toBeNull();
  });

  it("a late job's result never overwrites a newer visit's", () => {
    const { registry, state } = setup();
    state.visit = { visitEpoch: 5, origin: ORIGIN };
    registry.beginJob("job-new");
    expect(registry.publish(ok({ visitEpoch: 5, jobId: "job-new" }))).toEqual({ ok: true });
    expect(registry.publish(ok({ visitEpoch: 4, jobId: "job-old" }))).toEqual({ ok: false, code: "stale_visit" });
    expect(registry.current()?.jobId).toBe("job-new");
  });

  it("refuses invalid results: bad targets, a wrong hostname, and frames the contract rejects", () => {
    const { registry } = setup();
    const item = { candidateId: "c1", title: "t", reason: "r", href: `${ORIGIN}/a`, hostname: "docs.example.com" };
    const bad: PublishedResult[] = [
      ok({ items: [{ ...item, href: "http://docs.example.com/a" }] } as Partial<PublishedResult>),
      ok({ items: [{ ...item, href: "https://user:pw@docs.example.com/a" }] } as Partial<PublishedResult>),
      ok({ items: [{ ...item, href: "https://docs.example.com:8443/a" }] } as Partial<PublishedResult>),
      ok({ items: [{ ...item, href: "https://evil.example/a" }] } as Partial<PublishedResult>),
      ok({ items: [{ ...item, hostname: "evil.example" }] } as Partial<PublishedResult>),
      ok({ items: [] } as Partial<PublishedResult>),
      ok({ items: [item, item] } as Partial<PublishedResult>),
      ok({ items: [{ ...item, reason: "r".repeat(141) }] } as Partial<PublishedResult>),
      ok({ items: [{ ...item, candidateId: "https://evil.example/" }] } as Partial<PublishedResult>),
      ok({ jobId: "has space" }),
    ];
    for (const r of bad) {
      registry.beginJob(r.jobId);
      expect(registry.publish(r), JSON.stringify(r)).toEqual({ ok: false, code: "invalid" });
    }
  });

  it("a replaced job's result is refused, whether the replacement answered or is still running", () => {
    const { registry, heard } = setup();
    // job-1 (A) is begun by setup; B replaces it and answers.
    expect(registry.beginJob("job-2")).toEqual({ ok: true });
    expect(registry.publish(ok({ jobId: "job-2" }))).toEqual({ ok: true });
    expect(registry.publish(ok())).toEqual({ ok: false, code: "stale_job" });
    expect(registry.current()?.jobId).toBe("job-2");
    expect(heard).toHaveLength(1);

    // A refused while B is still running, and nothing held changes.
    const second = setup();
    expect(second.registry.beginJob("job-2")).toEqual({ ok: true });
    expect(second.registry.publish(ok())).toEqual({ ok: false, code: "stale_job" });
    expect(second.registry.current()).toBeNull();
  });

  it("stale_job is checked after stale_visit, and before the origin and grant", () => {
    const { registry, state } = setup();
    expect(registry.publish(ok({ visitEpoch: 3, jobId: "job-9" }))).toEqual({ ok: false, code: "stale_visit" });
    expect(registry.publish(ok({ jobId: "job-9", origin: "https://other.example.com" }))).toEqual({ ok: false, code: "stale_job" });
    state.permitted = false;
    expect(registry.publish(ok({ jobId: "job-9" }))).toEqual({ ok: false, code: "stale_job" });
  });

  it("beginJob needs a current visit; a clear or a new visit forgets the job", () => {
    const { registry, state, events } = setup();
    state.visit = null;
    expect(registry.beginJob("job-2")).toEqual({ ok: false, code: "stale_visit" });
    expect(events.at(-1)).toEqual({ name: "results_job_refused", fields: { code: "stale_visit" } });

    state.visit = { visitEpoch: 4, origin: ORIGIN };
    registry.clear("job_replaced");
    expect(registry.publish(ok())).toEqual({ ok: false, code: "stale_job" });

    registry.beginJob("job-1");
    state.visit = { visitEpoch: 5, origin: ORIGIN };
    expect(registry.publish(ok({ visitEpoch: 5 }))).toEqual({ ok: false, code: "stale_job" });
  });

  it("a held result stops resolving links once a newer job begins", () => {
    const { registry } = setup();
    registry.publish(ok());
    expect(registry.resolveLink(link())).toMatchObject({ ok: true });
    registry.beginJob("job-2");
    expect(registry.resolveLink(link())).toEqual({ ok: false, code: "stale_revision" });
  });

  it("clear drops the result once and tells listeners", () => {
    const { registry, heard } = setup();
    expect(registry.clear("visit_changed")).toBe(false);
    registry.beginJob("job-1"); // the clear forgot the job
    registry.publish(ok());
    expect(registry.clear("paused")).toBe(true);
    expect(registry.clear("paused")).toBe(false);
    expect(registry.current()).toBeNull();
    expect(heard.at(-1)).toEqual({ kind: "cleared", visitEpoch: 4, reason: "paused" });
  });

  it("a silent clear drops the result and logs it but tells no listener", () => {
    const { registry, heard, events } = setup();
    registry.publish(ok());
    expect(registry.clear("disconnected", { silent: true })).toBe(true);
    expect(registry.current()).toBeNull();
    expect(heard.map((e) => e.kind)).toEqual(["published"]);
    expect(events.at(-1)).toEqual({ name: "results_cleared", fields: { epoch: 4, reason: "disconnected" } });
  });

  it("resolves a displayed link to its stored, re-checked target", () => {
    const { registry } = setup();
    registry.publish(ok());
    expect(registry.resolveLink(link())).toEqual({ ok: true, href: `${ORIGIN}/webhooks/retries` });
    expect(registry.resolveLink(link({ candidateId: "c2" }))).toEqual({ ok: true, href: `${ORIGIN}/testing?x=1#top` });
  });

  it("tells onLinkOpened the target of every resolved link, and nothing for a refused one", () => {
    const opened: string[] = [];
    const state = { visit: { visitEpoch: 4, origin: ORIGIN }, permitted: true };
    const registry = createResultRegistry({ coreInstanceId: CORE, activeVisit: () => state.visit, isPermitted: () => state.permitted, onLinkOpened: (href) => void opened.push(href) });
    registry.beginJob("job-1");
    registry.publish(ok());
    registry.resolveLink(link({ candidateId: "c9" }));
    registry.resolveLink(link({ jobId: "job-0" }));
    expect(opened).toEqual([]);
    registry.resolveLink(link({ candidateId: "c2" }));
    expect(opened).toEqual([`${ORIGIN}/testing?x=1#top`]);
  });

  it("keeps a verified HTML twin as the target", () => {
    const { registry } = setup();
    const twin = ok({
      items: [{ candidateId: "c7", title: "Guide", reason: "r", href: `${ORIGIN}/guides/start`, hostname: "docs.example.com" }],
    } as Partial<PublishedResult>);
    registry.publish(twin);
    expect(registry.resolveLink(link({ candidateId: "c7" }))).toEqual({ ok: true, href: `${ORIGIN}/guides/start` });
  });

  it("refuses stale identity, unknown candidates, and an origin no longer permitted", () => {
    const { registry, state } = setup();
    expect(registry.resolveLink(link())).toEqual({ ok: false, code: "stale_revision" }); // nothing held
    registry.publish(ok());
    expect(registry.resolveLink(link({ coreInstanceId: "core-old" }))).toEqual({ ok: false, code: "stale_revision" });
    expect(registry.resolveLink(link({ visitEpoch: 3 }))).toEqual({ ok: false, code: "stale_revision" });
    expect(registry.resolveLink(link({ jobId: "job-0" }))).toEqual({ ok: false, code: "stale_revision" });
    expect(registry.resolveLink(link({ candidateId: "c9" }))).toEqual({ ok: false, code: "not_found" });
    state.permitted = false;
    expect(registry.resolveLink(link())).toEqual({ ok: false, code: "not_permitted" });
    state.permitted = true;
    // The visit moved on before the coordinator cleared the result.
    state.visit = { visitEpoch: 5, origin: ORIGIN };
    expect(registry.resolveLink(link())).toEqual({ ok: false, code: "stale_revision" });
    state.visit = { visitEpoch: 4, origin: ORIGIN };
    registry.clear("visit_changed");
    expect(registry.resolveLink(link())).toEqual({ ok: false, code: "stale_revision" });
  });

  it("an empty or failed result has no links", () => {
    const { registry } = setup();
    registry.publish({ coreInstanceId: CORE, visitEpoch: 4, origin: ORIGIN, jobId: "job-1", status: "empty" });
    expect(registry.resolveLink(link())).toEqual({ ok: false, code: "not_found" });
  });

  it("diagnostics carry status, counts, and codes only: never titles, reasons, or hrefs", () => {
    const { registry, events, state } = setup();
    registry.publish(ok());
    registry.publish(ok({ visitEpoch: 9 }));
    registry.resolveLink(link());
    registry.resolveLink(link({ candidateId: "c9" }));
    state.permitted = false;
    registry.clear("permission_lost");
    expect(events.map((e) => e.name)).toEqual(["results_published", "results_refused", "link_resolved", "link_resolved", "results_cleared"]);
    expect(events[0]!.fields).toEqual({ status: "ok", items: 2, epoch: 4 });
    expect(events[2]!.fields).toEqual({ ok: true });
    expect(events[3]!.fields).toEqual({ ok: false, code: "not_found" });
    const all = JSON.stringify(events);
    for (const secret of ["SECRET", "webhooks", "://", "Testing"]) expect(all).not.toContain(secret);
    for (const e of events) for (const v of Object.values(e.fields)) expect(["string", "number", "boolean"]).toContain(typeof v);
  });

  it("returns copies, so a caller cannot change the held result", () => {
    const { registry } = setup();
    const r = ok();
    registry.publish(r);
    if (r.status === "ok") r.items[0]!.href = "https://evil.example/";
    const held = registry.current();
    if (held?.status === "ok") held.items[0]!.href = "https://evil.example/";
    expect(registry.resolveLink(link())).toEqual({ ok: true, href: `${ORIGIN}/webhooks/retries` });
  });
});

describe("checkTarget", () => {
  it.each([
    [`${ORIGIN}/a`, true],
    [`${ORIGIN}/a?b=c#d`, true],
    [`${ORIGIN}/`, true],
    ["http://docs.example.com/a", false],
    ["https://u:p@docs.example.com/a", false],
    ["https://u@docs.example.com/a", false],
    ["https://docs.example.com:443/a", false],
    ["https://docs.example.com:8443/a", false],
    ["https://other.example.com/a", false],
    ["https://docs.example.com.evil.example/a", false],
    ["javascript:alert(1)", false],
    ["data:text/html,hi", false],
    ["/relative", false],
    ["#fragment", false],
    [" https://docs.example.com/a", false],
    ["https://docs.example.com\\@evil.example/a", false],
    ["HTTPS://DOCS.EXAMPLE.COM/a", false],
    [`${ORIGIN}/${"a".repeat(2048)}`, false],
  ])("%s -> %s", (href, accepted) => {
    expect(checkTarget(href, ORIGIN) !== null).toBe(accepted);
  });

  it("accepts every humanHref verifyTargets keeps, including ones the parser normalized", async () => {
    const paths = ["/Guides/Start Here.md", "/a/../b/%7Euser?q=ü#frag", "/payments/subscriptions.md"];
    const candidates = paths.map((path, i) => ({
      id: `c${i}`,
      sourceUrl: `${ORIGIN}${path}`,
      title: path,
      labelQuality: "published" as const,
      provenance: "llms.txt" as const,
    }));
    const { verified } = await verifyTargets(candidates, {
      origin: ORIGIN,
      fetch: async (url) => ({ kind: "ok", status: 200, body: "<html></html>", bytes: new Uint8Array(), contentType: "text/html", finalUrl: url }),
    });
    expect(verified).toHaveLength(paths.length);
    for (const { humanHref } of verified) {
      expect(checkTarget(humanHref, ORIGIN)?.href, humanHref).toBe(humanHref);
    }
    // The raw source strings themselves are not in the parser's form, so only the normalized ones pass.
    expect(checkTarget(`${ORIGIN}/Guides/Start Here.md`, ORIGIN)).toBeNull();
  });
});
