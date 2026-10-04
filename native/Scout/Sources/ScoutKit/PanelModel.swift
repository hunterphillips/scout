import Foundation

/// The sections of the expanded panel.
public enum PanelSection: String, Sendable, Equatable, CaseIterable {
    case results, offers, library, preview, settings, activity, problems

    public var title: String {
        switch self {
        case .offers: return "Files"
        case .library: return "Approved"
        default: return rawValue.capitalized
        }
    }
}

/// What the compact panel signals.
public enum Indicator: Sendable, Equatable {
    case nothing
    case offers(count: Int, host: String)
    case results(count: Int)
    case error(String)
}

/// Something the Problems section lists.
public enum Problem: Sendable, Equatable {
    case sidecar(String)
    case conflict(CapabilityConflict)
    case command(CommandTracker.Record)
    case preview(PreviewKey, PreviewAssembler.Failure)
    /// The core answered a link click with a target this app would not open, or Chrome did not open it.
    case link(commandId: String, LinkOpener.Refusal)
}

/// Everything Scout's window shows: sidecar and core status, results, the capability view,
/// previews, command states, and the user's expanded-view selection. A pure value: every
/// event goes through `apply`, every user action through a method that returns the commands
/// to send. Nothing here expands the panel or changes the shown preview except a user action.
/// Approve exists only for the shown preview, so a list reordering under the pointer cannot
/// redirect an approval.
public struct PanelModel: Sendable, Equatable {
    public static let previewCapacity = 8

    public private(set) var sidecar: SidecarStatus = .starting
    /// The latest `state` frame's status (held once, in `pause`); nil while no core is running.
    public var core: CoreStatus? { pause.core }
    public private(set) var detail: String?
    public private(set) var permitted: Bool?
    /// The current visit's results and the links clicked on them.
    public private(set) var resultsModel = ResultsModel()
    public private(set) var capabilities = CapabilityModel()
    public private(set) var commands: CommandTracker
    /// Pause as the core's `state` frames report it, and the app's request in flight.
    public private(set) var pause = PauseState()

    public private(set) var expanded = false
    public private(set) var section: PanelSection = .results
    /// The preview in the Preview section; changes only by a user action.
    public private(set) var shownPreview: PreviewKey?
    public private(set) var previews: [PreviewKey: PreviewAssembler] = [:]
    /// Oldest first, for eviction.
    private var previewOrder: [PreviewKey] = []
    /// The `preview` command each loading preview waits on; chunks answering anything else are ignored.
    private var awaiting: [PreviewKey: String] = [:]
    /// Versions decided (ok ack) since the last `capabilities` frame, which may still list them.
    private var decidedSinceFrame: Set<PreviewKey> = []
    private var revokedSinceFrame: Set<String> = []
    /// Failed commands the user dismissed from Problems.
    private var dismissed: Set<String> = []

    public init(commands: CommandTracker = CommandTracker()) {
        self.commands = commands
    }

    // MARK: Events

    /// Returns commands to send: on a core restart, the pending mutations (same IDs) and the
    /// first chunk of every preview that was still loading.
    public mutating func apply(_ status: SidecarStatus) -> [NativeCommand] {
        let wasRunning = sidecar == .running
        sidecar = status
        guard status == .running else {
            detail = nil
            permitted = nil
            pause.coreStopped()
            resultsModel.coreStopped()
            capabilities.reset()
            decidedSinceFrame = []
            revokedSinceFrame = []
            return []
        }
        guard !wasRunning else { return [] }
        return coreRestarted()
    }

    /// A new core process: re-send pending mutations under their IDs and reload loading previews.
    private mutating func coreRestarted() -> [NativeCommand] {
        resultsModel.reset()
        pause.coreRestarted()
        var out = commands.coreRestarted()
        for key in previewOrder where previews[key]?.phase == .loading {
            out += startPreview(key).map { [$0] } ?? []
        }
        return out
    }

    /// Returns commands to send: the next `preview` chunk request, if a chunk asks for one.
    public mutating func apply(_ state: PanelState) -> [NativeCommand] {
        switch state {
        case let .state(status, epoch, detail, permitted, jobId):
            resultsModel.applyState(status, epoch: epoch, jobId: jobId)
            pause.apply(status)
            self.detail = detail
            self.permitted = permitted
        case let .results(frame):
            guard sidecar == .running else { break }
            resultsModel.applyResults(frame, coreInstanceId: capabilities.capabilities?.coreInstanceId, core: core)
        case let .capabilities(frame):
            let previous = capabilities.capabilities?.coreInstanceId
            if capabilities.apply(frame) {
                decidedSinceFrame = []
                revokedSinceFrame = []
                settleMoot()
                // Another core answered without the app seeing a restart: treat it as one.
                if let previous, previous != frame.coreInstanceId { return coreRestarted() }
            }
        case let .preview(chunk):
            return receive(chunk)
        case let .ack(ack):
            let wasPending = commands.record(ack.commandId)?.state == .pending
            guard let record = commands.apply(ack) else { break }
            switch (record.request, ack) {
            case let (.openLink, .ok(id, _, _, target)):
                resultsModel.linkAcked(commandId: id, target: target, wasPending: wasPending)
            case let (.preview(rid, version, _), .failed(_, code, _)):
                let key = PreviewKey(resourceId: rid, version: version)
                if awaiting[key] == ack.commandId {
                    awaiting[key] = nil
                    previews[key]?.refused(code)
                }
            case let (.approve(rid, version, _), .ok), let (.decline(rid, version, _), .ok):
                decidedSinceFrame.insert(PreviewKey(resourceId: rid, version: version))
            case let (.revoke(rid, _), .ok):
                revokedSinceFrame.insert(rid)
            case (_, .failed(_, .staleRevision, _)) where record.request.isToggle || record.request.isDecision:
                settleMoot()
            default:
                break
            }
        case let .audit(entries):
            capabilities.applyAudit(entries)
        case let .grant(enabled):
            capabilities.applyGrant(enabled)
            settleMoot()
        }
        return []
    }

    /// A toggle or decision refused as stale whose target the latest frame already shows did what
    /// the user wanted (often a decision the old core applied before a restart, re-sent to the new
    /// one): settle it as ok so it is not a problem.
    private mutating func settleMoot() {
        for record in commands.records where record.state == .failed(.staleRevision) {
            switch record.request {
            case let .approve(rid, version, _):
                if let entry = capabilities.libraryEntry(rid), entry.state == .approved, entry.defaultVersion == version {
                    commands.settle(record.id)
                }
            case let .decline(rid, version, _):
                if capabilities.libraryEntry(rid)?.versions.contains(where: { $0.hash == version && $0.state == .declined }) == true {
                    commands.settle(record.id)
                }
            case let .revoke(rid, _):
                if capabilities.libraryEntry(rid)?.state == .blocked { commands.settle(record.id) }
            case let .setAutoAcquire(origin, enabled, _, _):
                if capabilities.originSetting(origin)?.autoAcquire == enabled { commands.settle(record.id) }
            case let .setAgentBrowserContext(enabled, _):
                if capabilities.agentBrowserContext == enabled { commands.settle(record.id) }
            default:
                break
            }
        }
    }

    private mutating func receive(_ chunk: PreviewChunk) -> [NativeCommand] {
        commands.chunkArrived(for: chunk.commandId)
        let key = PreviewKey(resourceId: chunk.resourceId, version: chunk.version)
        guard awaiting[key] == chunk.commandId, var assembler = previews[key] else { return [] }
        awaiting[key] = nil
        _ = assembler.accept(chunk)
        previews[key] = assembler
        guard let next = assembler.requestNext() else { return [] }
        let command = commands.issue(next)
        awaiting[key] = command.commandId
        return [command]
    }

    // MARK: Results

    /// The visit the latest `state` frame named.
    public var visitEpoch: Int? { resultsModel.visitEpoch }

    /// The current visit's results; reset by every `state` frame that is not `working` for the
    /// same visit and job, and by a core restart.
    public var results: ResultsPhase? { resultsModel.phase }

    public var resultsDisplay: ResultsDisplay {
        guard sidecar == .running else { return .none }
        return resultsModel.display(core: core)
    }

    /// The user clicked a shown result: ask the core for its target with the identity shown.
    /// Nothing opens until the core's ack authorizes a target and it passes `LinkOpener`; a late
    /// ok ack after the user navigated still opens the link clicked (`ResultsModel.openResult`).
    public mutating func openResult(_ candidateId: String) -> NativeCommand? {
        guard sidecar == .running else { return nil }
        return resultsModel.openResult(candidateId, commands: &commands)
    }

    /// The newest click on `candidateId` of the results shown.
    public func linkRecord(_ candidateId: String) -> CommandTracker.Record? {
        resultsModel.linkRecord(candidateId, commands: commands)
    }

    /// Links to open now, each once. Only acks for the user's clicks put links here.
    public mutating func takeLinksToOpen() -> [LinkOpenRequest] {
        resultsModel.takeLinksToOpen()
    }

    /// The app did not open a link (its check, or the open itself, failed); Problems lists why.
    public mutating func linkRefused(commandId: String, _ refusal: LinkOpener.Refusal) {
        resultsModel.linkRefused(commandId: commandId, refusal)
    }

    // MARK: User actions

    public mutating func toggleExpanded() {
        expanded.toggle()
    }

    public mutating func select(_ section: PanelSection) {
        expanded = true
        self.section = section
    }

    /// Shows `key` in the Preview section, loading it unless it is loaded or loading. While the core
    /// is not running nothing is sent; the load starts when it is.
    public mutating func showPreview(_ key: PreviewKey) -> NativeCommand? {
        shownPreview = key
        select(.preview)
        switch previews[key]?.phase {
        case .complete?: return nil
        case .loading? where awaiting[key] != nil: return nil
        default: return startPreview(key)
        }
    }

    /// Loads `key` again from its first chunk.
    public mutating func restartPreview(_ key: PreviewKey) -> NativeCommand? {
        startPreview(key)
    }

    public func preview(_ key: PreviewKey) -> PreviewAssembler? { previews[key] }

    /// Why Approve is off for `key`, or nil when it is on.
    public func approveBlocker(_ key: PreviewKey) -> String? {
        if sidecar != .running { return "Scout isn't running." }
        if let blocker = decisionBlocker(key) { return blocker }
        if let blocker = capabilities.approvalBlocker(key) { return blocker.reason }
        switch previews[key]?.phase {
        case .complete: return shownPreview == key ? nil : "Open this version in Preview to approve it."
        case .loading: return "Preview is still loading."
        case .failed: return "Preview failed; load it again to approve."
        case nil: return "Preview this version before approving it."
        }
    }

    public func canApprove(_ key: PreviewKey) -> Bool { approveBlocker(key) == nil }

    public func canDecline(_ key: PreviewKey) -> Bool {
        sidecar == .running && decisionBlocker(key) == nil && capabilities.offer(key) != nil
    }

    public mutating func approve(_ key: PreviewKey) -> NativeCommand? {
        guard canApprove(key), let revision = capabilities.resourceRevision(key.resourceId) else { return nil }
        return commands.issue(.approve(resourceId: key.resourceId, version: key.version, expectedRevision: revision))
    }

    public mutating func decline(_ key: PreviewKey) -> NativeCommand? {
        guard canDecline(key), let revision = capabilities.resourceRevision(key.resourceId) else { return nil }
        return commands.issue(.decline(resourceId: key.resourceId, version: key.version, expectedRevision: revision))
    }

    public func canRevoke(_ resourceId: String) -> Bool {
        guard sidecar == .running, let entry = capabilities.libraryEntry(resourceId), entry.state != .blocked else {
            return false
        }
        if revokedSinceFrame.contains(resourceId) { return false }
        return revokeRecord(resourceId)?.state != .pending
    }

    public mutating func revoke(_ resourceId: String) -> NativeCommand? {
        guard canRevoke(resourceId), let entry = capabilities.libraryEntry(resourceId) else { return nil }
        return commands.issue(.revoke(resourceId: resourceId, expectedRevision: entry.resourceRevision))
    }

    /// Whether the auto-acquire checkbox for `origin` takes a click: the frame lists the origin, no
    /// toggle of it is pending, and it is on or Chrome permits the site (only then can it go on).
    public func canToggleAutoAcquire(_ origin: String) -> Bool {
        guard sidecar == .running, autoAcquireRecord(origin)?.state != .pending,
              let setting = capabilities.originSetting(origin) else { return false }
        return setting.autoAcquire || setting.permitted
    }

    /// Turning auto-acquire on requires a site Chrome permits and the user's confirmation of the
    /// risk. The command carries the value the latest frame shows, so a change made meanwhile is
    /// refused, not overwritten.
    public mutating func setAutoAcquire(origin: String, enabled: Bool, acknowledgeRisk: Bool) -> NativeCommand? {
        guard canToggleAutoAcquire(origin), let setting = capabilities.originSetting(origin),
              setting.autoAcquire != enabled, !enabled || (acknowledgeRisk && setting.permitted) else {
            return nil
        }
        return commands.issue(.setAutoAcquire(
            origin: origin, enabled: enabled, acknowledgeRisk: enabled && acknowledgeRisk, expectedEnabled: setting.autoAcquire))
    }

    /// Whether the browser-context checkbox takes a click: a `grant` frame arrived and no toggle is pending.
    public var canToggleGrant: Bool {
        sidecar == .running && capabilities.agentBrowserContext != nil && grantRecord?.state != .pending
    }

    public mutating func setAgentBrowserContext(_ enabled: Bool) -> NativeCommand? {
        guard canToggleGrant, let current = capabilities.agentBrowserContext, current != enabled else { return nil }
        return commands.issue(.setAgentBrowserContext(enabled: enabled, expectedEnabled: current))
    }

    public mutating func refreshCapabilities() -> NativeCommand? {
        guard sidecar == .running else { return nil }
        return commands.issue(.refreshCapabilities)
    }

    /// `pause` while working or idle, `resume` while paused.
    public func pauseCommand() -> NativeCommand? {
        pause.command
    }

    /// The Pause/Resume control the window and the menu bar both show; disabled while quitting.
    public var pauseControl: PauseControl { pause.control }

    /// Whether the app is quitting (`beginQuit`).
    public var quitting: Bool { pause.quitting }

    /// The app began quitting: Pause and Resume stay disabled everywhere from now on.
    public mutating func beginQuit() {
        pause.beginQuit()
    }

    /// The user clicked Pause or Resume (window or menu bar): the command to send, or nil while
    /// one is in flight or the app is quitting. Report the write with `pauseSent`.
    public mutating func requestPauseOrResume() -> NativeCommand? {
        pause.request()
    }

    public mutating func pauseSent(_ outcome: SendOutcome) {
        pause.sent(outcome)
    }

    /// Whether `retry(commandId)` would send something.
    public func canRetry(_ commandId: String) -> Bool { commands.canRetry(commandId) }

    /// Re-sends a failed or unsent decision or refresh with its own ID. Toggles and link clicks
    /// are not retried.
    public mutating func retry(_ commandId: String) -> NativeCommand? {
        guard let command = commands.retry(commandId) else { return nil }
        dismissed.remove(commandId)
        return command
    }

    /// Removes a failed command or a refused link from Problems.
    public mutating func dismiss(_ commandId: String) {
        resultsModel.dismissLink(commandId)
        guard case .failed? = commands.record(commandId)?.state else { return }
        dismissed.insert(commandId)
        // Forget dismissals of commands the tracker no longer holds.
        dismissed = dismissed.filter { commands.record($0) != nil }
    }

    public mutating func markSent(_ command: NativeCommand, written: Bool) {
        markSent(command, written ? .written : .retryLater)
    }

    /// Records what became of a write. An oversize command fails as `invalid` and is never re-sent;
    /// a preview it was loading fails with it.
    public mutating func markSent(_ command: NativeCommand, _ outcome: SendOutcome) {
        guard case let .panel(id, request) = command else { return }
        commands.markSent(id, outcome)
        guard outcome == .oversize, case let .preview(rid, version, _) = request else { return }
        let key = PreviewKey(resourceId: rid, version: version)
        if awaiting[key] == id {
            awaiting[key] = nil
            previews[key]?.refused(.invalid)
        }
    }

    // MARK: Command state lookups

    /// The newest approve or decline of `key`.
    public func decisionRecord(_ key: PreviewKey) -> CommandTracker.Record? {
        commands.latest { request in
            switch request {
            case let .approve(rid, version, _), let .decline(rid, version, _):
                return rid == key.resourceId && version == key.version
            default:
                return false
            }
        }
    }

    public func revokeRecord(_ resourceId: String) -> CommandTracker.Record? {
        commands.latest { if case let .revoke(rid, _) = $0 { return rid == resourceId } else { return false } }
    }

    public func autoAcquireRecord(_ origin: String) -> CommandTracker.Record? {
        commands.latest { if case let .setAutoAcquire(o, _, _, _) = $0 { return o == origin } else { return false } }
    }

    public var grantRecord: CommandTracker.Record? {
        commands.latest { if case .setAgentBrowserContext = $0 { return true } else { return false } }
    }

    private func decisionBlocker(_ key: PreviewKey) -> String? {
        if decidedSinceFrame.contains(key) { return "Decision recorded." }
        if decisionRecord(key)?.state == .pending { return "Waiting for Scout…" }
        return nil
    }

    // MARK: Derived views

    /// The site of the current visit, when Chrome permits it.
    public var currentHost: String? {
        guard core == .idle, permitted != false, let detail, !detail.isEmpty else { return nil }
        return detail
    }

    public var currentOffers: [CapabilityOffer] {
        currentHost.map { capabilities.offers(forHost: $0) } ?? []
    }

    public var indicator: Indicator {
        switch sidecar {
        case .setupNeeded: return .error("Setup needed")
        case .stopped: return .error("Stopped")
        case .starting: return .nothing
        case .running: break
        }
        if let host = currentHost, !currentOffers.isEmpty {
            return .offers(count: currentOffers.count, host: host)
        }
        switch resultsDisplay {
        case let .ready(items): return .results(count: items.count)
        case .unavailable, .timeout, .error: return .error(resultsDisplay.summary ?? "")
        case .none, .paused, .disconnected, .working, .empty, .cancelled: return .nothing
        }
    }

    public var problems: [Problem] {
        var out: [Problem] = []
        switch sidecar {
        case let .setupNeeded(reason): out.append(.sidecar("Setup needed: \(reason)"))
        case .stopped: out.append(.sidecar(Self.stoppedText))
        case .starting, .running: break
        }
        out += capabilities.conflicts.map(Problem.conflict)
        out += commands.records.filter {
            guard case .failed = $0.state, !dismissed.contains($0.id) else { return false }
            return $0.request.isMutation
        }
            .reversed().map(Problem.command)
        out += resultsModel.linkRefusals.reversed().map { Problem.link(commandId: $0.commandId, $0.refusal) }
        for key in previewOrder.reversed() {
            if case let .failed(failure) = previews[key]?.phase { out.append(.preview(key, failure)) }
        }
        return out
    }

    /// Status and current host: the compact panel's text beside its offer badge.
    public var statusLine: String {
        switch sidecar {
        case .starting: return "Starting…"
        case .setupNeeded: return "Setup needed"
        case .stopped: return "Stopped"
        case .running: break
        }
        var parts = [core.map { $0.rawValue.capitalized } ?? "Connected"]
        if let host = currentHost ?? detail, !host.isEmpty { parts.append(host) }
        return parts.joined(separator: " · ")
    }

    /// One line for the compact panel: status, current host, offer count, results.
    public var compactLine: String {
        var parts = [statusLine]
        let count = currentOffers.count
        if count > 0 { parts.append(count == 1 ? "1 offer" : "\(count) offers") }
        if let summary = resultsSummary { parts.append(summary) }
        return parts.joined(separator: " · ")
    }

    /// The compact panel's label, which shows the offer count as a badge beside it.
    public var headerLine: String {
        [statusLine, resultsSummary].compactMap { $0 }.joined(separator: " · ")
    }

    /// The results part of the compact line; paused and disconnected are already the status.
    private var resultsSummary: String? {
        switch resultsDisplay {
        case .paused, .disconnected: return nil
        default: return resultsDisplay.summary
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

    // MARK: Previews

    /// Starts `key` over from its first chunk; the request it waited on, if any, is superseded.
    /// While the core is not running the preview waits, loading, for `coreRestarted` to send it.
    private mutating func startPreview(_ key: PreviewKey) -> NativeCommand? {
        let assembler = PreviewAssembler(key: key)
        guard let request = assembler.requestNext() else { return nil }
        if let old = awaiting.removeValue(forKey: key) { commands.supersede(old) }
        previews[key] = assembler
        previewOrder.removeAll { $0 == key }
        previewOrder.append(key)
        while previewOrder.count > Self.previewCapacity,
              let evict = previewOrder.first(where: { $0 != shownPreview }) {
            previewOrder.removeAll { $0 == evict }
            previews[evict] = nil
            if let old = awaiting.removeValue(forKey: evict) { commands.supersede(old) }
        }
        guard sidecar == .running, previews[key] != nil else { return nil }
        let command = commands.issue(request)
        awaiting[key] = command.commandId
        return command
    }
}

extension NativeCommand {
    /// The command ID of a window command.
    public var commandId: String? {
        if case let .panel(id, _) = self { return id }
        return nil
    }
}
