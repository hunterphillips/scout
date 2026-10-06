import Foundation
import Testing

/// ScoutApp is an executable target the tests cannot import, so its AppKit-only rules are pinned
/// by reading its sources: Scout never activates itself (a `results` frame, or any frame,
/// never brings it forward), it stays an accessory app, and Quit
/// goes through `applicationShouldTerminate`.
@Suite struct AppSourceGuardTests {
    private static let appDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Sources/ScoutApp")

    private func sources() throws -> [String: String] {
        let files = try FileManager.default.contentsOfDirectory(at: Self.appDir, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
        #expect(files.count >= 2)
        var out: [String: String] = [:]
        for file in files {
            // Comments may name the rule; only code counts.
            let code = try String(contentsOf: file, encoding: .utf8)
                .split(separator: "\n", omittingEmptySubsequences: false)
                .map { line in line.range(of: "//").map { String(line[..<$0.lowerBound]) } ?? String(line) }
                .joined(separator: "\n")
            out[file.lastPathComponent] = code
        }
        return out
    }

    @Test func theAppNeverActivatesItself() throws {
        for (name, code) in try sources() {
            for call in ["activate(", "activateIgnoringOtherApps", "setActivationPolicy(.regular", "makeKeyAndOrderFront", "unhide("] {
                #expect(!code.contains(call), "\(name) contains \(call)")
            }
        }
    }

    @Test func theAppIsAnAccessoryThatQuitsOnlyThroughTerminationPolicy() throws {
        let main = try #require(try sources()["main.swift"])
        #expect(main.contains("setActivationPolicy(.accessory)"))
        #expect(main.contains("TerminationPolicy.decide("))
        // The only terminate call in the app is the menu's Quit, `NSApp.terminate(nil)`, which
        // AppKit routes to applicationShouldTerminate; no process or app is terminated elsewhere.
        for (name, code) in try sources() {
            let calls = code.components(separatedBy: ".terminate(").count - 1
            #expect(calls == (name == "main.swift" ? 1 : 0), "\(name) has \(calls) terminate call(s)")
            #expect(!code.contains("exit("), "\(name) calls exit")
        }
        #expect(main.contains("NSApp.terminate(nil)"))
    }
}
