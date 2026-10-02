// Ported from native/Scout/Tests/ScoutKitTests/ResultsModelTests.swift. The app's sidecar
// `.running` is the worker's link `connected`; `.starting`/`.stopped` are a link that is down.
// The opener the Swift tests inject is chrome.tabs.create here (panel-app.test.ts); these cases
// check what the model queues and refuses.
import { describe, expect, it } from "vitest";
import { PanelModel } from "./model.js";
import { displayExplanation, displaySummary, type ResultsDisplay } from "./results.js";
import { ackFailed, ackOk, capabilities, F, offer, type Outcome, results, state, tracker } from "./test-frames.js";

const items = [
  { candidateId: "c1", title: "Webhooks", reason: "You read about retries.", hostname: "docs.example.com" },
  { candidateId: "c2", title: "Testing", reason: "Covers the CLI.", hostname: "docs.example.com" },
];

function visiting(epoch = 1): PanelModel {
  const m = new PanelModel(tracker("t"));
  m.applyLink("connected");
  m.apply(capabilities({ instance: "core-1" }));
  m.apply(state("idle", { epoch, detail: "docs.example.com", permitted: true }));
  return m;
}
function ready(epoch = 1, job = "job-1"): PanelModel {
  const m = visiting(epoch);
  m.apply(results(epoch, { status: "ok", items }, { job }));
  return m;
}

describe("ResultsModel (ResultsModelTests.swift)", () => {
  it("everyStateIsDistinctAndEmptyIsNeverAFailure", () => {
    const m = visiting();
    const seen: ResultsDisplay[] = [m.resultsDisplay];
    m.apply(state("working", { epoch: 1, jobId: "job-1" }));
    seen.push(m.resultsDisplay);
    const outcomes: Outcome[] = [
      { status: "ok", items },
      { status: "empty" },
      { status: "unavailable", reason: "no_time_left" },
      { status: "error", reason: "timeout" },
      { status: "error", reason: "agent_failed" },
      { status: "cancelled", reason: "superseded" },
    ];
    outcomes.forEach((o, i) => {
      m.apply(results(1, o, { job: `job-${i + 1}` }));
      seen.push(m.resultsDisplay);
    });
    expect(seen).toEqual([
      { kind: "none" },
      { kind: "working" },
      { kind: "ready", items },
      { kind: "empty" },
      { kind: "unavailable", reason: "no_time_left" },
      { kind: "timeout" },
      { kind: "error", reason: "agent_failed" },
      { kind: "cancelled", reason: "superseded" },
    ]);
    m.apply(state("paused"));
    seen.push(m.resultsDisplay);
    m.apply(state("disconnected"));
    seen.push(m.resultsDisplay);
    expect(seen.slice(-2)).toEqual([{ kind: "paused" }, { kind: "disconnected" }]);
    expect(new Set(seen.map(displayExplanation)).size).toBe(seen.length);
    const failures: ResultsDisplay[] = [
      { kind: "unavailable", reason: "busy" },
      { kind: "timeout" },
      { kind: "error", reason: "invalid_output" },
      { kind: "cancelled", reason: "visit_changed" },
      { kind: "paused" },
      { kind: "disconnected" },
    ];
    for (const f of failures) {
      expect(displaySummary(f)).not.toBe(displaySummary({ kind: "empty" }));
      expect(displayExplanation(f)).not.toBe(displayExplanation({ kind: "empty" }));
    }
  });

  it("compactLineShowsTheResultsState (the panel header)", () => {
    const m = ready();
    expect(m.headerLine).toBe("Idle · docs.example.com · 2 links");
    m.apply(results(1, { status: "empty" }, { job: "job-2" }));
    expect(m.headerLine).toBe("Idle · docs.example.com · Nothing relevant");
    m.apply(results(1, { status: "error", reason: "timeout" }, { job: "job-3" }));
    expect(m.headerLine).toBe("Idle · docs.example.com · Timed out");
    m.apply(state("paused"));
    expect(m.headerLine).toBe("Paused");
  });

  it("ignoresResultsForAnotherCoreInstanceOrVisit", () => {
    const m = visiting(2);
    m.apply(results(2, { status: "ok", items }, { instance: "core-0" }));
    expect(m.results).toBeNull();
    m.apply(results(1, { status: "ok", items }));
    expect(m.results).toBeNull();
    m.apply(results(3, { status: "ok", items }));
    expect(m.results).toBeNull();
    m.apply(results(2, { status: "ok", items }));
    expect(m.resultsDisplay).toEqual({ kind: "ready", items });
  });

  it("ignoresResultsBeforeTheCoreNamedItself", () => {
    const m = new PanelModel(tracker("t"));
    m.applyLink("connected");
    m.apply(state("idle", { epoch: 1, detail: "docs.example.com", permitted: true }));
    m.apply(results(1, { status: "ok", items }));
    expect(m.results).toBeNull();
  });

  it("aNewVisitPauseOrClearResetsTheResults", () => {
    let m = ready();
    m.apply(state("idle", { epoch: 2, detail: "other.example.org", permitted: true }));
    expect(m.resultsDisplay).toEqual({ kind: "none" });
    m = ready();
    m.apply(state("paused"));
    m.apply(state("idle", { epoch: 1, detail: "docs.example.com", permitted: true }));
    expect(m.resultsDisplay).toEqual({ kind: "none" });
    m = ready();
    m.apply(state("idle", { epoch: 1, detail: "docs.example.com", permitted: true }));
    expect(m.resultsDisplay).toEqual({ kind: "none" });
    m = ready();
    m.apply(capabilities({ instance: "core-2" }));
    expect(m.results).toBeNull();
    // Browser: the worker's link to the core dropping (a replaced connection) clears them too.
    m = ready();
    m.applyLink("connecting");
    expect(m.results).toBeNull();
    expect(m.resultsDisplay).toEqual({ kind: "none" });
  });

  it("aLateResultNeverReplacesANewerOne", () => {
    let m = ready(1);
    m.apply(state("idle", { epoch: 2, detail: "docs.example.com", permitted: true }));
    m.apply(results(2, { status: "empty" }, { job: "job-2" }));
    m.apply(results(1, { status: "ok", items }, { job: "job-1" }));
    expect(m.resultsDisplay).toEqual({ kind: "empty" });

    m = visiting();
    m.apply(state("working", { epoch: 1, jobId: "job-1" }));
    m.apply(state("working", { epoch: 1, jobId: "job-2" }));
    m.apply(results(1, { status: "ok", items }, { job: "job-1" }));
    expect(m.resultsDisplay).toEqual({ kind: "working" });
    m.apply(state("idle", { epoch: 1, detail: "docs.example.com", permitted: true }));
    m.apply(results(1, { status: "ok", items }, { job: "job-1" }));
    expect(m.results).toBeNull();
    m.apply(results(1, { status: "empty" }, { job: "job-2" }));
    m.apply(results(1, { status: "ok", items }, { job: "job-1" }));
    expect(m.resultsDisplay).toEqual({ kind: "empty" });

    m = ready(1, "job-1");
    m.apply(results(1, { status: "error", reason: "agent_failed" }, { job: "job-2" }));
    m.apply(results(1, { status: "ok", items }, { job: "job-1" }));
    expect(m.resultsDisplay).toEqual({ kind: "error", reason: "agent_failed" });
  });

  it("resultsNeverOpenOrMoveAnything", () => {
    const m = visiting();
    m.apply(capabilities({ instance: "core-1", revision: 2, offers: [offer()] }));
    const offers = m.currentOffers;
    m.apply(results(1, { status: "ok", items }));
    expect(m.takeLinksToOpen()).toEqual([]);
    expect(m.section).toBe("results");
    expect(m.shownPreview).toBeNull();
    expect(m.commands.records).toEqual([]);
    expect(m.currentOffers).toEqual(offers);
  });

  it("aClickSendsTheDisplayedIdentityAndOnlyItsAckOpens", () => {
    const m = ready(1, "job-7");
    expect(m.openResult("c9")).toBeNull();
    const click = m.openResult("c2")!;
    expect(click).toEqual({ type: "open_link", coreInstanceId: "core-1", visitEpoch: 1, jobId: "job-7", candidateId: "c2", commandId: click.commandId });
    expect(m.openResult("c2")).toBeNull();
    expect(m.linkRecord("c2")?.state).toBe("pending");
    expect(m.takeLinksToOpen()).toEqual([]);
    m.apply(ackOk(click.commandId, { target: `${F.origin}/testing` }));
    expect(m.takeLinksToOpen()).toEqual([{ commandId: click.commandId, href: `${F.origin}/testing`, origin: F.origin }]);
    m.apply(ackOk(click.commandId, { target: `${F.origin}/testing` }));
    expect(m.takeLinksToOpen()).toEqual([]);
  });

  it("aRefusedClickOpensNothingAndIsAProblem", () => {
    const m = ready();
    const click = m.openResult("c1")!;
    m.apply(ackFailed(click.commandId, "stale_revision"));
    expect(m.takeLinksToOpen()).toEqual([]);
    const p = m.problems[0];
    expect(p?.kind === "command" && p.record.id === click.commandId && p.record.code === "stale_revision").toBe(true);
  });

  it("aTargetThisAppWouldNotOpenIsAProblem", () => {
    for (const [target, refusal] of [
      ["https://evil.example/x", "wrong_host"],
      ["http://docs.example.com/x", "not_https"],
      [undefined, "malformed"],
    ] as const) {
      const m = ready();
      const click = m.openResult("c1")!;
      m.apply(ackOk(click.commandId, target === undefined ? {} : { target }));
      expect(m.takeLinksToOpen()).toEqual([]);
      expect(m.problems).toEqual([{ kind: "linkRefused", commandId: click.commandId, refusal }]);
      m.dismiss(click.commandId);
      expect(m.problems).toEqual([]);
    }
  });

  it("anAckForACommandTheModelDidNotIssueOpensNothing", () => {
    const m = ready();
    m.apply(ackOk("t-99", { target: `${F.origin}/x` }));
    expect(m.takeLinksToOpen()).toEqual([]);
  });

  it("aLinkChromeCouldNotOpenIsAProblemWithDismissOnly", () => {
    const m = ready();
    const click = m.openResult("c1")!;
    m.apply(ackOk(click.commandId, { target: `${F.origin}/webhooks` }));
    const [req] = m.takeLinksToOpen();
    m.linkRefused(req!.commandId, "open_failed");
    expect(m.problems).toEqual([{ kind: "linkRefused", commandId: click.commandId, refusal: "open_failed" }]);
    expect(m.canRetry(click.commandId)).toBe(false);
    m.dismiss(click.commandId);
    expect(m.problems).toEqual([]);
  });

  it("aFailedClickIsNeverRetried (browser: a click the worker could not send fails at once)", () => {
    const m = ready();
    const click = m.openResult("c1")!;
    const id = click.commandId;
    expect(m.canRetry(id)).toBe(false);
    // Swift leaves an unsent click to the pipe's own re-send; the panel never re-sends a click.
    m.markSent(click, "retryLater");
    expect(m.commands.unsent).toEqual([]);
    expect(m.commands.record(id)).toMatchObject({ state: "failed", code: "unavailable" });
    const p = m.problems[0];
    expect(p?.kind === "command" && p.record.id === id).toBe(true);
    expect(m.canRetry(id)).toBe(false);
    expect(m.retry(id)).toBeNull();
    // And a written click refused as unavailable gets Dismiss only, as in the app.
    const again = m.openResult("c2")!;
    m.markSent(again, "written");
    m.apply(ackFailed(again.commandId, "unavailable"));
    expect(m.canRetry(again.commandId)).toBe(false);
  });

  it("aLateAckAfterNavigatingStillOpensTheClickedLink", () => {
    const m = ready();
    const click = m.openResult("c1")!;
    m.apply(state("idle", { epoch: 2, detail: "other.example.org", permitted: true }));
    expect(m.results).toBeNull();
    m.apply(ackOk(click.commandId, { target: `${F.origin}/webhooks` }));
    expect(m.takeLinksToOpen()).toEqual([{ commandId: click.commandId, href: `${F.origin}/webhooks`, origin: F.origin }]);
  });

  it("nothingIsClickableWithoutReadyResultsOrARunningCore", () => {
    let m = visiting();
    expect(m.openResult("c1")).toBeNull();
    m.apply(results(1, { status: "empty" }));
    expect(m.openResult("c1")).toBeNull();
    m = ready();
    m.applyLink("core_unavailable");
    expect(m.openResult("c1")).toBeNull();
  });

  it("aPendingClickIsNotResentToARestartedCore", () => {
    const m = ready();
    const click = m.openResult("c1")!;
    m.markSent(click, "written");
    m.applyLink("connecting");
    expect(m.applyLink("connected")).toEqual([]);
    expect(m.commands.record(click.commandId)?.state).toBe("unknown");
  });

  it("the fixture results frames render as their states", () => {
    const m = new PanelModel(tracker("t"));
    m.applyLink("connected");
    m.apply(F.frame("frame.capabilities.minimal.json"));
    const expected: Record<string, ResultsDisplay["kind"]> = { ok: "ready", empty: "empty", unavailable: "unavailable", timeout: "timeout", error: "error", cancelled: "cancelled" };
    for (const name of F.names("frame.results.")) {
      const frame = F.frame(name);
      if (frame.type !== "results") throw new Error(name);
      m.apply(state("idle", { epoch: frame.visitEpoch, detail: "docs.example.com", permitted: true }));
      m.apply(frame);
      const kind = name.replace("frame.results.", "").replace(".json", "");
      expect(m.resultsDisplay.kind, name).toBe(expected[kind]);
    }
  });
});
