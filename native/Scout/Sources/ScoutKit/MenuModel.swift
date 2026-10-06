import Foundation

/// What the menu-bar item shows: the sidecar's status, the core's pause state, and whether the
/// app is quitting. A pure value: sidecar and core events go through `apply`, the Pause/Resume
/// click through `requestPauseOrResume`.
public struct MenuModel: Sendable, Equatable {
    public private(set) var sidecar: SidecarStatus = .starting
    /// Pause as the core's `state` frames report it, and the app's request in flight.
    public private(set) var pause = PauseState()

    public init() {}

    /// The latest `state` frame's status; nil while no core is running.
    public var core: CoreStatus? { pause.core }

    public var quitting: Bool { pause.quitting }

    public mutating func apply(_ status: SidecarStatus) {
        let wasRunning = sidecar == .running
        sidecar = status
        if status != .running {
            pause.coreStopped()
        } else if !wasRunning {
            pause.coreRestarted()
        }
    }

    public mutating func apply(_ state: PanelState) {
        switch state {
        case let .state(frame): pause.apply(frame.status)
        }
    }

    public var pauseControl: PauseControl { pause.control }

    /// The user clicked Pause or Resume: the command to send, or nil while one is in flight or the
    /// app is quitting. Report the write with `pauseSent`.
    public mutating func requestPauseOrResume() -> NativeCommand? {
        pause.request()
    }

    public mutating func pauseSent(_ outcome: SendOutcome) {
        pause.sent(outcome)
    }

    /// The app began quitting: Pause and Resume stay disabled from now on.
    public mutating func beginQuit() {
        pause.beginQuit()
    }

    public var statusLine: String {
        if quitting { return "Scout: quitting…" }
        switch sidecar {
        case .starting: return "Scout: starting…"
        case let .setupNeeded(reason): return "Scout: setup needed. \(reason)"
        case .stopped: return Self.stoppedText
        case .running: return "Scout: \(core?.rawValue ?? "running")"
        }
    }

    static var stoppedText: String {
        "Scout kept stopping (\(RestartPolicy.defaultMaxRestarts) times in "
            + "\(describe(RestartPolicy.defaultWindow))). Quit and reopen Scout."
    }

    static func describe(_ window: Double) -> String {
        let seconds = Int(window)
        if seconds == 60 { return "a minute" }
        if seconds % 60 == 0 { return "\(seconds / 60) minutes" }
        return "\(seconds) seconds"
    }
}
