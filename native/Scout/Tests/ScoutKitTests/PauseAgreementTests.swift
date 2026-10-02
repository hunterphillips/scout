import Testing
@testable import ScoutKit

/// The window's Settings button and the menu-bar item render the same `PanelModel.pauseControl`,
/// and the Chrome side panel changes pause only through the core; all three follow the core's
/// `state` frame (P4.2).
@Suite struct PauseAgreementTests {
    private func running() throws -> PanelModel {
        var model = PanelModel()
        _ = model.apply(.running)
        _ = model.apply(.capabilities(try TestFrames.capabilities(instance: "core-1")))
        _ = model.apply(.state(status: .idle, visitEpoch: 1, detail: "docs.example.com"))
        return model
    }

    private func menu(_ model: PanelModel) -> StatusMenuModel {
        StatusMenuModel(sidecar: model.sidecar, pause: model.pauseControl, windowVisible: true)
    }

    @Test func coreSaysPausedSoBothShowResume() throws {
        var model = try running()
        // Paused by the side panel: the app sent nothing.
        _ = model.apply(.state(status: .paused, visitEpoch: nil, detail: nil))
        #expect(model.pauseControl.title == "Resume" && model.pauseControl.enabled)
        #expect(menu(model).pause == .init("Resume", enabled: true))
        _ = model.apply(.state(status: .idle, visitEpoch: 1, detail: nil))
        #expect(model.pauseControl.title == "Pause" && menu(model).pause == .init("Pause", enabled: true))
    }

    @Test func aPendingRequestDisablesBothUntilTheFrame() throws {
        var model = try running()
        #expect(model.requestPauseOrResume() == .pause)
        model.pauseSent(.written)
        #expect(model.pauseControl == PauseControl(title: "Pausing…", enabled: false, accessibilityLabel: "Pausing Scout"))
        #expect(menu(model).pause == .init("Pausing…", enabled: false))
        #expect(model.requestPauseOrResume() == nil)  // a second click from the other place sends nothing
        _ = model.apply(.state(status: .paused, visitEpoch: nil, detail: nil))
        #expect(menu(model).pause == .init("Resume", enabled: true))

        #expect(model.requestPauseOrResume() == .resume)
        model.pauseSent(.written)
        #expect(menu(model).pause == .init("Resuming…", enabled: false))
        _ = model.apply(.state(status: .idle, visitEpoch: 2, detail: nil))
        #expect(model.pauseControl.title == "Pause" && model.pauseControl.enabled)
    }

    @Test func aRestartedSidecarFollowsTheNewCoreAndNeverResendsPause() throws {
        var model = try running()
        _ = model.requestPauseOrResume()
        model.pauseSent(.written)
        #expect(model.apply(.starting).isEmpty)
        #expect(menu(model).pause == .init("Pause", enabled: false))
        let resent = model.apply(.running)
        #expect(!resent.contains(.pause) && !resent.contains(.resume))
        _ = model.apply(.state(status: .idle, visitEpoch: 1, detail: nil))
        #expect(menu(model).pause == .init("Pause", enabled: true))
    }

    @Test func aNewCoreInstanceFollowsItsOwnState() throws {
        var model = try running()
        _ = model.apply(.state(status: .paused, visitEpoch: nil, detail: nil))
        #expect(model.requestPauseOrResume() == .resume)
        model.pauseSent(.written)
        // Another core answers without the app seeing a restart; it reports itself paused.
        _ = model.apply(.state(status: .paused, visitEpoch: nil, detail: nil))
        let resent = model.apply(.capabilities(try TestFrames.capabilities(instance: "core-2")))
        #expect(!resent.contains(.pause) && !resent.contains(.resume))
        #expect(model.pauseControl.title == "Resume" && model.pauseControl.enabled)
        #expect(menu(model).pause == .init("Resume", enabled: true))
    }

    @Test func pauseCommandStillNamesWhatAClickSends() throws {
        var model = try running()
        #expect(model.pauseCommand() == .pause)
        _ = model.requestPauseOrResume()
        model.pauseSent(.written)
        #expect(model.pauseCommand() == .pause)  // unchanged until the frame
        _ = model.apply(.state(status: .paused, visitEpoch: nil, detail: nil))
        #expect(model.pauseCommand() == .resume)
    }
}
