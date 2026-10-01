import Foundation

/// The core's latest capability view, browser-context grant, and context-read audit, plus the
/// lookups the window needs. `capabilities` frames replace each other whole; a frame with a
/// lower `revision` than the one held is stale and dropped. Revisions restart with each core
/// process, so `reset()` on a restart.
public struct CapabilityModel: Sendable, Equatable {
    public private(set) var capabilities: Capabilities?
    /// What the latest `grant` frame said; nil until one arrives.
    public private(set) var agentBrowserContext: Bool?
    /// Oldest first.
    public private(set) var audit: [AuditEntry] = []

    public init() {}

    /// Returns false for a stale frame.
    @discardableResult
    public mutating func apply(_ frame: Capabilities) -> Bool {
        if let held = capabilities, frame.revision < held.revision { return false }
        capabilities = frame
        return true
    }

    public mutating func applyGrant(_ enabled: Bool) {
        agentBrowserContext = enabled
    }

    public mutating func applyAudit(_ entries: [AuditEntry]) {
        audit = entries
    }

    public mutating func reset() {
        self = CapabilityModel()
    }

    public var offers: [CapabilityOffer] { capabilities?.offers ?? [] }
    public var library: [LibraryEntry] { capabilities?.library ?? [] }
    public var conflicts: [CapabilityConflict] { capabilities?.conflicts ?? [] }
    public var origins: [OriginSetting] { capabilities?.origins ?? [] }

    /// Offers whose site is `host` (a hostname, as the idle state's `detail` carries it).
    public func offers(forHost host: String) -> [CapabilityOffer] {
        offers.filter { Self.host(of: $0.siteOrigin) == host }
    }

    public func offer(_ key: PreviewKey) -> CapabilityOffer? {
        offers.first { $0.resourceId == key.resourceId && $0.version == key.version }
    }

    public func libraryEntry(_ resourceId: String) -> LibraryEntry? {
        library.first { $0.resourceId == resourceId }
    }

    public func originSetting(_ origin: String) -> OriginSetting? {
        origins.first { $0.origin == origin }
    }

    /// The hostname of an `https://host[:port]` origin.
    public static func host(of origin: String) -> String? {
        URLComponents(string: origin)?.host
    }

    /// Why `key` cannot be approved right now, or nil when it can, given a complete preview.
    /// The revision to send comes from `approvalRevision(for:)`.
    public func approvalBlocker(_ key: PreviewKey) -> ApprovalBlocker? {
        if offer(key) != nil { return nil }
        guard let entry = libraryEntry(key.resourceId),
              let version = entry.versions.first(where: { $0.hash == key.version }) else {
            return .notOffered
        }
        // The library's explicit re-approval of a revoked resource; the core skips the origin check.
        if entry.state == .blocked { return nil }
        switch version.state {
        case .approved:
            return entry.defaultVersion == key.version ? .alreadyApproved : nil
        case .pending, .declined, .superseded:
            if version.state == .pending, originSetting(entry.siteOrigin)?.permitted == false {
                return .siteNotPermitted
            }
            return nil
        case .revoked:
            return .notOffered
        }
    }

    /// `expectedRevision` for a decision about `key`: the offer's, else the library entry's.
    public func resourceRevision(_ resourceId: String) -> Int? {
        offers.first { $0.resourceId == resourceId }?.resourceRevision
            ?? libraryEntry(resourceId)?.resourceRevision
    }
}

public enum ApprovalBlocker: Sendable, Equatable {
    /// Neither offered nor in the library any more.
    case notOffered
    case alreadyApproved
    /// A pending version for a site Chrome does not grant right now.
    case siteNotPermitted

    public var reason: String {
        switch self {
        case .notOffered: return "This version is no longer offered."
        case .alreadyApproved: return "This version is already approved."
        case .siteNotPermitted: return "Chrome does not give Scout access to this site right now."
        }
    }
}
