import Testing
@testable import ScoutKit

@Suite struct StatusMenuModelTests {
    private static let pause = PauseControl(title: "Pause", enabled: true, accessibilityLabel: "Pause Scout")

    @Test func statusLineNamesTheSidecarState() {
        let cases: [(SidecarStatus, String)] = [
            (.starting, "Scout: starting"), (.running, "Scout: running"), (.stopped, "Scout: stopped"),
            (.setupNeeded("nodePath is missing"), "Scout: setup needed"),
        ]
        for (sidecar, title) in cases {
            let menu = StatusMenuModel(sidecar: sidecar, pause: Self.pause, windowVisible: false)
            #expect(menu.status == .init(title, enabled: false))
        }
    }

    @Test func pauseItemIsThePauseControl() {
        for control in [
            Self.pause,
            PauseControl(title: "Resume", enabled: true, accessibilityLabel: "Resume Scout"),
            PauseControl(title: "Pausing…", enabled: false, accessibilityLabel: "Pausing Scout"),
        ] {
            let menu = StatusMenuModel(sidecar: .running, pause: control, windowVisible: false)
            #expect(menu.pause == .init(control.title, enabled: control.enabled))
            #expect(menu.pauseAccessibilityLabel == control.accessibilityLabel)
        }
    }

    @Test func windowItemShowsOrHides() {
        #expect(StatusMenuModel(sidecar: .running, pause: Self.pause, windowVisible: false).window == .init("Show window", enabled: true))
        #expect(StatusMenuModel(sidecar: .running, pause: Self.pause, windowVisible: true).window == .init("Hide window", enabled: true))
    }

    @Test func quitIsAlwaysAvailableAndQuittingDisablesPause() {
        let running = StatusMenuModel(sidecar: .running, pause: Self.pause, windowVisible: false)
        #expect(running.quit == .init("Quit Scout", enabled: true))
        let quitting = StatusMenuModel(sidecar: .running, pause: Self.pause, windowVisible: true, quitting: true)
        #expect(quitting.status == .init("Scout: quitting…", enabled: false))
        #expect(quitting.pause.enabled == false)
        // A second Quit is TerminationPolicy's to answer (it waits, never cancels).
        #expect(quitting.quit == .init("Quit Scout", enabled: true))
    }

    @Test func menuFollowsThePanelModel() {
        var model = PanelModel()
        var menu = StatusMenuModel(sidecar: model.sidecar, pause: model.pauseControl, windowVisible: false)
        #expect(menu.status.title == "Scout: starting" && menu.pause == .init("Pause", enabled: false))
        _ = model.apply(.running)
        _ = model.apply(.state(status: .paused, visitEpoch: nil, detail: nil))
        menu = StatusMenuModel(sidecar: model.sidecar, pause: model.pauseControl, windowVisible: false)
        #expect(menu.status.title == "Scout: running" && menu.pause == .init("Resume", enabled: true))
        _ = model.apply(.stopped)
        menu = StatusMenuModel(sidecar: model.sidecar, pause: model.pauseControl, windowVisible: false)
        #expect(menu.status.title == "Scout: stopped" && menu.pause == .init("Pause", enabled: false))
    }

    @Test func windowShowsAtLaunchOnlyWithScoutWindowOne() {
        #expect(WindowLaunch.showsWindowAtLaunch(environment: ["SCOUT_WINDOW": "1"]))
        #expect(!WindowLaunch.showsWindowAtLaunch(environment: [:]))
        #expect(!WindowLaunch.showsWindowAtLaunch(environment: ["SCOUT_WINDOW": "0"]))
        #expect(!WindowLaunch.showsWindowAtLaunch(environment: ["SCOUT_WINDOW": "true"]))
    }
}
