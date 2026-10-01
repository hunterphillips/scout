import Foundation

/// Issues command IDs for Scout's window and follows each command to its ack.
///
/// A command is `pending` from the moment it is issued until an ack (or, for `preview`, its
/// chunk) arrives. A write the pipe refused leaves it pending and `unsent`; the app re-sends
/// unsent commands with the same ID. When the core restarts, every still-pending mutation is
/// re-sent with the same ID: the new core re-checks it against the store, and the
/// `expectedRevision` inside keeps a stale change from applying. Pending previews fail as
/// `unavailable` instead (their cursors died with the old core); the user restarts them.
/// A retry never draws a new ID, so one decision can never become two commands.
public struct CommandTracker: Sendable, Equatable {
    public static let capacity = 64

    public enum State: Sendable, Equatable {
        case pending
        case ok
        case failed(AckFailureCode)
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
        guard let i = index(id), records[i].state == .pending else { return }
        records[i].sent = records[i].sent || written
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

    /// A preview chunk answered `id`.
    public mutating func chunkArrived(for id: String) {
        guard let i = index(id) else { return }
        records[i].sent = true
        records[i].state = .ok
    }

    /// Pending commands whose write was refused, to send again with the same ID.
    public var unsent: [NativeCommand] {
        records.filter { $0.state == .pending && !$0.sent }.map(\.command)
    }

    /// A fresh core is running: returns the pending mutations to re-send with their IDs, and
    /// fails pending previews.
    public mutating func coreRestarted() -> [NativeCommand] {
        var resend: [NativeCommand] = []
        for i in records.indices where records[i].state == .pending {
            if records[i].request.isMutation {
                records[i].sent = false
                resend.append(records[i].command)
            } else {
                records[i].state = .failed(.unavailable)
            }
        }
        return resend
    }

    /// Re-sends a failed mutation with its own ID. Previews restart from their first chunk
    /// through a new command instead, so they are not retried here.
    public mutating func retry(_ id: String) -> NativeCommand? {
        guard let i = index(id), records[i].request.isMutation else { return nil }
        switch records[i].state {
        case .failed:
            records[i].state = .pending
            records[i].sent = false
            return records[i].command
        case .pending where !records[i].sent:
            return records[i].command
        default:
            return nil
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
