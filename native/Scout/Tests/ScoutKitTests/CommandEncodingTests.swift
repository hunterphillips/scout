import Foundation
import Testing
@testable import ScoutKit

/// App -> core commands: parity with the shared fixtures and the atomic-write bound.
@Suite struct CommandEncodingTests {
    typealias F = ContractFixtures

    private func object(_ command: NativeCommand) throws -> NSDictionary {
        let line = command.jsonLine()
        #expect(line.last == 0x0A)
        #expect(line.dropLast().contains(0x0A) == false)
        return try JSONSerialization.jsonObject(with: line) as! NSDictionary
    }

    @Test func everyCommandMatchesItsFixture() throws {
        let cases: [(String, NativeCommand)] = [
            ("command.frontmost.json", .frontmost(bundleId: "com.google.Chrome", at: 1_759_300_000_123)),
            ("command.pause.json", .pause),
            ("command.resume.json", .resume),
            ("command.shutdown.json", .shutdown),
        ]
        #expect(Set(cases.map(\.0)) == Set(try F.names(prefix: "command.")))
        for (name, command) in cases {
            #expect(try object(command) == F.object(name), "\(name)")
        }
    }

    @Test func everyCommandFitsOneAtomicWrite() {
        #expect(PanelLimits.commandMaxBytes == 512 && Int(PIPE_BUF) == PanelLimits.commandMaxBytes)
        // A bundle ID is at most 255 characters.
        let longest: [NativeCommand] = [.frontmost(bundleId: String(repeating: "a", count: 255), at: .max), .pause, .resume, .shutdown]
        for command in longest {
            #expect(command.jsonLine().count < PanelLimits.commandMaxBytes, "\(command)")
        }
    }
}
