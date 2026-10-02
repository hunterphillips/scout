import Foundation

/// Opens a recommended link, and only one the core sent back for the user's click
/// (`open_link`'s ack). The core has already re-checked the target; this checks it again
/// before anything opens: `https`, no user or password, no explicit port (not even 443), and
/// exactly the result's host. Any path, query, or fragment on that host passes, so a verified
/// HTML twin does. The open itself is injected (`NSWorkspace.shared.open` in the app), so the
/// checks are testable and nothing here touches AppKit.
public struct LinkOpener {
    /// Why a target was not opened; the Problems list shows it.
    public enum Refusal: String, Error, Sendable, Equatable, CaseIterable {
        case malformed
        case notHTTPS = "not_https"
        case credentials
        case port
        case wrongHost = "wrong_host"

        public var text: String {
            switch self {
            case .malformed: return "the link was malformed"
            case .notHTTPS: return "the link was not https"
            case .credentials: return "the link carried a user name or password"
            case .port: return "the link named a port"
            case .wrongHost: return "the link pointed at another site"
            }
        }
    }

    private let openURL: (URL) -> Void

    public init(open: @escaping (URL) -> Void) {
        openURL = open
    }

    /// `href` as a URL to open for a result from `origin` (`https://host`), or why not.
    public static func check(_ href: String, origin: String) -> Result<URL, Refusal> {
        let bytes = href.utf8
        // Nothing a parser might read two ways: no whitespace, controls, backslashes, or non-ASCII.
        guard !bytes.isEmpty, bytes.count <= PanelLimits.urlMaxBytes,
              bytes.allSatisfy({ $0 > 0x20 && $0 < 0x7F && $0 != 0x5C }) else { return .failure(.malformed) }
        guard href.hasPrefix("https://") else {
            return .failure(href.contains(":") ? .notHTTPS : .malformed)
        }
        guard let parts = URLComponents(string: href), let url = URL(string: href) else { return .failure(.malformed) }
        guard parts.scheme == "https", url.scheme == "https" else { return .failure(.notHTTPS) }
        guard parts.user == nil, parts.password == nil, url.user == nil, url.password == nil else { return .failure(.credentials) }
        guard parts.port == nil, url.port == nil else { return .failure(.port) }
        // The result's origin must itself be a bare https host: a result on another port cannot open.
        guard let expected = URLComponents(string: origin), expected.scheme == "https", expected.port == nil,
              let host = expected.percentEncodedHost, !host.isEmpty, "https://" + host == origin else { return .failure(.wrongHost) }
        guard parts.percentEncodedHost == host, url.host == host else { return .failure(.wrongHost) }
        return .success(url)
    }

    /// Checks `href` and opens it; returns why not when refused.
    @discardableResult
    public func open(_ href: String, origin: String) -> Refusal? {
        switch Self.check(href, origin: origin) {
        case let .success(url):
            openURL(url)
            return nil
        case let .failure(refusal):
            return refusal
        }
    }
}
