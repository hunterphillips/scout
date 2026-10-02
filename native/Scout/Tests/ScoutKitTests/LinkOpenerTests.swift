import Foundation
import Testing
@testable import ScoutKit

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
        var opened: [URL] = []
        let opener = LinkOpener { opened.append($0) }
        #expect(opener.open(href, origin: Self.origin) == refusal, "\(href)")
        #expect(opened.map(\.absoluteString) == (refusal == nil ? [href] : []), "\(href)")
    }

    @Test func aResultOnAnotherPortCannotOpen() {
        #expect(LinkOpener.check("https://docs.example.com:8443/a", origin: "https://docs.example.com:8443") == .failure(.port))
        #expect(LinkOpener.check("https://docs.example.com/a", origin: "https://docs.example.com:8443") == .failure(.wrongHost))
    }

    @Test func refusalsHaveText() {
        for refusal in LinkOpener.Refusal.allCases { #expect(!refusal.text.isEmpty) }
    }
}
