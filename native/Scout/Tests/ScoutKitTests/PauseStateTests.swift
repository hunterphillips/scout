import Testing
@testable import ScoutKit

@Suite struct PauseStateTests {
    private static let pause = PauseControl(title: "Pause", enabled: true, accessibilityLabel: "Pause Scout")
    private static let resume = PauseControl(title: "Resume", enabled: true, accessibilityLabel: "Resume Scout")
    private static let pausing = PauseControl(title: "Pausing…", enabled: false, accessibilityLabel: "Pausing Scout")
    private static let resuming = PauseControl(title: "Resuming…", enabled: false, accessibilityLabel: "Resuming Scout")
    private static let off = PauseControl(title: "Pause", enabled: false, accessibilityLabel: "Pause Scout")

    @Test func followsTheCoresStateFrame() {
        var state = PauseState()
        #expect(state.control == Self.off && state.command == nil)
        state.apply(.idle)
        #expect(state.control == Self.pause && state.command == .pause)
        state.apply(.working)
        #expect(state.control == Self.pause)
        state.apply(.paused)
        #expect(state.control == Self.resume && state.command == .resume)
        state.apply(.disconnected)
        #expect(state.control == Self.off && state.command == nil)
    }

    @Test func aRequestIsPendingUntilAFrameShowsItsTarget() {
        var state = PauseState(core: .idle)
        #expect(state.request() == .pause)
        state.sent(.written)
        #expect(state.control == Self.pausing)
        #expect(state.request() == nil)  // one at a time
        // A frame the core emitted before it read the pause does not settle it.
        state.apply(.working)
        #expect(state.control == Self.pausing)
        state.apply(.paused)
        #expect(state.pending == nil && state.control == Self.resume)

        #expect(state.request() == .resume)
        state.sent(.written)
        #expect(state.control == Self.resuming)
        state.apply(.paused)
        #expect(state.control == Self.resuming)
        state.apply(.disconnected)  // resumed, browser not connected
        #expect(state.pending == nil && state.control == Self.off)
    }

    @Test func aChangeMadeElsewhereSettlesTheRequest() {
        // The side panel paused the core while the app's own pause was in flight.
        var state = PauseState(core: .working)
        _ = state.request()
        state.sent(.written)
        state.apply(.paused)
        #expect(state.pending == nil && state.control == Self.resume)
    }

    @Test func aRefusedWriteSettlesAtOnce() {
        for outcome in [SendOutcome.retryLater, .oversize] {
            var state = PauseState(core: .paused)
            #expect(state.request() == .resume)
            state.sent(outcome)
            #expect(state.pending == nil && state.control == Self.resume)
        }
    }

    @Test func aStoppedOrRestartedCoreSettlesWithoutResending() {
        var state = PauseState(core: .idle)
        _ = state.request()
        state.sent(.written)
        state.coreStopped()
        #expect(state.pending == nil && state.core == nil && state.control == Self.off)

        state.apply(.idle)
        _ = state.request()
        state.sent(.written)
        state.coreRestarted()
        // The new core's state frame decides; nothing is pending to re-send.
        #expect(state.pending == nil && state.control == Self.pause)
        state.apply(.paused)
        #expect(state.control == Self.resume)
    }

    @Test func quittingDisablesTheControlAndSendsNothing() {
        var state = PauseState(core: .paused)
        state.beginQuit()
        #expect(state.control == PauseControl(title: "Resume", enabled: false, accessibilityLabel: "Resume Scout"))
        #expect(state.request() == nil && state.pending == nil)
        state.apply(.idle)
        #expect(state.control == PauseControl(title: "Pause", enabled: false, accessibilityLabel: "Pause Scout"))
    }

    @Test func nothingToSendWithoutACore() {
        var state = PauseState()
        #expect(state.request() == nil && state.pending == nil)
        state.apply(.disconnected)
        #expect(state.request() == nil && state.pending == nil)
    }
}
