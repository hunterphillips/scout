/// What the placeholder panel shows: sidecar status, the core's latest state, and the
/// latest results as plain text.
public struct PanelModel: Sendable, Equatable {
    public private(set) var sidecar: SidecarStatus = .starting
    public private(set) var core: CoreStatus?
    public private(set) var detail: String?
    public private(set) var results: ResultsOutcome?

    public init() {}

    public mutating func apply(_ status: SidecarStatus) {
        sidecar = status
        if status != .running {
            core = nil
            detail = nil
            results = nil
        }
    }

    public mutating func apply(_ state: PanelState) {
        switch state {
        case let .state(status, _, detail):
            core = status
            self.detail = detail
        case let .results(_, outcome):
            results = outcome
        }
    }

    public var text: String {
        switch sidecar {
        case .starting:
            return "Starting…"
        case let .setupNeeded(reason):
            return "Setup needed\n\(reason)"
        case .stopped:
            return "Stopped\nScout core kept exiting after 3 restarts in a minute. Quit and reopen Scout."
        case .running:
            break
        }
        var lines = [core.map { $0.rawValue.capitalized } ?? "Connected"]
        if let detail, !detail.isEmpty { lines.append(detail) }
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
}
