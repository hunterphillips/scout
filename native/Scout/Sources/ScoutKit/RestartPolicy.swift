import Foundation

/// Allows at most `maxRestarts` restarts within any sliding `window`.
/// The caller passes the current time, so tests control the clock.
public struct RestartPolicy: Sendable {
    public let maxRestarts: Int
    public let window: TimeInterval
    private var restarts: [Date] = []

    public static let defaultMaxRestarts = 3
    public static let defaultWindow: TimeInterval = 60

    public init(maxRestarts: Int = defaultMaxRestarts, window: TimeInterval = defaultWindow) {
        self.maxRestarts = maxRestarts
        self.window = window
    }

    /// Returns true and records a restart if one is allowed at `now`; otherwise false.
    public mutating func recordRestart(at now: Date) -> Bool {
        restarts.removeAll { now.timeIntervalSince($0) >= window }
        guard restarts.count < maxRestarts else { return false }
        restarts.append(now)
        return true
    }
}
