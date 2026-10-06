// Ported from ScoutKit's PanelModelTests.swift (PanelModelTests and
// PanelModelCapabilityTests). Browser mapping: the app's sidecar `.running` is the worker's
// link `connected`, `.starting` is `connecting`, `.stopped` is `core_unavailable`; the app's
// expanded/collapsed window has no counterpart (the side panel is always open when shown), so
// "never expands" becomes "never changes the section or the shown preview".
import { describe, expect, it } from "vitest";
import { BLOCKER_TEXT } from "./capabilities.js";
import type { PanelCommand } from "./commands.js";
import { MISSING_CAPABILITIES, PanelModel } from "./model.js";
import { LINK_DOWN_TEXT, resultsSlot } from "./results.js";
import { ackFailed, ackOk, AGENTS, answer, applyVerified, capabilities, chunks, entry, F, offer, originSetting, results, state, tracker, withId } from "./test-frames.js";

const key = { resourceId: F.rid, version: F.v1 };

describe("PanelModel (PanelModelTests)", () => {
  it("link states show in the header and Problems (sidecarStatusesShowInTheCompactLineAndProblems)", () => {
    const m = new PanelModel();
    expect(m.headerLine).toBe("Connecting…");
    expect(m.problems).toEqual([]);
    m.applyLink("upgrade_required");
    expect(m.headerLine).toBe("Update needed");
    expect(m.problems[0]).toMatchObject({ kind: "link", text: expect.stringContaining("different versions") });
    m.applyLink("core_unavailable");
    expect(m.headerLine).toBe("Scout isn't running");
    expect(m.problems[0]).toMatchObject({ kind: "link", text: expect.stringContaining("isn't running") });
    m.applyLink("disconnected");
    expect(m.problems[0]).toMatchObject({ kind: "link", text: expect.stringContaining("Chrome can't reach Scout") });
  });

  it("Results says the link is down (never idle) while the core can't be reached, and shows results again on reconnect", () => {
    const m = new PanelModel();
    expect(m.resultsDisplay).toEqual({ kind: "connecting" });
    expect(resultsSlot(m.resultsDisplay)).toEqual({ kind: "caption", text: "Connecting to Scout…" });
    expect(m.headerLine).toBe("Connecting…"); // no results summary
    for (const link of ["disconnected", "core_unavailable", "upgrade_required"] as const) {
      m.applyLink(link);
      expect(m.resultsDisplay).toEqual({ kind: "link_down", link });
      expect(resultsSlot(m.resultsDisplay)).toEqual({ kind: "caption", text: LINK_DOWN_TEXT[link] });
      expect(m.problems[0]).toEqual({ kind: "link", text: LINK_DOWN_TEXT[link] });
      expect(m.headerLine).toBe(m.statusLine); // no results summary next to the link state
    }
    m.applyLink("connected");
    expect(m.resultsDisplay).toEqual({ kind: "none" });
    m.apply(capabilities({ instance: "core-1" }));
    m.apply(state("idle", { epoch: 1 }));
    m.apply(results(1, { status: "empty" }));
    expect(m.resultsDisplay).toEqual({ kind: "empty" });
    m.applyLink("core_unavailable");
    expect(m.resultsDisplay).toEqual({ kind: "link_down", link: "core_unavailable" });
    m.applyLink("connecting"); // e.g. the host unreachable through the retry schedule
    expect(m.resultsDisplay).toEqual({ kind: "connecting" });
    m.applyLink("connected");
    expect(m.resultsDisplay).toEqual({ kind: "none" });
  });

  it("runningShowsCoreStatusAndResults", () => {
    const m = new PanelModel();
    m.applyLink("connected");
    m.apply(capabilities({ instance: "core-1" }));
    m.apply(state("working", { epoch: 1, detail: "ranking" }));
    expect(m.headerLine).toBe("Working · ranking · Looking for links…");
    const items = [
      { candidateId: "c1", title: "Webhooks", reason: "r", hostname: "docs.example.com" },
      { candidateId: "c2", title: "Testing", reason: "r", hostname: "docs.example.com" },
    ];
    m.apply(state("idle", { epoch: 1 }));
    m.apply(results(1, { status: "ok", items }));
    expect(m.headerLine).toBe("Idle · 2 links");
    expect(m.resultsDisplay).toEqual({ kind: "ready", items });
  });

  it("idleVisitShowsTheHostnameAndLeavingClearsIt", () => {
    const m = new PanelModel();
    m.applyLink("connected");
    m.apply(state("idle", { epoch: 2, detail: "docs.stripe.com" }));
    expect(m.headerLine).toBe("Idle · docs.stripe.com");
    m.apply(state("idle", { epoch: 3 }));
    expect(m.headerLine).toBe("Idle");
  });

  it("restartClearsCoreState", () => {
    const m = new PanelModel();
    m.applyLink("connected");
    m.apply(state("idle", { epoch: 1 }));
    m.apply(results(1, { status: "empty" }));
    m.applyLink("connecting");
    m.applyLink("connected");
    expect(m.headerLine).toBe("Connected");
    expect(m.results).toBeNull();
  });
});

describe("PanelModel capabilities (PanelModelCapabilityTests)", () => {
  function onSite(offers = [offer()]): PanelModel {
    const m = new PanelModel(tracker("t"));
    m.applyLink("connected");
    m.apply(state("idle", { epoch: 1, detail: "docs.example.com", permitted: true }));
    m.apply(capabilities({ offers, origins: [originSetting()] }));
    return m;
  }
  async function loaded(m: PanelModel, k = key, text = "hello ✓"): Promise<void> {
    const first = m.showPreview(k);
    if (first) await answer(m, first, chunks(text, k, 4));
  }

  it("indicatorDerivation (offers for the current host)", () => {
    const m = onSite();
    expect(m.currentOffers).toHaveLength(1);
    expect(m.headerLine).toBe("Idle · docs.example.com · 1 offer");
    expect(m.statusLine).toBe("Idle · docs.example.com");
    m.apply(state("idle", { epoch: 2, detail: "other.example.org", permitted: true }));
    expect(m.currentOffers).toEqual([]);
    m.apply(state("idle", { epoch: 3, detail: "docs.example.com", permitted: false }));
    expect(m.currentHost).toBeNull();
    expect(m.currentOffers).toEqual([]);
  });

  it("offersNeverMoveThePanel (offersNeverExpandThePanel)", () => {
    const m = onSite();
    m.apply(capabilities({ revision: 2, offers: [offer(), offer({ rid: F.rid2 })] }));
    expect(m.section).toBe("page");
    m.select("sites");
    m.apply(capabilities({ revision: 3, offers: [offer(), offer({ rid: F.rid2, version: F.v2 })] }));
    expect(m.section).toBe("sites");
    expect(m.shownPreview).toBeNull();
  });

  it("approveOnlyWhenThePreviewIsComplete", async () => {
    let m = onSite();
    expect(m.approveBlocker(key)).toBe("Preview this version before approving it.");
    expect(m.approve(key)).toBeNull();
    expect(m.canDecline(key)).toBe(true);
    const first = m.showPreview(key)!;
    expect(first).not.toBeNull();
    expect(m.section).toBe("page");
    expect(m.shownPreview).toEqual(key);
    expect(m.showPreview(key)).toBeNull();
    expect(m.approveBlocker(key)).toBe("Preview is still loading.");
    const cs = chunks("hello ✓ world", key, 4);
    await applyVerified(m, withId(cs[0]!, first.commandId));
    expect(m.canApprove(key)).toBe(false);
    m = onSite();
    await loaded(m);
    expect(m.preview(key)?.isComplete).toBe(true);
    const approve = m.approve(key)!;
    expect(approve).toEqual({ type: "approve", resourceId: F.rid, version: F.v1, expectedRevision: 1, commandId: approve.commandId });
    expect(m.approve(key)).toBeNull();
    expect(m.canDecline(key)).toBe(false);
    expect(m.decisionRecord(key)?.state).toBe("pending");
    m.apply(ackOk(approve.commandId, { revision: 2, approvalRevision: 1 }));
    expect(m.approve(key)).toBeNull();
    m.apply(capabilities({ revision: 2, library: [entry({ defaultVersion: F.v1, versions: [[F.v1, "approved"]], revision: 2 })] }));
    expect(m.approveBlocker(key)).toBe(BLOCKER_TEXT.alreadyApproved);
  });

  it("a preview whose last chunk arrived is not approvable until its hash is checked", async () => {
    const m = onSite();
    const first = m.showPreview(key)!;
    m.apply(withId(chunks("abc", key, 10)[0]!, first.commandId));
    expect(m.preview(key)?.phase).toBe("verifying");
    expect(m.approveBlocker(key)).toBe("Preview is still loading.");
    expect(m.previewsToVerify()).toHaveLength(1);
  });

  it("hashMismatchKeepsApproveOff", async () => {
    const m = onSite();
    const first = m.showPreview(key)!;
    const c = chunks("abc", key, 10)[0]!;
    await applyVerified(m, { ...withId(c, first.commandId), sha256: F.v3 });
    expect(m.preview(key)?.failure).toEqual({ kind: "hashMismatch" });
    expect(m.canApprove(key)).toBe(false);
    expect(m.problems).toContainEqual({ kind: "preview", key, failure: { kind: "hashMismatch" } });
    const again = m.showPreview(key)!;
    expect(again).toMatchObject({ type: "preview", resourceId: F.rid, version: F.v1 });
    expect("cursor" in again).toBe(false);
  });

  it("expandedPreviewSurvivesNewFramesAndTabs", async () => {
    const m = onSite();
    await loaded(m, key, "the guide");
    const before = m.preview(key);
    m.apply(capabilities({ revision: 2, offers: [offer({ rid: F.rid2, version: F.v2 })] }));
    m.apply(state("idle", { epoch: 9, detail: "other.example.org", permitted: true }));
    m.apply(state("working", { epoch: 9 }));
    expect(m.section).toBe("page");
    expect(m.shownPreview).toEqual(key);
    expect(m.preview(key)).toBe(before);
    expect(m.preview(key)?.text).toBe("the guide");
    expect(m.approveBlocker(key)).toBe(BLOCKER_TEXT.notOffered);
    m.showPreview({ resourceId: F.rid2, version: F.v2 });
    expect(m.shownPreview).toEqual({ resourceId: F.rid2, version: F.v2 });
  });

  it("chunksFromAnAbandonedRequestAreIgnored", async () => {
    const m = onSite();
    const first = m.showPreview(key)!;
    const cs = chunks("0123456789abcdef", key, 4);
    const second = m.apply(withId(cs[0]!, first.commandId));
    expect(second).toHaveLength(1);
    m.applyLink("connecting");
    const restarted = m.applyLink("connected");
    expect(restarted).toHaveLength(1);
    m.apply(withId(cs[1]!, second[0]!.commandId));
    expect(m.preview(key)?.phase).toBe("loading");
    expect(m.preview(key)?.bytes.length).toBe(0);
    await answer(m, restarted[0]!, cs);
    expect(m.preview(key)?.isComplete).toBe(true);
  });

  it("restartResendsPendingApprovalWithItsId", async () => {
    const m = onSite();
    await loaded(m);
    const approve = m.approve(key)!;
    m.markSent(approve, "written");
    m.applyLink("connecting");
    expect(m.capabilities.capabilities).toBeNull();
    expect(m.applyLink("connected")).toEqual([approve]);
    m.apply(capabilities({ revision: 0, offers: [offer()] }));
    expect(m.capabilities.offers).toHaveLength(1);
  });

  it("failedCommandsAreProblemsAndRetryKeepsTheId", async () => {
    const m = onSite();
    await loaded(m);
    const approve = m.approve(key)!;
    m.apply(ackFailed(approve.commandId, "store_error"));
    expect(m.problems[0]).toMatchObject({ kind: "command", record: { state: "failed", code: "store_error" } });
    expect(m.retry(approve.commandId)).toEqual(approve);
    expect(m.problems).toEqual([]);
    m.apply(ackFailed(approve.commandId, "stale_revision", 3));
    const again = m.approve(key)!;
    expect(again.commandId).not.toBe(approve.commandId);
  });

  it("libraryReapprovalAndUnpermittedPendingVersions", async () => {
    const m = new PanelModel(tracker("t"));
    m.applyLink("connected");
    const other = "https://other.example.org";
    m.apply(
      capabilities({
        library: [entry({ state: "blocked", defaultVersion: null, versions: [[F.v1, "revoked"]], revision: 7 }), entry({ rid: F.rid2, origin: other, state: "no_default", defaultVersion: null, versions: [[F.v2, "pending"]], revision: 2 })],
        origins: [originSetting(other, { permitted: false })],
      }),
    );
    expect(m.canApprove(key)).toBe(false);
    await loaded(m);
    expect(m.approve(key)).toMatchObject({ type: "approve", resourceId: F.rid, version: F.v1, expectedRevision: 7 });
    const pending = { resourceId: F.rid2, version: F.v2 };
    await loaded(m, pending);
    expect(m.approveBlocker(pending)).toBe(BLOCKER_TEXT.siteNotPermitted);
    expect(m.canRevoke(F.rid)).toBe(false);
    expect(m.revoke(F.rid2)).toMatchObject({ type: "revoke", resourceId: F.rid2, expectedRevision: 2 });
    expect(m.revoke(F.rid2)).toBeNull();
  });

  it("settingsCommands", () => {
    const m = onSite();
    expect(m.setAutoAcquire(F.origin, true, false)).toBeNull();
    const on = m.setAutoAcquire(F.origin, true, true)!;
    expect(on).toMatchObject({ type: "set_auto_acquire", origin: F.origin, enabled: true, acknowledgeRisk: true, expectedEnabled: false });
    expect(m.setAutoAcquire(F.origin, false, false)).toBeNull();
    m.apply(ackOk(on.commandId));
    m.apply(capabilities({ revision: 2, origins: [originSetting(F.origin, { autoAcquire: true })] }));
    expect(m.setAutoAcquire(F.origin, false, true)).toMatchObject({ type: "set_auto_acquire", origin: F.origin, enabled: false, acknowledgeRisk: false, expectedEnabled: true });
    expect(m.setAutoAcquire("https://unknown.example", true, true)).toBeNull();

    expect(m.setAgentBrowserContext(true)).toBeNull();
    m.apply({ type: "grant", agentBrowserContext: false });
    const grant = m.setAgentBrowserContext(true)!;
    expect(grant).toMatchObject({ type: "set_agent_browser_context", enabled: true, expectedEnabled: false });
    expect(m.setAgentBrowserContext(true)).toBeNull();
    m.apply(ackFailed(grant.commandId, "invalid"));
    m.apply({ type: "grant", agentBrowserContext: false });
    expect(m.capabilities.agentBrowserContext).toBe(false);
    expect(m.grantRecord).toMatchObject({ state: "failed", code: "invalid" });
    expect(m.retry(grant.commandId)).toBeNull();
    expect(m.setAgentBrowserContext(true)).not.toBeNull();

    expect(m.pauseState.control).toMatchObject({ title: "Pause", pause: true });
    m.apply(state("paused"));
    expect(m.pauseState.control).toMatchObject({ title: "Resume", pause: false });
    expect(m.refreshCapabilities()).not.toBeNull();
  });

  it("staleCapabilitiesFrameIsDropped", () => {
    const m = onSite();
    m.apply(capabilities({ revision: 5, offers: [] }));
    m.apply(capabilities({ revision: 4, offers: [offer()] }));
    expect(m.capabilities.offers).toEqual([]);
  });

  it("conflictsAndLinkAreProblems (conflictsAndSidecarAreProblems)", () => {
    const m = new PanelModel();
    m.applyLink("connected");
    m.apply(capabilities({ conflicts: [{ name: "scout-skill-0123456789abcdef", resourceId: F.rid, code: "foreign_collision" }] }));
    expect(m.problems[0]).toMatchObject({ kind: "conflict", conflict: { code: "foreign_collision" } });
    m.applyLink("core_unavailable");
    expect(m.problems[0]).toMatchObject({ kind: "link" });
  });

  it("aNewCoreInstanceRestartsRevisionsAndResendsPendingCommands", async () => {
    const m = onSite();
    m.apply(capabilities({ revision: 9, offers: [offer()], origins: [originSetting()] }));
    await loaded(m);
    const approve = m.approve(key)!;
    m.markSent(approve, "written");
    m.apply(capabilities({ revision: 3, offers: [] }));
    expect(m.capabilities.offers).toHaveLength(1);
    expect(m.apply(capabilities({ instance: "core-2", revision: 0, offers: [offer()] }))).toEqual([approve]);
    expect(m.capabilities.capabilities?.coreInstanceId).toBe("core-2");
  });

  it("approveIsBoundToTheShownPreview", async () => {
    const m = onSite([offer(), offer({ rid: F.rid2, version: F.v2 })]);
    const other = { resourceId: F.rid2, version: F.v2 };
    await loaded(m, key);
    await loaded(m, other);
    expect(m.preview(key)?.isComplete).toBe(true);
    expect(m.shownPreview).toEqual(other);
    expect(m.approveBlocker(key)).toBe("Open this version in the preview to approve it.");
    expect(m.approve(key)).toBeNull();
    m.apply(capabilities({ revision: 2, offers: [offer({ rid: F.rid2, version: F.v2 }), offer()], origins: [originSetting()] }));
    expect(m.approve(other)).toMatchObject({ type: "approve", resourceId: F.rid2, version: F.v2, expectedRevision: 1 });
    expect(m.canDecline(key)).toBe(true);
  });

  it("pendingVersionOnAnUnlistedOriginIsNotApprovable", async () => {
    const m = new PanelModel(tracker("t"));
    m.applyLink("connected");
    m.apply(capabilities({ library: [entry({ origin: "https://unlisted.example.net", state: "no_default", defaultVersion: null, versions: [[F.v1, "pending"]], revision: 2 })] }));
    await loaded(m);
    expect(m.preview(key)?.isComplete).toBe(true);
    expect(m.approveBlocker(key)).toBe(BLOCKER_TEXT.siteNotPermitted);
    expect(m.approve(key)).toBeNull();
  });

  it("restartSettlesPendingTogglesWithoutResendingOrFailingThem", () => {
    const m = onSite();
    m.apply({ type: "grant", agentBrowserContext: false });
    const grant = m.setAgentBrowserContext(true)!;
    const auto = m.setAutoAcquire(F.origin, true, true)!;
    m.markSent(grant, "written");
    m.markSent(auto, "retryLater");
    expect(m.apply(capabilities({ instance: "core-2", revision: 0, origins: [originSetting()] }))).toEqual([]);
    expect(m.grantRecord?.state).toBe("unknown");
    expect(m.autoAcquireRecord(F.origin)?.state).toBe("unknown");
    expect(m.commands.unsent).toEqual([]);
    expect(m.problems).toEqual([]);
    m.apply({ type: "grant", agentBrowserContext: false });
    expect(m.setAgentBrowserContext(true)).not.toBeNull();
    expect(m.setAutoAcquire(F.origin, true, true)).not.toBeNull();
  });

  it("staleToggleWhoseTargetTheFrameShowsIsSettled", () => {
    const m = onSite();
    m.apply({ type: "grant", agentBrowserContext: false });
    const auto = m.setAutoAcquire(F.origin, true, true)!;
    const grant = m.setAgentBrowserContext(true)!;
    m.apply(capabilities({ revision: 2, origins: [originSetting(F.origin, { autoAcquire: true })] }));
    m.apply({ type: "grant", agentBrowserContext: true });
    m.apply(ackFailed(auto.commandId, "stale_revision"));
    m.apply(ackFailed(grant.commandId, "stale_revision"));
    expect(m.autoAcquireRecord(F.origin)?.state).toBe("ok");
    expect(m.grantRecord?.state).toBe("ok");
    expect(m.problems).toEqual([]);
    const off = m.setAgentBrowserContext(false)!;
    m.apply(ackFailed(off.commandId, "stale_revision"));
    expect(m.grantRecord).toMatchObject({ state: "failed", code: "stale_revision" });
    expect(m.problems).toEqual([{ kind: "command", record: m.grantRecord }]);
    expect(m.retry(off.commandId)).toBeNull();
    m.apply({ type: "grant", agentBrowserContext: false });
    expect(m.grantRecord?.state).toBe("ok");
    expect(m.problems).toEqual([]);
  });

  it("dismissRemovesAFailedCommandFromProblems", async () => {
    const m = onSite();
    await loaded(m);
    const approve = m.approve(key)!;
    const refresh = m.refreshCapabilities()!;
    m.apply(ackFailed(approve.commandId, "store_error"));
    m.apply(ackFailed(refresh.commandId, "unavailable"));
    expect(m.problems).toHaveLength(2);
    m.dismiss(approve.commandId);
    expect(m.problems).toHaveLength(1);
    expect(m.problems[0]).toMatchObject({ kind: "command", record: { id: refresh.commandId } });
    const pending = m.refreshCapabilities()!;
    m.dismiss(pending.commandId);
    m.apply(ackFailed(pending.commandId, "unavailable"));
    expect(m.problems).toHaveLength(2);
    expect(m.retry(approve.commandId)).toEqual(approve);
    m.apply(ackFailed(approve.commandId, "store_error"));
    expect(m.problems).toHaveLength(3);
  });

  it("staleDecisionsAfterARestartSettleWhenTheFrameShowsTheirTarget", async () => {
    const rid3 = `res_${"c".repeat(64)}`;
    const m = onSite([offer(), offer({ rid: F.rid2, version: F.v2 })]);
    m.apply(capabilities({ revision: 2, offers: [offer(), offer({ rid: F.rid2, version: F.v2 })], library: [entry({ rid: rid3, state: "approved", defaultVersion: F.v3, versions: [[F.v3, "approved"]] })], origins: [originSetting()] }));
    await loaded(m);
    const approve = m.approve(key)!;
    const decline = m.decline({ resourceId: F.rid2, version: F.v2 })!;
    const revoke = m.revoke(rid3)!;
    for (const c of [approve, decline, revoke]) m.markSent(c, "written");
    m.applyLink("connecting");
    expect(m.applyLink("connected")).toEqual([approve, decline, revoke]);
    for (const c of [approve, decline, revoke]) m.apply(ackFailed(c.commandId, "stale_revision", 9));
    expect(m.problems).toHaveLength(3);
    m.apply(
      capabilities({
        instance: "core-2",
        revision: 1,
        library: [
          entry({ defaultVersion: F.v1, versions: [[F.v1, "approved"]], revision: 9 }),
          entry({ rid: F.rid2, state: "no_default", defaultVersion: null, versions: [[F.v2, "declined"]], revision: 9 }),
          entry({ rid: rid3, state: "blocked", defaultVersion: null, versions: [[F.v3, "revoked"]], revision: 9 }),
        ],
        origins: [originSetting()],
      }),
    );
    for (const c of [approve, decline, revoke]) expect(m.commands.record(c.commandId)?.state).toBe("ok");
    expect(m.problems).toEqual([]);
  });

  it("staleDecisionWhoseTargetTheFrameDoesNotShowStaysAProblem", async () => {
    const m = onSite();
    await loaded(m);
    const approve = m.approve(key)!;
    m.apply(capabilities({ revision: 2, library: [entry({ state: "no_default", defaultVersion: null, versions: [[F.v1, "declined"]], revision: 2 })] }));
    m.apply(ackFailed(approve.commandId, "stale_revision", 2));
    expect(m.commands.record(approve.commandId)).toMatchObject({ state: "failed", code: "stale_revision" });
    expect(m.problems).toHaveLength(1);
  });

  it("restartingOrEvictingAPreviewSupersedesItsRequest", () => {
    const m = onSite();
    const first = m.showPreview(key)!;
    m.markSent(first, "retryLater");
    const again = m.restartPreview(key)!;
    expect(m.commands.record(first.commandId)?.state).toBe("superseded");
    expect(m.commands.unsent).toEqual([again]);
    const requests: PanelCommand[] = [again];
    for (let i = 0; i < PanelModel.previewCapacity; i++) {
      requests.push(m.showPreview({ resourceId: F.rid2, version: (i + 1).toString(16).padStart(64, "0") })!);
    }
    expect(m.preview(key)).toBeUndefined();
    expect(m.commands.record(again.commandId)?.state).toBe("superseded");
    for (const r of requests.slice(1)) expect(m.commands.record(r.commandId)?.state).toBe("pending");
  });

  it("completeShownPreviewSurvivesARestartAndWaitsForAFrame", async () => {
    const m = onSite();
    await loaded(m);
    expect(m.canApprove(key)).toBe(true);
    m.applyLink("connecting");
    expect(m.applyLink("connected")).toEqual([]);
    expect(m.shownPreview).toEqual(key);
    expect(m.preview(key)?.isComplete).toBe(true);
    expect(m.canApprove(key)).toBe(false);
    expect(m.approve(key)).toBeNull();
    m.apply(capabilities({ instance: "core-2", offers: [offer()], origins: [originSetting()] }));
    expect(m.canApprove(key)).toBe(true);
  });

  it("showPreviewWhileStartingSendsNothingUntilTheCoreRuns", () => {
    const m = new PanelModel(tracker("t"));
    expect(m.link).toBe("connecting");
    expect(m.showPreview(key)).toBeNull();
    expect(m.shownPreview).toEqual(key);
    expect(m.preview(key)?.phase).toBe("loading");
    expect(m.commands.records).toEqual([]);
    const started = m.applyLink("connected");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ type: "preview", resourceId: F.rid, version: F.v1 });
  });

  it("grantFrameWhileAToggleIsPendingLeavesItPending", () => {
    const m = onSite();
    m.apply({ type: "grant", agentBrowserContext: false });
    expect(m.setAgentBrowserContext(true)).not.toBeNull();
    m.apply({ type: "grant", agentBrowserContext: true });
    expect(m.grantRecord?.state).toBe("pending");
    expect(m.canToggleGrant).toBe(false);
  });

  // The per-site recommendations switch, a toggle like the grant.
  it("set_destination is a compare-and-set toggle on the grant frame's destinations", () => {
    const m = onSite();
    const STRIPE = "https://docs.stripe.com";
    expect(m.canToggleDestination(F.origin)).toBe(false); // no grant frame yet
    expect(m.setDestination(F.origin, true)).toBeNull();
    m.apply({ type: "grant", agentBrowserContext: false, destinations: [STRIPE] });
    expect(m.isDestination(F.origin)).toBe(false);
    expect(m.isDestination(STRIPE)).toBe(true);
    expect(m.canToggleDestination(F.origin)).toBe(true);
    expect(m.setDestination(F.origin, false)).toBeNull(); // already off
    const on = m.setDestination(F.origin, true)!;
    expect(on).toMatchObject({ type: "set_destination", origin: F.origin, enabled: true, expectedEnabled: false });
    expect(on.commandId).toMatch(/^t/);
    expect(m.canToggleDestination(F.origin)).toBe(false); // pending
    expect(m.canToggleDestination(STRIPE)).toBe(true); // another site's switch is independent
    expect(m.setDestination(F.origin, true)).toBeNull();
    // The grant frame alone leaves the toggle pending; the ack settles it.
    m.apply({ type: "grant", agentBrowserContext: false, destinations: [STRIPE, F.origin] });
    expect(m.destinationRecord(F.origin)?.state).toBe("pending");
    m.apply(ackOk(on.commandId));
    expect(m.destinationRecord(F.origin)?.state).toBe("ok");
    expect(m.setDestination(F.origin, false)).toMatchObject({ type: "set_destination", origin: F.origin, enabled: false, expectedEnabled: true });
    m.applyLink("core_unavailable");
    expect(m.canToggleDestination(F.origin)).toBe(false);
  });

  it("a stale set_destination the next grant frame shows done settles; otherwise it is a Problem without Retry", () => {
    const m = onSite();
    m.apply({ type: "grant", agentBrowserContext: false, destinations: [] });
    const on = m.setDestination(F.origin, true)!;
    m.apply(ackFailed(on.commandId, "stale_revision"));
    expect(m.destinationRecord(F.origin)).toMatchObject({ state: "failed", code: "stale_revision" });
    expect(m.problems.some((p) => p.kind === "command" && p.record.id === on.commandId)).toBe(true);
    expect(m.canRetry(on.commandId)).toBe(false);
    m.apply({ type: "grant", agentBrowserContext: false, destinations: [F.origin] });
    expect(m.destinationRecord(F.origin)?.state).toBe("ok");
    const off = m.setDestination(F.origin, false)!;
    m.apply(ackFailed(off.commandId, "store_error"));
    expect(m.canRetry(off.commandId)).toBe(false);
    expect(m.problems.some((p) => p.kind === "command" && p.record.id === off.commandId)).toBe(true);
  });

  it("a pending set_destination settles unknown on expiry and on a core restart, never re-sent", () => {
    const m = onSite();
    m.apply({ type: "grant", agentBrowserContext: false, destinations: [] });
    const a = m.setDestination(F.origin, true)!;
    m.markSent(a, "written", 1000);
    m.expirePending(1000 + 10_000);
    expect(m.destinationRecord(F.origin)?.state).toBe("unknown");
    m.apply({ type: "grant", agentBrowserContext: false, destinations: [] });
    const b = m.setDestination(F.origin, true)!;
    m.markSent(b, "written", 2000);
    m.applyLink("core_unavailable");
    expect(m.applyLink("connected")).toEqual([]);
    expect(m.destinationRecord(F.origin)?.state).toBe("unknown");
  });

  it("set_agent names one offered agent; the pending choice, then the ok ack, show as selected until the next capabilities frame", () => {
    const m = onSite();
    expect(m.capabilities.agents).toBeNull(); // a frame without agents (an older core)
    expect(m.canSetAgent).toBe(false);
    expect(m.setAgent("agent-b")).toBeNull();
    m.apply(capabilities({ revision: 2, agents: AGENTS }));
    expect(m.selectedAgent).toBe("agent-a");
    expect(m.canSetAgent).toBe(true);
    expect(m.setAgent("agent-a")).toBeNull(); // already selected
    expect(m.setAgent("agent-z")).toBeNull(); // not offered
    const c = m.setAgent("agent-b")!;
    expect(c).toEqual({ type: "set_agent", commandId: expect.stringMatching(/^t/), agent: "agent-b" });
    expect(m.selectedAgent).toBe("agent-b");
    expect(m.canSetAgent).toBe(false);
    expect(m.setAgent("agent-a")).toBeNull(); // one choice at a time
    m.apply(ackOk(c.commandId));
    expect(m.agentRecord?.state).toBe("ok");
    expect(m.selectedAgent).toBe("agent-b"); // the frame that shows it has not arrived yet
    m.apply(capabilities({ revision: 3, agents: { ...AGENTS, current: "agent-b" } }));
    expect(m.selectedAgent).toBe("agent-b");
    // A later hand edit back is what the frame says.
    m.apply(capabilities({ revision: 4, agents: AGENTS }));
    expect(m.selectedAgent).toBe("agent-a");
    m.applyLink("core_unavailable");
    expect(m.canSetAgent).toBe(false);
    expect(m.selectedAgent).toBeNull();
  });

  it("a refused set_agent is a Problem without Retry, and the frame's agent stays selected", () => {
    const m = onSite();
    m.apply(capabilities({ revision: 2, agents: AGENTS }));
    const c = m.setAgent("agent-b")!;
    m.apply(ackFailed(c.commandId, "not_found"));
    expect(m.selectedAgent).toBe("agent-a");
    expect(m.canSetAgent).toBe(true);
    expect(m.canRetry(c.commandId)).toBe(false);
    expect(m.problems.some((p) => p.kind === "command" && p.record.id === c.commandId && p.record.code === "not_found")).toBe(true);
  });

  it("a pending set_agent settles unknown on expiry and on a core restart, never re-sent", () => {
    const m = onSite();
    m.apply(capabilities({ revision: 2, agents: AGENTS }));
    const a = m.setAgent("agent-b")!;
    m.markSent(a, "written", 1000);
    m.expirePending(1000 + 10_000);
    expect(m.agentRecord?.state).toBe("unknown");
    expect(m.selectedAgent).toBe("agent-a");
    const b = m.setAgent("agent-b")!;
    m.markSent(b, "written", 2000);
    m.applyLink("core_unavailable");
    expect(m.applyLink("connected")).toEqual([]);
    expect(m.agentRecord?.state).toBe("unknown");
  });

  it("ackForAnUnknownCommandIsIgnored", async () => {
    const m = onSite();
    await loaded(m);
    const before = JSON.stringify(m.commands.records) + m.problems.length;
    expect(m.apply(ackOk("nope", { revision: 1, approvalRevision: 1 }))).toEqual([]);
    expect(m.apply(ackFailed("nope", "stale_revision", 1))).toEqual([]);
    expect(JSON.stringify(m.commands.records) + m.problems.length).toBe(before);
  });

  it("togglePredicatesFollowTheModel", () => {
    const m = onSite();
    const blocked = "https://other.example.org";
    m.apply(capabilities({ revision: 2, origins: [originSetting(), originSetting(blocked, { permitted: false })] }));
    expect(m.canToggleAutoAcquire(F.origin)).toBe(true);
    expect(m.canToggleAutoAcquire(blocked)).toBe(false);
    expect(m.canToggleAutoAcquire("https://unknown.example")).toBe(false);
    expect(m.setAutoAcquire(blocked, true, true)).toBeNull();
    expect(m.canToggleGrant).toBe(false);
    m.apply({ type: "grant", agentBrowserContext: false });
    expect(m.canToggleGrant).toBe(true);
    expect(m.setAutoAcquire(F.origin, true, true)).not.toBeNull();
    expect(m.canToggleAutoAcquire(F.origin)).toBe(false);
    m.applyLink("core_unavailable");
    expect(m.canToggleGrant).toBe(false);
  });

  it("oversizePreviewRequestFailsThePreview", () => {
    const m = onSite();
    const first = m.showPreview(key)!;
    m.markSent(first, "oversize");
    expect(m.commands.record(first.commandId)).toMatchObject({ state: "failed", code: "invalid" });
    expect(m.preview(key)?.failure).toEqual({ kind: "refused", code: "invalid" });
    expect(m.commands.unsent).toEqual([]);
  });

  it("approveOfAnUnknownVersionIsAProblemWithoutRetry", async () => {
    const m = onSite();
    await loaded(m);
    const approve = m.approve(key)!;
    m.apply(ackFailed(approve.commandId, "not_found", 1));
    expect(m.problems[0]).toMatchObject({ kind: "command", record: { state: "failed", code: "not_found" } });
    expect(m.retry(approve.commandId)).toBeNull();
  });
});

describe("PanelModel browser additions", () => {
  it("the full capabilities fixture lists offers, library, conflicts and origins as the app does", () => {
    const m = new PanelModel(tracker("t"));
    m.applyLink("connected");
    m.apply(F.frame("frame.capabilities.full.json"));
    m.apply(F.frame("frame.grant.json"));
    m.apply(F.frame("frame.audit.json"));
    expect(m.capabilities.offersForHost("docs.example.com")).toHaveLength(1);
    expect(m.capabilities.libraryForHost("docs.example.com")).toHaveLength(2);
    expect(m.problems).toEqual([{ kind: "conflict", conflict: { name: "scout-skill-0123456789abcdef", resourceId: `res_${"c".repeat(64)}`, code: "left_modified" } }]);
    expect(m.canRevoke(`res_${"a".repeat(64)}`)).toBe(true);
    expect(m.canRevoke(`res_${"c".repeat(64)}`)).toBe(false);
    expect(m.canToggleAutoAcquire("https://docs.example.com")).toBe(true);
    expect(m.canToggleAutoAcquire("https://other.example.org:8443")).toBe(false);
    expect(m.capabilities.agentBrowserContext).toBe(true);
    expect(m.capabilities.audit).toHaveLength(2);
  });

  it("every fixture frame applies without throwing, and a fixture ack for an unknown command changes nothing", () => {
    const m = new PanelModel(tracker("t"));
    m.applyLink("connected");
    for (const name of F.names("frame.")) expect(() => m.apply(F.frame(name)), name).not.toThrow();
    expect(m.commands.records).toEqual([]);
    expect(m.takeLinksToOpen()).toEqual([]);
  });

  it("a state without a capabilities frame (dropped over the relay's cap) is a Problems line", () => {
    const m = new PanelModel(tracker("t"));
    m.applyLink("connected");
    expect(m.missingCapabilities).toBe(false); // nothing has arrived yet
    m.apply({ type: "grant", agentBrowserContext: false });
    m.apply(state("idle", { epoch: 1 }));
    expect(m.missingCapabilities).toBe(true);
    expect(m.problems).toContainEqual({ kind: "link", text: MISSING_CAPABILITIES });
    m.apply(capabilities());
    expect(m.problems).toEqual([]);
  });

  it("Escape's target: leaving Page and selecting it again keeps the shown preview", async () => {
    const m = new PanelModel(tracker("t"));
    m.applyLink("connected");
    m.select("sites");
    m.showPreview(key);
    expect(m.section).toBe("page");
    m.select("activity");
    m.select("page");
    expect(m.shownPreview).toEqual(key);
  });

  it("a preview request the core never answers fails the preview after 10 s; Load again starts over", () => {
    const m = new PanelModel(tracker("t"));
    m.applyLink("connected");
    const first = m.showPreview(key)!;
    m.markSent(first, "written", 0);
    m.expirePending(9_999);
    expect(m.preview(key)?.phase).toBe("loading");
    m.expirePending(10_000);
    expect(m.preview(key)?.failure).toEqual({ kind: "refused", code: "unavailable" });
    expect(m.restartPreview(key)).toMatchObject({ type: "preview", resourceId: F.rid });
  });

  it("frames dropped under backpressure: a later capabilities or state frame is taken whole", () => {
    const m = new PanelModel(tracker("t"));
    m.applyLink("connected");
    m.apply(capabilities({ revision: 1, offers: [offer()] }));
    // revisions 2..6 never arrived; the repaint carries 7.
    m.apply(capabilities({ revision: 7, offers: [] }));
    expect(m.capabilities.offers).toEqual([]);
    m.apply(state("working", { epoch: 1, jobId: "job-1" }));
    m.apply(state("idle", { epoch: 5, detail: "docs.example.com", permitted: true })); // epochs 2..4 missed
    expect(m.visitEpoch).toBe(5);
    expect(m.resultsDisplay).toEqual({ kind: "none" });
  });

  it("a grant frame's destinations are kept; a grant without them means none; link loss clears them", () => {
    const m = new PanelModel(tracker("t"));
    m.applyLink("connected");
    m.apply({ type: "grant", agentBrowserContext: false, destinations: ["https://docs.stripe.com"] });
    expect(m.capabilities.destinations).toEqual(["https://docs.stripe.com"]);
    m.apply({ type: "grant", agentBrowserContext: false });
    expect(m.capabilities.destinations).toEqual([]);
    m.apply({ type: "grant", agentBrowserContext: true, destinations: ["https://docs.stripe.com"] });
    m.applyLink("core_unavailable");
    expect(m.capabilities.destinations).toEqual([]);
    expect(m.capabilities.agentBrowserContext).toBeNull();
  });
});
