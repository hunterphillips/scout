import Foundation
import Testing
@testable import ScoutKit

/// A temp dir with a scout root, a fake node, and a config pointing at them.
struct Fixture {
    let dir: URL
    let root: URL
    let node: URL
    let mainJS: URL
    let configURL: URL

    init() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("scoutkit-\(UUID().uuidString)")
        root = dir.appendingPathComponent("scout")
        node = dir.appendingPathComponent("node")
        mainJS = root.appendingPathComponent("packages/scout-core/dist/main.js")
        configURL = dir.appendingPathComponent("config.json")
        try FileManager.default.createDirectory(
            at: mainJS.deletingLastPathComponent(), withIntermediateDirectories: true)
        try writeNode("#!/bin/sh\nexit 0\n")
        try Data().write(to: mainJS)
    }

    func writeNode(_ script: String, executable: Bool = true) throws {
        try Data(script.utf8).write(to: node)
        try FileManager.default.setAttributes(
            [.posixPermissions: executable ? 0o755 : 0o644], ofItemAtPath: node.path)
    }

    func writeConfig(_ json: String) throws {
        try Data(json.utf8).write(to: configURL)
    }

    func writeConfig(nodePath: String? = nil, scoutRoot: String? = nil) throws {
        let object = ["nodePath": nodePath ?? node.path, "scoutRoot": scoutRoot ?? root.path]
        try JSONSerialization.data(withJSONObject: object).write(to: configURL)
    }

    func cleanUp() {
        try? FileManager.default.removeItem(at: dir)
    }
}

@Suite struct SidecarLaunchTests {
    private func setupNeeded(_ launch: SidecarLaunch) -> Bool {
        if case .setupNeeded = launch { return true }
        return false
    }

    @Test func validConfigBuildsLaunchSpec() throws {
        let f = try Fixture(); defer { f.cleanUp() }
        try f.writeConfig(#"{"nodePath":"\#(f.node.path)","scoutRoot":"\#(f.root.path)","claudePath":"/x"}"#)
        #expect(SidecarLaunch.resolve(configURL: f.configURL) == .ready(LaunchSpec(
            executable: f.node, arguments: [f.mainJS.path, "--stdio"])))
    }

    @Test func missingConfigFile() throws {
        let f = try Fixture(); defer { f.cleanUp() }
        #expect(setupNeeded(SidecarLaunch.resolve(configURL: f.configURL)))
    }

    @Test func malformedOrIncompleteConfig() throws {
        let f = try Fixture(); defer { f.cleanUp() }
        for json in ["not json", "{}", #"{"nodePath":"\#(f.node.path)"}"#, #"{"nodePath":1,"scoutRoot":"/"}"#] {
            try f.writeConfig(json)
            #expect(setupNeeded(SidecarLaunch.resolve(configURL: f.configURL)), "\(json)")
        }
    }

    @Test func missingNode() throws {
        let f = try Fixture(); defer { f.cleanUp() }
        try f.writeConfig(nodePath: f.dir.appendingPathComponent("nope").path)
        #expect(setupNeeded(SidecarLaunch.resolve(configURL: f.configURL)))
    }

    @Test func nonExecutableNode() throws {
        let f = try Fixture(); defer { f.cleanUp() }
        try f.writeNode("#!/bin/sh\n", executable: false)
        try f.writeConfig()
        #expect(setupNeeded(SidecarLaunch.resolve(configURL: f.configURL)))
    }

    @Test func directoryAsNode() throws {
        let f = try Fixture(); defer { f.cleanUp() }
        try f.writeConfig(nodePath: f.dir.path)
        #expect(setupNeeded(SidecarLaunch.resolve(configURL: f.configURL)))
    }

    @Test func bareCommandNameIsNotLookedUpOnPath() throws {
        let f = try Fixture(); defer { f.cleanUp() }
        try f.writeConfig(nodePath: "sh")
        #expect(setupNeeded(SidecarLaunch.resolve(configURL: f.configURL)))
    }

    @Test func relativeScoutRoot() throws {
        let f = try Fixture(); defer { f.cleanUp() }
        try f.writeConfig(scoutRoot: "scout")
        #expect(setupNeeded(SidecarLaunch.resolve(configURL: f.configURL)))
    }

    @Test func unbuiltScoutCore() throws {
        let f = try Fixture(); defer { f.cleanUp() }
        try FileManager.default.removeItem(at: f.mainJS)
        try f.writeConfig()
        #expect(setupNeeded(SidecarLaunch.resolve(configURL: f.configURL)))
    }
}
