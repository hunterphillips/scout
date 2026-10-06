import Foundation

/// The menu-bar item's menu: a status line, Pause/Resume, and Quit. A pure value the app renders
/// into an `NSMenu`; AppKit stays in ScoutApp.
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
    /// Always enabled: Quit goes through `TerminationPolicy`, which never cancels a second Quit.
    public let quit: Item

    public init(_ model: MenuModel) {
        status = Item(model.statusLine, enabled: false)
        let pause = model.pauseControl
        self.pause = Item(pause.title, enabled: pause.enabled)
        pauseAccessibilityLabel = pause.accessibilityLabel
        quit = Item("Quit Scout", enabled: true)
    }
}
