import Foundation

/// Allows at most `maxRestarts` restarts within any sliding `window`.
/// The caller passes the current time, so tests control the clock.
public struct RestartPolicy: Sendable {
    public let maxRestarts: Int
    public let window: TimeInterval
    private var restarts: [Date] = []

    public init(maxRestarts: Int = 3, window: TimeInterval = 60) {
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
