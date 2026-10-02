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
        // The only terminate call in the app is the menu's Quit, `NSApp.terminate(nil)`, which
        // AppKit routes to applicationShouldTerminate; no process or app is terminated elsewhere.
        for (name, code) in try sources() {
            let calls = code.components(separatedBy: ".terminate(").count - 1
            #expect(calls == (name == "main.swift" ? 1 : 0), "\(name) has \(calls) terminate call(s)")
            #expect(!code.contains("exit("), "\(name) calls exit")
        }
        #expect(main.contains("NSApp.terminate(nil)"))
    }

    @Test func closingTheWindowHidesIt() throws {
        let main = try #require(try sources()["main.swift"])
        let body = try #require(Self.body(of: "func windowShouldClose", in: main))
        #expect(body.contains("return false") && body.contains("hide()"))
        #expect(!body.contains("terminate"))
        #expect(!main.contains("func windowWillClose"))
    }

    /// The text between the first `{` after `signature` and its matching `}`.
    static func body(of signature: String, in code: String) -> String? {
        guard let start = code.range(of: signature),
              let open = code[start.upperBound...].firstIndex(of: "{") else { return nil }
        var depth = 0
        var i = open
        while i < code.endIndex {
            switch code[i] {
            case "{": depth += 1
            case "}":
                depth -= 1
                if depth == 0 { return String(code[code.index(after: open)..<i]) }
            default: break
            }
            i = code.index(after: i)
        }
        return nil
    }

    @Test func braceMatchingFindsTheWholeBody() {
        let code = "func a() { if x { y() } else { z() }; return false }\nfunc b() { terminate() }"
        #expect(Self.body(of: "func a", in: code) == " if x { y() } else { z() }; return false ")
        #expect(Self.body(of: "func missing", in: code) == nil)
    }
}
