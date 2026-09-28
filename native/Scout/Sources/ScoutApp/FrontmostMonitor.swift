import AppKit

/// Reports the frontmost app's bundle id whenever it changes. Uses the activation
/// notification plus a 2 s poll that catches missed activations (Rook's pattern).
@MainActor
final class FrontmostMonitor {
    var onChange: ((String) -> Void)?
    private(set) var current: String?

    private var observer: NSObjectProtocol?
    private var pollTimer: Timer?

    func start() {
        guard observer == nil else { return }
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            let bundleId = app.flatMap(Self.bundleId(of:))
            MainActor.assumeIsolated { self?.observe(bundleId) }
        }
        pollTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
        poll()
    }

    func stop() {
        if let observer {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        observer = nil
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func poll() {
        observe(NSWorkspace.shared.frontmostApplication.flatMap(Self.bundleId(of:)))
    }

    private func observe(_ bundleId: String?) {
        guard let bundleId, bundleId != current else { return }
        current = bundleId
        onChange?(bundleId)
    }

    /// Scout itself never counts as the frontmost app.
    private nonisolated static func bundleId(of app: NSRunningApplication) -> String? {
        guard app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return nil }
        return app.bundleIdentifier
    }
}
