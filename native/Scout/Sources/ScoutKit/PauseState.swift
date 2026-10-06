import Foundation

/// The menu bar's Pause/Resume control.
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

/// Pause as the core reports it, plus the app's own pause or resume still in flight.
///
/// Every place that can pause Scout (the Chrome side panel, the menu bar) follows the
/// core's `state` frame: `paused` is what the latest frame says, never what the app last sent.
/// `pause` and `resume` carry no command ID and get no ack; this reducer holds the one pending
/// request instead. It settles when a `state` frame
/// shows its target (paused for a pause, anything else for a resume): it settles on the first
/// frame showing the target, whoever caused it, and a frame the core emitted before it read the
/// request does not settle it. A write the pipe refused settles it at once (the user clicks
/// again). A stopped or restarted core settles it without re-sending: the app picked `pause` or
/// `resume` from the old core's possibly stale frame, so sending it to a new core could undo what
/// that core reports; the new core's own `state` frame decides what shows. Once the app begins
/// quitting the control stays disabled and nothing is sent.
public struct PauseState: Sendable, Equatable {
    public enum Pending: Sendable, Equatable {
        case pausing
        case resuming
    }

    /// The latest `state` frame's status; nil while no core is running or none has reported.
    public private(set) var core: CoreStatus?
    public private(set) var pending: Pending?
    public private(set) var quitting = false

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

    /// The app began quitting: no pause or resume goes out after this.
    public mutating func beginQuit() {
        quitting = true
    }

    /// The user clicked Pause or Resume: returns the command to send and marks it pending, or nil
    /// while one is pending, the app is quitting, or there is nothing to send.
    public mutating func request() -> NativeCommand? {
        guard pending == nil, !quitting, let command else { return nil }
        pending = command == .pause ? .pausing : .resuming
        return command
    }

    /// What became of the write of the requested command.
    public mutating func sent(_ outcome: SendOutcome) {
        if outcome != .written { pending = nil }
    }

    public var control: PauseControl {
        let control = idleControl
        guard quitting else { return control }
        return PauseControl(title: control.title, enabled: false, accessibilityLabel: control.accessibilityLabel)
    }

    private var idleControl: PauseControl {
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
