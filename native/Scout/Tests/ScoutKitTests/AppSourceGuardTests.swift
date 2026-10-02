import Foundation
import Testing

/// ScoutApp is an executable target the tests cannot import, so its AppKit-only rules are pinned
/// by reading its sources (P4.2): Scout never activates itself (a `results` frame, or any frame,
/// never brings it forward; the P2.5 non-activating rule), it stays an accessory app, closing the
/// window hides it, and Quit goes through `applicationShouldTerminate`.
@Suite struct AppSourceGuardTests {
    private static let appDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Sources/ScoutApp")

    private func sources() throws -> [String: String] {
        let files = try FileManager.default.contentsOfDirectory(at: Self.appDir, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
        #expect(files.count >= 3)
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
        for (name, source) in try sources() {
            // Activating layout constraints is not activating the app.
            let code = source.replacingOccurrences(of: "NSLayoutConstraint.activate(", with: "")
            for call in ["activate(", "activateIgnoringOtherApps", "setActivationPolicy(.regular", "makeKeyAndOrderFront", "unhide("] {
                #expect(!code.contains(call), "\(name) contains \(call)")
            }
        }
    }

    @Test func theAppIsAnAccessoryThatQuitsOnlyThroughTerminationPolicy() throws {
        let main = try #require(try sources()["main.swift"])
        #expect(main.contains("setActivationPolicy(.accessory)"))
        #expect(main.contains("TerminationPolicy.decide("))
        // The only terminate call is the menu's Quit, which AppKit routes to applicationShouldTerminate.
        #expect(main.components(separatedBy: "NSApp.terminate(").count == 2)
        #expect(!main.contains("exit("))
    }

    @Test func closingTheWindowHidesIt() throws {
        let main = try #require(try sources()["main.swift"])
        let close = try #require(main.range(of: "func windowShouldClose"))
        let body = main[close.lowerBound...].prefix(200)
        #expect(body.contains("return false") && body.contains("hide()"))
        #expect(!body.contains("terminate"))
        #expect(!main.contains("func windowWillClose"))
    }
}
