import Foundation

// Wire types for the JSONL link between the app and the scout-core sidecar.
// Mirrors `PanelState` and `NativeCommand` in packages/contracts (panel.ts). Decoding is
// strict about the shapes and bounds the app relies on: IDs and hashes it may echo back,
// list bounds, and the preview chunk size. A line that fails any check is dropped whole.

public enum CoreStatus: String, Sendable, Equatable, Decodable {
    case idle, working, paused, disconnected
}

/// `JOB_UNAVAILABLE_REASONS` in contracts job.ts.
public enum JobUnavailableReason: String, Sendable, Equatable, Decodable, CaseIterable {
    case noTimeLeft = "no_time_left"
    case agentUnavailable = "agent_unavailable"
    case busy
}

/// `JOB_ERROR_REASONS` in contracts job.ts. `timeout` is the visit deadline.
public enum JobErrorReason: String, Sendable, Equatable, Decodable, CaseIterable {
    case timeout
    case invalidOutput = "invalid_output"
    case toolUnavailable = "tool_unavailable"
    case preflightFailed = "preflight_failed"
    case unsupportedConfiguration = "unsupported_configuration"
    case agentFailed = "agent_failed"
}

/// `JOB_CANCELLED_REASONS` in contracts job.ts.
public enum JobCancelledReason: String, Sendable, Equatable, Decodable, CaseIterable {
    case superseded
    case visitChanged = "visit_changed"
    case revoked, paused, shutdown
}

/// One recommended link as the window shows it. Never its URL: a click sends `candidateId`
/// back (`open_link`) and the core answers with the target.
public struct ResultItem: Sendable, Equatable, Decodable {
    public let candidateId: String
    public let title: String
    /// Shown only in Scout's window.
    public let reason: String
    /// The verified target's host.
    public let hostname: String

    public init(candidateId: String, title: String, reason: String, hostname: String) {
        self.candidateId = candidateId
        self.title = title
        self.reason = reason
        self.hostname = hostname
    }

    public init(from decoder: Decoder) throws {
        try onlyKeys(decoder, CodingKeys.allCases)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        candidateId = try c.decode(String.self, forKey: .candidateId)
        title = try c.decode(String.self, forKey: .title)
        reason = try c.decode(String.self, forKey: .reason)
        hostname = try c.decode(String.self, forKey: .hostname)
        try check(WireFormat.isCandidateId(candidateId))
        // zod counts UTF-16 code units.
        try check((1...PanelLimits.resultTitleMax).contains(title.utf16.count))
        try check((1...PanelLimits.resultReasonMax).contains(reason.utf16.count))
        try check((1...PanelLimits.hostnameMaxBytes).contains(hostname.utf16.count))
    }

    private enum CodingKeys: String, CodingKey, CaseIterable { case candidateId, title, reason, hostname }
}

public enum ResultsOutcome: Sendable, Equatable {
    /// One to `PanelLimits.resultItemsMax` items with distinct candidate IDs.
    case ok([ResultItem])
    /// The model's intentional "nothing relevant": a success.
    case empty
    case unavailable(JobUnavailableReason)
    case error(JobErrorReason)
    case cancelled(JobCancelledReason)
}

/// A `results` frame: the core instance, visit, origin, and job it answers, and the outcome.
public struct ResultsFrame: Sendable, Equatable, Decodable {
    public let coreInstanceId: String
    public let visitEpoch: Int
    /// `https://host[:port]`.
    public let origin: String
    public let jobId: String
    public let outcome: ResultsOutcome

    public init(coreInstanceId: String, visitEpoch: Int, origin: String, jobId: String, outcome: ResultsOutcome) {
        self.coreInstanceId = coreInstanceId
        self.visitEpoch = visitEpoch
        self.origin = origin
        self.jobId = jobId
        self.outcome = outcome
    }

    /// Strict like the contract: an unknown key (an `href` above all) drops the frame.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        coreInstanceId = try c.decode(String.self, forKey: .coreInstanceId)
        visitEpoch = try c.decode(Int.self, forKey: .visitEpoch)
        origin = try c.decode(String.self, forKey: .origin)
        jobId = try c.decode(String.self, forKey: .jobId)
        try check(WireFormat.isToken(coreInstanceId) && WireFormat.isToken(jobId))
        try check(WireFormat.isRevision(visitEpoch) && WireFormat.isHostOrigin(origin))
        let identity: [CodingKeys] = [.type, .coreInstanceId, .visitEpoch, .origin, .jobId, .status]
        switch try c.decode(String.self, forKey: .status) {
        case "ok":
            try onlyKeys(decoder, identity + [.items])
            let items = try c.decode([ResultItem].self, forKey: .items)
            try check((1...PanelLimits.resultItemsMax).contains(items.count))
            try check(Set(items.map(\.candidateId)).count == items.count)
            outcome = .ok(items)
        case "empty":
            try onlyKeys(decoder, identity)
            outcome = .empty
        case "unavailable":
            try onlyKeys(decoder, identity + [.reason])
            outcome = .unavailable(try c.decode(JobUnavailableReason.self, forKey: .reason))
        case "error":
            try onlyKeys(decoder, identity + [.reason])
            outcome = .error(try c.decode(JobErrorReason.self, forKey: .reason))
        case "cancelled":
            try onlyKeys(decoder, identity + [.reason])
            outcome = .cancelled(try c.decode(JobCancelledReason.self, forKey: .reason))
        default:
            throw WireError()
        }
    }

    private enum CodingKeys: String, CodingKey { case type, coreInstanceId, visitEpoch, origin, jobId, status, items, reason }
}

/// Bounds from packages/contracts (panel.ts, capability.ts).
public enum PanelLimits {
    /// macOS `PIPE_BUF` (`sys/syslimits.h`), the largest write a pipe takes whole or not at all:
    /// one command line, newline included, must be shorter than this.
    public static let commandMaxBytes = 512
    public static let previewChunkMaxBytes = 16 * 1024
    /// RESOURCE_MAX_BYTES: the largest resource the core stores, so the largest preview.
    public static let resourceMaxBytes = 128 * 1024
    public static let offersMax = 50
    public static let libraryMax = 200
    public static let originsMax = 200
    public static let conflictsMax = 50
    public static let libraryVersionsMax = 6
    public static let auditMax = 200
    /// Source URLs, counted in UTF-8 bytes. Never echoed in a command.
    public static let urlMaxBytes = 2048
    /// RFC 1123 hostname length.
    public static let hostnameMaxBytes = 253
    /// `https://` + a hostname of at most `hostnameMaxBytes` + `:65535` (HOST_ORIGIN_MAX_CHARS),
    /// so an origin echoed in a command keeps the line under `commandMaxBytes`.
    public static let originMaxBytes = 267
    /// zod `z.int()`: a safe integer.
    public static let maxRevision = 9_007_199_254_740_991
    /// JOB_MAX_PICKS.
    public static let resultItemsMax = 3
    /// CANDIDATE_TITLE_MAX, in UTF-16 code units.
    public static let resultTitleMax = 160
    /// JOB_REASON_MAX_CHARS, in UTF-16 code units.
    public static let resultReasonMax = 140
    /// CANDIDATE_ID_MAX_CHARS.
    public static let candidateIdMaxBytes = 32
}

/// Pattern checks for values the app may send back to the core.
public enum WireFormat {
    /// `[A-Za-z0-9_-]{1,64}`: command IDs and preview cursors.
    public static func isToken(_ s: String) -> Bool {
        (1...64).contains(s.utf8.count) && s.utf8.allSatisfy { b in
            (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || b == 0x5F || b == 0x2D
        }
    }

    /// 64 lowercase hex characters.
    public static func isHash(_ s: String) -> Bool {
        s.utf8.count == 64 && s.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
    }

    /// `res_` + 64 lowercase hex.
    public static func isResourceId(_ s: String) -> Bool {
        s.hasPrefix("res_") && isHash(String(s.dropFirst(4)))
    }

    /// A loose https check; the core holds the strict one. At most `urlMaxBytes` UTF-8 bytes, and
    /// nothing JSON would escape (control characters, `"`, `\`), so its encoded size is its byte count.
    public static func isHttpsURL(_ s: String) -> Bool {
        let bytes = s.utf8
        return s.hasPrefix("https://") && bytes.count > 8 && bytes.count <= PanelLimits.urlMaxBytes
            && bytes.allSatisfy { $0 >= 0x20 && $0 != 0x22 && $0 != 0x5C }
    }

    /// `https://host[:port]` as the contract's `isHttpsOrigin` accepts it: an RFC 1123 hostname
    /// (lowercase letters, digits, inner hyphens; labels of at most 63, at most `hostnameMaxBytes`
    /// in all; the last label not all digits) and a port 1-65535 without leading zeros other than
    /// 443. ASCII only, so at most `originMaxBytes` and nothing JSON escapes.
    public static func isHostOrigin(_ s: String) -> Bool {
        let scheme = "https://"
        guard s.hasPrefix(scheme), s.utf8.count <= PanelLimits.originMaxBytes else { return false }
        let rest = Substring(s.dropFirst(scheme.count))
        let parts = rest.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let host = parts[0]
        if parts.count == 2 {
            let port = parts[1]
            guard (1...5).contains(port.utf8.count), port.utf8.allSatisfy({ (0x30...0x39).contains($0) }),
                  port.first != "0", let n = Int(port), n <= 65535, n != 443 else { return false }
        }
        guard (1...PanelLimits.hostnameMaxBytes).contains(host.utf8.count) else { return false }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        for label in labels {
            let bytes = Array(label.utf8)
            guard (1...63).contains(bytes.count), bytes.first != 0x2D, bytes.last != 0x2D,
                  bytes.allSatisfy({ (0x61...0x7A).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2D }) else { return false }
        }
        return !labels.last!.utf8.allSatisfy { (0x30...0x39).contains($0) }
    }

    /// `c` + lowercase base36, at most `candidateIdMaxBytes`.
    public static func isCandidateId(_ s: String) -> Bool {
        let bytes = Array(s.utf8)
        return (2...PanelLimits.candidateIdMaxBytes).contains(bytes.count) && bytes[0] == 0x63
            && bytes.dropFirst().allSatisfy { (0x30...0x39).contains($0) || (0x61...0x7A).contains($0) }
    }

    static func isRevision(_ n: Int) -> Bool { n >= 0 && n <= PanelLimits.maxRevision }
}

struct WireError: Error {}

private func check(_ condition: Bool) throws {
    if !condition { throw WireError() }
}

private struct AnyKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

/// Throws when the object holds a key outside `allowed`.
private func onlyKeys<K: CodingKey>(_ decoder: Decoder, _ allowed: [K]) throws {
    let names = Set(allowed.map(\.stringValue))
    let present = try decoder.container(keyedBy: AnyKey.self).allKeys
    try check(present.allSatisfy { names.contains($0.stringValue) })
}

public enum ResourceKind: String, Sendable, Equatable, Codable {
    case llmsTxt = "llms_txt"
    case agentsMd = "agents_md"
    case skill
}

public enum VersionState: String, Sendable, Equatable, Codable {
    case pending, approved, superseded, declined, revoked
}

public struct SkillDescriptor: Sendable, Equatable, Decodable {
    public let name: String
    public let description: String?

    public init(name: String, description: String? = nil) {
        self.name = name
        self.description = description
    }
}

/// A pending version of an unblocked resource whose site origin Chrome currently permits.
public struct CapabilityOffer: Sendable, Equatable, Decodable {
    public let resourceId: String
    public let version: String
    public let kind: ResourceKind
    public let siteOrigin: String
    public let sourceUrl: String
    public let byteLength: Int
    public let fetchedAt: Double
    /// Sent back as `expectedRevision`.
    public let resourceRevision: Int
    public let skill: SkillDescriptor?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        resourceId = try c.decode(String.self, forKey: .resourceId)
        version = try c.decode(String.self, forKey: .version)
        kind = try c.decode(ResourceKind.self, forKey: .kind)
        siteOrigin = try c.decode(String.self, forKey: .siteOrigin)
        sourceUrl = try c.decode(String.self, forKey: .sourceUrl)
        byteLength = try c.decode(Int.self, forKey: .byteLength)
        fetchedAt = try c.decode(Double.self, forKey: .fetchedAt)
        resourceRevision = try c.decode(Int.self, forKey: .resourceRevision)
        skill = try c.decodeIfPresent(SkillDescriptor.self, forKey: .skill)
        try check(WireFormat.isResourceId(resourceId) && WireFormat.isHash(version))
        try check(WireFormat.isHostOrigin(siteOrigin) && WireFormat.isHttpsURL(sourceUrl))
        try check(byteLength >= 0 && WireFormat.isRevision(resourceRevision))
    }

    private enum CodingKeys: String, CodingKey {
        case resourceId, version, kind, siteOrigin, sourceUrl, byteLength, fetchedAt, resourceRevision, skill
    }
}

public struct LibraryVersion: Sendable, Equatable, Decodable {
    public let hash: String
    public let state: VersionState
    public let byteLength: Int
    public let fetchedAt: Double

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hash = try c.decode(String.self, forKey: .hash)
        state = try c.decode(VersionState.self, forKey: .state)
        byteLength = try c.decode(Int.self, forKey: .byteLength)
        fetchedAt = try c.decode(Double.self, forKey: .fetchedAt)
        try check(WireFormat.isHash(hash) && byteLength >= 0)
    }

    private enum CodingKeys: String, CodingKey { case hash, state, byteLength, fetchedAt }
}

/// `blocked`: revoked; `approved`: has a default version; `no_default`: neither.
public enum LibraryState: String, Sendable, Equatable, Decodable {
    case approved, blocked
    case noDefault = "no_default"
}

public struct LibraryEntry: Sendable, Equatable, Decodable {
    public let resourceId: String
    public let kind: ResourceKind
    public let siteOrigin: String
    public let sourceUrl: String
    public let defaultVersion: String?
    public let state: LibraryState
    /// Newest first; always includes `defaultVersion`.
    public let versions: [LibraryVersion]
    public let resourceRevision: Int

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        resourceId = try c.decode(String.self, forKey: .resourceId)
        kind = try c.decode(ResourceKind.self, forKey: .kind)
        siteOrigin = try c.decode(String.self, forKey: .siteOrigin)
        sourceUrl = try c.decode(String.self, forKey: .sourceUrl)
        defaultVersion = try c.decodeIfPresent(String.self, forKey: .defaultVersion)
        state = try c.decode(LibraryState.self, forKey: .state)
        versions = try c.decode([LibraryVersion].self, forKey: .versions)
        resourceRevision = try c.decode(Int.self, forKey: .resourceRevision)
        try check(WireFormat.isResourceId(resourceId))
        try check(WireFormat.isHostOrigin(siteOrigin) && WireFormat.isHttpsURL(sourceUrl))
        try check(defaultVersion.map(WireFormat.isHash) ?? true)
        try check(versions.count <= PanelLimits.libraryVersionsMax && WireFormat.isRevision(resourceRevision))
    }

    private enum CodingKeys: String, CodingKey {
        case resourceId, kind, siteOrigin, sourceUrl, defaultVersion, state, versions, resourceRevision
    }
}

public enum ConflictCode: String, Sendable, Equatable, Decodable {
    case foreignCollision = "foreign_collision"
    case leftModified = "left_modified"
    case leftSymlink = "left_symlink"
    case nameCollision = "name_collision"
    case ioError = "io_error"
}

/// A skill wrapper the exporter left alone.
public struct CapabilityConflict: Sendable, Equatable, Decodable {
    public let name: String
    public let resourceId: String
    public let code: ConflictCode

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        resourceId = try c.decode(String.self, forKey: .resourceId)
        code = try c.decode(ConflictCode.self, forKey: .code)
        try check(WireFormat.isResourceId(resourceId))
    }

    private enum CodingKeys: String, CodingKey { case name, resourceId, code }
}

public struct OriginSetting: Sendable, Equatable, Decodable {
    public let origin: String
    public let autoAcquire: Bool
    /// Present only while auto-acquire is on.
    public let acknowledgedAt: Double?
    /// Chrome currently grants this origin.
    public let permitted: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        origin = try c.decode(String.self, forKey: .origin)
        autoAcquire = try c.decode(Bool.self, forKey: .autoAcquire)
        acknowledgedAt = try c.decodeIfPresent(Double.self, forKey: .acknowledgedAt)
        permitted = try c.decode(Bool.self, forKey: .permitted)
        try check(WireFormat.isHostOrigin(origin))
    }

    private enum CodingKeys: String, CodingKey { case origin, autoAcquire, acknowledgedAt, permitted }
}

/// The whole capability view; the core re-sends it on every change.
public struct Capabilities: Sendable, Equatable, Decodable {
    /// Names the core process that sent the frame; `revision` is monotonic only within one.
    public let coreInstanceId: String
    /// Increases with every frame one core process sends.
    public let revision: Int
    public let approvalRevision: Int
    public let offers: [CapabilityOffer]
    public let library: [LibraryEntry]
    public let conflicts: [CapabilityConflict]
    public let origins: [OriginSetting]
    /// Some list was cut to its bound.
    public let truncated: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        coreInstanceId = try c.decode(String.self, forKey: .coreInstanceId)
        revision = try c.decode(Int.self, forKey: .revision)
        approvalRevision = try c.decode(Int.self, forKey: .approvalRevision)
        offers = try c.decode([CapabilityOffer].self, forKey: .offers)
        library = try c.decode([LibraryEntry].self, forKey: .library)
        conflicts = try c.decode([CapabilityConflict].self, forKey: .conflicts)
        origins = try c.decode([OriginSetting].self, forKey: .origins)
        truncated = try c.decode(Bool.self, forKey: .truncated)
        try check(WireFormat.isToken(coreInstanceId))
        try check(WireFormat.isRevision(revision) && WireFormat.isRevision(approvalRevision))
        try check(offers.count <= PanelLimits.offersMax && library.count <= PanelLimits.libraryMax)
        try check(conflicts.count <= PanelLimits.conflictsMax && origins.count <= PanelLimits.originsMax)
    }

    private enum CodingKeys: String, CodingKey {
        case coreInstanceId, revision, approvalRevision, offers, library, conflicts, origins, truncated
    }
}

/// What the preview shows beside the text; part of the version's content hash.
public struct PreviewDescriptor: Sendable, Equatable, Decodable {
    public let kind: ResourceKind
    public let siteOrigin: String
    public let sourceUrl: String
    public let contentType: String?
    public let skill: SkillDescriptor?

    public init(kind: ResourceKind, siteOrigin: String, sourceUrl: String, contentType: String? = nil, skill: SkillDescriptor? = nil) {
        self.kind = kind
        self.siteOrigin = siteOrigin
        self.sourceUrl = sourceUrl
        self.contentType = contentType
        self.skill = skill
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(ResourceKind.self, forKey: .kind)
        siteOrigin = try c.decode(String.self, forKey: .siteOrigin)
        sourceUrl = try c.decode(String.self, forKey: .sourceUrl)
        contentType = try c.decodeIfPresent(String.self, forKey: .contentType)
        skill = try c.decodeIfPresent(SkillDescriptor.self, forKey: .skill)
        try check(WireFormat.isHostOrigin(siteOrigin) && WireFormat.isHttpsURL(sourceUrl))
    }

    private enum CodingKeys: String, CodingKey { case kind, siteOrigin, sourceUrl, contentType, skill }
}

/// One chunk of one version's text, answering a `preview` command.
public struct PreviewChunk: Sendable, Equatable, Decodable {
    public let commandId: String
    public let resourceId: String
    public let version: String
    public let seq: Int
    /// Byte offset of `text` in the blob.
    public let offset: Int
    public let totalBytes: Int
    public let text: String
    /// SHA-256 of the full blob.
    public let sha256: String
    public let descriptor: PreviewDescriptor
    /// Absent on the last chunk.
    public let nextCursor: String?

    public init(
        commandId: String, resourceId: String, version: String, seq: Int, offset: Int, totalBytes: Int,
        text: String, sha256: String, descriptor: PreviewDescriptor, nextCursor: String?
    ) {
        self.commandId = commandId
        self.resourceId = resourceId
        self.version = version
        self.seq = seq
        self.offset = offset
        self.totalBytes = totalBytes
        self.text = text
        self.sha256 = sha256
        self.descriptor = descriptor
        self.nextCursor = nextCursor
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        commandId = try c.decode(String.self, forKey: .commandId)
        resourceId = try c.decode(String.self, forKey: .resourceId)
        version = try c.decode(String.self, forKey: .version)
        seq = try c.decode(Int.self, forKey: .seq)
        offset = try c.decode(Int.self, forKey: .offset)
        totalBytes = try c.decode(Int.self, forKey: .totalBytes)
        text = try c.decode(String.self, forKey: .text)
        sha256 = try c.decode(String.self, forKey: .sha256)
        descriptor = try c.decode(PreviewDescriptor.self, forKey: .descriptor)
        nextCursor = try c.decodeIfPresent(String.self, forKey: .nextCursor)
        try check(WireFormat.isToken(commandId) && WireFormat.isResourceId(resourceId))
        try check(WireFormat.isHash(version) && WireFormat.isHash(sha256))
        try check(seq >= 0 && offset >= 0 && totalBytes >= 0)
        try check(text.utf8.count <= PanelLimits.previewChunkMaxBytes)
        try check(nextCursor.map(WireFormat.isToken) ?? true)
    }

    private enum CodingKeys: String, CodingKey {
        case commandId, resourceId, version, seq, offset, totalBytes, text, sha256, descriptor, nextCursor
    }
}

public enum AckFailureCode: String, Sendable, Equatable, Decodable, CaseIterable {
    case staleRevision = "stale_revision"
    case notFound = "not_found"
    case invalid
    case storeError = "store_error"
    case notPermitted = "not_permitted"
    case unavailable

    /// Whether sending the same command again can succeed: the store or core was briefly
    /// unavailable. The others need the user to act on fresh state, under a new command.
    public var isRetryable: Bool { self == .unavailable || self == .storeError }
}

public enum Ack: Sendable, Equatable {
    /// `revision` is the resource's revision after the command; 0 when not about one resource.
    /// `target` answers `open_link` only: the href the core re-checked, not yet checked here.
    case ok(commandId: String, revision: Int, approvalRevision: Int, target: String? = nil)
    /// `revision` is the resource's current revision, when the command named a known one.
    case failed(commandId: String, code: AckFailureCode, revision: Int?)

    public var commandId: String {
        switch self {
        case let .ok(id, _, _, _), let .failed(id, _, _): return id
        }
    }
}

public enum AgentRole: String, Sendable, Equatable, Decodable {
    case interactive, job
}

public enum AgentMethod: String, Sendable, Equatable, Decodable {
    case hello
    case currentSite = "current_site"
    case recentActivity = "recent_activity"
    case siteLinks = "site_links"
    case listResources = "list_resources"
    case readResource = "read_resource"
}

/// `ok` or one of the agent status codes (`AGENT_STATUS_CODES` in contracts agent.ts).
public enum AuditOutcome: String, Sendable, Equatable, Decodable, CaseIterable {
    case ok
    case notGranted = "not_granted"
    case paused, revoked
    case notFound = "not_found"
    case expiredSnapshot = "expired_snapshot"
    case limitExceeded = "limit_exceeded"
    case unavailable
    case protocolMismatch = "protocol_mismatch"
}

/// One browser-context read by the user's agent. Never the text read.
public struct AuditEntry: Sendable, Equatable, Decodable {
    /// Milliseconds since the Unix epoch.
    public let at: Double
    public let role: AgentRole
    public let method: AgentMethod
    public let outcome: AuditOutcome
    public let origin: String?

    public init(at: Double, role: AgentRole, method: AgentMethod, outcome: AuditOutcome, origin: String? = nil) {
        self.at = at
        self.role = role
        self.method = method
        self.outcome = outcome
        self.origin = origin
    }
}

/// Core -> app.
public enum PanelState: Sendable, Equatable {
    /// `permitted` is present on `idle` only: whether a visit to a Chrome-permitted origin is current.
    /// `jobId` is present on `working` only: the job a spinner belongs to.
    case state(status: CoreStatus, visitEpoch: Int?, detail: String?, permitted: Bool? = nil, jobId: String? = nil)
    case results(ResultsFrame)
    case capabilities(Capabilities)
    case preview(PreviewChunk)
    case ack(Ack)
    /// Oldest first.
    case audit([AuditEntry])
    case grant(agentBrowserContext: Bool)

    /// Decodes one JSONL line. Returns nil for anything that doesn't match the contract.
    public static func decode(line: Data) -> PanelState? {
        let decoder = JSONDecoder()
        guard let raw = try? decoder.decode(Raw.self, from: line) else {
            return nil
        }
        switch raw.type {
        case "state":
            guard let name = raw.status, let status = CoreStatus(rawValue: name) else {
                return nil
            }
            if let jobId = raw.jobId {
                guard status == .working, WireFormat.isToken(jobId) else { return nil }
            }
            return .state(status: status, visitEpoch: raw.visitEpoch, detail: raw.detail, permitted: raw.permitted, jobId: raw.jobId)
        case "results":
            return (try? decoder.decode(ResultsFrame.self, from: line)).map(PanelState.results)
        case "capabilities":
            return (try? decoder.decode(Capabilities.self, from: line)).map(PanelState.capabilities)
        case "preview":
            return (try? decoder.decode(PreviewChunk.self, from: line)).map(PanelState.preview)
        case "ack":
            guard let id = raw.commandId, WireFormat.isToken(id), let ok = raw.ok else { return nil }
            if ok {
                guard let revision = raw.revision, let approval = raw.approvalRevision,
                      WireFormat.isRevision(revision), WireFormat.isRevision(approval) else { return nil }
                return .ack(.ok(commandId: id, revision: revision, approvalRevision: approval, target: raw.target?.href))
            }
            guard let name = raw.code, let code = AckFailureCode(rawValue: name) else { return nil }
            if let revision = raw.revision, !WireFormat.isRevision(revision) { return nil }
            return .ack(.failed(commandId: id, code: code, revision: raw.revision))
        case "audit":
            guard let audit = try? decoder.decode(AuditFrame.self, from: line),
                  audit.entries.count <= PanelLimits.auditMax else { return nil }
            return .audit(audit.entries)
        case "grant":
            guard let grant = raw.agentBrowserContext else { return nil }
            return .grant(agentBrowserContext: grant)
        default:
            return nil
        }
    }

    private struct Raw: Decodable {
        let type: String
        let status: String?
        let visitEpoch: Int?
        let detail: String?
        let permitted: Bool?
        let jobId: String?
        let commandId: String?
        let ok: Bool?
        let code: String?
        let revision: Int?
        let approvalRevision: Int?
        let agentBrowserContext: Bool?
        let target: AckTarget?
    }

    private struct AckTarget: Decodable {
        let href: String
    }

    private struct AuditFrame: Decodable {
        let entries: [AuditEntry]
    }
}

/// A command from Scout's window that carries a `commandId`. Only IDs, hashes, revisions,
/// cursors, origins, and booleans: resource text never goes back to the core.
public enum PanelRequest: Sendable, Equatable, Hashable {
    case preview(resourceId: String, version: String, cursor: String?)
    case approve(resourceId: String, version: String, expectedRevision: Int)
    case decline(resourceId: String, version: String, expectedRevision: Int)
    case revoke(resourceId: String, expectedRevision: Int)
    /// `expectedEnabled` is the value the user saw when toggling; the core refuses a stale one.
    case setAutoAcquire(origin: String, enabled: Bool, acknowledgeRisk: Bool, expectedEnabled: Bool)
    case setAgentBrowserContext(enabled: Bool, expectedEnabled: Bool)
    case refreshCapabilities
    /// A click on a recommended link: the identity the window showed. Nothing opens except
    /// through this command's ack.
    case openLink(coreInstanceId: String, visitEpoch: Int, jobId: String, candidateId: String)

    /// Everything except `preview` is acked and listed under Problems when it fails. All but
    /// `openLink` change stored state or settings.
    public var isMutation: Bool {
        if case .preview = self { return false }
        return true
    }

    /// Approve, decline, and revoke: guarded by `expectedRevision`, so safe to re-send to a new core.
    public var isDecision: Bool {
        switch self {
        case .approve, .decline, .revoke: return true
        default: return false
        }
    }

    /// A settings toggle: never retried; the user toggles again from fresh state.
    public var isToggle: Bool {
        switch self {
        case .setAutoAcquire, .setAgentBrowserContext: return true
        default: return false
        }
    }
}

/// App -> core.
public enum NativeCommand: Sendable, Equatable {
    /// `at` is milliseconds since the Unix epoch.
    case frontmost(bundleId: String, at: Int64)
    case pause
    case resume
    case shutdown
    case panel(commandId: String, PanelRequest)

    /// One JSON object followed by a newline.
    public func jsonLine() -> Data {
        var object: [String: Any]
        switch self {
        case let .frontmost(bundleId, at):
            object = ["type": "frontmost", "bundleId": bundleId, "at": at]
        case .pause:
            object = ["type": "pause"]
        case .resume:
            object = ["type": "resume"]
        case .shutdown:
            object = ["type": "shutdown"]
        case let .panel(commandId, request):
            object = Self.fields(of: request)
            object["commandId"] = commandId
        }
        // Only strings, integers, and booleans above, so serialization cannot fail.
        let options: JSONSerialization.WritingOptions = [.sortedKeys, .withoutEscapingSlashes]
        var data = (try? JSONSerialization.data(withJSONObject: object, options: options)) ?? Data()
        data.append(0x0A)
        return data
    }

    private static func fields(of request: PanelRequest) -> [String: Any] {
        switch request {
        case let .preview(resourceId, version, cursor):
            var object: [String: Any] = ["type": "preview", "resourceId": resourceId, "version": version]
            if let cursor { object["cursor"] = cursor }
            return object
        case let .approve(resourceId, version, expectedRevision):
            return ["type": "approve", "resourceId": resourceId, "version": version, "expectedRevision": expectedRevision]
        case let .decline(resourceId, version, expectedRevision):
            return ["type": "decline", "resourceId": resourceId, "version": version, "expectedRevision": expectedRevision]
        case let .revoke(resourceId, expectedRevision):
            return ["type": "revoke", "resourceId": resourceId, "expectedRevision": expectedRevision]
        case let .setAutoAcquire(origin, enabled, acknowledgeRisk, expectedEnabled):
            return ["type": "set_auto_acquire", "origin": origin, "enabled": enabled, "acknowledgeRisk": acknowledgeRisk,
                    "expectedEnabled": expectedEnabled]
        case let .setAgentBrowserContext(enabled, expectedEnabled):
            return ["type": "set_agent_browser_context", "enabled": enabled, "expectedEnabled": expectedEnabled]
        case .refreshCapabilities:
            return ["type": "refresh_capabilities"]
        case let .openLink(coreInstanceId, visitEpoch, jobId, candidateId):
            return ["type": "open_link", "coreInstanceId": coreInstanceId, "visitEpoch": visitEpoch, "jobId": jobId,
                    "candidateId": candidateId]
        }
    }

    public static func frontmost(bundleId: String, date: Date) -> NativeCommand {
        .frontmost(bundleId: bundleId, at: Int64((date.timeIntervalSince1970 * 1000).rounded(.down)))
    }
}
