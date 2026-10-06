// Scout's Mac app: the engine's windowless home. A menu-bar accessory that supervises the
// scout-core sidecar, reports the frontmost app to it, and quits through TerminationPolicy. Its
// menu holds a status line, Pause/Resume, and Quit. Model logic lives in ScoutKit.
//
// Never activating: nothing here calls `activate` on the app, so a frame can never bring
// Scout forward. ScoutKitTests' AppSourceGuardTests scans these sources and fails if an
// activation call appears.
import AppKit
import ScoutKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let sidecar = SidecarProcess()
    private let frontmost = FrontmostMonitor()
    private var model = MenuModel()

    private var statusItem: NSStatusItem?
    private let statusLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let pauseItem = NSMenuItem(title: "Pause", action: #selector(pauseFromMenu), keyEquivalent: "")
    /// ⌘Q works only while the status menu is open: an accessory app has no main menu.
    private let quitItem = NSMenuItem(title: "Quit Scout", action: #selector(quit), keyEquivalent: "q")

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildStatusItem()
        sidecar.onStatus = { [weak self] status in
            guard let self else { return }
            model.apply(status)
            // A fresh sidecar needs to know what is frontmost right now.
            if status == .running, let bundleId = frontmost.current {
                sidecar.send(.frontmost(bundleId: bundleId, date: Date()))
            }
            updateMenu()
        }
        sidecar.onPanelState = { [weak self] state in
            guard let self else { return }
            model.apply(state)
            updateMenu()
        }
        frontmost.onChange = { [weak self] bundleId in
            self?.sidecar.send(.frontmost(bundleId: bundleId, date: Date()))
        }
        sidecar.start()
        frontmost.start()
    }

    /// Quitting waits for the core: it gets `SidecarProcess.hardStopAllowance` (7 s) to stop its
    /// jobs and exit (its own deadline is 5 s), then is terminated and killed. AppKit gives
    /// `applicationWillTerminate` no supported way to wait that long without freezing the app's
    /// run loop, so the wait happens here instead: `.terminateLater` keeps the app running (in the
    /// modal-panel run-loop mode, which the main queue still serves) until
    /// `reply(toApplicationShouldTerminate:)` once the sidecar is gone. The decision is
    /// ScoutKit's `TerminationPolicy`: a second Quit while one is pending waits for the same reply
    /// (never `.terminateCancel`, which left Quit stuck); with no sidecar running, quit at once.
    /// The menu's Quit reaches here through `NSApp.terminate`; nothing bypasses it.
    private var terminating = false

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let decision = TerminationPolicy.decide(shutdownPending: terminating, sidecarRunning: sidecar.isRunning)
        if decision.beginShutdown {
            terminating = true
            // Pause and Resume go disabled.
            model.beginQuit()
            frontmost.stop()
            sidecar.beginShutdown {
                NSApp.reply(toApplicationShouldTerminate: true)
            }
            updateMenu()
        }
        switch decision.reply {
        case .now: return .terminateNow
        case .later: return .terminateLater
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        frontmost.stop()
        // Normally already stopped by applicationShouldTerminate; this is the fallback for a
        // termination that skipped it, and returns at once when nothing is running.
        sidecar.shutdown()
    }

    // MARK: Menu bar

    private func buildStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            button.image = Self.markImage()
        }
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self
        statusLine.isEnabled = false
        for menuItem in [pauseItem, quitItem] { menuItem.target = self }
        menu.addItem(statusLine)
        menu.addItem(.separator())
        menu.addItem(pauseItem)
        menu.addItem(.separator())
        menu.addItem(quitItem)
        item.menu = menu
        statusItem = item
        updateMenu()
    }

    /// Scout's mark (a ring with a dot spotted up-right; `packages/browser-extension/assets/mark.svg`)
    /// as a one-colour template image, so the menu bar tints it for light and dark mode.
    static func markImage() -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
            // The 24-unit mark scaled to 18 pt: ring r 8 at (12, 12), dot r 3 at (15, 9).
            let s: CGFloat = 18.0 / 24.0
            let ring = NSBezierPath(ovalIn: NSRect(x: (12 - 8) * s, y: (12 - 8) * s, width: 16 * s, height: 16 * s))
            ring.lineWidth = 2.4 * s
            NSColor.black.setStroke()
            ring.stroke()
            NSColor.black.setFill()
            NSBezierPath(ovalIn: NSRect(x: (15 - 3) * s, y: (9 - 3) * s, width: 6 * s, height: 6 * s)).fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Scout"
        return image
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        updateMenu()
    }

    private func updateMenu() {
        let menu = StatusMenuModel(model)
        statusLine.title = menu.status.title
        pauseItem.title = menu.pause.title
        pauseItem.isEnabled = menu.pause.enabled
        pauseItem.setAccessibilityLabel(menu.pauseAccessibilityLabel)
        quitItem.title = menu.quit.title
        quitItem.isEnabled = menu.quit.enabled
        statusItem?.button?.toolTip = menu.status.title
    }

    /// The control settles only when the core's `state` frame shows the change (`PauseState`).
    @objc private func pauseFromMenu() {
        guard let command = model.requestPauseOrResume() else { return }
        model.pauseSent(sidecar.send(command))
        updateMenu()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

signal(SIGPIPE, SIG_IGN)
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
