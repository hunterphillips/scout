import Testing
@testable import ScoutKit

/// The menu bar's Pause/Resume and the Chrome side panel's agree because both follow the core's
/// `state` frame: the side panel changes pause only through the core.
@Suite struct PauseAgreementTests {
    private func running() -> MenuModel {
        var model = MenuModel()
        model.apply(.running)
        model.apply(.state(StateFrame(status: .idle, visitEpoch: 1, detail: "docs.example.com")))
        return model
    }

    private func menu(_ model: MenuModel) -> StatusMenuModel.Item {
        StatusMenuModel(model).pause
    }

    @Test func theSidePanelPausedSoTheMenuShowsResume() {
        var model = running()
        // Paused from the side panel: the app sent nothing.
        model.apply(.state(StateFrame(status: .paused)))
        #expect(menu(model) == .init("Resume", enabled: true))
        model.apply(.state(StateFrame(status: .idle, visitEpoch: 1)))
        #expect(menu(model) == .init("Pause", enabled: true))
    }

    @Test func aPendingRequestDisablesTheMenuUntilTheFrame() {
        var model = running()
        #expect(model.requestPauseOrResume() == .pause)
        model.pauseSent(.written)
        #expect(menu(model) == .init("Pausing…", enabled: false))
        #expect(model.requestPauseOrResume() == nil)
        model.apply(.state(StateFrame(status: .paused)))
        #expect(menu(model) == .init("Resume", enabled: true))

        #expect(model.requestPauseOrResume() == .resume)
        model.pauseSent(.written)
        #expect(menu(model) == .init("Resuming…", enabled: false))
        // Resumed from the side panel first: the same frame settles the menu's request.
        model.apply(.state(StateFrame(status: .idle, visitEpoch: 2)))
        #expect(menu(model) == .init("Pause", enabled: true))
    }

    @Test func aRefusedWriteLeavesTheMenuEnabled() {
        var model = running()
        #expect(model.requestPauseOrResume() == .pause)
        model.pauseSent(.retryLater)
        #expect(menu(model) == .init("Pause", enabled: true))
        #expect(model.requestPauseOrResume() == .pause)  // the user clicks again
    }

    @Test func quittingDisablesTheMenuAndAClickDoesNothing() {
        for core in [CoreStatus.idle, .paused] {
            var model = running()
            model.apply(.state(StateFrame(status: core)))
            let title = menu(model).title
            model.beginQuit()
            #expect(menu(model) == .init(title, enabled: false))
            #expect(model.requestPauseOrResume() == nil)
            // Frames keep arriving while the core stops; the control stays disabled.
            model.apply(.state(StateFrame(status: .idle)))
            #expect(!menu(model).enabled)
        }
    }
}
