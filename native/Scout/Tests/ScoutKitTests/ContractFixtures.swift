import Foundation
@testable import ScoutKit

/// The contract fixtures the app reads, in Tests/Fixtures: byte-identical copies of files in
/// packages/contracts/fixtures/panel, which a contracts test checks.
enum ContractFixtures {
    static let directory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Fixtures")

    static func data(_ name: String) throws -> Data {
        try Data(contentsOf: directory.appendingPathComponent(name))
    }

    static func object(_ name: String) throws -> NSDictionary {
        try JSONSerialization.jsonObject(with: data(name)) as! NSDictionary
    }

    /// The fixture as one compact JSONL line, newline included.
    static func line(_ name: String) throws -> Data {
        var line = try JSONSerialization.data(withJSONObject: object(name), options: [.withoutEscapingSlashes])
        line.append(0x0A)
        return line
    }

    static func frame(_ name: String) throws -> PanelState? {
        try PanelState.decode(line: data(name))
    }

    static func names(prefix: String) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0.hasPrefix(prefix) && $0.hasSuffix(".json") }
            .sorted()
    }

    static let rid = "res_" + String(repeating: "a", count: 64)
    static let rid2 = "res_" + String(repeating: "b", count: 64)
    static let v1 = String(repeating: "1", count: 64)
    static let v2 = String(repeating: "2", count: 64)
    static let v3 = String(repeating: "3", count: 64)
    static let origin = "https://docs.example.com"
}
