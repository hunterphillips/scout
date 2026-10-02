import Foundation

/// The one Pause/Resume control the window's Settings button and the menu-bar item both show.
public struct PauseControl: Sendable, Equatable {
    public let title: String
    public let enabled: Bool
    public let accessibilityLabel: String

    public init(title: String, enabled: Bool, accessibilityLabel: String) {
        self.title = title
        self.enabled = enabled
        self.accessibilityLabel = accessibilityLabel
    }
}

/// Pause as the core reports it, plus the app's own pause or resume still in flight (P4.2).
///
/// Every place that can pause Scout (the Chrome side panel, the window, the menu bar) follows the
/// core's `state` frame: `paused` is what the latest frame says, never what the app last sent.
/// `pause` and `resume` carry no command ID and get no ack, so `CommandTracker` cannot follow
/// them; this reducer holds the one pending request instead. It settles when a `state` frame
/// shows its target (paused for a pause, anything else for a resume), whoever caused it; a frame
/// the core emitted before it read the request does not settle it. A write the pipe refused
/// settles it at once (the user clicks again). A stopped or restarted core settles it without
/// re-sending: pause is a toggle, and the new core's own `state` frame decides what shows (the
/// P2.5 rule for toggles).
public struct PauseState: Sendable, Equatable {
    public enum Pending: Sendable, Equatable {
        case pausing
        case resuming
    }

    /// The latest `state` frame's status; nil while no core is running or none has reported.
    public private(set) var core: CoreStatus?
    public private(set) var pending: Pending?

    public init(core: CoreStatus? = nil, pending: Pending? = nil) {
        self.core = core
        self.pending = pending
    }

    /// A `state` frame arrived.
    public mutating func apply(_ status: CoreStatus) {
        core = status
        switch pending {
        case .pausing where status == .paused: pending = nil
        case .resuming where status != .paused: pending = nil
        default: break
        }
    }

    /// The core is not running (starting, stopped, or setup needed).
    public mutating func coreStopped() {
        core = nil
        pending = nil
    }

    /// Another core instance answers now: the request went to the old one and is not re-sent.
    public mutating func coreRestarted() {
        pending = nil
    }

    /// What a click sends, given the latest frame: `pause` while idle or working, `resume` while
    /// paused, nothing while disconnected or with no core.
    public var command: NativeCommand? {
        switch core {
        case .paused: return .resume
        case .idle, .working: return .pause
        case .disconnected, nil: return nil
        }
    }

    /// The user clicked Pause or Resume: returns the command to send and marks it pending, or nil
    /// while one is pending or there is nothing to send.
    public mutating func request() -> NativeCommand? {
        guard pending == nil, let command else { return nil }
        pending = command == .pause ? .pausing : .resuming
        return command
    }

    /// What became of the write of the requested command.
    public mutating func sent(_ outcome: SendOutcome) {
        if outcome != .written { pending = nil }
    }

    public var control: PauseControl {
        switch pending {
        case .pausing?: return PauseControl(title: "Pausing…", enabled: false, accessibilityLabel: "Pausing Scout")
        case .resuming?: return PauseControl(title: "Resuming…", enabled: false, accessibilityLabel: "Resuming Scout")
        case nil: break
        }
        if core == .paused {
            return PauseControl(title: "Resume", enabled: true, accessibilityLabel: "Resume Scout")
        }
        return PauseControl(title: "Pause", enabled: command != nil, accessibilityLabel: "Pause Scout")
    }
}
