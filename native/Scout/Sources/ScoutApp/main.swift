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
        }
        frontmost.onChange = { [weak self] bundleId in
            self?.sidecar.send(.frontmost(bundleId: bundleId, date: Date()))
        }
        // Window commands the pipe refused are re-sent with their own IDs.
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

    func applicationWillTerminate(_ notification: Notification) {
        resendTimer?.invalidate()
        frontmost.stop()
        sidecar.shutdown()
    }

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
        }
        render()
    }

    private func send(_ command: NativeCommand?) {
        send(command.map { [$0] } ?? [])
    }

    private func send(_ commands: [NativeCommand]) {
        for command in commands {
            model.markSent(command, written: sidecar.send(command))
        }
        render()
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
