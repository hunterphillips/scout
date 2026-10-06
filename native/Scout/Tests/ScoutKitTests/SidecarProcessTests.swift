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
        let launches = f.dir.appendingPathComponent("launches")
        try f.writeNode("""
            #!/bin/sh
            echo x >> '\(launches.path)'
            echo '{"type":"state","status":"idle"}'
            echo 'garbage'
            echo '{"type":"results","coreInstanceId":"core-1","visitEpoch":1,"origin":"https://docs.example.com","jobId":"job-1","status":"empty"}'
            echo '{"type":"state","status":"working","visitEpoch":1}'
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

        // The garbage line and the results frame are skipped; only state frames reach the app.
        #expect(states == [.state(StateFrame(status: .idle)), .state(StateFrame(status: .working, visitEpoch: 1))])
        #expect(sidecar.ignoredLineCount == 2)

        sidecar.send(.frontmost(bundleId: "com.google.Chrome", at: 42))
        await waitUntil { lines(received).count == 1 }
        sidecar.shutdown(timeout: 2)

        #expect(lines(received) == [
            #"{"at":42,"bundleId":"com.google.Chrome","type":"frontmost"}"#,
            #"{"type":"shutdown"}"#,
        ])
        // Give a stray termination callback a chance to (wrongly) restart it.
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(lines(launches).count == 1)
    }

    @Test func startTwiceLaunchesOneChild() async throws {
        let f = try Fixture(); defer { f.cleanUp() }
        let launches = f.dir.appendingPathComponent("launches")
        try f.writeNode("#!/bin/sh\necho x >> '\(launches.path)'\nwhile read line; do :; done\n")
        let sidecar = SidecarProcess(
            resolveLaunch: { .ready(LaunchSpec(executable: f.node, arguments: [])) })
        sidecar.start()
        sidecar.start()
        await waitUntil { !lines(launches).isEmpty }
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(lines(launches).count == 1)
        sidecar.shutdown(timeout: 1)
    }

    @Test func childRunsInTheSpecsDirectory() async throws {
        let f = try Fixture(); defer { f.cleanUp() }
        let cwd = f.dir.appendingPathComponent("cwd")
        try f.writeNode("#!/bin/sh\npwd -P > '\(cwd.path)'\nwhile read line; do :; done\n")
        let sidecar = SidecarProcess(resolveLaunch: {
            .ready(LaunchSpec(executable: f.node, arguments: [], currentDirectoryURL: f.root))
        })
        sidecar.start()
        await waitUntil { !lines(cwd).isEmpty }
        sidecar.shutdown(timeout: 1)
        // Foundation's symlink resolution drops /private, so ask the OS.
        let real = try #require(realpath(f.root.path, nil))
        defer { free(real) }
        #expect(lines(cwd) == [String(cString: real)])
    }

    @Test func childEnvironmentDropsScoutHome() async throws {
        let f = try Fixture(); defer { f.cleanUp() }
        let env = f.dir.appendingPathComponent("env")
        try f.writeNode("""
            #!/bin/sh
            echo "home=${SCOUT_HOME-unset} keep=${KEEP_ME-unset}" > '\(env.path)'
            while read line; do :; done
            """)
        let sidecar = SidecarProcess(
            resolveLaunch: { .ready(LaunchSpec(executable: f.node, arguments: [])) },
            parentEnvironment: { ["SCOUT_HOME": "/tmp/elsewhere", "KEEP_ME": "yes", "PATH": "/usr/bin:/bin"] })
        sidecar.start()
        await waitUntil { !lines(env).isEmpty }
        sidecar.shutdown(timeout: 1)
        #expect(lines(env) == ["home=unset keep=yes"])
        #expect(SidecarProcess.childEnvironment(from: ["SCOUT_HOME": "x", "A": "b"]) == ["A": "b"])
    }

    @Test func unfinishedLastLineAtEOFIsCounted() async throws {
        let f = try Fixture(); defer { f.cleanUp() }
        // Prints a good line and an unfinished one, closes stdout, and keeps running.
        try f.writeNode("""
            #!/bin/sh
            echo '{"type":"state","status":"idle"}'
            printf '{"type":"state"'
            exec >&-
            while read line; do :; done
            """)
        var states: [PanelState] = []
        let sidecar = SidecarProcess(
            resolveLaunch: { .ready(LaunchSpec(executable: f.node, arguments: [])) })
        sidecar.onPanelState = { states.append($0) }
        sidecar.start()
        await waitUntil { sidecar.ignoredLineCount == 1 }
        sidecar.shutdown(timeout: 1)
        #expect(states == [.state(StateFrame(status: .idle))])
        #expect(sidecar.ignoredLineCount == 1)
    }

    @Test func sendNeverBlocksWhenTheChildStopsReading() async throws {
        let f = try Fixture(); defer { f.cleanUp() }
        let pidFile = f.dir.appendingPathComponent("pid")
        try f.writeNode("#!/bin/sh\necho $$ > '\(pidFile.path)'\nwhile :; do sleep 0.1; done\n")
        let sidecar = SidecarProcess(
            resolveLaunch: { .ready(LaunchSpec(executable: f.node, arguments: [])) })
        sidecar.start()
        await waitUntil { !lines(pidFile).isEmpty }
        let pid = try #require(lines(pidFile).first.flatMap { pid_t($0) })

        // Too long for one atomic write: refused for good, before the pipe is touched.
        #expect(sidecar.send(.frontmost(bundleId: String(repeating: "x", count: PanelLimits.commandMaxBytes), at: 0)) == .oversize)
        #expect(sidecar.droppedCommandCount == 1)

        // A pipe holds 16-64 KiB; this is far more.
        let began = Date()
        var last = SendOutcome.written
        for i in 0..<10_000 where last == .written {
            last = sidecar.send(.frontmost(bundleId: "com.example.app\(i)", at: Int64(i)))
        }
        #expect(last == .retryLater)
        #expect(sidecar.droppedCommandCount > 1)
        sidecar.shutdown(timeout: 0.5)
        #expect(Date().timeIntervalSince(began) < 3)
        #expect(kill(pid, 0) != 0)
    }

    @Test func hardStopAllowanceIsAboveTheCoresDeadline() {
        // scout-core's SHUTDOWN_DEADLINE_MS is 5 s; the app waits longer before it terminates.
        #expect(SidecarProcess.hardStopAllowance == 7)
        #expect(SidecarProcess.hardStopAllowance > 5)
        #expect(SidecarProcess.terminateGrace == 1)
    }

    /// A child that takes `exitAfter` seconds to exit once it reads `shutdown`, records any
    /// SIGTERM it gets (and ignores it), and records its pid.
    private func slowCore(_ f: Fixture, exitAfter: Double?) throws -> (pid: URL, term: URL) {
        let pidFile = f.dir.appendingPathComponent("pid")
        let term = f.dir.appendingPathComponent("term")
        let onShutdown = exitAfter.map { "sleep \($0); exit 0" } ?? "while :; do sleep 0.05; done"
        try f.writeNode("""
            #!/bin/sh
            echo $$ > '\(pidFile.path)'
            trap 'echo term >> "\(term.path)"' TERM
            while read line; do
              case "$line" in *shutdown*) \(onShutdown);; esac
            done
            \(onShutdown)
            """)
        return (pidFile, term)
    }

    @Test func beginShutdownWaitsForACoreThatIsStillStopping() async throws {
        let f = try Fixture(); defer { f.cleanUp() }
        let files = try slowCore(f, exitAfter: 0.6)
        let sidecar = SidecarProcess(resolveLaunch: { .ready(LaunchSpec(executable: f.node, arguments: [])) })
        sidecar.start()
        await waitUntil { !lines(files.pid).isEmpty }
        let pid = try #require(lines(files.pid).first.flatMap { pid_t($0) })

        let began = Date()
        var doneAt: Date?
        sidecar.beginShutdown(allowance: 2, terminateGrace: 0.5) { doneAt = Date() }
        // Still stopping: nothing is reported yet, and nothing is sent but `shutdown`.
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(doneAt == nil)
        #expect(sidecar.isRunning)
        await waitUntil(timeout: 4) { doneAt != nil }
        let took = try #require(doneAt).timeIntervalSince(began)
        #expect(took >= 0.5)
        #expect(took < 2)
        #expect(lines(files.term).isEmpty) // never terminated: it exited inside the allowance
        #expect(kill(pid, 0) != 0)
        #expect(!sidecar.isRunning)
    }

    @Test func beginShutdownTerminatesThenKillsOnlyAfterTheAllowance() async throws {
        let f = try Fixture(); defer { f.cleanUp() }
        let files = try slowCore(f, exitAfter: nil)
        let sidecar = SidecarProcess(resolveLaunch: { .ready(LaunchSpec(executable: f.node, arguments: [])) })
        sidecar.start()
        await waitUntil { !lines(files.pid).isEmpty }
        let pid = try #require(lines(files.pid).first.flatMap { pid_t($0) })

        let began = Date()
        var completions = 0
        var doneAt: Date?
        sidecar.beginShutdown(allowance: 0.8, terminateGrace: 0.4) { completions += 1; doneAt = Date() }
        // A second request (the app asked twice) only waits for the same stop.
        sidecar.beginShutdown { completions += 1 }
        try await Task.sleep(nanoseconds: 600_000_000)
        #expect(lines(files.term).isEmpty) // no SIGTERM inside the allowance
        await waitUntil(timeout: 4) { completions == 2 }
        let took = try #require(doneAt).timeIntervalSince(began)
        #expect(took >= 1.2) // allowance + terminate grace: SIGTERM was ignored, SIGKILL ended it
        #expect(took < 2.5)
        #expect(lines(files.term) == ["term"])
        #expect(kill(pid, 0) != 0)
    }

    @Test func beginShutdownWithNothingRunningCompletesAsynchronously() async throws {
        let sidecar = SidecarProcess(resolveLaunch: { .setupNeeded("no config") })
        sidecar.start()
        var done = false
        sidecar.beginShutdown { done = true }
        #expect(!done) // never before the caller returned `.terminateLater`
        await waitUntil(timeout: 1) { done }
        #expect(done)
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
