import Foundation
import Testing
@testable import ScoutKit

/// Runs SidecarProcess against a shell script standing in for node.
@MainActor
@Suite(.serialized) struct SidecarProcessTests {
    private func waitUntil(timeout: TimeInterval = 5, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    private func lines(_ url: URL) -> [String] {
        let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        return text.split(separator: "\n").map(String.init)
    }

    @Test func setupNeededDoesNotLaunch() {
        let sidecar = SidecarProcess(resolveLaunch: { .setupNeeded("no config") })
        sidecar.start()
        #expect(sidecar.status == .setupNeeded("no config"))
    }

    @Test func crashLoopStopsAfterThreeRestarts() async throws {
        let f = try Fixture(); defer { f.cleanUp() }
        let launches = f.dir.appendingPathComponent("launches")
        try f.writeNode("#!/bin/sh\necho \"$1 $2\" >> '\(launches.path)'\nexit 1\n")
        try f.writeConfig()
        var statuses: [SidecarStatus] = []
        let sidecar = SidecarProcess(
            resolveLaunch: { SidecarLaunch.resolve(configURL: f.configURL) },
            restartDelay: 0)
        sidecar.onStatus = { statuses.append($0) }
        sidecar.start()
        await waitUntil { sidecar.status == .stopped }

        #expect(sidecar.status == .stopped)
        #expect(lines(launches) == Array(repeating: "\(f.mainJS.path) --stdio", count: 4))
        #expect(statuses.last == .stopped)
        #expect(statuses.filter { $0 == .running }.count == 4)
    }

    @Test func restartsIndefinitelyWhenExitsAreSpreadOut() async throws {
        let f = try Fixture(); defer { f.cleanUp() }
        let launches = f.dir.appendingPathComponent("launches")
        try f.writeNode("#!/bin/sh\necho x >> '\(launches.path)'\nexit 1\n")
        var clock = Date(timeIntervalSince1970: 0)
        let sidecar = SidecarProcess(
            resolveLaunch: { .ready(LaunchSpec(executable: f.node, arguments: [])) },
            restartDelay: 0,
            now: { clock += 61; return clock })
        sidecar.start()
        await waitUntil { lines(launches).count >= 6 }
        sidecar.shutdown(timeout: 0.5)

        #expect(lines(launches).count >= 6)
        #expect(sidecar.status != .stopped)
    }

    @Test func parsesStdoutWritesStdinAndShutsDownCleanly() async throws {
        let f = try Fixture(); defer { f.cleanUp() }
        let received = f.dir.appendingPathComponent("received")
        try f.writeNode("""
            #!/bin/sh
            echo '{"type":"state","status":"idle"}'
            echo 'garbage'
            echo '{"type":"results","visitEpoch":1,"status":"empty","items":[]}'
            while read line; do
              echo "$line" >> '\(received.path)'
              case "$line" in *shutdown*) exit 0;; esac
            done
            """)
        var states: [PanelState] = []
        let sidecar = SidecarProcess(
            resolveLaunch: { .ready(LaunchSpec(executable: f.node, arguments: [])) },
            restartDelay: 0)
        sidecar.onPanelState = { states.append($0) }
        sidecar.start()
        await waitUntil { states.count == 2 }

        #expect(states == [
            .state(status: .idle, visitEpoch: nil, detail: nil),
            .results(visitEpoch: 1, outcome: .empty),
        ])
        #expect(sidecar.ignoredLineCount == 1)

        sidecar.send(.frontmost(bundleId: "com.google.Chrome", at: 42))
        await waitUntil { lines(received).count == 1 }
        sidecar.shutdown(timeout: 2)

        #expect(lines(received) == [
            #"{"at":42,"bundleId":"com.google.Chrome","type":"frontmost"}"#,
            #"{"type":"shutdown"}"#,
        ])
        // Give a stray termination callback a chance to (wrongly) restart it.
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(sidecar.status == .running)
    }

    @Test func shutdownKillsAChildThatIgnoresIt() async throws {
        let f = try Fixture(); defer { f.cleanUp() }
        let pidFile = f.dir.appendingPathComponent("pid")
        try f.writeNode("#!/bin/sh\necho $$ > '\(pidFile.path)'\ntrap '' TERM\nwhile :; do sleep 0.1; done\n")
        let sidecar = SidecarProcess(
            resolveLaunch: { .ready(LaunchSpec(executable: f.node, arguments: [])) })
        sidecar.start()
        await waitUntil { !lines(pidFile).isEmpty }
        let pid = try #require(lines(pidFile).first.flatMap { pid_t($0) })

        let began = Date()
        sidecar.shutdown(timeout: 0.3)
        #expect(Date().timeIntervalSince(began) < 3)
        #expect(kill(pid, 0) != 0) // gone
    }
}
