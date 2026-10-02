import Testing
@testable import ScoutKit

@Suite struct StatusMenuModelTests {
    private func model(_ sidecar: SidecarStatus, core: CoreStatus? = nil) -> PanelModel {
        var model = PanelModel()
        _ = model.apply(sidecar)
        if let core { _ = model.apply(.state(status: core, visitEpoch: nil, detail: nil)) }
        return model
    }

    @Test func statusLineNamesTheSidecarState() {
        let cases: [(SidecarStatus, String)] = [
            (.starting, "Scout: starting"), (.running, "Scout: running"), (.stopped, "Scout: stopped"),
            (.setupNeeded("nodePath is missing"), "Scout: setup needed"),
        ]
        for (sidecar, title) in cases {
            let menu = StatusMenuModel(model(sidecar), windowVisible: false)
            #expect(menu.status == .init(title, enabled: false))
        }
    }

    @Test func pauseItemIsThePanelModelsPauseControl() {
        var running = model(.running, core: .idle)
        for core in [CoreStatus.idle, .working, .paused, .disconnected] {
            _ = running.apply(.state(status: core, visitEpoch: nil, detail: nil))
            let menu = StatusMenuModel(running, windowVisible: false)
            #expect(menu.pause == .init(running.pauseControl.title, enabled: running.pauseControl.enabled))
            #expect(menu.pauseAccessibilityLabel == running.pauseControl.accessibilityLabel)
        }
        _ = running.apply(.state(status: .idle, visitEpoch: nil, detail: nil))
        _ = running.requestPauseOrResume()
        running.pauseSent(.written)
        #expect(StatusMenuModel(running, windowVisible: false).pause == .init("Pausing…", enabled: false))
    }

    @Test func windowItemShowsOrHides() {
        let running = model(.running)
        #expect(StatusMenuModel(running, windowVisible: false).window == .init("Show window", enabled: true))
        #expect(StatusMenuModel(running, windowVisible: true).window == .init("Hide window", enabled: true))
    }

    @Test func quitIsAlwaysAvailableAndQuittingShowsInTheStatusLine() {
        var running = model(.running, core: .idle)
        #expect(StatusMenuModel(running, windowVisible: false).quit == .init("Quit Scout", enabled: true))
        running.beginQuit()
        let quitting = StatusMenuModel(running, windowVisible: true)
        #expect(quitting.status == .init("Scout: quitting…", enabled: false))
        #expect(quitting.pause == .init("Pause", enabled: false))
        // A second Quit is TerminationPolicy's to answer (it waits, never cancels).
        #expect(quitting.quit == .init("Quit Scout", enabled: true))
    }

    @Test func menuFollowsThePanelModel() {
        var model = PanelModel()
        var menu = StatusMenuModel(model, windowVisible: false)
        #expect(menu.status.title == "Scout: starting" && menu.pause == .init("Pause", enabled: false))
        _ = model.apply(.running)
        _ = model.apply(.state(status: .paused, visitEpoch: nil, detail: nil))
        menu = StatusMenuModel(model, windowVisible: false)
        #expect(menu.status.title == "Scout: running" && menu.pause == .init("Resume", enabled: true))
        _ = model.apply(.stopped)
        menu = StatusMenuModel(model, windowVisible: false)
        #expect(menu.status.title == "Scout: stopped" && menu.pause == .init("Pause", enabled: false))
    }

    @Test func windowShowsAtLaunchOnlyWithScoutWindowOne() {
        #expect(WindowLaunch.showsWindowAtLaunch(environment: ["SCOUT_WINDOW": "1"]))
        #expect(!WindowLaunch.showsWindowAtLaunch(environment: [:]))
        #expect(!WindowLaunch.showsWindowAtLaunch(environment: ["SCOUT_WINDOW": "0"]))
        #expect(!WindowLaunch.showsWindowAtLaunch(environment: ["SCOUT_WINDOW": "true"]))
    }
}
