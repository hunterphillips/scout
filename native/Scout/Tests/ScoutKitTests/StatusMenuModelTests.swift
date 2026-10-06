import Testing
@testable import ScoutKit

@Suite struct StatusMenuModelTests {
    private func model(_ sidecar: SidecarStatus, core: CoreStatus? = nil) -> MenuModel {
        var model = MenuModel()
        model.apply(sidecar)
        if let core { model.apply(.state(StateFrame(status: core))) }
        return model
    }

    @Test func statusItemIsTheModelsStatusLineAndOnlyReports() {
        for sidecar in [SidecarStatus.starting, .running, .stopped, .setupNeeded("nodePath is missing")] {
            let model = model(sidecar)
            #expect(StatusMenuModel(model).status == .init(model.statusLine, enabled: false))
        }
    }

    @Test func pauseItemIsTheModelsPauseControl() {
        var running = model(.running, core: .idle)
        for core in [CoreStatus.idle, .working, .paused, .disconnected] {
            running.apply(.state(StateFrame(status: core)))
            let menu = StatusMenuModel(running)
            #expect(menu.pause == .init(running.pauseControl.title, enabled: running.pauseControl.enabled))
            #expect(menu.pauseAccessibilityLabel == running.pauseControl.accessibilityLabel)
        }
    }

    @Test func quitIsAlwaysAvailable() {
        var running = model(.running, core: .idle)
        #expect(StatusMenuModel(running).quit == .init("Quit Scout", enabled: true))
        running.beginQuit()
        let quitting = StatusMenuModel(running)
        #expect(quitting.status == .init("Scout: quitting…", enabled: false))
        #expect(quitting.pause == .init("Pause", enabled: false))
        // A second Quit is TerminationPolicy's to answer (it waits, never cancels).
        #expect(quitting.quit == .init("Quit Scout", enabled: true))
    }
}
