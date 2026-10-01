import Foundation

/// Issues command IDs for Scout's window and follows each command to its ack.
///
/// A command is `pending` from the moment it is issued until an ack (or, for `preview`, its
/// chunk) arrives. A write the pipe refused for now leaves it pending and `unsent`; within one
/// core instance the app re-sends unsent commands with the same ID. A line too long for one
/// atomic write fails at once as `invalid` and is never sent. When the core restarts, only
/// pending decisions (approve, decline, revoke) are re-sent with the same ID: the new core
/// re-checks each against the store, and the `expectedRevision` inside keeps a stale change from
/// applying. Pending toggles and refreshes become `unknown` (settled, not failed); the window
/// re-renders them from the new core's next `capabilities` or `grant` frame. Pending previews
/// fail as `unavailable` (their cursors died with the old core); the user restarts them. A
/// preview the window stopped waiting for (restarted or evicted) settles as `superseded`.
/// A retry never draws a new ID, so one decision can never become two commands. Toggles are
/// never retried: the user toggles again, under a new ID with a fresh `expectedEnabled`.
public struct CommandTracker: Sendable, Equatable {
    public static let capacity = 64

    public enum State: Sendable, Equatable {
        case pending
        case ok
        case failed(AckFailureCode)
        /// The core restarted before answering; the next frame shows what took effect.
        case unknown
        /// A preview request the window no longer waits for; never sent again.
        case superseded
    }

    public struct Record: Sendable, Equatable {
        public let id: String
        public let request: PanelRequest
        public fileprivate(set) var state: State
        /// False until a write of this command went through whole.
        public fileprivate(set) var sent: Bool

        public var command: NativeCommand { .panel(commandId: id, request) }
    }

    /// Oldest first.
    public private(set) var records: [Record] = []
    private let prefix: String
    private var counter = 0

    /// `prefix` keeps IDs from different app runs apart; it must match `[A-Za-z0-9_-]{1,40}`.
    public init(prefix: String = CommandTracker.randomPrefix()) {
        precondition(WireFormat.isToken(prefix) && prefix.utf8.count <= 40)
        self.prefix = prefix
    }

    public static func randomPrefix() -> String {
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        return String((0..<12).map { _ in alphabet.randomElement()! })
    }

    /// Records a new pending command and returns it to send.
    public mutating func issue(_ request: PanelRequest) -> NativeCommand {
        counter += 1
        let record = Record(id: "\(prefix)-\(counter)", request: request, state: .pending, sent: false)
        records.append(record)
        trim()
        return record.command
    }

    public func record(_ id: String) -> Record? {
        records.first { $0.id == id }
    }

    /// The newest command matching `predicate`.
    public func latest(where predicate: (PanelRequest) -> Bool) -> Record? {
        records.last { predicate($0.request) }
    }

    /// Whether the write of `id` went through.
    public mutating func markSent(_ id: String, written: Bool) {
        markSent(id, written ? .written : .retryLater)
    }

    /// Records what became of a write of `id`: an oversize line fails as `invalid`, for good.
    public mutating func markSent(_ id: String, _ outcome: SendOutcome) {
        guard let i = index(id), records[i].state == .pending else { return }
        switch outcome {
        case .written: records[i].sent = true
        case .retryLater: break
        case .oversize: records[i].state = .failed(.invalid)
        }
    }

    /// Applies an ack. Repeated identical acks change nothing; an ack for an unknown ID is ignored.
    @discardableResult
    public mutating func apply(_ ack: Ack) -> Record? {
        guard let i = index(ack.commandId) else { return nil }
        records[i].sent = true
        switch ack {
        case .ok:
            records[i].state = .ok
        case let .failed(_, code, _):
            records[i].state = .failed(code)
        }
        return records[i]
    }

    /// A preview chunk answered `id`. Settles only a pending `preview`: a chunk naming any other
    /// command changes nothing.
    public mutating func chunkArrived(for id: String) {
        guard let i = index(id), case .preview = records[i].request, records[i].state == .pending else { return }
        records[i].sent = true
        records[i].state = .ok
    }

    /// The window no longer waits for preview `id`: settle it so it is never sent again.
    public mutating func supersede(_ id: String) {
        guard let i = index(id), case .preview = records[i].request, records[i].state == .pending else { return }
        records[i].state = .superseded
    }

    /// Pending commands whose write was refused, to send again with the same ID.
    public var unsent: [NativeCommand] {
        records.filter { $0.state == .pending && !$0.sent }.map(\.command)
    }

    /// A fresh core is running: returns the pending decisions to re-send with their IDs, settles
    /// pending toggles and refreshes as `unknown`, and fails pending previews.
    public mutating func coreRestarted() -> [NativeCommand] {
        var resend: [NativeCommand] = []
        for i in records.indices where records[i].state == .pending {
            if records[i].request.isDecision {
                records[i].sent = false
                resend.append(records[i].command)
            } else if records[i].request.isMutation {
                records[i].state = .unknown
            } else {
                records[i].state = .failed(.unavailable)
            }
        }
        return resend
    }

    /// Settles `id` as `ok`: a refusal that the latest frame shows was moot.
    public mutating func settle(_ id: String) {
        guard let i = index(id) else { return }
        records[i].state = .ok
    }

    /// Re-sends a decision or refresh that failed for a passing reason (`AckFailureCode.isRetryable`)
    /// or whose write was refused, with its own ID. Previews restart from their first chunk through
    /// a new command instead, and toggles are toggled again, so neither is retried here.
    public mutating func retry(_ id: String) -> NativeCommand? {
        guard canRetry(id), let i = index(id) else { return nil }
        if case .failed = records[i].state {
            records[i].state = .pending
            records[i].sent = false
        }
        return records[i].command
    }

    /// Whether `retry(id)` would send something.
    public func canRetry(_ id: String) -> Bool {
        guard let record = record(id), record.request.isMutation, !record.request.isToggle else { return false }
        switch record.state {
        case let .failed(code): return code.isRetryable
        case .pending: return !record.sent
        case .ok, .unknown, .superseded: return false
        }
    }

    private func index(_ id: String) -> Int? {
        records.firstIndex { $0.id == id }
    }

    /// Drops the oldest settled commands first, then the oldest of any kind.
    private mutating func trim() {
        while records.count > Self.capacity {
            if let i = records.firstIndex(where: { $0.state != .pending }) {
                records.remove(at: i)
            } else {
                records.removeFirst()
            }
        }
    }
}
