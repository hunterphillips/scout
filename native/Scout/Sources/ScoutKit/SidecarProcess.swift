import Foundation

public enum SidecarStatus: Sendable, Equatable {
    case starting
    case running
    case setupNeeded(String)
    /// Exited too often; no further restarts.
    case stopped
}

/// Runs `node scout-core/dist/main.js --stdio` as a child process. Reads `PanelState`
/// JSONL from its stdout, writes `NativeCommand` JSONL to its stdin, and leaves its
/// stderr on the app's stderr. Restarts it on exit, subject to `RestartPolicy`.
@MainActor
public final class SidecarProcess {
    public var onStatus: ((SidecarStatus) -> Void)?
    public var onPanelState: ((PanelState) -> Void)?

    public private(set) var status: SidecarStatus = .starting {
        didSet { if status != oldValue { onStatus?(status) } }
    }

    public var ignoredLineCount: Int { parser.ignoredLineCount + ignoredBefore }

    private let resolveLaunch: () -> SidecarLaunch
    private var policy: RestartPolicy
    private let restartDelay: TimeInterval
    private let now: () -> Date

    private var process: Process?
    private var stdin: FileHandle?
    private var parser = JSONLParser()
    private var ignoredBefore = 0
    private var generation = 0
    private var stopping = false

    public init(
        resolveLaunch: @escaping () -> SidecarLaunch = { SidecarLaunch.resolve() },
        restartPolicy: RestartPolicy = RestartPolicy(),
        restartDelay: TimeInterval = 1,
        now: @escaping () -> Date = Date.init
    ) {
        self.resolveLaunch = resolveLaunch
        self.policy = restartPolicy
        self.restartDelay = restartDelay
        self.now = now
    }

    public func start() {
        // A write to a child that already exited must fail, not kill the app.
        signal(SIGPIPE, SIG_IGN)
        stopping = false
        launch()
    }

    public func send(_ command: NativeCommand) {
        guard let stdin else { return }
        do {
            try stdin.write(contentsOf: command.jsonLine())
        } catch {
            log("write failed: \(error)")
        }
    }

    /// Sends `shutdown`, waits up to `timeout` for the child to exit, then kills it.
    /// Blocks the caller; meant for app termination.
    public func shutdown(timeout: TimeInterval = 2) {
        stopping = true
        guard let process, process.isRunning else { return }
        send(.shutdown)
        try? stdin?.close()
        stdin = nil
        if !Self.wait(for: process, upTo: timeout) {
            log("sidecar did not exit after shutdown; killing pid \(process.processIdentifier)")
            process.terminate()
            if !Self.wait(for: process, upTo: 0.5) {
                kill(process.processIdentifier, SIGKILL)
                _ = Self.wait(for: process, upTo: 0.5)
            }
        }
        self.process = nil
    }

    private func launch() {
        guard !stopping else { return }
        let spec: LaunchSpec
        switch resolveLaunch() {
        case let .setupNeeded(reason):
            status = .setupNeeded(reason)
            return
        case let .ready(ready):
            spec = ready
        }

        generation += 1
        let gen = generation
        ignoredBefore += parser.ignoredLineCount
        parser = JSONLParser()

        let child = Process()
        child.executableURL = spec.executable
        child.arguments = spec.arguments
        let input = Pipe()
        let output = Pipe()
        child.standardInput = input
        child.standardOutput = output
        child.standardError = FileHandle.standardError

        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            // The main queue is FIFO, so chunks arrive in order.
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.receive(data, generation: gen) }
            }
        }
        child.terminationHandler = { [weak self] exited in
            let code = exited.terminationStatus
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.handleExit(generation: gen, code: code) }
            }
        }

        status = .starting
        do {
            try child.run()
        } catch {
            output.fileHandleForReading.readabilityHandler = nil
            log("launch failed: \(error)")
            DispatchQueue.main.async {
                MainActor.assumeIsolated { [weak self] in self?.handleExit(generation: gen, code: -1) }
            }
            return
        }
        process = child
        stdin = input.fileHandleForWriting
        status = .running
    }

    private func receive(_ data: Data, generation gen: Int) {
        guard gen == generation else { return }
        let before = parser.ignoredLineCount
        for state in parser.append(data) {
            onPanelState?(state)
        }
        let dropped = parser.ignoredLineCount - before
        if dropped > 0 {
            log("ignored \(dropped) malformed line(s); total \(ignoredLineCount)")
        }
    }

    private func handleExit(generation gen: Int, code: Int32) {
        guard gen == generation, !stopping else { return }
        process = nil
        stdin = nil
        log("sidecar exited with status \(code)")
        guard policy.recordRestart(at: now()) else {
            status = .stopped
            return
        }
        status = .starting
        DispatchQueue.main.asyncAfter(deadline: .now() + restartDelay) {
            MainActor.assumeIsolated { [weak self] in self?.launch() }
        }
    }

    private static func wait(for process: Process, upTo seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.02)
        }
        return !process.isRunning
    }

    private func log(_ message: String) {
        FileHandle.standardError.write(Data("[scout-app] \(message)\n".utf8))
    }
}
