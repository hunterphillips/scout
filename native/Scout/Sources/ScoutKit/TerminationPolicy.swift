import Foundation

/// The answer to AppKit's `applicationShouldTerminate` (the decision only; the app applies it).
///
/// Quitting waits for the core: with the sidecar running, the first request begins its shutdown
/// and answers "later"; the shutdown's completion replies. A request that arrives while that
/// shutdown is pending also answers "later" (the pending reply ends the app), never "cancel",
/// which would leave Quit stuck. With no sidecar running there is nothing to wait for: "now".
public enum TerminationPolicy {
    public enum Reply: Sendable, Equatable {
        case now
        case later
    }

    public struct Decision: Sendable, Equatable {
        public let reply: Reply
        /// Whether the app should begin the sidecar's shutdown now.
        public let beginShutdown: Bool

        public init(reply: Reply, beginShutdown: Bool) {
            self.reply = reply
            self.beginShutdown = beginShutdown
        }
    }

    public static func decide(shutdownPending: Bool, sidecarRunning: Bool) -> Decision {
        guard sidecarRunning else { return Decision(reply: .now, beginShutdown: false) }
        return Decision(reply: .later, beginShutdown: !shutdownPending)
    }
}
