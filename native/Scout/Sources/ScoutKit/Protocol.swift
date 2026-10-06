import Foundation

// Wire types for the JSONL link between the app and the scout-core sidecar: the slice of
// `PanelState` and `NativeCommand` in packages/contracts (panel.ts) the menu bar uses. The core
// sends the app `state` frames only; any other line decodes to nil and is skipped.

public enum CoreStatus: String, Sendable, Equatable, Decodable {
    case idle, working, paused, disconnected
}

/// A `state` frame. `permitted` is present on `idle` only: whether a visit to a Chrome-permitted
/// origin is current. `jobId` is present on `working` only: the job a spinner belongs to.
public struct StateFrame: Sendable, Equatable {
    public let status: CoreStatus
    public let visitEpoch: Int?
    public let detail: String?
    public let permitted: Bool?
    public let jobId: String?

    public init(status: CoreStatus, visitEpoch: Int? = nil, detail: String? = nil, permitted: Bool? = nil, jobId: String? = nil) {
        self.status = status
        self.visitEpoch = visitEpoch
        self.detail = detail
        self.permitted = permitted
        self.jobId = jobId
    }
}

/// Bounds from packages/contracts (panel.ts).
public enum PanelLimits {
    /// macOS `PIPE_BUF` (`sys/syslimits.h`), the largest write a pipe takes whole or not at all:
    /// one command line, newline included, must be shorter than this.
    public static let commandMaxBytes = 512
}

/// Core -> app.
public enum PanelState: Sendable, Equatable {
    case state(StateFrame)

    /// Decodes one JSONL line. Returns nil for any other frame type and for anything that doesn't
    /// match the contract.
    public static func decode(line: Data) -> PanelState? {
        guard let raw = try? JSONDecoder().decode(Raw.self, from: line), raw.type == "state",
              let name = raw.status, let status = CoreStatus(rawValue: name) else {
            return nil
        }
        if let jobId = raw.jobId {
            guard status == .working, isToken(jobId) else { return nil }
        }
        return .state(StateFrame(status: status, visitEpoch: raw.visitEpoch, detail: raw.detail, permitted: raw.permitted, jobId: raw.jobId))
    }

    /// `[A-Za-z0-9_-]{1,64}`, the contract's job ID.
    static func isToken(_ s: String) -> Bool {
        (1...64).contains(s.utf8.count) && s.utf8.allSatisfy { b in
            (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || b == 0x5F || b == 0x2D
        }
    }

    private struct Raw: Decodable {
        let type: String
        let status: String?
        let visitEpoch: Int?
        let detail: String?
        let permitted: Bool?
        let jobId: String?
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
        let object: [String: Any]
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
        let options: JSONSerialization.WritingOptions = [.sortedKeys, .withoutEscapingSlashes]
        var data = (try? JSONSerialization.data(withJSONObject: object, options: options)) ?? Data()
        data.append(0x0A)
        return data
    }

    public static func frontmost(bundleId: String, date: Date) -> NativeCommand {
        .frontmost(bundleId: bundleId, at: Int64((date.timeIntervalSince1970 * 1000).rounded(.down)))
    }
}
