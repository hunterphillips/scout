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
/// The child inherits the app's environment minus `SCOUT_HOME`, so the core always uses
/// `~/.scout`, the same home the app and the browser side use.
@MainActor
public final class SidecarProcess {
    public var onStatus: ((SidecarStatus) -> Void)?
    public var onPanelState: ((PanelState) -> Void)?

    public private(set) var status: SidecarStatus = .starting {
        didSet { if status != oldValue { onStatus?(status) } }
    }

    public var ignoredLineCount: Int { parser.ignoredLineCount + ignoredBefore }

    /// Commands dropped because the child's stdin was full or closed.
    public private(set) var droppedCommandCount = 0

    private let resolveLaunch: () -> SidecarLaunch
    private var policy: RestartPolicy
    private let restartDelay: TimeInterval
    private let now: () -> Date
    private let parentEnvironment: () -> [String: String]

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
        now: @escaping () -> Date = Date.init,
        parentEnvironment: @escaping () -> [String: String] = { ProcessInfo.processInfo.environment }
    ) {
        self.resolveLaunch = resolveLaunch
        self.policy = restartPolicy
        self.restartDelay = restartDelay
        self.now = now
        self.parentEnvironment = parentEnvironment
    }

    /// The child's environment: the parent's without `SCOUT_HOME`.
    nonisolated static func childEnvironment(from parent: [String: String]) -> [String: String] {
        var env = parent
        env.removeValue(forKey: "SCOUT_HOME")
        return env
    }

    public func start() {
        guard process == nil else { return }
        // A write to a child that already exited must fail, not kill the app.
        signal(SIGPIPE, SIG_IGN)
        stopping = false
        launch()
    }

    /// Never blocks: stdin is non-blocking, and a message that doesn't fit in the pipe
    /// right now is dropped. Messages under `PIPE_BUF` bytes are written whole or not
    /// at all, so a drop never leaves half a line in the pipe. Returns whether the line
    /// was written; the caller keeps a dropped window command pending and re-sends it.
    @discardableResult
    public func send(_ command: NativeCommand) -> Bool {
        guard let stdin else { return false }
        let line = command.jsonLine()
        guard line.count < PanelLimits.commandMaxBytes, line.count <= Int(PIPE_BUF) else {
            drop("command is \(line.count) bytes, not under \(PanelLimits.commandMaxBytes)")
            return false
        }
        let written = line.withUnsafeBytes { Darwin.write(stdin.fileDescriptor, $0.baseAddress, $0.count) }
        if written != line.count {
            let reason = written < 0 ? String(cString: strerror(errno)) : "short write \(written)"
            drop(reason)
            return false
        }
        return true
    }

    private func drop(_ reason: String) {
        droppedCommandCount += 1
        log("dropped command (\(reason)); total dropped \(droppedCommandCount)")
    }

    /// Sends `shutdown`, waits up to `timeout` for the child to exit, then kills it.
    /// Blocks the caller; meant for app termination.
    public func shutdown(timeout: TimeInterval = 2) {
        stopping = true
        // Ignore anything the child still prints.
        generation += 1
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
        child.currentDirectoryURL = spec.currentDirectoryURL
        child.environment = Self.childEnvironment(from: parentEnvironment())
        let input = Pipe()
        let output = Pipe()
        child.standardInput = input
        child.standardOutput = output
        child.standardError = FileHandle.standardError

        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { self?.finishOutput(generation: gen) }
                }
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
        let fd = input.fileHandleForWriting.fileDescriptor
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
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

    private func finishOutput(generation gen: Int) {
        guard gen == generation else { return }
        let before = parser.ignoredLineCount
        parser.finish()
        if parser.ignoredLineCount > before {
            log("ignored an unfinished last line; total \(ignoredLineCount)")
        }
    }

    private func handleExit(generation gen: Int, code: Int32) {
        guard gen == generation, !stopping else { return }
        finishOutput(generation: gen)
        // Output from the dead child that is still in flight must not reach the panel.
        generation += 1
        let pending = generation
        process = nil
        stdin = nil
        log("sidecar exited with status \(code)")
        guard policy.recordRestart(at: now()) else {
            status = .stopped
            return
        }
        status = .starting
        DispatchQueue.main.asyncAfter(deadline: .now() + restartDelay) {
            MainActor.assumeIsolated { [weak self] in
                // Skip if start() or shutdown() ran in the meantime.
                guard let self, self.generation == pending else { return }
                self.launch()
            }
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
