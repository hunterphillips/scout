import Foundation
import Testing
@testable import ScoutKit

@Suite struct CommandTrackerTests {
    typealias F = ContractFixtures
    let approve = PanelRequest.approve(resourceId: F.rid, version: F.v1, expectedRevision: 1)

    @Test func issuesDistinctWellFormedIds() {
        var t = CommandTracker(prefix: "run1")
        let a = t.issue(approve), b = t.issue(.refreshCapabilities)
        #expect(a.commandId == "run1-1" && b.commandId == "run1-2")
        #expect(WireFormat.isToken(CommandTracker.randomPrefix() + "-999999"))
        #expect(t.record("run1-1")?.state == .pending)
    }

    @Test func acksMapToStates() {
        var t = CommandTracker(prefix: "p")
        let a = t.issue(approve), b = t.issue(.revoke(resourceId: F.rid, expectedRevision: 2))
        t.apply(.ok(commandId: a.commandId!, revision: 2, approvalRevision: 3))
        t.apply(.failed(commandId: b.commandId!, code: .staleRevision, revision: 4))
        #expect(t.record(a.commandId!)?.state == .ok)
        #expect(t.record(b.commandId!)?.state == .failed(.staleRevision))
        // Repeated identical acks and unknown IDs change nothing.
        t.apply(.ok(commandId: a.commandId!, revision: 2, approvalRevision: 3))
        #expect(t.apply(.ok(commandId: "nope", revision: 0, approvalRevision: 0)) == nil)
        #expect(t.record(a.commandId!)?.state == .ok && t.records.count == 2)
    }

    @Test func everyFailureCodeIsKept() {
        var t = CommandTracker(prefix: "p")
        for code in AckFailureCode.allCases {
            let c = t.issue(.refreshCapabilities)
            t.apply(.failed(commandId: c.commandId!, code: code, revision: nil))
            #expect(t.record(c.commandId!)?.state == .failed(code))
        }
    }

    @Test func droppedWriteIsResentWithTheSameId() {
        var t = CommandTracker(prefix: "p")
        let c = t.issue(approve)
        t.markSent(c.commandId!, written: false)
        #expect(t.unsent == [c])
        t.markSent(c.commandId!, written: true)
        #expect(t.unsent.isEmpty)
        #expect(t.record(c.commandId!)?.state == .pending)
    }

    @Test func restartResendsPendingMutationsWithSameIdsAndFailsPreviews() {
        var t = CommandTracker(prefix: "p")
        let a = t.issue(approve)
        let done = t.issue(.refreshCapabilities)
        let p = t.issue(.preview(resourceId: F.rid, version: F.v1, cursor: "c1"))
        for c in [a, done, p] { t.markSent(c.commandId!, written: true) }
        t.apply(.ok(commandId: done.commandId!, revision: 0, approvalRevision: 1))
        let resend = t.coreRestarted()
        #expect(resend == [a])
        #expect(t.record(p.commandId!)?.state == .failed(.unavailable))
        #expect(t.records.count == 3)
        // An ack for the re-sent command settles the original record.
        t.apply(.ok(commandId: a.commandId!, revision: 2, approvalRevision: 2))
        #expect(t.record(a.commandId!)?.state == .ok)
    }

    @Test func restartNeverResendsTogglesAndSettlesThemAsUnknown() {
        var t = CommandTracker(prefix: "p")
        let auto = t.issue(.setAutoAcquire(origin: F.origin, enabled: true, acknowledgeRisk: true, expectedEnabled: false))
        let grant = t.issue(.setAgentBrowserContext(enabled: true, expectedEnabled: false))
        let refresh = t.issue(.refreshCapabilities)
        let revoke = t.issue(.revoke(resourceId: F.rid, expectedRevision: 2))
        t.markSent(auto.commandId!, written: true)
        t.markSent(grant.commandId!, written: false)  // refused write: still unsent
        // Within one instance, a refused toggle write goes again under its ID.
        #expect(t.unsent.contains(grant))
        #expect(t.coreRestarted() == [revoke])
        for c in [auto, grant, refresh] {
            #expect(t.record(c.commandId!)?.state == .unknown)
        }
        // Settled, so the resend timer leaves them alone.
        #expect(t.unsent == [revoke])
    }

    @Test func togglesAreNeverRetried() {
        var t = CommandTracker(prefix: "p")
        let grant = t.issue(.setAgentBrowserContext(enabled: true, expectedEnabled: false))
        t.apply(.failed(commandId: grant.commandId!, code: .unavailable, revision: nil))
        #expect(t.retry(grant.commandId!) == nil)
        let auto = t.issue(.setAutoAcquire(origin: F.origin, enabled: false, acknowledgeRisk: false, expectedEnabled: true))
        t.markSent(auto.commandId!, written: false)
        #expect(t.retry(auto.commandId!) == nil)
        #expect(t.record(grant.commandId!)?.state == .failed(.unavailable))
    }

    @Test func retryReusesTheIdForFailedMutationsOnly() {
        var t = CommandTracker(prefix: "p")
        let a = t.issue(approve)
        t.markSent(a.commandId!, written: true)
        #expect(t.retry(a.commandId!) == nil)  // pending and sent
        t.apply(.failed(commandId: a.commandId!, code: .storeError, revision: nil))
        #expect(t.retry(a.commandId!) == a)
        #expect(t.record(a.commandId!)?.state == .pending)
        #expect(t.records.count == 1)
        let p = t.issue(.preview(resourceId: F.rid, version: F.v1, cursor: nil))
        t.apply(.failed(commandId: p.commandId!, code: .notFound, revision: nil))
        #expect(t.retry(p.commandId!) == nil)
    }

    @Test func boundedToTheLast64PreferringSettled() {
        var t = CommandTracker(prefix: "p")
        let first = t.issue(approve)  // stays pending
        for _ in 0..<100 {
            let c = t.issue(.refreshCapabilities)
            t.apply(.ok(commandId: c.commandId!, revision: 0, approvalRevision: 0))
        }
        #expect(t.records.count == CommandTracker.capacity)
        #expect(t.record(first.commandId!)?.state == .pending)
        #expect(t.records.last?.id == "p-101")
    }

    @Test func previewChunkSettlesItsCommand() {
        var t = CommandTracker(prefix: "p")
        let p = t.issue(.preview(resourceId: F.rid, version: F.v1, cursor: nil))
        t.chunkArrived(for: p.commandId!)
        #expect(t.record(p.commandId!)?.state == .ok)
    }

    @Test func aChunkNamingANonPreviewCommandSettlesNothing() {
        var t = CommandTracker(prefix: "p")
        let a = t.issue(approve)
        let r = t.issue(.refreshCapabilities)
        t.apply(.failed(commandId: r.commandId!, code: .unavailable, revision: nil))
        t.chunkArrived(for: a.commandId!)
        t.chunkArrived(for: r.commandId!)
        #expect(t.record(a.commandId!)?.state == .pending && t.record(a.commandId!)?.sent == false)
        #expect(t.record(r.commandId!)?.state == .failed(.unavailable))
    }

    @Test func supersededPreviewIsSettledAndNeverResent() {
        var t = CommandTracker(prefix: "p")
        let p = t.issue(.preview(resourceId: F.rid, version: F.v1, cursor: nil))
        t.markSent(p.commandId!, written: false)
        #expect(t.unsent == [p])
        t.supersede(p.commandId!)
        #expect(t.record(p.commandId!)?.state == .superseded)
        #expect(t.unsent.isEmpty && t.coreRestarted().isEmpty && !t.canRetry(p.commandId!))
        // A late chunk for it changes nothing, and only previews are superseded.
        t.chunkArrived(for: p.commandId!)
        #expect(t.record(p.commandId!)?.state == .superseded)
        let a = t.issue(approve)
        t.supersede(a.commandId!)
        #expect(t.record(a.commandId!)?.state == .pending)
    }

    @Test func oversizeWriteFailsAsInvalidAndIsNeverResent() {
        var t = CommandTracker(prefix: "p")
        let a = t.issue(approve)
        t.markSent(a.commandId!, .oversize)
        #expect(t.record(a.commandId!)?.state == .failed(.invalid))
        #expect(t.unsent.isEmpty && !t.canRetry(a.commandId!) && t.retry(a.commandId!) == nil)
        #expect(t.coreRestarted().isEmpty)
        // A write refused for now stays pending and goes again.
        let b = t.issue(approve)
        t.markSent(b.commandId!, .retryLater)
        #expect(t.unsent == [b] && t.canRetry(b.commandId!))
        t.markSent(b.commandId!, .written)
        #expect(t.unsent.isEmpty && !t.canRetry(b.commandId!))
    }

    @Test func canRetryMatchesRetry() {
        var t = CommandTracker(prefix: "p")
        let a = t.issue(approve)
        let grant = t.issue(.setAgentBrowserContext(enabled: true, expectedEnabled: false))
        let p = t.issue(.preview(resourceId: F.rid, version: F.v1, cursor: nil))
        t.apply(.failed(commandId: a.commandId!, code: .storeError, revision: nil))
        t.apply(.failed(commandId: grant.commandId!, code: .unavailable, revision: nil))
        t.apply(.failed(commandId: p.commandId!, code: .unavailable, revision: nil))
        #expect(t.canRetry(a.commandId!) && !t.canRetry(grant.commandId!) && !t.canRetry(p.commandId!))
        #expect(!t.canRetry("nope"))
        #expect(t.retry(a.commandId!) == a)
        t.apply(.failed(commandId: a.commandId!, code: .notFound, revision: nil))
        #expect(!t.canRetry(a.commandId!) && t.retry(a.commandId!) == nil)
    }
}
