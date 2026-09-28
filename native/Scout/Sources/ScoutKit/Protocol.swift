import Foundation

// Wire types for the JSONL link between the app and the scout-core sidecar.
// Mirrors `PanelState` and `NativeCommand` in packages/contracts.

public enum CoreStatus: String, Sendable, Equatable, Decodable {
    case idle, working, paused, disconnected
}

public struct ResultItem: Sendable, Equatable, Decodable {
    public let candidateId: String
    public let title: String
    public let href: String
    public let reason: String

    public init(candidateId: String, title: String, href: String, reason: String) {
        self.candidateId = candidateId
        self.title = title
        self.href = href
        self.reason = reason
    }
}

public enum ResultsOutcome: Sendable, Equatable {
    case ok([ResultItem])
    case empty
    case unavailable(String)
    case error(String)
}

/// Core -> app.
public enum PanelState: Sendable, Equatable {
    case state(status: CoreStatus, visitEpoch: Int?, detail: String?)
    case results(visitEpoch: Int, outcome: ResultsOutcome)

    /// Decodes one JSONL line. Returns nil for anything that doesn't match the contract.
    public static func decode(line: Data) -> PanelState? {
        guard let raw = try? JSONDecoder().decode(Raw.self, from: line) else {
            return nil
        }
        switch raw.type {
        case "state":
            guard let name = raw.status, let status = CoreStatus(rawValue: name) else {
                return nil
            }
            return .state(status: status, visitEpoch: raw.visitEpoch, detail: raw.detail)
        case "results":
            guard let epoch = raw.visitEpoch else { return nil }
            switch raw.status {
            case "ok":
                guard let items = raw.items else { return nil }
                return .results(visitEpoch: epoch, outcome: .ok(items))
            case "empty":
                guard raw.items != nil else { return nil }
                return .results(visitEpoch: epoch, outcome: .empty)
            case "unavailable":
                guard let reason = raw.reason else { return nil }
                return .results(visitEpoch: epoch, outcome: .unavailable(reason))
            case "error":
                guard let reason = raw.reason else { return nil }
                return .results(visitEpoch: epoch, outcome: .error(reason))
            default:
                return nil
            }
        default:
            return nil
        }
    }

    private struct Raw: Decodable {
        let type: String
        let status: String?
        let visitEpoch: Int?
        let detail: String?
        let items: [ResultItem]?
        let reason: String?
    }
}

/// App -> core.
public enum NativeCommand: Sendable, Equatable {
    /// `at` is milliseconds since the Unix epoch.
    case frontmost(bundleId: String, at: Int64)
    case pause
    case resume
    case shutdown

    /// One JSON object followed by a newline.
    public func jsonLine() -> Data {
        var object: [String: Any]
        switch self {
        case let .frontmost(bundleId, at):
            object = ["type": "frontmost", "bundleId": bundleId, "at": at]
        case .pause:
            object = ["type": "pause"]
        case .resume:
            object = ["type": "resume"]
        case .shutdown:
            object = ["type": "shutdown"]
        }
        // Only strings and integers above, so serialization cannot fail.
        var data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        data.append(0x0A)
        return data
    }

    public static func frontmost(bundleId: String, date: Date) -> NativeCommand {
        .frontmost(bundleId: bundleId, at: Int64((date.timeIntervalSince1970 * 1000).rounded(.down)))
    }
}
