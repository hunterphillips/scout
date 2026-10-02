import Foundation

/// The job behind the results the window shows: what a click on one of them sends back.
public struct ResultsIdentity: Sendable, Equatable {
    public let coreInstanceId: String
    public let visitEpoch: Int
    public let origin: String
    public let jobId: String
}

/// The current visit's recommendation results.
public enum ResultsPhase: Sendable, Equatable {
    /// A job is running; `jobId` when the core named it.
    case working(jobId: String?)
    case ready(ResultsIdentity, [ResultItem])
    /// The model found nothing relevant: a successful answer.
    case empty
    case unavailable(JobUnavailableReason)
    /// The visit's deadline passed.
    case timeout
    case error(JobErrorReason)
    case cancelled(JobCancelledReason)
}

/// What the Results section and the compact line show. Each state is distinct; "nothing
/// relevant" (`empty`) is never shown for a failure.
public enum ResultsDisplay: Sendable, Equatable {
    case none
    case paused
    case disconnected
    case working
    case ready([ResultItem])
    case empty
    case unavailable(JobUnavailableReason)
    case timeout
    case error(JobErrorReason)
    case cancelled(JobCancelledReason)

    /// A few words for the compact line; nil when there is nothing to say.
    public var summary: String? {
        switch self {
        case .none: return nil
        case .paused: return "Paused"
        case .disconnected: return "Chrome not connected"
        case .working: return "Looking for links…"
        case let .ready(items): return items.count == 1 ? "1 link" : "\(items.count) links"
        case .empty: return "Nothing relevant"
        case .unavailable: return "Links unavailable"
        case .timeout: return "Timed out"
        case .error: return "Links failed"
        case .cancelled: return "Stopped"
        }
    }

    /// One sentence for the Results section, also its accessibility label.
    public var explanation: String {
        switch self {
        case .none: return "No links for this page yet. Scout looks once you stay on a site Chrome lets it read."
        case .paused: return "Scout is paused. Resume it to get links."
        case .disconnected: return "Scout can't see Chrome right now, so it has no links to show."
        case .working: return "Looking for links on this site…"
        case let .ready(items): return items.count == 1 ? "1 link for this page." : "\(items.count) links for this page."
        case .empty: return "Nothing on this site looks relevant to what you are doing."
        case let .unavailable(reason): return "Links are unavailable: \(Self.text(reason))."
        case .timeout: return "Scout ran out of time looking for links on this visit."
        case let .error(reason): return "Scout couldn't get links: \(Self.text(reason))."
        case let .cancelled(reason): return "Scout stopped looking: \(Self.text(reason))."
        }
    }

    static func text(_ reason: JobUnavailableReason) -> String {
        switch reason {
        case .noTimeLeft: return "not enough time was left on this visit"
        case .agentUnavailable: return "Claude is not available"
        case .busy: return "Scout is busy with another request"
        }
    }

    static func text(_ reason: JobErrorReason) -> String {
        switch reason {
        case .timeout: return "it took too long"
        case .invalidOutput: return "the answer was not usable"
        case .toolUnavailable: return "a required tool was unavailable"
        case .preflightFailed: return "the subscription check failed"
        case .unsupportedConfiguration: return "this setup is not supported"
        case .agentFailed: return "the agent failed"
        }
    }

    static func text(_ reason: JobCancelledReason) -> String {
        switch reason {
        case .superseded: return "a newer request replaced this one"
        case .visitChanged: return "you moved on"
        case .revoked: return "access was revoked"
        case .paused: return "Scout was paused"
        case .shutdown: return "Scout is shutting down"
        }
    }
}

/// A link the core authorized for the user's click, checked here; the app opens it through
/// `LinkOpener`, which checks it once more.
public struct LinkOpenRequest: Sendable, Equatable {
    public let commandId: String
    public let href: String
    /// The origin of the result the user clicked.
    public let origin: String
}

struct LinkRefusalRecord: Sendable, Equatable {
    let commandId: String
    let refusal: LinkOpener.Refusal
}

/// The current visit's recommendation results and the links clicked on them. `PanelModel`
/// composes it (as it does `CapabilityModel`) and supplies what it needs from the rest of the
/// window: the sidecar and core status, the core instance, and the command tracker.
///
/// One results state per visit. A `state` frame for a new visit, or one that is not `working`
/// (an `idle` for the same visit is how the core says it cleared them), resets it; `working` for
/// the current visit starts a job's spinner, and the job it replaces can no longer publish. A
/// `results` frame counts only for the running core instance and the visit the latest `state`
/// named, and never for a replaced job. Nothing here opens a link on its own: a click sends
/// `open_link`, and only that command's ok ack yields a target to open.
public struct ResultsModel: Sendable, Equatable {
    static let linkRefusalsMax = 8

    /// The current visit's results; nil when there are none to show.
    public private(set) var phase: ResultsPhase?
    /// The visit the latest `state` frame named.
    public private(set) var visitEpoch: Int?
    /// Jobs of the current visit that a newer job replaced; their late results are ignored.
    private var supersededJobs: Set<String> = []
    /// The job whose answer `phase` shows.
    private var resultJob: String?
    /// The origin of the result each pending `open_link` was clicked on.
    private var linkOrigins: [String: String] = [:]
    /// Links the core authorized, waiting for the app to open them (`takeLinksToOpen`).
    private var linksToOpen: [LinkOpenRequest] = []
    /// Link targets refused here or by the opener, newest last.
    private(set) var linkRefusals: [LinkRefusalRecord] = []

    public init() {}

    // MARK: Frames

    /// A `state` frame: a new visit, `idle`, `paused`, or `disconnected` resets the results (an
    /// `idle` for the same visit is how the core says it cleared them); `working` for the
    /// current visit starts a job's spinner, and a job it replaces can no longer publish.
    mutating func applyState(_ status: CoreStatus, epoch: Int?, jobId: String?) {
        if epoch != visitEpoch { supersededJobs = [] }
        visitEpoch = epoch
        guard status == .working, epoch != nil else {
            phase = nil
            return
        }
        if let running = currentJobId, running != jobId { supersededJobs.insert(running) }
        phase = .working(jobId: jobId)
    }

    /// A `results` frame counts only for `coreInstanceId` (the running core's, nil before it named
    /// itself) and the visit the latest `state` named, while `core` is idle or working, and never
    /// for a job a newer one replaced. It replaces whatever that visit showed; nothing opens.
    mutating func applyResults(_ frame: ResultsFrame, coreInstanceId: String?, core: CoreStatus?) {
        guard let instance = coreInstanceId, frame.coreInstanceId == instance, core == .idle || core == .working,
              let epoch = visitEpoch, frame.visitEpoch == epoch, !supersededJobs.contains(frame.jobId) else { return }
        if case let .working(running?)? = phase, running != frame.jobId { return }
        if let shown = currentJobId, shown != frame.jobId { supersededJobs.insert(shown) }
        let identity = ResultsIdentity(coreInstanceId: frame.coreInstanceId, visitEpoch: frame.visitEpoch, origin: frame.origin, jobId: frame.jobId)
        switch frame.outcome {
        case let .ok(items): phase = .ready(identity, items)
        case .empty: phase = .empty
        case let .unavailable(reason): phase = .unavailable(reason)
        case .error(.timeout): phase = .timeout
        case let .error(reason): phase = .error(reason)
        case let .cancelled(reason): phase = .cancelled(reason)
        }
        resultJob = frame.jobId
    }

    private var currentJobId: String? {
        switch phase {
        case let .working(jobId)?: return jobId
        case nil: return nil
        default: return resultJob
        }
    }

    /// Drops the results (a core restart). Pending clicks and refusals stay.
    mutating func reset() {
        phase = nil
        resultJob = nil
        supersededJobs = []
    }

    /// The core is not running: drops the results and the visit.
    mutating func coreStopped() {
        reset()
        visitEpoch = nil
    }

    /// What to show while the core is `core`.
    func display(core: CoreStatus?) -> ResultsDisplay {
        switch core {
        case .paused?: return .paused
        case .disconnected?: return .disconnected
        default: break
        }
        switch phase {
        case nil: return .none
        case .working?: return .working
        case let .ready(_, items)?: return .ready(items)
        case .empty?: return .empty
        case let .unavailable(reason)?: return .unavailable(reason)
        case .timeout?: return .timeout
        case let .error(reason)?: return .error(reason)
        case let .cancelled(reason)?: return .cancelled(reason)
        }
    }

    // MARK: Clicks

    /// The user clicked a shown result: ask the core for its target with the identity shown.
    /// Nothing opens until the core's ack authorizes a target and it passes `LinkOpener`.
    ///
    /// The click is remembered by command, not by the results shown: if the user navigates (a new
    /// visit resets the results) before the ack arrives, an ok ack still opens the link they
    /// clicked. The core resolved it while that visit was current.
    mutating func openResult(_ candidateId: String, commands: inout CommandTracker) -> NativeCommand? {
        guard case let .ready(identity, items)? = phase,
              items.contains(where: { $0.candidateId == candidateId }),
              linkRecord(candidateId, commands: commands)?.state != .pending else { return nil }
        let command = commands.issue(.openLink(
            coreInstanceId: identity.coreInstanceId, visitEpoch: identity.visitEpoch, jobId: identity.jobId, candidateId: candidateId))
        if let id = command.commandId { linkOrigins[id] = identity.origin }
        linkOrigins = linkOrigins.filter { commands.record($0.key) != nil }
        return command
    }

    /// The newest click on `candidateId` of the results shown.
    func linkRecord(_ candidateId: String, commands: CommandTracker) -> CommandTracker.Record? {
        guard case let .ready(identity, _)? = phase else { return nil }
        return commands.latest {
            $0 == .openLink(coreInstanceId: identity.coreInstanceId, visitEpoch: identity.visitEpoch, jobId: identity.jobId, candidateId: candidateId)
        }
    }

    /// An ok ack for `open_link` `commandId`. Only the ack that settled a pending click
    /// (`wasPending`) counts, once; its target is checked here before it is queued to open. This
    /// holds even after the results it was clicked on were reset (see `openResult`).
    mutating func linkAcked(commandId: String, target: String?, wasPending: Bool) {
        guard wasPending, let origin = linkOrigins.removeValue(forKey: commandId) else { return }
        switch target.map({ LinkOpener.check($0, origin: origin) }) {
        case .success?:
            linksToOpen.append(LinkOpenRequest(commandId: commandId, href: target!, origin: origin))
        case let .failure(refusal)?:
            linkRefused(commandId: commandId, refusal)
        case nil:
            linkRefused(commandId: commandId, .malformed)
        }
    }

    /// Links to open now, each once. Only acks for the user's clicks put links here.
    mutating func takeLinksToOpen() -> [LinkOpenRequest] {
        defer { linksToOpen = [] }
        return linksToOpen
    }

    /// The app did not open a link; Problems lists why.
    mutating func linkRefused(commandId: String, _ refusal: LinkOpener.Refusal) {
        linkRefusals.append(LinkRefusalRecord(commandId: commandId, refusal: refusal))
        if linkRefusals.count > Self.linkRefusalsMax { linkRefusals.removeFirst(linkRefusals.count - Self.linkRefusalsMax) }
    }

    mutating func dismissLink(_ commandId: String) {
        linkRefusals.removeAll { $0.commandId == commandId }
    }
}
