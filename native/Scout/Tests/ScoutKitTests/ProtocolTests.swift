import Foundation
import Testing
@testable import ScoutKit

@Suite struct JSONLParserTests {
    private func parse(_ chunks: [String]) -> ([PanelState], Int) {
        var parser = JSONLParser()
        var out: [PanelState] = []
        for chunk in chunks { out += parser.append(Data(chunk.utf8)) }
        return (out, parser.ignoredLineCount)
    }

    @Test func decodesStateLines() {
        let (states, ignored) = parse([
            #"{"type":"state","status":"idle"}"# + "\n",
            #"{"type":"state","status":"working","visitEpoch":4,"detail":"ranking"}"# + "\n",
        ])
        #expect(states == [
            .state(status: .idle, visitEpoch: nil, detail: nil),
            .state(status: .working, visitEpoch: 4, detail: "ranking"),
        ])
        #expect(ignored == 0)
    }

    @Test func decodesEveryResultsVariant() {
        let item = #"{"candidateId":"c1","title":"Webhooks","href":"https://docs.stripe.com/webhooks","reason":"matches"}"#
        let (states, ignored) = parse([
            #"{"type":"results","visitEpoch":2,"status":"ok","items":["# + item + "]}\n",
            #"{"type":"results","visitEpoch":2,"status":"empty","items":[]}"# + "\n",
            #"{"type":"results","visitEpoch":3,"status":"unavailable","reason":"service down"}"# + "\n",
            #"{"type":"results","visitEpoch":3,"status":"error","reason":"timeout"}"# + "\n",
        ])
        #expect(states == [
            .results(visitEpoch: 2, outcome: .ok([ResultItem(
                candidateId: "c1", title: "Webhooks",
                href: "https://docs.stripe.com/webhooks", reason: "matches")])),
            .results(visitEpoch: 2, outcome: .empty),
            .results(visitEpoch: 3, outcome: .unavailable("service down")),
            .results(visitEpoch: 3, outcome: .error("timeout")),
        ])
        #expect(ignored == 0)
    }

    @Test func joinsLinesSplitAcrossChunks() {
        let (states, _) = parse([#"{"type":"sta"#, #"te","status":"#, "\"paused\"}\n"])
        #expect(states == [.state(status: .paused, visitEpoch: nil, detail: nil)])
    }

    @Test func holdsPartialLineUntilNewline() {
        var parser = JSONLParser()
        let first = parser.append(Data(#"{"type":"state","status":"idle"}"#.utf8))
        let second = parser.append(Data("\n".utf8))
        #expect(first.isEmpty)
        #expect(second.count == 1)
    }

    @Test func acceptsCRLFAndSkipsBlankLines() {
        let (states, ignored) = parse(["\n  \n" + #"{"type":"state","status":"disconnected"}"# + "\r\n"])
        #expect(states == [.state(status: .disconnected, visitEpoch: nil, detail: nil)])
        #expect(ignored == 0)
    }

    @Test func ignoresAndCountsMalformedAndUnknownLines() {
        let (states, ignored) = parse([
            "not json\n",
            "[1,2]\n",
            #"{"type":"hello"}"# + "\n",                                           // unknown type
            #"{"type":"state","status":"sleeping"}"# + "\n",                       // unknown status
            #"{"type":"state"}"# + "\n",                                           // missing status
            #"{"type":"results","status":"ok","items":[]}"# + "\n",                // missing visitEpoch
            #"{"type":"results","visitEpoch":1,"status":"ok"}"# + "\n",            // missing items
            #"{"type":"results","visitEpoch":1,"status":"error"}"# + "\n",         // missing reason
            #"{"type":"results","visitEpoch":"1","status":"empty","items":[]}"# + "\n", // wrong type
            #"{"type":"results","visitEpoch":1,"status":"ok","items":[{"title":"x"}]}"# + "\n",
            #"{"type":"state","status":"idle"}"# + "\n",
        ])
        #expect(states == [.state(status: .idle, visitEpoch: nil, detail: nil)])
        #expect(ignored == 10)
    }

    @Test func dropsOversizedLineThroughItsNewline() {
        var parser = JSONLParser()
        _ = parser.append(Data(repeating: 0x61, count: JSONLParser.maxLineBytes + 1))
        #expect(parser.ignoredLineCount == 1)
        // The rest of the oversized line is discarded too, then parsing resumes.
        _ = parser.append(Data(repeating: 0x61, count: 1000))
        let next = parser.append(Data(("aaa\n" + #"{"type":"state","status":"idle"}"# + "\n").utf8))
        #expect(next == [.state(status: .idle, visitEpoch: nil, detail: nil)])
        #expect(parser.ignoredLineCount == 1)
    }

    @Test func largeFrameSplitIntoSmallChunksParsesOnce() throws {
        var parser = JSONLParser()
        let line = Data(#"{"type":"grant","agentBrowserContext":true,"pad":""#.utf8)
            + Data(repeating: 0x61, count: 300_000) + Data("\"}\n".utf8)
        var states: [PanelState] = []
        var i = 0
        while i < line.count {
            states += parser.append(line[i..<min(i + 4096, line.count)])
            i += 4096
        }
        #expect(states == [.grant(agentBrowserContext: true)])
        #expect(parser.ignoredLineCount == 0)
    }

    @Test func finishCountsAnUnfinishedLastLineOnce() {
        var parser = JSONLParser()
        _ = parser.append(Data(#"{"type":"state","status":"idle"}"#.utf8))
        parser.finish()
        #expect(parser.ignoredLineCount == 1)
        parser.finish()
        #expect(parser.ignoredLineCount == 1)
    }

    @Test func finishIgnoresTrailingWhitespace() {
        var parser = JSONLParser()
        _ = parser.append(Data("\n  \r".utf8))
        parser.finish()
        #expect(parser.ignoredLineCount == 0)
    }
}

@Suite struct NativeCommandTests {
    private func line(_ command: NativeCommand) -> String {
        String(decoding: command.jsonLine(), as: UTF8.self)
    }

    @Test func encodesEachCommandAsOneLine() {
        #expect(line(.frontmost(bundleId: "com.google.Chrome", at: 1_700_000_000_123))
            == #"{"at":1700000000123,"bundleId":"com.google.Chrome","type":"frontmost"}"# + "\n")
        #expect(line(.pause) == #"{"type":"pause"}"# + "\n")
        #expect(line(.resume) == #"{"type":"resume"}"# + "\n")
        #expect(line(.shutdown) == #"{"type":"shutdown"}"# + "\n")
    }

    @Test func frontmostDateIsMillisecondsSinceEpoch() {
        let command = NativeCommand.frontmost(bundleId: "x", date: Date(timeIntervalSince1970: 12.3456))
        #expect(command == .frontmost(bundleId: "x", at: 12_345))
    }
}
