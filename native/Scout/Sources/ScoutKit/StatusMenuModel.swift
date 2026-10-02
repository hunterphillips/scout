import Foundation

/// The menu-bar item's menu (P4.2): a status line, Pause/Resume, Show/Hide window, and Quit. A
/// pure value the app renders into an `NSMenu`; AppKit stays in ScoutApp.
public struct StatusMenuModel: Sendable, Equatable {
    public struct Item: Sendable, Equatable {
        public let title: String
        public let enabled: Bool

        public init(_ title: String, enabled: Bool) {
            self.title = title
            self.enabled = enabled
        }
    }

    /// Disabled; it only reports.
    public let status: Item
    public let pause: Item
    public let pauseAccessibilityLabel: String
    public let window: Item
    /// Always enabled: Quit goes through `TerminationPolicy`, which never cancels a second Quit.
    public let quit: Item

    /// Pause comes from `model.pauseControl`, the same control the window's Settings button shows.
    public init(_ model: PanelModel, windowVisible: Bool) {
        status = Item(model.quitting ? "Scout: quitting…" : "Scout: \(Self.describe(model.sidecar))", enabled: false)
        let pause = model.pauseControl
        self.pause = Item(pause.title, enabled: pause.enabled)
        pauseAccessibilityLabel = pause.accessibilityLabel
        window = Item(windowVisible ? "Hide window" : "Show window", enabled: true)
        quit = Item("Quit Scout", enabled: true)
    }

    public static func describe(_ sidecar: SidecarStatus) -> String {
        switch sidecar {
        case .starting: return "starting"
        case .running: return "running"
        case .stopped: return "stopped"
        case .setupNeeded: return "setup needed"
        }
    }
}

/// Whether the app shows its window at launch: only when `SCOUT_WINDOW` is exactly `1`. Otherwise
/// the window is created the first time the user picks Show window.
public enum WindowLaunch {
    public static let environmentKey = "SCOUT_WINDOW"

    public static func showsWindowAtLaunch(environment: [String: String]) -> Bool {
        environment[environmentKey] == "1"
    }
}
