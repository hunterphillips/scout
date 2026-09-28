// Phase 1 placeholder app: a floating text-only panel that shows the sidecar's status.
// Phase 4 replaces the panel.
import AppKit
import ScoutKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let sidecar = SidecarProcess()
    private let frontmost = FrontmostMonitor()
    private var model = PanelModel()
    private var panel: NSPanel?
    private let label = NSTextField(wrappingLabelWithString: "")

    func applicationDidFinishLaunching(_ notification: Notification) {
        showPanel()
        sidecar.onStatus = { [weak self] status in
            guard let self else { return }
            model.apply(status)
            render()
            // A fresh sidecar needs to know what is frontmost right now.
            if status == .running, let bundleId = frontmost.current {
                sidecar.send(.frontmost(bundleId: bundleId, date: Date()))
            }
        }
        sidecar.onPanelState = { [weak self] state in
            self?.model.apply(state)
            self?.render()
        }
        frontmost.onChange = { [weak self] bundleId in
            self?.sidecar.send(.frontmost(bundleId: bundleId, date: Date()))
        }
        render()
        sidecar.start()
        frontmost.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        frontmost.stop()
        sidecar.shutdown()
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.terminate(nil)
    }

    private func showPanel() {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 320, height: 160),
            styleMask: [.titled, .closable, .utilityWindow, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "Scout"
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.delegate = self

        label.translatesAutoresizingMaskIntoConstraints = false
        label.isSelectable = false
        let content = NSView()
        content.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            label.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
            label.topAnchor.constraint(equalTo: content.topAnchor, constant: 12),
            label.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -12),
        ])
        panel.contentView = content

        if let screen = NSScreen.main?.visibleFrame {
            panel.setFrameOrigin(NSPoint(x: screen.maxX - 336, y: screen.minY + 16))
        }
        panel.orderFrontRegardless()
        self.panel = panel
    }

    private func render() {
        label.stringValue = model.text
    }
}

signal(SIGPIPE, SIG_IGN)
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
