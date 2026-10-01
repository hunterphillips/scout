import Foundation
import Testing
@testable import ScoutKit

@Suite struct PanelModelTests {
    @Test func sidecarStatusesRenderAsText() {
        var model = PanelModel()
        #expect(model.text == "Starting…")
        _ = model.apply(.setupNeeded("nodePath is missing"))
        #expect(model.text.hasPrefix("Setup needed\nnodePath is missing"))
        _ = model.apply(.stopped)
        #expect(model.text.hasPrefix("Stopped"))
        #expect(model.text.contains("after \(RestartPolicy.defaultMaxRestarts) restarts in a minute"))
    }

    @Test func describesRestartWindows() {
        #expect(PanelModel.describe(60) == "a minute")
        #expect(PanelModel.describe(120) == "2 minutes")
        #expect(PanelModel.describe(90) == "90 seconds")
    }

    @Test func runningShowsCoreStatusAndResults() {
        var model = PanelModel()
        _ = model.apply(.running)
        _ = model.apply(.state(status: .working, visitEpoch: 1, detail: "ranking"))
        #expect(model.text == "Working\nranking")
        _ = model.apply(.results(visitEpoch: 1, outcome: .ok([
            ResultItem(candidateId: "c1", title: "Webhooks", href: "https://a", reason: "r"),
            ResultItem(candidateId: "c2", title: "Testing", href: "https://b", reason: "r"),
        ])))
        _ = model.apply(.state(status: .idle, visitEpoch: 1, detail: nil))
        #expect(model.text == "Idle\n\n• Webhooks\n• Testing")
        _ = model.apply(.results(visitEpoch: 2, outcome: .unavailable("service down")))
        #expect(model.text == "Idle\n\nResults unavailable: service down")
    }

    @Test func idleVisitShowsTheHostnameAndLeavingClearsIt() throws {
        var model = PanelModel()
        _ = model.apply(.running)
        let line = #"{"type":"state","status":"idle","visitEpoch":2,"detail":"docs.stripe.com"}"# + "\n"
        var parser = JSONLParser()
        let states = parser.append(Data(line.utf8))
        try #require(states.count == 1)
        _ = model.apply(states[0])
        #expect(model.text == "Idle\ndocs.stripe.com")
        _ = model.apply(.state(status: .idle, visitEpoch: 3, detail: nil))
        #expect(model.text == "Idle")
    }

    @Test func restartClearsCoreState() {
        var model = PanelModel()
        _ = model.apply(.running)
        _ = model.apply(.state(status: .paused, visitEpoch: nil, detail: nil))
        _ = model.apply(.results(visitEpoch: 1, outcome: .empty))
        _ = model.apply(.starting)
        _ = model.apply(.running)
        #expect(model.text == "Connected")
    }
}

@Suite struct PanelModelCapabilityTests {
    typealias F = ContractFixtures
    let key = PreviewKey(resourceId: F.rid, version: F.v1)

    /// Running, on docs.example.com, with one offer for it.
    private func onSite(offers: [[String: Any]] = [TestFrames.offer()]) throws -> PanelModel {
        var model = PanelModel(commands: CommandTracker(prefix: "t"))
        _ = model.apply(.running)
        _ = model.apply(.state(status: .idle, visitEpoch: 1, detail: "docs.example.com", permitted: true))
        _ = model.apply(.capabilities(try TestFrames.capabilities(offers: offers, origins: [TestFrames.origin()])))
        return model
    }

    private func loaded(_ model: inout PanelModel, _ key: PreviewKey, text: String = "hello ✓") {
        guard let first = model.showPreview(key) else { return }
        _ = TestFrames.answer(&model, first: first, with: TestFrames.chunks(of: text, key: key, size: 4))
    }

    @Test func indicatorDerivation() throws {
        var model = PanelModel()
        #expect(model.indicator == .nothing)
        _ = model.apply(.setupNeeded("no config"))
        #expect(model.indicator == .error("Setup needed"))
        model = try onSite()
        #expect(model.indicator == .offers(count: 1, host: "docs.example.com"))
        #expect(model.compactLine == "Idle · docs.example.com · 1 offer")
        #expect(model.text == "Idle\ndocs.example.com\n1 offer for docs.example.com")
        // Another site: its offers are not this site's.
        _ = model.apply(.state(status: .idle, visitEpoch: 2, detail: "other.example.org", permitted: true))
        #expect(model.indicator == .nothing)
        _ = model.apply(.results(visitEpoch: 2, outcome: .ok([ResultItem(candidateId: "c", title: "t", href: "h", reason: "r")])))
        #expect(model.indicator == .results(count: 1))
        _ = model.apply(.results(visitEpoch: 2, outcome: .error("timeout")))
        #expect(model.indicator == .error("timeout"))
        // An unpermitted visit shows no offers.
        _ = model.apply(.state(status: .idle, visitEpoch: 3, detail: "docs.example.com", permitted: false))
        #expect(model.currentHost == nil && model.currentOffers.isEmpty)
    }

    @Test func offersNeverExpandThePanel() throws {
        var model = try onSite()
        _ = model.apply(.capabilities(try TestFrames.capabilities(revision: 2, offers: [TestFrames.offer(), TestFrames.offer(rid: F.rid2)])))
        #expect(!model.expanded && model.shownPreview == nil)
        model.toggleExpanded()
        #expect(model.expanded && model.section == .offers)
        model.toggleExpanded()
        #expect(!model.expanded)
    }

    @Test func approveOnlyWhenThePreviewIsComplete() throws {
        var model = try onSite()
        #expect(model.approveBlocker(key) == "Preview this version before approving it.")
        #expect(model.approve(key) == nil)
        #expect(model.canDecline(key))
        let firstSent = model.showPreview(key)
        let first = try #require(firstSent)
        #expect(model.expanded && model.section == .preview && model.shownPreview == key)
        #expect(model.showPreview(key) == nil)  // already loading: no second request
        #expect(model.approveBlocker(key) == "Preview is still loading.")
        let chunks = TestFrames.chunks(of: "hello ✓ world", key: key, size: 4)
        _ = model.apply(.preview(TestFrames.with(chunks[0], commandId: first.commandId!)))
        #expect(!model.canApprove(key))
        model = try onSite()
        loaded(&model, key)
        #expect(model.preview(key)?.isComplete == true)
        let approveSent = model.approve(key)
        let approve = try #require(approveSent)
        guard case let .panel(id, request) = approve else { Issue.record("not a panel command"); return }
        #expect(request == .approve(resourceId: F.rid, version: F.v1, expectedRevision: 1))
        // Pending: no duplicate approval and no decline.
        #expect(model.approve(key) == nil && !model.canDecline(key))
        #expect(model.decisionRecord(key)?.state == .pending)
        _ = model.apply(.ack(.ok(commandId: id, revision: 2, approvalRevision: 1)))
        #expect(model.approve(key) == nil)  // decided until the next frame
        _ = model.apply(.capabilities(try TestFrames.capabilities(revision: 2, library: [
            TestFrames.entry(defaultVersion: F.v1, versions: [(F.v1, "approved")], revision: 2)])))
        #expect(model.approveBlocker(key) == ApprovalBlocker.alreadyApproved.reason)
    }

    @Test func hashMismatchKeepsApproveOff() throws {
        var model = try onSite()
        let firstSent = model.showPreview(key)
        let first = try #require(firstSent)
        let chunk = TestFrames.chunks(of: "abc", key: key, size: 10)[0]
        let bad = PreviewChunk(commandId: first.commandId!, resourceId: F.rid, version: F.v1, seq: 0, offset: 0,
            totalBytes: 3, text: "abc", sha256: F.v3, descriptor: chunk.descriptor, nextCursor: nil)
        _ = model.apply(.preview(bad))
        #expect(model.preview(key)?.phase == .failed(.hashMismatch))
        #expect(!model.canApprove(key))
        #expect(model.problems.contains(.preview(key, .hashMismatch)))
        // Loading it again starts over from the first chunk.
        guard case let .panel(_, request)? = model.showPreview(key) else { Issue.record("no restart"); return }
        #expect(request == .preview(resourceId: F.rid, version: F.v1, cursor: nil))
    }

    @Test func expandedPreviewSurvivesNewFramesAndTabs() throws {
        var model = try onSite()
        loaded(&model, key, text: "the guide")
        let before = model.preview(key)
        // A new offer arrives, the old one is gone, and the user switches tabs.
        _ = model.apply(.capabilities(try TestFrames.capabilities(revision: 2, offers: [TestFrames.offer(rid: F.rid2, version: F.v2)])))
        _ = model.apply(.state(status: .idle, visitEpoch: 9, detail: "other.example.org", permitted: true))
        _ = model.apply(.state(status: .working, visitEpoch: 9, detail: nil))
        #expect(model.expanded && model.section == .preview)
        #expect(model.shownPreview == key)
        #expect(model.preview(key) == before && model.preview(key)?.text == "the guide")
        // The offer is gone, so Approve says why rather than approving something else.
        #expect(model.approveBlocker(key) == ApprovalBlocker.notOffered.reason)
        // Only a user action changes the shown preview.
        _ = model.showPreview(PreviewKey(resourceId: F.rid2, version: F.v2))
        #expect(model.shownPreview == PreviewKey(resourceId: F.rid2, version: F.v2))
    }

    @Test func chunksFromAnAbandonedRequestAreIgnored() throws {
        var model = try onSite()
        let firstSent = model.showPreview(key)
        let first = try #require(firstSent)
        let chunks = TestFrames.chunks(of: "0123456789abcdef", key: key, size: 4)
        let second = model.apply(.preview(TestFrames.with(chunks[0], commandId: first.commandId!)))
        #expect(second.count == 1)
        // A core restart restarts the load; the old chain's next chunk must not land in the new one.
        _ = model.apply(.starting)
        let restarted = model.apply(.running)
        #expect(restarted.count == 1)
        _ = model.apply(.preview(TestFrames.with(chunks[1], commandId: second[0].commandId!)))
        #expect(model.preview(key)?.phase == .loading && model.preview(key)?.bytes.isEmpty == true)
        _ = TestFrames.answer(&model, first: restarted[0], with: chunks)
        #expect(model.preview(key)?.isComplete == true)
    }

    @Test func restartResendsPendingApprovalWithItsId() throws {
        var model = try onSite()
        loaded(&model, key)
        let approveSent = model.approve(key)
        let approve = try #require(approveSent)
        model.markSent(approve, written: true)
        _ = model.apply(.starting)
        #expect(model.capabilities.capabilities == nil)
        let resent = model.apply(.running)
        #expect(resent == [approve])
        // A restarted core's capability revisions start over.
        _ = model.apply(.capabilities(try TestFrames.capabilities(revision: 0, offers: [TestFrames.offer()])))
        #expect(model.capabilities.offers.count == 1)
    }

    @Test func failedCommandsAreProblemsAndRetryKeepsTheId() throws {
        var model = try onSite()
        loaded(&model, key)
        let approveSent = model.approve(key)
        let approve = try #require(approveSent)
        _ = model.apply(.ack(.failed(commandId: approve.commandId!, code: .storeError, revision: nil)))
        guard case let .command(record)? = model.problems.first else { Issue.record("no problem"); return }
        #expect(record.state == .failed(.storeError))
        #expect(model.retry(approve.commandId!) == approve)
        #expect(model.problems.isEmpty)
        // After a failure the user may decide again, under a new ID.
        _ = model.apply(.ack(.failed(commandId: approve.commandId!, code: .staleRevision, revision: 3)))
        let againSent = model.approve(key)
        let again = try #require(againSent)
        #expect(again.commandId != approve.commandId)
    }

    @Test func libraryReapprovalAndUnpermittedPendingVersions() throws {
        var model = PanelModel(commands: CommandTracker(prefix: "t"))
        _ = model.apply(.running)
        let other = "https://other.example.org"
        _ = model.apply(.capabilities(try TestFrames.capabilities(
            library: [
                TestFrames.entry(state: "blocked", defaultVersion: nil, versions: [(F.v1, "revoked")], revision: 7),
                TestFrames.entry(rid: F.rid2, origin: other, state: "no_default", defaultVersion: nil,
                                 versions: [(F.v2, "pending")], revision: 2),
            ],
            origins: [TestFrames.origin(other, permitted: false)])))
        // Re-approving a revoked resource is gated on a complete preview like an offer.
        #expect(!model.canApprove(key))
        loaded(&model, key)
        guard case let .panel(_, request)? = model.approve(key) else { Issue.record("no approve"); return }
        #expect(request == .approve(resourceId: F.rid, version: F.v1, expectedRevision: 7))
        // A pending version for a site Chrome does not grant cannot be approved.
        let pending = PreviewKey(resourceId: F.rid2, version: F.v2)
        loaded(&model, pending)
        #expect(model.approveBlocker(pending) == ApprovalBlocker.siteNotPermitted.reason)
        // Revoke uses the entry's revision and runs once at a time.
        #expect(!model.canRevoke(F.rid))  // already blocked
        guard case let .panel(_, revoke)? = model.revoke(F.rid2) else { Issue.record("no revoke"); return }
        #expect(revoke == .revoke(resourceId: F.rid2, expectedRevision: 2))
        #expect(model.revoke(F.rid2) == nil)
    }

    @Test func settingsCommands() throws {
        var model = try onSite()
        #expect(model.setAutoAcquire(origin: F.origin, enabled: true, acknowledgeRisk: false) == nil)
        guard case let .panel(id, on)? = model.setAutoAcquire(origin: F.origin, enabled: true, acknowledgeRisk: true) else {
            Issue.record("no command"); return
        }
        #expect(on == .setAutoAcquire(origin: F.origin, enabled: true, acknowledgeRisk: true, expectedEnabled: false))
        #expect(model.setAutoAcquire(origin: F.origin, enabled: false, acknowledgeRisk: false) == nil)  // pending
        _ = model.apply(.ack(.ok(commandId: id, revision: 0, approvalRevision: 0)))
        _ = model.apply(.capabilities(try TestFrames.capabilities(revision: 2, origins: [TestFrames.origin(autoAcquire: true)])))
        guard case let .panel(_, off)? = model.setAutoAcquire(origin: F.origin, enabled: false, acknowledgeRisk: true) else {
            Issue.record("no command"); return
        }
        #expect(off == .setAutoAcquire(origin: F.origin, enabled: false, acknowledgeRisk: false, expectedEnabled: true))
        // No origin setting in the frame: nothing to compare against, so no command.
        #expect(model.setAutoAcquire(origin: "https://unknown.example", enabled: true, acknowledgeRisk: true) == nil)

        // The grant toggles from what the latest frame shows and renders what the core reports.
        #expect(model.setAgentBrowserContext(true) == nil)  // no grant frame yet
        _ = model.apply(.grant(agentBrowserContext: false))
        let grantSent = model.setAgentBrowserContext(true)
        let grant = try #require(grantSent)
        guard case let .panel(_, grantRequest) = grant else { Issue.record("not a panel command"); return }
        #expect(grantRequest == .setAgentBrowserContext(enabled: true, expectedEnabled: false))
        #expect(model.setAgentBrowserContext(true) == nil)  // pending
        // Enabling it read back off: the core acks invalid and the frame keeps it off.
        _ = model.apply(.ack(.failed(commandId: grant.commandId!, code: .invalid, revision: nil)))
        _ = model.apply(.grant(agentBrowserContext: false))
        #expect(model.capabilities.agentBrowserContext == false)
        #expect(model.grantRecord?.state == .failed(.invalid))
        #expect(model.retry(grant.commandId!) == nil)  // not a passing failure: toggle again instead
        #expect(model.setAgentBrowserContext(true) != nil)

        #expect(model.pauseCommand() == .pause)
        _ = model.apply(.state(status: .paused, visitEpoch: nil, detail: nil))
        #expect(model.pauseCommand() == .resume)
        #expect(model.refreshCapabilities() != nil)
    }

    @Test func staleCapabilitiesFrameIsDropped() throws {
        var model = try onSite()
        _ = model.apply(.capabilities(try TestFrames.capabilities(revision: 5, offers: [])))
        _ = model.apply(.capabilities(try TestFrames.capabilities(revision: 4, offers: [TestFrames.offer()])))
        #expect(model.capabilities.offers.isEmpty)
    }

    @Test func conflictsAndSidecarAreProblems() throws {
        var model = PanelModel()
        _ = model.apply(.running)
        _ = model.apply(.capabilities(try TestFrames.capabilities(conflicts: [
            ["name": "scout-skill-0123456789abcdef", "resourceId": F.rid, "code": "foreign_collision"]])))
        guard case let .conflict(c)? = model.problems.first else { Issue.record("no conflict"); return }
        #expect(c.code == .foreignCollision)
        _ = model.apply(.stopped)
        guard case let .sidecar(text)? = model.problems.first else { Issue.record("no sidecar problem"); return }
        #expect(text.hasPrefix("Scout core kept exiting"))
    }

    @Test func aNewCoreInstanceRestartsRevisionsAndResendsPendingCommands() throws {
        var model = try onSite()
        _ = model.apply(.capabilities(try TestFrames.capabilities(revision: 9, offers: [TestFrames.offer()], origins: [TestFrames.origin()])))
        loaded(&model, key)
        let approveSent = model.approve(key)
        let approve = try #require(approveSent)
        model.markSent(approve, written: true)
        // Same instance, lower revision: stale.
        _ = model.apply(.capabilities(try TestFrames.capabilities(revision: 3, offers: [])))
        #expect(model.capabilities.offers.count == 1)
        // Another instance: accepted at any revision, and the pending approval goes again under its ID.
        let resent = model.apply(.capabilities(try TestFrames.capabilities(instance: "core-2", revision: 0, offers: [TestFrames.offer()])))
        #expect(resent == [approve])
        #expect(model.capabilities.capabilities?.coreInstanceId == "core-2")
    }

    @Test func approveIsBoundToTheShownPreview() throws {
        var model = try onSite(offers: [TestFrames.offer(), TestFrames.offer(rid: F.rid2, version: F.v2)])
        let other = PreviewKey(resourceId: F.rid2, version: F.v2)
        loaded(&model, key)
        loaded(&model, other)
        // Both are complete, but only the shown one can be approved.
        #expect(model.preview(key)?.isComplete == true && model.shownPreview == other)
        #expect(model.approveBlocker(key) == "Open this version in Preview to approve it.")
        #expect(model.approve(key) == nil)
        // The offers list reordering changes nothing about which version Approve names.
        _ = model.apply(.capabilities(try TestFrames.capabilities(
            revision: 2, offers: [TestFrames.offer(rid: F.rid2, version: F.v2), TestFrames.offer()], origins: [TestFrames.origin()])))
        guard case let .panel(_, request)? = model.approve(other) else { Issue.record("no approve"); return }
        #expect(request == .approve(resourceId: F.rid2, version: F.v2, expectedRevision: 1))
        // Decline stays available from the list for any offer.
        #expect(model.canDecline(key))
    }

    @Test func pendingVersionOnAnUnlistedOriginIsNotApprovable() throws {
        var model = PanelModel(commands: CommandTracker(prefix: "t"))
        _ = model.apply(.running)
        _ = model.apply(.capabilities(try TestFrames.capabilities(library: [
            TestFrames.entry(origin: "https://unlisted.example.net", state: "no_default", defaultVersion: nil,
                             versions: [(F.v1, "pending")], revision: 2)])))
        loaded(&model, key)
        #expect(model.preview(key)?.isComplete == true)
        #expect(model.approveBlocker(key) == ApprovalBlocker.siteNotPermitted.reason)
        #expect(model.approve(key) == nil)
    }

    @Test func restartSettlesPendingTogglesWithoutResendingOrFailingThem() throws {
        var model = try onSite()
        _ = model.apply(.grant(agentBrowserContext: false))
        let grantSent = model.setAgentBrowserContext(true)
        let grant = try #require(grantSent)
        let autoSent = model.setAutoAcquire(origin: F.origin, enabled: true, acknowledgeRisk: true)
        let auto = try #require(autoSent)
        model.markSent(grant, written: true)
        model.markSent(auto, written: false)
        // A new core instance answers: nothing is re-sent and nothing becomes a problem.
        let resent = model.apply(.capabilities(try TestFrames.capabilities(instance: "core-2", revision: 0, origins: [TestFrames.origin()])))
        #expect(resent.isEmpty)
        #expect(model.grantRecord?.state == .unknown && model.autoAcquireRecord(F.origin)?.state == .unknown)
        #expect(model.commands.unsent.isEmpty && model.problems.isEmpty)
        // The window shows what the new core reports, and the user can toggle again.
        _ = model.apply(.grant(agentBrowserContext: false))
        #expect(model.setAgentBrowserContext(true) != nil)
        #expect(model.setAutoAcquire(origin: F.origin, enabled: true, acknowledgeRisk: true) != nil)
    }

    @Test func staleToggleWhoseTargetTheFrameShowsIsSettled() throws {
        var model = try onSite()
        _ = model.apply(.grant(agentBrowserContext: false))
        let autoSent = model.setAutoAcquire(origin: F.origin, enabled: true, acknowledgeRisk: true)
        let auto = try #require(autoSent)
        let grantSent = model.setAgentBrowserContext(true)
        let grant = try #require(grantSent)
        // Someone else turned both on first; the frames already show it.
        _ = model.apply(.capabilities(try TestFrames.capabilities(revision: 2, origins: [TestFrames.origin(autoAcquire: true)])))
        _ = model.apply(.grant(agentBrowserContext: true))
        _ = model.apply(.ack(.failed(commandId: auto.commandId!, code: .staleRevision, revision: nil)))
        _ = model.apply(.ack(.failed(commandId: grant.commandId!, code: .staleRevision, revision: nil)))
        #expect(model.autoAcquireRecord(F.origin)?.state == .ok && model.grantRecord?.state == .ok)
        #expect(model.problems.isEmpty)

        // A stale refusal whose target the frame does not show stays a problem, without Retry.
        let offSent = model.setAgentBrowserContext(false)
        let off = try #require(offSent)
        _ = model.apply(.ack(.failed(commandId: off.commandId!, code: .staleRevision, revision: nil)))
        #expect(model.grantRecord?.state == .failed(.staleRevision))
        #expect(model.problems == [.command(try #require(model.grantRecord))])
        #expect(model.retry(off.commandId!) == nil)
        // A later frame that shows the target settles it.
        _ = model.apply(.grant(agentBrowserContext: false))
        #expect(model.grantRecord?.state == .ok && model.problems.isEmpty)
    }

    @Test func dismissRemovesAFailedCommandFromProblems() throws {
        var model = try onSite()
        loaded(&model, key)
        let approveSent = model.approve(key)
        let approve = try #require(approveSent)
        let refreshSent = model.refreshCapabilities()
        let refresh = try #require(refreshSent)
        _ = model.apply(.ack(.failed(commandId: approve.commandId!, code: .storeError, revision: nil)))
        _ = model.apply(.ack(.failed(commandId: refresh.commandId!, code: .unavailable, revision: nil)))
        #expect(model.problems.count == 2)
        model.dismiss(approve.commandId!)
        guard case let .command(left)? = model.problems.first, model.problems.count == 1 else {
            Issue.record("expected one problem"); return
        }
        #expect(left.id == refresh.commandId)
        // Dismissing a pending or unknown command does nothing.
        let pendingSent = model.refreshCapabilities()
        let pending = try #require(pendingSent)
        model.dismiss(pending.commandId!)
        _ = model.apply(.ack(.failed(commandId: pending.commandId!, code: .unavailable, revision: nil)))
        #expect(model.problems.count == 2)
        // A retried command that fails again is listed again.
        #expect(model.retry(approve.commandId!) == approve)
        _ = model.apply(.ack(.failed(commandId: approve.commandId!, code: .storeError, revision: nil)))
        #expect(model.problems.count == 3)
    }

    @Test func approveOfAnUnknownVersionIsAProblemWithoutRetry() throws {
        var model = try onSite()
        loaded(&model, key)
        let approveSent = model.approve(key)
        let approve = try #require(approveSent)
        _ = model.apply(.ack(.failed(commandId: approve.commandId!, code: .notFound, revision: 1)))
        guard case let .command(record)? = model.problems.first else { Issue.record("no problem"); return }
        #expect(record.state == .failed(.notFound))
        #expect(model.retry(approve.commandId!) == nil)
    }
}

