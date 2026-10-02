import Foundation

/// Opens a recommended link, and only one the core sent back for the user's click
/// (`open_link`'s ack). The core has already re-checked the target; this checks it again
/// before anything opens: `https`, no user or password, no explicit port (not even 443, nor an
/// empty one), and exactly the result's host, compared byte for byte with the link's authority.
/// Any path, query, or fragment on that host passes, so a verified HTML twin does.
///
/// The open itself is injected, so the checks are testable and nothing here touches AppKit. The
/// app opens in Chrome (the configured `chromeBundleId`), never in the default browser: when
/// Chrome is not installed, or the open reports an error, the link is refused as `openFailed`.
public struct LinkOpener {
    /// Opens `url` in Chrome and calls `done` with whether it did (from any thread).
    public typealias Open = (_ url: URL, _ done: @escaping @Sendable (Bool) -> Void) -> Void

    /// Why a target was not opened; the Problems list shows it.
    public enum Refusal: String, Error, Sendable, Equatable, CaseIterable {
        case malformed
        case notHTTPS = "not_https"
        case credentials
        case port
        case wrongHost = "wrong_host"
        /// Chrome was not found, or did not open the link.
        case openFailed = "open_failed"

        public var text: String {
            switch self {
            case .malformed: return "the link was malformed"
            case .notHTTPS: return "the link was not https"
            case .credentials: return "the link carried a user name or password"
            case .port: return "the link named a port"
            case .wrongHost: return "the link pointed at another site"
            case .openFailed: return "Chrome could not open it"
            }
        }
    }

    private let openURL: Open

    public init(open: @escaping Open) {
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
        // The authority as written (after `https://`, up to the first `/`, `?`, or `#`) must be the
        // host itself, byte for byte: nothing a parser drops, such as an empty port (`host:`).
        let rest = href.utf8.dropFirst("https://".utf8.count)
        let authority = rest.prefix { $0 != UInt8(ascii: "/") && $0 != UInt8(ascii: "?") && $0 != UInt8(ascii: "#") }
        guard authority.elementsEqual(host.utf8) else {
            return .failure(authority.starts(with: Array((host + ":").utf8)) ? .port : .wrongHost)
        }
        return .success(url)
    }

    /// Checks `href` and opens it. `completion` gets nil once it opened, or why not: a failed
    /// check at once (nothing is opened), `openFailed` when the opener reports it did not open.
    public func open(_ href: String, origin: String, completion: @escaping @Sendable (Refusal?) -> Void) {
        switch Self.check(href, origin: origin) {
        case let .success(url):
            openURL(url) { opened in completion(opened ? nil : .openFailed) }
        case let .failure(refusal):
            completion(refusal)
        }
    }
}
