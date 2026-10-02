import Testing
@testable import ScoutKit

@Suite struct TerminationPolicyTests {
    @Test func firstQuitWithTheSidecarRunningBeginsItsShutdownAndWaits() {
        #expect(TerminationPolicy.decide(shutdownPending: false, sidecarRunning: true)
            == .init(reply: .later, beginShutdown: true))
    }

    @Test func aSecondQuitWhileOneIsPendingWaitsForThatReplyAndNeverCancels() {
        #expect(TerminationPolicy.decide(shutdownPending: true, sidecarRunning: true)
            == .init(reply: .later, beginShutdown: false))
    }

    @Test func withNoSidecarRunningTheAppQuitsAtOnce() {
        #expect(TerminationPolicy.decide(shutdownPending: false, sidecarRunning: false)
            == .init(reply: .now, beginShutdown: false))
        #expect(TerminationPolicy.decide(shutdownPending: true, sidecarRunning: false)
            == .init(reply: .now, beginShutdown: false))
    }
}
