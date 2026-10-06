import Foundation

public enum SidecarStatus: Sendable, Equatable {
    case starting
    case running
    case setupNeeded(String)
    /// Exited too often; no further restarts.
    case stopped
}

/// What became of one `SidecarProcess.send`.
public enum SendOutcome: Sendable, Equatable {
    case written
    /// The pipe was full (`EAGAIN`) or the child is gone: send it again later.
    case retryLater
    /// The line is not under `PanelLimits.commandMaxBytes`; sending it again cannot help.
    case oversize
}

/// Runs `node scout-core/dist/main.js --stdio` as a child process. Reads `PanelState`
/// JSONL from its stdout, writes `NativeCommand` JSONL to its stdin, and leaves its
/// stderr on the app's stderr. Restarts it on exit, subject to `RestartPolicy`.
/// The child inherits the app's environment minus `SCOUT_HOME`, so the core always uses
/// `~/.scout`, the same home the app and the browser side use.
///
/// Stopping: `shutdown` is sent and stdin closed, then the core gets
/// `hardStopAllowance` (7 s) to stop its jobs and exit on its own; its own deadline is 5 s
/// (`SHUTDOWN_DEADLINE_MS` in scout-core's main.ts), so the allowance is only a backstop. Past
/// it the core is sent SIGTERM (`terminate()`), then SIGKILL after `terminateGrace` (1 s).
/// `beginShutdown` does this without blocking (the app's `.terminateLater` path);
/// `shutdown(timeout:)` blocks the caller and is the fallback.
@MainActor
public final class SidecarProcess {
    public var onStatus: ((SidecarStatus) -> Void)?
    public var onPanelState: ((PanelState) -> Void)?

    public private(set) var status: SidecarStatus = .starting {
        didSet { if status != oldValue { onStatus?(status) } }
    }

    public var ignoredLineCount: Int { parser.ignoredLineCount + ignoredBefore }

    /// Commands not written: the child's stdin was full or closed, or the line was too long.
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
    /// The child `beginShutdown` is waiting for, and who to tell once it is gone.
    private var stoppingProcess: Process?
    private var shutdownCompletions: [@MainActor () -> Void] = []

    /// How long the core gets to exit after `shutdown` before it is terminated. Above the
    /// core's own 5 s shutdown deadline, so a core that is still stopping a job is not cut off.
    public static let hardStopAllowance: TimeInterval = 7
    /// After `terminate()` (SIGTERM), how long before SIGKILL.
    public static let terminateGrace: TimeInterval = 1

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

    /// Never blocks: stdin is non-blocking, and a line that doesn't fit in the pipe right now
    /// is not written. Lines under `PIPE_BUF` bytes are written whole or not at all, so nothing
    /// ever leaves half a line in the pipe. A command not `.written` was not sent; the caller
    /// does not re-send it.
    @discardableResult
    public func send(_ command: NativeCommand) -> SendOutcome {
        let line = command.jsonLine()
        // macOS PIPE_BUF is 512, the same bound as `commandMaxBytes`.
        guard line.count < PanelLimits.commandMaxBytes, line.count <= Int(PIPE_BUF) else {
            drop("command is \(line.count) bytes, not under \(PanelLimits.commandMaxBytes)")
            return .oversize
        }
        guard let stdin else { return .retryLater }
        let written = line.withUnsafeBytes { Darwin.write(stdin.fileDescriptor, $0.baseAddress, $0.count) }
        if written != line.count {
            let reason = written < 0 ? String(cString: strerror(errno)) : "short write \(written)"
            drop(reason)
            return .retryLater
        }
        return .written
    }

    private func drop(_ reason: String) {
        droppedCommandCount += 1
        log("dropped command (\(reason)); total dropped \(droppedCommandCount)")
    }

    /// Whether a child is running (it may be shutting down).
    public var isRunning: Bool { process?.isRunning ?? false }

    /// Sends `shutdown`, waits up to `timeout` for the child to exit, then terminates it, then
    /// SIGKILLs it after `terminateGrace`. Blocks the caller: the fallback when the app could not
    /// wait for `beginShutdown`.
    public func shutdown(timeout: TimeInterval = SidecarProcess.hardStopAllowance, terminateGrace: TimeInterval = SidecarProcess.terminateGrace) {
        stopping = true
        // Ignore anything the child still prints.
        generation += 1
        guard let process, process.isRunning else {
            self.process = nil
            stdin = nil
            return
        }
        send(.shutdown)
        try? stdin?.close()
        stdin = nil
        if !Self.wait(for: process, upTo: timeout) {
            log("sidecar did not exit within \(timeout) s of shutdown; terminating pid \(process.processIdentifier)")
            process.terminate()
            if !Self.wait(for: process, upTo: terminateGrace) {
                kill(process.processIdentifier, SIGKILL)
                _ = Self.wait(for: process, upTo: 0.5)
            }
        }
        self.process = nil
        finishShutdown(of: process)
    }

    /// Non-blocking shutdown: sends `shutdown`, closes stdin, and calls `completion` (always
    /// asynchronously, on the main actor) once the child has exited, or once `allowance` and then
    /// `terminateGrace` have passed and it was terminated and killed. A second call while one is
    /// in progress only adds its completion. Timers run on the main queue, which AppKit serves in
    /// the common run-loop modes, including the modal-panel mode it runs in while a
    /// `.terminateLater` reply is pending.
    public func beginShutdown(
        allowance: TimeInterval = SidecarProcess.hardStopAllowance,
        terminateGrace: TimeInterval = SidecarProcess.terminateGrace,
        completion: @escaping @MainActor () -> Void
    ) {
        if stoppingProcess != nil {
            shutdownCompletions.append(completion)
            return
        }
        stopping = true
        // Ignore anything the child still prints.
        generation += 1
        guard let process, process.isRunning else {
            self.process = nil
            stdin = nil
            DispatchQueue.main.async { MainActor.assumeIsolated { completion() } }
            return
        }
        stoppingProcess = process
        shutdownCompletions = [completion]
        send(.shutdown)
        try? stdin?.close()
        stdin = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + allowance) {
            MainActor.assumeIsolated { [weak self] in
                guard let self, self.stoppingProcess === process else { return }
                self.log("sidecar did not exit within \(allowance) s of shutdown; terminating pid \(process.processIdentifier)")
                process.terminate()
                DispatchQueue.main.asyncAfter(deadline: .now() + terminateGrace) {
                    MainActor.assumeIsolated { [weak self] in
                        guard let self, self.stoppingProcess === process else { return }
                        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                        // The exit normally arrives first; never wait past this.
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                            MainActor.assumeIsolated { [weak self] in self?.finishShutdown(of: process) }
                        }
                    }
                }
            }
        }
    }

    /// The child `beginShutdown` waited for is gone (or its time is up): tell everyone once.
    private func finishShutdown(of process: Process) {
        guard stoppingProcess === process else { return }
        stoppingProcess = nil
        if self.process === process {
            self.process = nil
        }
        let completions = shutdownCompletions
        shutdownCompletions = []
        for done in completions {
            DispatchQueue.main.async { MainActor.assumeIsolated { done() } }
        }
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
                MainActor.assumeIsolated {
                    self?.finishShutdown(of: exited)
                    self?.handleExit(generation: gen, code: code)
                }
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
            log("ignored \(dropped) unknown or malformed line(s); total \(ignoredLineCount)")
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
