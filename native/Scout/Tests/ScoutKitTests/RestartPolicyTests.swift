import Foundation
import Testing
@testable import ScoutKit

@Suite struct RestartPolicyTests {
    /// Feeds exits at the given seconds and returns whether each restart was allowed.
    private func decisions(_ seconds: [Double]) -> [Bool] {
        var policy = RestartPolicy()
        let t0 = Date(timeIntervalSince1970: 1_000)
        return seconds.map { policy.recordRestart(at: t0 + $0) }
    }

    @Test func allowsThreeRestartsThenRefuses() {
        #expect(decisions([0, 1, 2, 3, 59]) == [true, true, true, false, false])
    }

    @Test func windowSlides() {
        // At 60 the first restart is 60 s old and falls out of the window.
        #expect(decisions([0, 30, 40, 59.9, 60, 61, 90])
            == [true, true, true, false, true, false, true])
    }

    @Test func refusalsDoNotCountAsRestarts() {
        let seconds = (0..<50).map(Double.init) + [60]
        let expected = Array(repeating: true, count: 3) + Array(repeating: false, count: 47) + [true]
        #expect(decisions(seconds) == expected)
    }
}
