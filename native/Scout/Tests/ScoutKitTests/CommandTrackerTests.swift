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
}
