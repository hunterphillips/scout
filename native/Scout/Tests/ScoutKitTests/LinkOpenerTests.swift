import Foundation
import Testing
@testable import ScoutKit

/// What a fake opener saw and what `open` answered; the completion may run on any thread.
final class OpenLog: @unchecked Sendable {
    private let lock = NSLock()
    private var _opened: [URL] = []
    private var _answers: [LinkOpener.Refusal?] = []
    var opened: [URL] { lock.withLock { _opened } }
    var answers: [LinkOpener.Refusal?] { lock.withLock { _answers } }
    func open(_ url: URL) { lock.withLock { _opened.append(url) } }
    func answer(_ refusal: LinkOpener.Refusal?) { lock.withLock { _answers.append(refusal) } }

    /// An opener that records the URL and reports `succeeds`.
    func opener(succeeds: Bool = true) -> LinkOpener {
        LinkOpener { url, done in
            self.open(url)
            done(succeeds)
        }
    }
}

@Suite struct LinkOpenerTests {
    static let origin = "https://docs.example.com"

    @Test(arguments: [
        ("https://docs.example.com/webhooks", nil),
        ("https://docs.example.com/guides/start?tab=a#top", nil),
        ("https://docs.example.com/", nil),
        ("http://docs.example.com/webhooks", LinkOpener.Refusal.notHTTPS),
        ("javascript:alert(1)", .notHTTPS),
        ("file:///etc/passwd", .notHTTPS),
        ("data:text/html,hi", .notHTTPS),
        ("https://user:pw@docs.example.com/a", .credentials),
        ("https://user@docs.example.com/a", .credentials),
        ("https://docs.example.com:443/a", .port),
        ("https://docs.example.com:8443/a", .port),
        ("https://docs.example.com:/a", .port),
        ("https://docs.example.com:", .port),
        ("https://docs.example.com.:443/a", .port),
        ("https://docs.example.com./a", .wrongHost),
        ("https://docs.example.com.", .wrongHost),
        ("https://other.example.com/a", .wrongHost),
        ("https://docs.example.com.evil.example/a", .wrongHost),
        ("https://evil.example/#docs.example.com", .wrongHost),
        ("https://DOCS.EXAMPLE.COM/a", .wrongHost),
        ("#top", .malformed),
        ("/relative/path", .malformed),
        ("", .malformed),
        (" https://docs.example.com/a", .malformed),
        ("https://docs.example.com/a b", .malformed),
        ("https://docs.example.com\\@evil.example/", .malformed),
        ("https://docs.example.com/\u{00E9}", .malformed),
    ] as [(String, LinkOpener.Refusal?)])
    func checks(href: String, refusal: LinkOpener.Refusal?) {
        let log = OpenLog()
        log.opener().open(href, origin: Self.origin) { log.answer($0) }
        #expect(log.answers == [refusal], "\(href)")
        #expect(log.opened.map(\.absoluteString) == (refusal == nil ? [href] : []), "\(href)")
    }

    @Test func anOpenThatFailsIsRefusedAsOpenFailed() {
        // The app's opener reports failure when Chrome is not installed or the open errs; it
        // never falls back to another browser.
        let log = OpenLog()
        log.opener(succeeds: false).open(Self.origin + "/a", origin: Self.origin) { log.answer($0) }
        #expect(log.opened == [URL(string: Self.origin + "/a")!])
        #expect(log.answers == [.openFailed])
    }

    @Test func aResultOnAnotherPortCannotOpen() {
        #expect(LinkOpener.check("https://docs.example.com:8443/a", origin: "https://docs.example.com:8443") == .failure(.port))
        #expect(LinkOpener.check("https://docs.example.com/a", origin: "https://docs.example.com:8443") == .failure(.wrongHost))
    }

    @Test func refusalsHaveText() {
        for refusal in LinkOpener.Refusal.allCases { #expect(!refusal.text.isEmpty) }
    }
}
