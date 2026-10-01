import Foundation

/// The sections of the expanded panel.
public enum PanelSection: String, Sendable, Equatable, CaseIterable {
    case offers, library, preview, settings, activity, problems

    public var title: String { rawValue.capitalized }
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
}

/// Everything Scout's window shows: sidecar and core status, results, the capability view,
/// previews, command states, and the user's expanded-view selection. A pure value: every
/// event goes through `apply`, every user action through a method that returns the commands
/// to send. Nothing here expands the panel or changes the shown preview except a user action.
public struct PanelModel: Sendable, Equatable {
    public static let previewCapacity = 8

    public private(set) var sidecar: SidecarStatus = .starting
    public private(set) var core: CoreStatus?
    public private(set) var detail: String?
    public private(set) var permitted: Bool?
    public private(set) var results: ResultsOutcome?
    public private(set) var capabilities = CapabilityModel()
    public private(set) var commands: CommandTracker

    public private(set) var expanded = false
    public private(set) var section: PanelSection = .offers
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
            core = nil
            detail = nil
            permitted = nil
            results = nil
            capabilities.reset()
            decidedSinceFrame = []
            revokedSinceFrame = []
            return []
        }
        guard !wasRunning else { return [] }
        var out = commands.coreRestarted()
        for key in previewOrder where previews[key]?.phase == .loading {
            out += startPreview(key).map { [$0] } ?? []
        }
        return out
    }

    /// Returns commands to send: the next `preview` chunk request, if a chunk asks for one.
    public mutating func apply(_ state: PanelState) -> [NativeCommand] {
        switch state {
        case let .state(status, _, detail, permitted):
            core = status
            self.detail = detail
            self.permitted = permitted
        case let .results(_, outcome):
            results = outcome
        case let .capabilities(frame):
            if capabilities.apply(frame) {
                decidedSinceFrame = []
                revokedSinceFrame = []
            }
        case let .preview(chunk):
            return receive(chunk)
        case let .ack(ack):
            guard let record = commands.apply(ack) else { break }
            switch (record.request, ack) {
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
            default:
                break
            }
        case let .audit(entries):
            capabilities.applyAudit(entries)
        case let .grant(enabled):
            capabilities.applyGrant(enabled)
        }
        return []
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

    // MARK: User actions

    public mutating func toggleExpanded() {
        expanded.toggle()
    }

    public mutating func select(_ section: PanelSection) {
        expanded = true
        self.section = section
    }

    /// Shows `key` in the Preview section, loading it unless it is loaded or loading.
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
        if sidecar != .running { return "Scout core is not running." }
        if let blocker = decisionBlocker(key) { return blocker }
        if let blocker = capabilities.approvalBlocker(key) { return blocker.reason }
        switch previews[key]?.phase {
        case .complete: return nil
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

    /// Turning auto-acquire on requires the user to have confirmed the risk.
    public mutating func setAutoAcquire(origin: String, enabled: Bool, acknowledgeRisk: Bool) -> NativeCommand? {
        guard sidecar == .running, !enabled || acknowledgeRisk, autoAcquireRecord(origin)?.state != .pending else {
            return nil
        }
        return commands.issue(.setAutoAcquire(origin: origin, enabled: enabled, acknowledgeRisk: enabled && acknowledgeRisk))
    }

    public mutating func setAgentBrowserContext(_ enabled: Bool) -> NativeCommand? {
        guard sidecar == .running, grantRecord?.state != .pending else { return nil }
        return commands.issue(.setAgentBrowserContext(enabled: enabled))
    }

    public mutating func refreshCapabilities() -> NativeCommand? {
        guard sidecar == .running else { return nil }
        return commands.issue(.refreshCapabilities)
    }

    /// `pause` while working or idle, `resume` while paused.
    public func pauseCommand() -> NativeCommand? {
        switch core {
        case .paused: return .resume
        case .idle, .working: return .pause
        case .disconnected, nil: return nil
        }
    }

    /// Re-sends a failed or unsent mutation with its own ID.
    public mutating func retry(_ commandId: String) -> NativeCommand? {
        commands.retry(commandId)
    }

    public mutating func markSent(_ command: NativeCommand, written: Bool) {
        guard case let .panel(id, _) = command else { return }
        commands.markSent(id, written: written)
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
        commands.latest { if case let .setAutoAcquire(o, _, _) = $0 { return o == origin } else { return false } }
    }

    public var grantRecord: CommandTracker.Record? {
        commands.latest { if case .setAgentBrowserContext = $0 { return true } else { return false } }
    }

    private func decisionBlocker(_ key: PreviewKey) -> String? {
        if decidedSinceFrame.contains(key) { return "Decision recorded." }
        if decisionRecord(key)?.state == .pending { return "Waiting for Scout core." }
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
        switch results {
        case let .ok(items): return .results(count: items.count)
        case let .unavailable(reason), let .error(reason): return .error(reason)
        case .empty, nil: return .nothing
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
        out += commands.records.filter { if case .failed = $0.state { return $0.request.isMutation } else { return false } }
            .reversed().map(Problem.command)
        for key in previewOrder.reversed() {
            if case let .failed(failure) = previews[key]?.phase { out.append(.preview(key, failure)) }
        }
        return out
    }

    /// One line for the compact panel: status, current host, offer count.
    public var compactLine: String {
        switch sidecar {
        case .starting: return "Starting…"
        case .setupNeeded: return "Setup needed"
        case .stopped: return "Stopped"
        case .running: break
        }
        var parts = [core.map { $0.rawValue.capitalized } ?? "Connected"]
        if let host = currentHost ?? detail, !host.isEmpty { parts.append(host) }
        let count = currentOffers.count
        if count > 0 { parts.append(count == 1 ? "1 offer" : "\(count) offers") }
        return parts.joined(separator: " · ")
    }

    public var text: String {
        switch sidecar {
        case .starting:
            return "Starting…"
        case let .setupNeeded(reason):
            return "Setup needed\n\(reason)"
        case .stopped:
            return "Stopped\n" + Self.stoppedText
        case .running:
            break
        }
        var lines = [core.map { $0.rawValue.capitalized } ?? "Connected"]
        if let detail, !detail.isEmpty { lines.append(detail) }
        if case let .offers(count, host) = indicator {
            lines.append(count == 1 ? "1 offer for \(host)" : "\(count) offers for \(host)")
        }
        switch results {
        case nil:
            break
        case let .ok(items):
            lines.append("")
            lines.append(contentsOf: items.map { "• \($0.title)" })
        case .empty:
            lines.append("")
            lines.append("No results")
        case let .unavailable(reason):
            lines.append("")
            lines.append("Results unavailable: \(reason)")
        case let .error(reason):
            lines.append("")
            lines.append("Results error: \(reason)")
        }
        return lines.joined(separator: "\n")
    }

    static var stoppedText: String {
        "Scout core kept exiting after \(RestartPolicy.defaultMaxRestarts) restarts in "
            + "\(describe(RestartPolicy.defaultWindow)). Quit and reopen Scout."
    }

    static func describe(_ window: Double) -> String {
        let seconds = Int(window)
        if seconds == 60 { return "a minute" }
        if seconds % 60 == 0 { return "\(seconds / 60) minutes" }
        return "\(seconds) seconds"
    }

    // MARK: Previews

    private mutating func startPreview(_ key: PreviewKey) -> NativeCommand? {
        let assembler = PreviewAssembler(key: key)
        guard let request = assembler.requestNext() else { return nil }
        let command = commands.issue(request)
        previews[key] = assembler
        previewOrder.removeAll { $0 == key }
        previewOrder.append(key)
        awaiting[key] = command.commandId
        while previewOrder.count > Self.previewCapacity,
              let evict = previewOrder.first(where: { $0 != shownPreview }) {
            previewOrder.removeAll { $0 == evict }
            previews[evict] = nil
            awaiting[evict] = nil
        }
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
