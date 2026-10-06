import Testing
@testable import ScoutKit

@Suite struct MenuModelTests {
    private func model(_ sidecar: SidecarStatus, core: CoreStatus? = nil) -> MenuModel {
        var model = MenuModel()
        model.apply(sidecar)
        if let core { model.apply(.state(StateFrame(status: core))) }
        return model
    }

    @Test func statusLineForEachSidecarStatus() {
        #expect(MenuModel().statusLine == "Scout: starting…")
        #expect(model(.running).statusLine == "Scout: running")
        #expect(model(.setupNeeded("No config at /x. Run scripts/setup.mjs, then reopen Scout.")).statusLine
            == "Scout: setup needed. No config at /x. Run scripts/setup.mjs, then reopen Scout.")
        #expect(model(.stopped).statusLine == "Scout kept stopping (3 times in a minute). Quit and reopen Scout.")
    }

    @Test func statusLineNamesTheCoreStatusWhileRunning() {
        let cases: [(CoreStatus, String)] = [
            (.idle, "Scout: idle"), (.working, "Scout: working"), (.paused, "Scout: paused"),
            (.disconnected, "Scout: disconnected"),
        ]
        for (core, line) in cases {
            #expect(model(.running, core: core).statusLine == line)
        }
    }

    @Test func aStoppedSidecarForgetsTheCoreStatus() {
        var model = model(.running, core: .paused)
        model.apply(.starting)
        #expect(model.core == nil && model.statusLine == "Scout: starting…")
        model.apply(.running)
        #expect(model.statusLine == "Scout: running")
    }

    @Test func quittingShowsInTheStatusLineWhateverTheSidecarSays() {
        for sidecar in [SidecarStatus.starting, .running, .stopped, .setupNeeded("x")] {
            var model = model(sidecar, core: .idle)
            model.beginQuit()
            #expect(model.quitting && model.statusLine == "Scout: quitting…")
        }
    }

    @Test func aRestartClearsAPendingPauseWithoutResending() {
        var model = model(.running, core: .idle)
        #expect(model.requestPauseOrResume() == .pause)
        model.pauseSent(.written)
        #expect(model.pause.pending == .pausing)
        model.apply(.starting)
        #expect(model.pause.pending == nil)
        model.apply(.running)
        #expect(model.pause.pending == nil && !model.pauseControl.enabled)
        // The new core's own frame decides what shows.
        model.apply(.state(StateFrame(status: .paused)))
        #expect(model.pauseControl.title == "Resume" && model.pauseControl.enabled)
    }
}
