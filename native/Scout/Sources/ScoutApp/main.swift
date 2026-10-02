// Scout's Mac app: supervises the scout-core sidecar, reports the frontmost app to it, and
// shows its state in a floating panel (ScoutPanel). Model logic lives in ScoutKit.
import AppKit
import ScoutKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let sidecar = SidecarProcess()
    private let frontmost = FrontmostMonitor()
    private var model = PanelModel()
    private var panel: ScoutPanel?
    private var resendTimer: Timer?
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
        let panel = ScoutPanel { [weak self] action in self?.handle(action) }
        panel.window.delegate = self
        self.panel = panel
        panel.show()
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
    private var terminating = false

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let decision = TerminationPolicy.decide(shutdownPending: terminating, sidecarRunning: sidecar.isRunning)
        if decision.beginShutdown {
            terminating = true
            resendTimer?.invalidate()
            frontmost.stop()
            sidecar.beginShutdown {
                NSApp.reply(toApplicationShouldTerminate: true)
            }
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

    /// The close button quits Scout. Escape never reaches here: ScoutWindow turns it into a collapse.
    func windowWillClose(_ notification: Notification) {
        NSApp.terminate(nil)
    }

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
            if let command = model.pauseCommand() { sidecar.send(command) }
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
    private func openAuthorizedLinks() {
        let requests = model.takeLinksToOpen()
        guard !requests.isEmpty else { return }
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
    }
}

signal(SIGPIPE, SIG_IGN)
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
