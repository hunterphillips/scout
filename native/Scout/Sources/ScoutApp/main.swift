// Scout's Mac app: the engine's windowless home (P4.2). A menu-bar accessory that supervises the
// scout-core sidecar, reports the frontmost app to it, and quits through TerminationPolicy. Its
// menu holds a status line, Pause/Resume, Show/Hide window, and Quit. The floating window
// (ScoutPanel) is hidden by default: it is created on the first Show window, or at launch with
// SCOUT_WINDOW=1, and closing it hides it. Core frames always reach the model, so the window is
// current whenever it is shown. Model logic lives in ScoutKit.
//
// Never activating (P2.5): nothing here or in ScoutPanel calls `activate` on the app, so a
// `results` frame (or any frame) can never bring Scout forward. The window is a non-activating
// panel ordered front with `orderFrontRegardless`. ScoutKitTests' AppSourceGuardTests scans these
// sources and fails if an activation call appears.
import AppKit
import ScoutKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate {
    private let sidecar = SidecarProcess()
    private let frontmost = FrontmostMonitor()
    private var model = PanelModel()
    /// Created on first use; it then lives (hidden or shown) until the app quits.
    private var panel: ScoutPanel?
    private var resendTimer: Timer?

    private var statusItem: NSStatusItem?
    private let statusLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let pauseItem = NSMenuItem(title: "Pause", action: #selector(pauseFromMenu), keyEquivalent: "")
    private let windowItem = NSMenuItem(title: "Show window", action: #selector(toggleWindow), keyEquivalent: "")
    /// ⌘Q works only while the status menu is open: an accessory app has no main menu.
    private let quitItem = NSMenuItem(title: "Quit Scout", action: #selector(quit), keyEquivalent: "q")

    /// Opens only links the core authorized for a click, never anything on its own, and only in
    /// Chrome (`chromeBundleId` in ~/.scout/config.json, default Chrome): never the default browser.
    private let linkOpener = LinkOpener { [chromeBundleId = ScoutConfig.chromeBundleId()] url, done in
        guard let chrome = NSWorkspace.shared.urlForApplication(withBundleIdentifier: chromeBundleId) else {
            done(false)
            return
        }
        NSWorkspace.shared.open([url], withApplicationAt: chrome, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            done(error == nil)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildStatusItem()
        if WindowLaunch.showsWindowAtLaunch(environment: ProcessInfo.processInfo.environment) {
            showWindow()
        }
        sidecar.onStatus = { [weak self] status in
            guard let self else { return }
            let resend = model.apply(status)
            // A fresh sidecar needs to know what is frontmost right now.
            if status == .running, let bundleId = frontmost.current {
                sidecar.send(.frontmost(bundleId: bundleId, date: Date()))
            }
            send(resend)
        }
        sidecar.onPanelState = { [weak self] state in
            guard let self else { return }
            send(model.apply(state))
            openAuthorizedLinks()
        }
        frontmost.onChange = { [weak self] bundleId in
            self?.sidecar.send(.frontmost(bundleId: bundleId, date: Date()))
        }
        // Window commands the pipe refused for now are re-sent with their own IDs.
        resendTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.sidecar.status == .running else { return }
                let unsent = self.model.commands.unsent
                if !unsent.isEmpty { self.send(unsent) }
            }
        }
        render()
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
            // Pause and Resume go disabled in the window and the menu alike.
            model.beginQuit()
            resendTimer?.invalidate()
            frontmost.stop()
            sidecar.beginShutdown {
                NSApp.reply(toApplicationShouldTerminate: true)
            }
            render()
        }
        switch decision.reply {
        case .now: return .terminateNow
        case .later: return .terminateLater
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        resendTimer?.invalidate()
        frontmost.stop()
        // Normally already stopped by applicationShouldTerminate; this is the fallback for a
        // termination that skipped it, and returns at once when nothing is running.
        sidecar.shutdown()
    }

    /// The close button hides the window; Scout keeps running in the menu bar. Escape never
    /// reaches here: ScoutWindow turns it into a collapse.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        panel?.hide()
        updateMenu()
        return false
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
        for menuItem in [pauseItem, windowItem, quitItem] { menuItem.target = self }
        menu.addItem(statusLine)
        menu.addItem(.separator())
        menu.addItem(pauseItem)
        menu.addItem(windowItem)
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
        let menu = StatusMenuModel(model, windowVisible: panel?.isVisible ?? false)
        statusLine.title = menu.status.title
        pauseItem.title = menu.pause.title
        pauseItem.isEnabled = menu.pause.enabled
        pauseItem.setAccessibilityLabel(menu.pauseAccessibilityLabel)
        windowItem.title = menu.window.title
        windowItem.isEnabled = menu.window.enabled
        quitItem.title = menu.quit.title
        quitItem.isEnabled = menu.quit.enabled
        statusItem?.button?.toolTip = menu.status.title
    }

    @objc private func pauseFromMenu() {
        pauseOrResume()
    }

    @objc private func toggleWindow() {
        if panel?.isVisible == true {
            panel?.hide()
            updateMenu()
        } else {
            showWindow()
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    /// Creates the window on first use and shows it, current with every frame received so far.
    private func showWindow() {
        if panel == nil {
            let panel = ScoutPanel { [weak self] action in self?.handle(action) }
            panel.window.delegate = self
            panel.window.isReleasedWhenClosed = false
            self.panel = panel
        }
        panel?.render(model)
        panel?.show()
        updateMenu()
    }

    // MARK: Actions

    private func handle(_ action: PanelAction) {
        switch action {
        case .toggleExpanded:
            model.toggleExpanded()
        case let .select(section):
            model.select(section)
        case let .preview(key):
            send(model.showPreview(key))
        case let .restartPreview(key):
            send(model.restartPreview(key))
        case let .approve(key):
            send(model.approve(key))
        case let .decline(key):
            send(model.decline(key))
        case let .revoke(resourceId):
            send(model.revoke(resourceId))
        case let .setAutoAcquire(origin, enabled, acknowledgeRisk):
            send(model.setAutoAcquire(origin: origin, enabled: enabled, acknowledgeRisk: acknowledgeRisk))
        case let .setBrowserContext(enabled):
            send(model.setAgentBrowserContext(enabled))
        case .pauseOrResume:
            pauseOrResume()
        case .refresh:
            send(model.refreshCapabilities())
        case let .retry(id):
            send(model.retry(id))
        case let .dismiss(id):
            model.dismiss(id)
        case let .openResult(candidateId):
            send(model.openResult(candidateId))
        }
        render()
    }

    /// The one pause path for the window and the menu bar. The control settles only when the
    /// core's `state` frame shows the change (`PauseState`).
    private func pauseOrResume() {
        guard let command = model.requestPauseOrResume() else { return }
        model.pauseSent(sidecar.send(command))
        render()
    }

    private func send(_ command: NativeCommand?) {
        send(command.map { [$0] } ?? [])
    }

    private func send(_ commands: [NativeCommand]) {
        for command in commands {
            model.markSent(command, sidecar.send(command))
        }
        render()
    }

    /// Opens what the core authorized for the user's clicks (open_link acks), each checked again.
    /// Only the window sends open_link from this app; the Chrome side panel's clicks never reach
    /// it. Without a window the queue is drained and dropped, so a link authorized while there was
    /// no window can never open on a later Show window.
    private func openAuthorizedLinks() {
        let requests = model.takeLinksToOpen()
        guard panel != nil, !requests.isEmpty else { return }
        for request in requests {
            let commandId = request.commandId
            // The opener may answer from another thread; Problems lists a refusal.
            linkOpener.open(request.href, origin: request.origin) { [weak self] refusal in
                guard let refusal else { return }
                Task { @MainActor in
                    guard let self else { return }
                    self.model.linkRefused(commandId: commandId, refusal)
                    self.render()
                }
            }
        }
    }

    private func render() {
        panel?.render(model)
        updateMenu()
    }
}

signal(SIGPIPE, SIG_IGN)
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
