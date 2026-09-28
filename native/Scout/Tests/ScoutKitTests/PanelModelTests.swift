import Foundation
import Testing
@testable import ScoutKit

@Suite struct PanelModelTests {
    @Test func sidecarStatusesRenderAsText() {
        var model = PanelModel()
        #expect(model.text == "Starting…")
        model.apply(.setupNeeded("nodePath is missing"))
        #expect(model.text.hasPrefix("Setup needed\nnodePath is missing"))
        model.apply(.stopped)
        #expect(model.text.hasPrefix("Stopped"))
        #expect(model.text.contains("after \(RestartPolicy.defaultMaxRestarts) restarts in a minute"))
    }

    @Test func describesRestartWindows() {
        #expect(PanelModel.describe(60) == "a minute")
        #expect(PanelModel.describe(120) == "2 minutes")
        #expect(PanelModel.describe(90) == "90 seconds")
    }

    @Test func runningShowsCoreStatusAndResults() {
        var model = PanelModel()
        model.apply(.running)
        model.apply(.state(status: .working, visitEpoch: 1, detail: "ranking"))
        #expect(model.text == "Working\nranking")
        model.apply(.results(visitEpoch: 1, outcome: .ok([
            ResultItem(candidateId: "c1", title: "Webhooks", href: "https://a", reason: "r"),
            ResultItem(candidateId: "c2", title: "Testing", href: "https://b", reason: "r"),
        ])))
        model.apply(.state(status: .idle, visitEpoch: 1, detail: nil))
        #expect(model.text == "Idle\n\n• Webhooks\n• Testing")
        model.apply(.results(visitEpoch: 2, outcome: .unavailable("service down")))
        #expect(model.text == "Idle\n\nResults unavailable: service down")
    }

    @Test func idleVisitShowsTheHostnameAndLeavingClearsIt() throws {
        var model = PanelModel()
        model.apply(.running)
        let line = #"{"type":"state","status":"idle","visitEpoch":2,"detail":"docs.stripe.com"}"# + "\n"
        var parser = JSONLParser()
        let states = parser.append(Data(line.utf8))
        try #require(states.count == 1)
        model.apply(states[0])
        #expect(model.text == "Idle\ndocs.stripe.com")
        model.apply(.state(status: .idle, visitEpoch: 3, detail: nil))
        #expect(model.text == "Idle")
    }

    @Test func restartClearsCoreState() {
        var model = PanelModel()
        model.apply(.running)
        model.apply(.state(status: .paused, visitEpoch: nil, detail: nil))
        model.apply(.results(visitEpoch: 1, outcome: .empty))
        model.apply(.starting)
        model.apply(.running)
        #expect(model.text == "Connected")
    }
}
