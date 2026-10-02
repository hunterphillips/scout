// Scout's floating window. Compact: one line (status, current host, results, offer badge) and
// a disclosure button. Expanded, by the user's click only: Results, Offers, Library, Preview,
// Settings, Activity, Problems. A result is a button; clicking it asks the core for the
// target, and only that answer, checked again by LinkOpener, opens anything. Results arriving
// never open, expand, or focus anything. It renders a `PanelModel` and reports clicks as `PanelAction`s; every
// decision lives in ScoutKit. It never activates the app and never brings itself forward on
// a new frame; the preview pane changes content only when the user picks another preview.
// Approve lives only in the Preview pane, bound to the shown version, so a list reordering
// under the pointer can never put an approval where the user clicks.
// Since P4.2 the window is hidden by default: the app creates it on the first Show window (menu
// bar) or at launch with SCOUT_WINDOW=1, and closing it only hides it.
import AppKit
import ScoutKit

enum PanelAction {
    case toggleExpanded
    case select(PanelSection)
    case preview(PreviewKey)
    case restartPreview(PreviewKey)
    case approve(PreviewKey)
    case decline(PreviewKey)
    case revoke(String)
    case setAutoAcquire(origin: String, enabled: Bool, acknowledgeRisk: Bool)
    case setBrowserContext(Bool)
    case pauseOrResume
    case refresh
    case retry(String)
    case dismiss(String)
    case openResult(candidateId: String)
}

@MainActor
final class ScoutPanel: NSObject {
    static let libraryPageSize = 25
    static let autoAcquireRisk = "Auto-acquire approves every new guide or skill this site publishes without asking you, "
        + "and your agent can use it right away. Turn it on only for sites you trust."
    static let truncatedNote = "Some items are not shown."
    static let browserContextExplainer = "Lets your interactive Claude agent ask Scout which permitted site you are on, "
        + "that site's links, and your recent activity there. Background jobs never get it. Each read is listed under Activity."

    let window: ScoutWindow
    private let onAction: (PanelAction) -> Void

    private let disclosure = NSButton()
    private let statusLabel = NSTextField(labelWithString: "")
    private let badge = NSTextField(labelWithString: "")
    private let expandedBox = NSStackView()
    private let sections = NSSegmentedControl()
    private let listScroll = NSScrollView()
    private let listStack = NSStackView()

    private let previewBox = NSStackView()
    private let previewHeader = NSTextField(wrappingLabelWithString: "")
    private let previewProgress = NSProgressIndicator()
    private let previewError = NSTextField(wrappingLabelWithString: "")
    private let previewText: NSTextView
    private let previewTextScroll: NSScrollView
    private let previewButtons = NSStackView()

    private var handlers: [ActionTarget] = []
    private var previewHandlers: [ActionTarget] = []
    private var listSignature = ""
    private var previewSignature = ""
    private var previewTextKey: (PreviewKey, Int)?
    private var libraryPage = 0
    private var lastExpanded = false
    private var placed = false

    init(onAction: @escaping (PanelAction) -> Void) {
        self.onAction = onAction
        window = ScoutWindow(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 52),
            styleMask: [.titled, .closable, .utilityWindow, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        previewTextScroll = NSTextView.scrollableTextView()
        previewText = previewTextScroll.documentView as! NSTextView
        super.init()
        window.title = "Scout"
        window.level = .floating
        window.hidesOnDeactivate = false
        window.becomesKeyOnlyIfNeeded = true
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.autorecalculatesKeyViewLoop = true
        window.onCancel = { [weak self] in
            // Escape collapses the details; it never closes (hides) the window.
            guard let self, self.lastExpanded else { return }
            self.onAction(.toggleExpanded)
        }
        build()
    }

    /// Shows the panel without activating Scout: in the bottom-right corner the first time, then
    /// wherever the user left it.
    func show() {
        if !placed, let screen = NSScreen.main?.visibleFrame {
            window.setFrameOrigin(NSPoint(x: screen.maxX - window.frame.width - 16, y: screen.minY + 16))
        }
        placed = true
        window.orderFrontRegardless()
    }

    /// Hides the panel; it keeps its state and position.
    func hide() {
        window.orderOut(nil)
    }

    var isVisible: Bool { window.isVisible }

    // MARK: Layout

    private func build() {
        disclosure.bezelStyle = .disclosure
        disclosure.setButtonType(.pushOnPushOff)
        disclosure.title = ""
        disclosure.target = self
        disclosure.action = #selector(toggle)
        disclosure.setAccessibilityLabel("Show Scout details")

        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        badge.font = .boldSystemFont(ofSize: NSFont.smallSystemFontSize)
        badge.textColor = .white
        badge.drawsBackground = true
        badge.backgroundColor = .controlAccentColor
        badge.alignment = .center
        badge.isHidden = true

        let header = NSStackView(views: [disclosure, statusLabel, badge])
        header.orientation = .horizontal
        header.spacing = 6
        // A group VoiceOver can enter: the disclosure button and status stay reachable inside it.
        header.setAccessibilityElement(true)
        header.setAccessibilityRole(.group)
        header.setAccessibilityLabel("Scout")

        sections.segmentCount = PanelSection.allCases.count
        for (i, section) in PanelSection.allCases.enumerated() {
            sections.setLabel(section.title, forSegment: i)
            sections.setWidth(0, forSegment: i)
        }
        sections.trackingMode = .selectOne
        sections.segmentStyle = .automatic
        sections.target = self
        sections.action = #selector(sectionChanged)
        sections.setAccessibilityLabel("Scout sections")
        sections.controlSize = .small

        listStack.orientation = .vertical
        listStack.alignment = .leading
        listStack.spacing = 10
        listStack.edgeInsets = NSEdgeInsets(top: 4, left: 2, bottom: 8, right: 2)
        let document = FlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        listStack.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(listStack)
        listScroll.documentView = document
        listScroll.hasVerticalScroller = true
        listScroll.drawsBackground = false
        NSLayoutConstraint.activate([
            listStack.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            listStack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            listStack.topAnchor.constraint(equalTo: document.topAnchor),
            listStack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            document.widthAnchor.constraint(equalTo: listScroll.contentView.widthAnchor),
        ])

        previewHeader.font = .systemFont(ofSize: NSFont.smallSystemFontSize, weight: .semibold)
        previewHeader.setAccessibilityLabel("Previewed version")
        previewProgress.isIndeterminate = false
        previewProgress.style = .bar
        previewProgress.minValue = 0
        previewProgress.maxValue = 1
        previewProgress.setAccessibilityLabel("Preview loading progress")
        previewError.textColor = .systemRed
        previewText.isEditable = false
        previewText.isSelectable = true
        previewText.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        previewText.setAccessibilityLabel("Preview text")
        previewTextScroll.hasVerticalScroller = true
        previewButtons.orientation = .horizontal
        previewButtons.spacing = 8
        previewBox.orientation = .vertical
        previewBox.alignment = .leading
        previewBox.spacing = 6
        for view in [previewHeader, previewProgress, previewError, previewTextScroll, previewButtons] as [NSView] {
            previewBox.addArrangedSubview(view)
            view.translatesAutoresizingMaskIntoConstraints = false
            view.widthAnchor.constraint(equalTo: previewBox.widthAnchor).isActive = true
        }
        previewTextScroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        previewTextScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 200).isActive = true

        expandedBox.orientation = .vertical
        expandedBox.alignment = .leading
        expandedBox.spacing = 8
        for view in [sections, listScroll, previewBox] as [NSView] {
            expandedBox.addArrangedSubview(view)
            view.translatesAutoresizingMaskIntoConstraints = false
        }
        listScroll.widthAnchor.constraint(equalTo: expandedBox.widthAnchor).isActive = true
        previewBox.widthAnchor.constraint(equalTo: expandedBox.widthAnchor).isActive = true
        listScroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        listScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 200).isActive = true
        previewBox.setContentHuggingPriority(.defaultLow, for: .vertical)
        expandedBox.isHidden = true

        let root = NSStackView(views: [header, expandedBox])
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = 8
        root.edgeInsets = NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
        root.translatesAutoresizingMaskIntoConstraints = false
        header.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -24).isActive = true
        expandedBox.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -24).isActive = true
        let content = NSView()
        content.addSubview(root)
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            root.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            root.topAnchor.constraint(equalTo: content.topAnchor),
            root.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        window.contentView = content
    }

    // MARK: Render

    func render(_ model: PanelModel) {
        renderHeader(model)
        expandedBox.isHidden = !model.expanded
        disclosure.state = model.expanded ? .on : .off
        disclosure.setAccessibilityLabel(model.expanded ? "Hide Scout details" : "Show Scout details")
        resize(expanded: model.expanded)
        guard model.expanded else { return }

        let problems = model.problems.count
        for (i, section) in PanelSection.allCases.enumerated() {
            let title = section == .problems && problems > 0 ? "Problems (\(problems))" : section.title
            sections.setLabel(title, forSegment: i)
        }
        sections.selectedSegment = PanelSection.allCases.firstIndex(of: model.section) ?? 0

        let showsPreview = model.section == .preview
        previewBox.isHidden = !showsPreview
        listScroll.isHidden = showsPreview
        if showsPreview {
            renderPreview(model)
        } else {
            renderList(model)
        }
    }

    private func renderHeader(_ model: PanelModel) {
        // The offer count is the badge, so the label shows the compact line without it.
        statusLabel.stringValue = model.headerLine
        let count = model.currentOffers.count
        badge.isHidden = count == 0
        badge.stringValue = " \(count) "
        badge.setAccessibilityLabel(count == 1 ? "1 offer for this site" : "\(count) offers for this site")
        statusLabel.textColor = { if case .error = model.indicator { return .systemRed } else { return .labelColor } }()
        statusLabel.setAccessibilityLabel("Scout status: \(model.compactLine)")
    }

    private func resize(expanded: Bool) {
        guard expanded != lastExpanded else { return }
        lastExpanded = expanded
        var frame = window.frame
        let size = expanded ? NSSize(width: 460, height: 560) : NSSize(width: 380, height: 52)
        let target = window.frameRect(forContentRect: NSRect(origin: .zero, size: size)).size
        // Keep the bottom-right corner where it is.
        frame.origin.x = frame.maxX - target.width
        frame.size = target
        window.setFrame(frame, display: true, animate: false)
    }

    // MARK: Lists

    private func renderList(_ model: PanelModel) {
        let signature = listSignature(model)
        guard signature != listSignature else { return }
        listSignature = signature
        let focused = (window.firstResponder as? NSView)?.identifier
        handlers.removeAll()
        listStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let rows: [NSView]
        switch model.section {
        case .results: rows = resultRows(model)
        case .offers: rows = offerRows(model)
        case .library: rows = libraryRows(model)
        case .settings: rows = settingsRows(model)
        case .activity: rows = activityRows(model)
        case .problems: rows = problemRows(model)
        case .preview: rows = []
        }
        for row in rows { listStack.addArrangedSubview(row) }
        window.recalculateKeyViewLoop()
        if let focused, let view = find(focused, in: listStack) {
            window.makeFirstResponder(view)
        }
    }

    /// Everything a list section shows; it is rebuilt only when this changes, so keyboard focus
    /// and scrolling survive unrelated frames.
    private func listSignature(_ model: PanelModel) -> String {
        let caps = model.capabilities
        let running = model.sidecar == .running
        switch model.section {
        case .results:
            let display = model.resultsDisplay
            var links = ""
            if case let .ready(items) = display {
                links = items.map { "\(String(describing: model.linkRecord($0.candidateId)))" }.joined()
            }
            return "results|\(running)|\(display)|\(links)"
        case .offers:
            let keys = caps.offers.map { PreviewKey(resourceId: $0.resourceId, version: $0.version) }
            return "offers|\(running)|\(model.currentHost ?? "")|\(caps.offers)|\(caps.capabilities?.truncated ?? false)|"
                + keys.map { "\(String(describing: model.decisionRecord($0)))\(model.canDecline($0))" }.joined()
        case .library:
            return "library|\(running)|\(libraryPage)|\(caps.library)|\(caps.origins)|\(caps.capabilities?.truncated ?? false)|"
                + caps.library.map { "\(String(describing: model.revokeRecord($0.resourceId)))\(model.canRevoke($0.resourceId))" }.joined()
        case .settings:
            return "settings|\(running)|\(String(describing: model.core))|\(String(describing: model.pauseControl))|\(String(describing: caps.agentBrowserContext))|\(caps.origins)|"
                + "\(caps.capabilities?.truncated ?? false)|"
                + "\(String(describing: model.grantRecord))"
                + caps.origins.map { String(describing: model.autoAcquireRecord($0.origin)) }.joined()
        case .activity:
            return "activity|\(caps.audit)"
        case .problems:
            return "problems|\(model.problems)"
        case .preview:
            return "preview"
        }
    }

    private func resultRows(_ model: PanelModel) -> [NSView] {
        let display = model.resultsDisplay
        let summary = Self.secondary(display.explanation)
        summary.setAccessibilityLabel("Results: \(display.explanation)")
        switch display {
        case .working:
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .small
            spinner.startAnimation(nil)
            spinner.setAccessibilityLabel("Looking for links")
            return [hstack([spinner, summary])]
        case .unavailable, .timeout, .error:
            summary.textColor = .systemOrange
            return [summary]
        case let .ready(items):
            var rows: [NSView] = [summary]
            for item in items {
                let record = model.linkRecord(item.candidateId)
                let open = button(item.title, id: "result.\(item.candidateId)",
                                  label: "Open \(item.title) on \(item.hostname)") { [onAction] in
                    onAction(.openResult(candidateId: item.candidateId))
                }
                open.lineBreakMode = .byTruncatingTail
                open.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
                open.isEnabled = model.sidecar == .running && record?.state != .pending
                let controls = [open] + commandStatus(record, what: "opening \(item.title)", model)
                rows.append(row([hstack(controls), Self.secondary(item.hostname), Self.secondary(item.reason)],
                                summary: "\(item.title), on \(item.hostname). \(item.reason)"))
            }
            return rows
        case .none, .paused, .disconnected, .empty, .cancelled:
            return [summary]
        }
    }

    private func offerRows(_ model: PanelModel) -> [NSView] {
        let caps = model.capabilities
        guard !caps.offers.isEmpty else {
            return [note(model.sidecar == .running ? "No offers. Scout lists guides and skills from sites Chrome lets it read." : "Scout core is not running.")]
        }
        let host = model.currentHost
        let offers = caps.offers.sorted { a, b in
            (CapabilityModel.host(of: a.siteOrigin) == host ? 0 : 1) < (CapabilityModel.host(of: b.siteOrigin) == host ? 0 : 1)
        }
        var rows: [NSView] = []
        if caps.capabilities?.truncated == true { rows.append(note(Self.truncatedNote)) }
        for offer in offers {
            let key = PreviewKey(resourceId: offer.resourceId, version: offer.version)
            let name = Self.resourceName(offer.kind, skill: offer.skill)
            let site = CapabilityModel.host(of: offer.siteOrigin) ?? offer.siteOrigin
            var lines = [Self.title("\(name) · \(site)")]
            if let description = offer.skill?.description { lines.append(Self.secondary(description)) }
            lines.append(Self.secondary("\(Self.bytes(offer.byteLength)) · version \(offer.version.prefix(12))"))

            let preview = button("Preview", id: "offer.\(offer.resourceId).\(offer.version).preview",
                                 label: "Preview \(name) from \(site)") { [onAction] in onAction(.preview(key)) }
            let decline = button("Decline", id: "offer.\(offer.resourceId).\(offer.version).decline",
                                 label: "Decline \(name) from \(site)") { [onAction] in onAction(.decline(key)) }
            decline.isEnabled = model.canDecline(key)
            var controls: [NSView] = [preview, decline]
            controls += commandStatus(model.decisionRecord(key), what: "decision on \(name)", model)
            rows.append(row(lines + [hstack(controls)], summary: "\(name) from \(site), \(Self.bytes(offer.byteLength))"))
        }
        return rows
    }

    private func libraryRows(_ model: PanelModel) -> [NSView] {
        let library = model.capabilities.library
        guard !library.isEmpty else { return [note("The library is empty.")] }
        let pages = max(1, (library.count + Self.libraryPageSize - 1) / Self.libraryPageSize)
        libraryPage = min(libraryPage, pages - 1)
        var rows: [NSView] = []
        if model.capabilities.capabilities?.truncated == true { rows.append(note(Self.truncatedNote)) }
        let start = libraryPage * Self.libraryPageSize
        for entry in library[start..<min(start + Self.libraryPageSize, library.count)] {
            let name = Self.resourceName(entry.kind, skill: nil)
            let site = CapabilityModel.host(of: entry.siteOrigin) ?? entry.siteOrigin
            let state: String
            switch entry.state {
            case .approved: state = "Approved"
            case .blocked: state = "Revoked"
            case .noDefault: state = "Not approved"
            }
            var lines = [Self.title("\(name) · \(site)"), Self.secondary(state + (entry.defaultVersion.map { " · default \($0.prefix(12))" } ?? ""))]
            let versions = entry.versions.map { "\($0.hash.prefix(8)) \($0.state.rawValue)" }.joined(separator: ", ")
            lines.append(Self.secondary("Versions: \(versions)"))
            if entry.versions.contains(where: { $0.state == .pending }),
               model.capabilities.originSetting(entry.siteOrigin)?.permitted != true {
                lines.append(Self.secondary(ApprovalBlocker.siteNotPermitted.reason))
            }
            var controls: [NSView] = []
            if let version = entry.defaultVersion ?? entry.versions.first?.hash {
                let key = PreviewKey(resourceId: entry.resourceId, version: version)
                controls.append(button("Preview", id: "library.\(entry.resourceId).preview",
                                       label: "Preview \(name) from \(site)") { [onAction] in onAction(.preview(key)) })
            }
            let revoke = button("Revoke", id: "library.\(entry.resourceId).revoke",
                                label: "Revoke \(name) from \(site)") { [onAction] in onAction(.revoke(entry.resourceId)) }
            revoke.isEnabled = model.canRevoke(entry.resourceId)
            controls.append(revoke)
            controls += commandStatus(model.revokeRecord(entry.resourceId), what: "revoking \(name)", model)
            rows.append(row(lines + [hstack(controls)], summary: "\(name) from \(site), \(state)"))
        }
        if pages > 1 {
            let previous = button("Previous", id: "library.page.previous", label: "Previous library page") { [weak self] in
                self?.libraryPage -= 1
                self?.listSignature = ""
                self?.onAction(.select(.library))
            }
            previous.isEnabled = libraryPage > 0
            let next = button("Next", id: "library.page.next", label: "Next library page") { [weak self] in
                self?.libraryPage += 1
                self?.listSignature = ""
                self?.onAction(.select(.library))
            }
            next.isEnabled = libraryPage < pages - 1
            rows.append(hstack([previous, Self.secondary("Page \(libraryPage + 1) of \(pages)"), next]))
        }
        return rows
    }

    private func settingsRows(_ model: PanelModel) -> [NSView] {
        var rows: [NSView] = []
        // The same control as the menu bar's Pause item: both follow the core's state frame.
        let control = model.pauseControl
        let pause = button(control.title, id: "settings.pause", label: control.accessibilityLabel) { [onAction] in
            onAction(.pauseOrResume)
        }
        pause.isEnabled = control.enabled
        let refresh = button("Refresh", id: "settings.refresh", label: "Refresh offers and library") { [onAction] in onAction(.refresh) }
        refresh.isEnabled = model.sidecar == .running
        rows.append(hstack([pause, refresh]))

        let granted = model.capabilities.agentBrowserContext ?? false
        let grant = checkbox("Let my Claude agent read browser context", id: "settings.browserContext",
                             on: granted) { [onAction] in onAction(.setBrowserContext(!granted)) }
        grant.isEnabled = model.canToggleGrant
        rows.append(row([hstack([grant] + commandStatus(model.grantRecord, what: "browser-context setting", model)),
                         Self.secondary(Self.browserContextExplainer)], summary: "Browser context for your agent"))

        let origins = model.capabilities.origins
        rows.append(Self.title("Auto-acquire"))
        rows.append(Self.secondary(Self.autoAcquireRisk))
        if model.capabilities.capabilities?.truncated == true { rows.append(note(Self.truncatedNote)) }
        if origins.isEmpty { rows.append(note("No sites yet.")) }
        for setting in origins {
            let site = CapabilityModel.host(of: setting.origin) ?? setting.origin
            let record = model.autoAcquireRecord(setting.origin)
            let box = checkbox("Auto-acquire for \(site)", id: "settings.auto.\(setting.origin)", on: setting.autoAcquire) { [weak self] in
                self?.confirmAutoAcquire(origin: setting.origin, site: site, enable: !setting.autoAcquire)
            }
            box.isEnabled = model.canToggleAutoAcquire(setting.origin)
            var views: [NSView] = [hstack([box] + commandStatus(record, what: "auto-acquire for \(site)", model))]
            if !setting.permitted { views.append(Self.secondary("Chrome does not give Scout access to \(site) right now.")) }
            rows.append(row(views, summary: "Auto-acquire for \(site)"))
        }
        return rows
    }

    private func activityRows(_ model: PanelModel) -> [NSView] {
        let audit = model.capabilities.audit
        guard !audit.isEmpty else { return [note("Your agent has not read browser context yet.")] }
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .medium
        return audit.reversed().map { entry in
            let time = formatter.string(from: Date(timeIntervalSince1970: entry.at / 1000))
            var parts = [time, entry.role.rawValue, entry.method.rawValue, entry.outcome.rawValue]
            if let origin = entry.origin { parts.append(CapabilityModel.host(of: origin) ?? origin) }
            let text = Self.secondary(parts.joined(separator: " · "))
            text.setAccessibilityLabel(parts.joined(separator: ", "))
            return text
        }
    }

    private func problemRows(_ model: PanelModel) -> [NSView] {
        let problems = model.problems
        guard !problems.isEmpty else { return [note("No problems.")] }
        return problems.map { problem in
            switch problem {
            case let .sidecar(text):
                return row([Self.title("Scout core"), Self.secondary(text)], summary: text)
            case let .conflict(conflict):
                let text = "Skill \(conflict.name) was not exported: \(conflict.code.rawValue.replacingOccurrences(of: "_", with: " "))."
                return row([Self.secondary(text)], summary: text)
            case let .command(record):
                let what = describe(record.request, model)
                guard case let .failed(code) = record.state else { return row([], summary: what) }
                let text = "\(what) failed: \(code.rawValue)"
                var controls: [NSView] = []
                if model.canRetry(record.id) {
                    controls.append(button("Retry", id: "problem.\(record.id).retry", label: "Retry \(what)") { [onAction] in
                        onAction(.retry(record.id))
                    })
                }
                controls.append(button("Dismiss", id: "problem.\(record.id).dismiss", label: "Dismiss \(what) failure") { [onAction] in
                    onAction(.dismiss(record.id))
                })
                return row([Self.secondary(text), hstack(controls)], summary: text)
            case let .link(commandId, refusal):
                let text = "Scout did not open a link: \(refusal.text)."
                let dismiss = button("Dismiss", id: "problem.\(commandId).link", label: "Dismiss link problem") { [onAction] in
                    onAction(.dismiss(commandId))
                }
                return row([Self.secondary(text), dismiss], summary: text)
            case let .preview(key, failure):
                let text = "Preview of version \(key.version.prefix(12)) failed: \(Self.describe(failure))"
                let again = button("Load again", id: "problem.preview.\(key.resourceId).\(key.version)",
                                   label: "Load preview again") { [onAction] in onAction(.restartPreview(key)) }
                return row([Self.secondary(text), again], summary: text)
            }
        }
    }

    // MARK: Preview pane

    private func renderPreview(_ model: PanelModel) {
        guard let key = model.shownPreview else {
            previewHeader.stringValue = "Pick Preview on an offer or library item."
            previewProgress.isHidden = true
            previewError.isHidden = true
            setPreviewText("", key: nil)
            previewButtons.arrangedSubviews.forEach { $0.removeFromSuperview() }
            previewSignature = ""
            return
        }
        let assembler = model.preview(key)
        let descriptor = assembler?.descriptor
        let offer = model.capabilities.offer(key)
        let entry = model.capabilities.libraryEntry(key.resourceId)
        let kind = descriptor?.kind ?? offer?.kind ?? entry?.kind
        let name = kind.map { Self.resourceName($0, skill: descriptor?.skill ?? offer?.skill) } ?? "Resource"
        let origin = descriptor?.siteOrigin ?? offer?.siteOrigin ?? entry?.siteOrigin ?? ""
        let site = CapabilityModel.host(of: origin) ?? origin
        let total = assembler?.totalBytes.map(Self.bytes) ?? "…"
        previewHeader.stringValue = "\(name) · \(key.version.prefix(12)) · \(site) · \(total)"

        switch assembler?.phase {
        case .loading?:
            previewProgress.isHidden = false
            let received = Double(assembler?.bytes.count ?? 0)
            previewProgress.doubleValue = assembler?.totalBytes.map { $0 == 0 ? 1 : received / Double($0) } ?? 0
            previewError.isHidden = true
        case .complete?:
            previewProgress.isHidden = true
            previewError.isHidden = true
        case let .failed(failure)?:
            previewProgress.isHidden = true
            previewError.isHidden = false
            previewError.stringValue = "This preview failed: \(Self.describe(failure)). It cannot be approved."
        case nil:
            previewProgress.isHidden = true
            previewError.isHidden = false
            previewError.stringValue = "This preview was closed. Load it again to read it."
        }
        // Only new bytes or another key replace the text, so a finished preview stays put while
        // the user reads or selects it.
        setPreviewText(assembler?.text ?? "", key: (key, assembler?.bytes.count ?? -1))

        let signature = "\(key)|\(String(describing: assembler?.phase))|\(model.approveBlocker(key) ?? "")|\(model.canDecline(key))|"
            + "\(String(describing: model.decisionRecord(key)))"
        guard signature != previewSignature else { return }
        previewSignature = signature
        let focused = (window.firstResponder as? NSView)?.identifier
        previewHandlers.removeAll()
        previewButtons.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let approve = button("Approve", id: "preview.approve", label: "Approve \(name) from \(site)", into: &previewHandlers) { [onAction] in
            onAction(.approve(key))
        }
        approve.isEnabled = model.canApprove(key)
        previewButtons.addArrangedSubview(approve)
        if offer != nil {
            let decline = button("Decline", id: "preview.decline", label: "Decline \(name) from \(site)", into: &previewHandlers) { [onAction] in
                onAction(.decline(key))
            }
            decline.isEnabled = model.canDecline(key)
            previewButtons.addArrangedSubview(decline)
        }
        if case .failed? = assembler?.phase {
            previewButtons.addArrangedSubview(button("Load again", id: "preview.reload", label: "Load preview again", into: &previewHandlers) { [onAction] in
                onAction(.restartPreview(key))
            })
        } else if assembler == nil {
            previewButtons.addArrangedSubview(button("Load", id: "preview.reload", label: "Load preview", into: &previewHandlers) { [onAction] in
                onAction(.preview(key))
            })
        }
        for view in commandStatus(model.decisionRecord(key), what: "decision on \(name)", model, into: &previewHandlers) {
            previewButtons.addArrangedSubview(view)
        }
        if let reason = model.approveBlocker(key) {
            approve.toolTip = reason
            approve.setAccessibilityHelp(reason)
            previewButtons.addArrangedSubview(Self.secondary(reason))
        }
        window.recalculateKeyViewLoop()
        if let focused, let view = find(focused, in: previewButtons) { window.makeFirstResponder(view) }
    }

    private func setPreviewText(_ text: String, key: (PreviewKey, Int)?) {
        if let key, let shown = previewTextKey, shown.0 == key.0, shown.1 == key.1 { return }
        if key == nil, previewTextKey == nil { return }
        previewTextKey = key
        previewText.string = text
    }

    // MARK: Actions

    @objc private func toggle() {
        onAction(.toggleExpanded)
        // The user asked for the details, so take keyboard focus without activating the app.
        if disclosure.state == .on { window.makeKey() }
    }

    @objc private func sectionChanged() {
        let index = sections.selectedSegment
        guard PanelSection.allCases.indices.contains(index) else { return }
        listSignature = ""
        onAction(.select(PanelSection.allCases[index]))
    }

    private func confirmAutoAcquire(origin: String, site: String, enable: Bool) {
        guard enable else {
            onAction(.setAutoAcquire(origin: origin, enabled: false, acknowledgeRisk: false))
            return
        }
        let alert = NSAlert()
        alert.messageText = "Turn on auto-acquire for \(site)?"
        alert.informativeText = Self.autoAcquireRisk
        let turnOn = alert.addButton(withTitle: "Turn On")
        let cancel = alert.addButton(withTitle: "Cancel")
        // Return cancels; turning it on takes a deliberate click.
        turnOn.keyEquivalent = ""
        cancel.keyEquivalent = "\r"
        alert.beginSheetModal(for: window) { [weak self] response in
            MainActor.assumeIsolated {
                guard let self else { return }
                if response == .alertFirstButtonReturn {
                    self.onAction(.setAutoAcquire(origin: origin, enabled: true, acknowledgeRisk: true))
                } else {
                    // Put the checkbox back to what the core says.
                    self.listSignature = ""
                    self.onAction(.select(.settings))
                }
            }
        }
    }

    // MARK: Views

    private func button(_ title: String, id: String, label: String, action: @escaping () -> Void) -> NSButton {
        button(title, id: id, label: label, into: &handlers, action: action)
    }

    private func button(_ title: String, id: String, label: String, into store: inout [ActionTarget], action: @escaping () -> Void) -> NSButton {
        let target = ActionTarget(action)
        store.append(target)
        let button = NSButton(title: title, target: target, action: #selector(ActionTarget.fire))
        button.bezelStyle = .rounded
        button.controlSize = .small
        button.keyEquivalent = ""
        button.identifier = NSUserInterfaceItemIdentifier(id)
        button.setAccessibilityLabel(label)
        return button
    }

    /// A checkbox that shows `on` (the model's value) until the model says otherwise: a click puts
    /// it back at once, and only a new frame changes it.
    private func checkbox(_ title: String, id: String, on: Bool, action: @escaping () -> Void) -> NSButton {
        let box = NSButton(checkboxWithTitle: title, target: nil, action: nil)
        let target = ActionTarget { [weak box] in
            box?.state = on ? .on : .off
            action()
        }
        handlers.append(target)
        box.target = target
        box.action = #selector(ActionTarget.fire)
        box.state = on ? .on : .off
        box.identifier = NSUserInterfaceItemIdentifier(id)
        box.setAccessibilityLabel(title)
        return box
    }

    private func commandStatus(_ record: CommandTracker.Record?, what: String, _ model: PanelModel) -> [NSView] {
        commandStatus(record, what: what, model, into: &handlers)
    }

    /// A spinner while a command waits for its ack; the failure code and a Retry (same ID) after it fails.
    private func commandStatus(
        _ record: CommandTracker.Record?, what: String, _ model: PanelModel, into store: inout [ActionTarget]
    ) -> [NSView] {
        guard let record else { return [] }
        switch record.state {
        case .ok, .unknown, .superseded:
            return []
        case .pending:
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .small
            spinner.startAnimation(nil)
            spinner.setAccessibilityLabel("Waiting for Scout core: \(what)")
            return record.sent ? [spinner] : [spinner, Self.secondary("Sending…")]
        case let .failed(code):
            let label = Self.secondary("Failed: \(code.rawValue)")
            label.textColor = .systemRed
            label.setAccessibilityLabel("\(what) failed: \(code.rawValue)")
            guard model.canRetry(record.id) else { return [label] }
            let onAction = self.onAction
            let retry = button("Retry", id: "retry.\(record.id)", label: "Retry \(what)", into: &store) { onAction(.retry(record.id)) }
            return [label, retry]
        }
    }

    private func row(_ views: [NSView], summary: String) -> NSView {
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 3
        stack.setAccessibilityElement(true)
        stack.setAccessibilityRole(.group)
        stack.setAccessibilityLabel(summary)
        return stack
    }

    private func hstack(_ views: [NSView]) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal
        stack.spacing = 6
        return stack
    }

    private func note(_ text: String) -> NSTextField { Self.secondary(text) }

    private static func title(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: NSFont.systemFontSize, weight: .semibold)
        label.lineBreakMode = .byTruncatingMiddle
        return label
    }

    private static func secondary(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        label.textColor = .secondaryLabelColor
        label.preferredMaxLayoutWidth = 400
        return label
    }

    private func find(_ id: NSUserInterfaceItemIdentifier, in view: NSView) -> NSView? {
        if view.identifier == id { return view }
        for sub in view.subviews { if let hit = find(id, in: sub) { return hit } }
        return nil
    }

    // MARK: Text

    private func describe(_ request: PanelRequest, _ model: PanelModel) -> String {
        let caps = model.capabilities
        func name(_ rid: String) -> String {
            if let offer = caps.offers.first(where: { $0.resourceId == rid }) {
                return "\(Self.resourceName(offer.kind, skill: offer.skill)) from \(CapabilityModel.host(of: offer.siteOrigin) ?? offer.siteOrigin)"
            }
            if let entry = caps.libraryEntry(rid) {
                return "\(Self.resourceName(entry.kind, skill: nil)) from \(CapabilityModel.host(of: entry.siteOrigin) ?? entry.siteOrigin)"
            }
            return "resource \(rid.dropFirst(4).prefix(8))"
        }
        switch request {
        case let .preview(rid, _, _): return "Preview of \(name(rid))"
        case let .approve(rid, _, _): return "Approve \(name(rid))"
        case let .decline(rid, _, _): return "Decline \(name(rid))"
        case let .revoke(rid, _): return "Revoke \(name(rid))"
        case let .setAutoAcquire(origin, enabled, _, _):
            return "\(enabled ? "Turning on" : "Turning off") auto-acquire for \(CapabilityModel.host(of: origin) ?? origin)"
        case let .setAgentBrowserContext(enabled, _): return "\(enabled ? "Allowing" : "Stopping") browser-context reads"
        case .refreshCapabilities: return "Refresh"
        case .openLink: return "Opening a link"
        }
    }

    static func resourceName(_ kind: ResourceKind, skill: SkillDescriptor?) -> String {
        switch kind {
        case .llmsTxt: return "llms.txt"
        case .agentsMd: return "AGENTS.md"
        case .skill: return skill.map { "Skill “\($0.name)”" } ?? "Skill"
        }
    }

    static func bytes(_ count: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
    }

    static func describe(_ failure: PreviewAssembler.Failure) -> String {
        switch failure {
        case .outOfOrder: return "chunks arrived out of order"
        case .overlap: return "chunks overlapped"
        case .oversized: return "the text is larger than Scout allows"
        case .inconsistent: return "the chunks did not agree"
        case .hashMismatch: return "the text did not match its hash"
        case let .refused(code): return "Scout core refused it (\(code.rawValue))"
        }
    }
}

/// Holds a click handler for a button target.
@MainActor
private final class ActionTarget: NSObject {
    private let action: () -> Void
    init(_ action: @escaping () -> Void) { self.action = action }
    @objc func fire() { action() }
}

/// Scout's panel. Escape (`cancelOperation`) would close an `NSPanel`, so it goes to `onCancel`
/// (collapse) instead; only the close button closes the window, and the app turns that into a hide.
final class ScoutWindow: NSPanel {
    var onCancel: (() -> Void)?

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}
