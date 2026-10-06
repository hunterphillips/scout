import Foundation
import Testing
@testable import ScoutKit

/// The core -> app `state` frame, decoded from the shared fixtures.
@Suite struct FrameDecodingTests {
    typealias F = ContractFixtures

    @Test func everyFrameFixtureDecodes() throws {
        let names = try F.names(prefix: "frame.")
        #expect(names.count >= 3)
        for name in names {
            #expect(try F.frame(name) != nil, "\(name) did not decode")
            var parser = JSONLParser()
            #expect(try parser.append(F.line(name)).count == 1, "\(name) did not parse as a line")
        }
    }

    @Test func stateFixtures() throws {
        #expect(try F.frame("frame.state.idle.json")
            == .state(StateFrame(status: .idle, visitEpoch: 3, detail: "docs.example.com", permitted: true)))
        #expect(try F.frame("frame.state.working.json") == .state(StateFrame(status: .working, visitEpoch: 3)))
        #expect(try F.frame("frame.state.working-job.json")
            == .state(StateFrame(status: .working, visitEpoch: 3, jobId: "job-3a")))
    }

    @Test func aFrameOfAnotherTypeDecodesToNil() {
        let lines = [
            #"{"type":"grant","agentBrowserContext":true}"#,
            #"{"type":"results","coreInstanceId":"core-1","visitEpoch":2,"origin":"https://docs.example.com","jobId":"j1","status":"empty"}"#,
            #"{"type":"ack","commandId":"app-3","ok":true,"revision":2,"approvalRevision":5}"#,
        ]
        for line in lines {
            #expect(PanelState.decode(line: Data(line.utf8)) == nil, "\(line)")
        }
    }
}
