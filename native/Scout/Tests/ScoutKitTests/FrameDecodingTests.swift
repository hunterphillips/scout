import Foundation
import Testing
@testable import ScoutKit

/// Every core -> app frame, decoded from the shared fixtures.
@Suite struct FrameDecodingTests {
    typealias F = ContractFixtures

    @Test func everyFrameFixtureDecodes() throws {
        let names = try F.names(prefix: "frame.")
        #expect(names.count >= 15)
        for name in names {
            #expect(try F.frame(name) != nil, "\(name) did not decode")
            var parser = JSONLParser()
            #expect(try parser.append(F.line(name)).count == 1, "\(name) did not parse as a line")
        }
    }

    @Test func idleStateCarriesPermitted() throws {
        #expect(try F.frame("frame.state.idle.json")
            == .state(status: .idle, visitEpoch: 3, detail: "docs.example.com", permitted: true))
        #expect(try F.frame("frame.state.working.json")
            == .state(status: .working, visitEpoch: 3, detail: nil, permitted: nil))
    }

    @Test func capabilitiesWithOptionalFieldsAbsent() throws {
        guard case let .capabilities(caps) = try F.frame("frame.capabilities.minimal.json") else {
            Issue.record("not capabilities"); return
        }
        #expect(caps.revision == 1 && caps.approvalRevision == 0 && !caps.truncated)
        let offer = try #require(caps.offers.first)
        #expect(offer.skill == nil && offer.kind == .llmsTxt && offer.resourceRevision == 1)
        let entry = try #require(caps.library.first)
        #expect(entry.defaultVersion == nil && entry.state == .noDefault)
        #expect(entry.versions.map(\.state) == [.pending])
        #expect(caps.conflicts.isEmpty)
        #expect(caps.origins.first?.acknowledgedAt == nil)
    }

    @Test func capabilitiesWithOptionalFieldsPresent() throws {
        guard case let .capabilities(caps) = try F.frame("frame.capabilities.full.json") else {
            Issue.record("not capabilities"); return
        }
        #expect(caps.truncated)
        #expect(caps.offers.first?.skill == SkillDescriptor(name: "deploy", description: "Deploy the docs site"))
        #expect(caps.offers.first?.fetchedAt == 1_759_300_000_500.5)
        #expect(caps.library.map(\.state) == [.approved, .blocked])
        #expect(caps.library.first?.defaultVersion == F.v2)
        #expect(caps.library.first?.versions.map(\.state) == [.approved, .superseded])
        #expect(caps.conflicts.first?.code == .leftModified)
        #expect(caps.origins.first?.acknowledgedAt == 1_759_300_000_900)
        #expect(caps.origins.last?.permitted == false)
    }

    @Test func previewChunks() throws {
        guard case let .preview(first) = try F.frame("frame.preview.first.json"),
              case let .preview(last) = try F.frame("frame.preview.last.json") else {
            Issue.record("not preview"); return
        }
        #expect(first.seq == 0 && first.nextCursor == "cur_A-1")
        #expect(first.descriptor.contentType == "text/plain; charset=utf-8")
        #expect(last.seq == 1 && last.nextCursor == nil && last.offset == first.text.utf8.count)
        guard case let .preview(skill) = try F.frame("frame.preview.single-skill.json") else {
            Issue.record("not preview"); return
        }
        #expect(skill.descriptor.skill == SkillDescriptor(name: "deploy"))
    }

    @Test func acks() throws {
        #expect(try F.frame("frame.ack.ok.json") == .ack(.ok(commandId: "app-3", revision: 2, approvalRevision: 5)))
        #expect(try F.frame("frame.ack.ok-nonresource.json") == .ack(.ok(commandId: "app-4", revision: 0, approvalRevision: 5)))
        #expect(try F.frame("frame.ack.failed.json") == .ack(.failed(commandId: "app-3", code: .staleRevision, revision: 4)))
        #expect(try F.frame("frame.ack.failed-norevision.json") == .ack(.failed(commandId: "app-5", code: .notPermitted, revision: nil)))
    }

    @Test func auditAndGrant() throws {
        #expect(try F.frame("frame.audit.json") == .audit([
            AuditEntry(at: 1_759_300_001_000, role: .interactive, method: .currentSite, outcome: "ok", origin: F.origin),
            AuditEntry(at: 1_759_300_002_000, role: .job, method: .readResource, outcome: "not_granted"),
        ]))
        #expect(try F.frame("frame.audit.empty.json") == .audit([]))
        #expect(try F.frame("frame.grant.json") == .grant(agentBrowserContext: true))
    }

    /// Mutates one fixture and expects the line to be refused.
    private func refused(_ name: String, _ mutate: (NSMutableDictionary) -> Void) throws -> Bool {
        let object = try F.object(name).mutableCopy() as! NSMutableDictionary
        mutate(object)
        let data = try JSONSerialization.data(withJSONObject: object)
        return PanelState.decode(line: data) == nil
    }

    @Test func refusesFramesOutsideTheContract() throws {
        #expect(try refused("frame.ack.ok.json") { $0.removeObject(forKey: "approvalRevision") })
        #expect(try refused("frame.ack.failed.json") { $0["code"] = "nope" })
        #expect(try refused("frame.ack.ok.json") { $0["commandId"] = "has space" })
        #expect(try refused("frame.ack.ok.json") { $0["revision"] = -1 })
        #expect(try refused("frame.grant.json") { $0.removeObject(forKey: "agentBrowserContext") })
        #expect(try refused("frame.preview.first.json") { $0["version"] = "ABC" })
        #expect(try refused("frame.preview.first.json") { $0["nextCursor"] = String(repeating: "c", count: 65) })
        #expect(try refused("frame.preview.first.json") { $0["text"] = String(repeating: "é", count: 8193) })
        #expect(try refused("frame.preview.first.json") { $0["resourceId"] = "res_123" })
        #expect(try refused("frame.capabilities.minimal.json") { $0.removeObject(forKey: "truncated") })
        #expect(try refused("frame.capabilities.minimal.json") {
            let offers = ($0["offers"] as! NSArray)
            $0["offers"] = Array(repeating: offers[0], count: PanelLimits.offersMax + 1)
        })
        #expect(try refused("frame.capabilities.minimal.json") {
            let lib = ($0["library"] as! NSArray)[0] as! NSDictionary
            let entry = lib.mutableCopy() as! NSMutableDictionary
            entry["state"] = "pending_only"
            $0["library"] = [entry]
        })
        #expect(try refused("frame.audit.json") {
            let entry = (($0["entries"] as! NSArray)[0] as! NSDictionary).mutableCopy() as! NSMutableDictionary
            entry["method"] = "write_file"
            $0["entries"] = [entry]
        })
    }

    /// The largest view the core may send: every list at its bound, long URLs.
    static func largeCapabilitiesLine() throws -> Data {
        let hex = { (n: Int) in String(format: "%064x", n) }
        let origin = "https://" + String(repeating: "a", count: 60) + ".example.com"
        let url = origin + "/" + String(repeating: "p", count: 1500)
        let version = { (n: Int) -> [String: Any] in
            ["hash": hex(n), "state": "superseded", "byteLength": 131_072, "fetchedAt": 1_759_300_000_000]
        }
        let library: [[String: Any]] = (0..<PanelLimits.libraryMax).map { i in
            ["resourceId": "res_" + hex(i), "kind": "llms_txt", "siteOrigin": origin, "sourceUrl": url,
             "state": "no_default", "versions": (0..<6).map { version(i * 10 + $0) }, "resourceRevision": i]
        }
        let offers: [[String: Any]] = (0..<PanelLimits.offersMax).map { i in
            ["resourceId": "res_" + hex(i), "version": hex(i), "kind": "skill", "siteOrigin": origin,
             "sourceUrl": url, "byteLength": 10, "fetchedAt": 1, "resourceRevision": 1,
             "skill": ["name": "n\(i)", "description": String(repeating: "d", count: 200)]]
        }
        let frame: [String: Any] = [
            "type": "capabilities", "revision": 9, "approvalRevision": 3, "truncated": true,
            "offers": offers, "library": library, "conflicts": [], "origins": [],
        ]
        var line = try JSONSerialization.data(withJSONObject: frame, options: [.withoutEscapingSlashes])
        line.append(0x0A)
        return line
    }

    @Test func largeCapabilitiesFrameThroughParser() throws {
        let line = try Self.largeCapabilitiesLine()
        #expect(line.count > 300_000 && line.count < JSONLParser.maxLineBytes)
        var parser = JSONLParser()
        var states: [PanelState] = []
        var i = 0
        while i < line.count {
            states += parser.append(line[i..<min(i + 65_536, line.count)])
            i += 65_536
        }
        guard states.count == 1, case let .capabilities(caps) = states[0] else {
            Issue.record("frame did not decode"); return
        }
        #expect(caps.library.count == PanelLimits.libraryMax && caps.offers.count == PanelLimits.offersMax)
        #expect(parser.ignoredLineCount == 0)
    }
}
