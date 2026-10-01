import Foundation
import Testing
@testable import ScoutKit

/// App -> core commands: parity with the shared fixtures, the atomic-write bound, and no
/// resource text on the wire.
@Suite struct CommandEncodingTests {
    typealias F = ContractFixtures

    private func object(_ command: NativeCommand) throws -> NSDictionary {
        let line = command.jsonLine()
        #expect(line.last == 0x0A)
        #expect(line.dropLast().contains(0x0A) == false)
        return try JSONSerialization.jsonObject(with: line) as! NSDictionary
    }

    @Test func everyCommandMatchesItsFixture() throws {
        let cases: [(String, NativeCommand)] = [
            ("command.frontmost.json", .frontmost(bundleId: "com.google.Chrome", at: 1_759_300_000_123)),
            ("command.pause.json", .pause),
            ("command.resume.json", .resume),
            ("command.shutdown.json", .shutdown),
            ("command.preview.json", .panel(commandId: "app-1", .preview(resourceId: F.rid, version: F.v1, cursor: nil))),
            ("command.preview-cursor.json", .panel(commandId: "app-2", .preview(resourceId: F.rid, version: F.v1, cursor: "cur_A-1"))),
            ("command.approve.json", .panel(commandId: "app-3", .approve(resourceId: F.rid, version: F.v1, expectedRevision: 1))),
            ("command.decline.json", .panel(commandId: "app-6", .decline(resourceId: F.rid, version: F.v1, expectedRevision: 1))),
            ("command.revoke.json", .panel(commandId: "app-7", .revoke(resourceId: F.rid, expectedRevision: 5))),
            ("command.set-auto-acquire.json", .panel(commandId: "app-8", .setAutoAcquire(origin: F.origin, enabled: true, acknowledgeRisk: true, expectedEnabled: false))),
            ("command.set-agent-browser-context.json", .panel(commandId: "app-10", .setAgentBrowserContext(enabled: false, expectedEnabled: true))),
            ("command.refresh-capabilities.json", .panel(commandId: "app-11", .refreshCapabilities)),
        ]
        #expect(Set(cases.map(\.0)) == Set(try F.names(prefix: "command.")))
        for (name, command) in cases {
            #expect(try object(command) == F.object(name), "\(name)")
        }
    }

    @Test func booleansEncodeAsJSONBooleans() {
        let line = String(decoding: NativeCommand.panel(commandId: "x",
            .setAutoAcquire(origin: F.origin, enabled: true, acknowledgeRisk: false, expectedEnabled: true)).jsonLine(), as: UTF8.self)
        #expect(line == #"{"acknowledgeRisk":false,"commandId":"x","enabled":true,"expectedEnabled":true,"origin":"https://docs.example.com","type":"set_auto_acquire"}"# + "\n")
    }

    @Test func largestLegalCommandOfEachTypeFitsOneAtomicWrite() {
        let id = String(repeating: "Z", count: 64)
        let cursor = String(repeating: "c", count: 64)
        let rid = "res_" + String(repeating: "f", count: 64)
        let hash = String(repeating: "f", count: 64)
        let rev = PanelLimits.maxRevision
        let origin = "https://" + String(repeating: "a", count: PanelLimits.urlMaxBytes - 8)
        #expect(WireFormat.isHttpsURL(origin))
        let requests: [PanelRequest] = [
            .preview(resourceId: rid, version: hash, cursor: cursor),
            .approve(resourceId: rid, version: hash, expectedRevision: rev),
            .decline(resourceId: rid, version: hash, expectedRevision: rev),
            .revoke(resourceId: rid, expectedRevision: rev),
            .setAutoAcquire(origin: origin, enabled: false, acknowledgeRisk: false, expectedEnabled: false),
            .setAgentBrowserContext(enabled: false, expectedEnabled: false),
            .refreshCapabilities,
        ]
        for request in requests {
            let size = NativeCommand.panel(commandId: id, request).jsonLine().count
            #expect(size < PanelLimits.commandMaxBytes, "\(request) is \(size) bytes")
        }
    }

    @Test func originsAreBoundedInUTF8Bytes() {
        // 2048 characters but 6136 bytes: refused, so it can never be echoed into a command.
        let wide = "https://" + String(repeating: "\u{7FFF}", count: PanelLimits.urlMaxBytes - 8)
        #expect(!WireFormat.isHttpsURL(wide))
        // The widest origin that passes, multi-byte characters included, still fits one write.
        let fill = PanelLimits.urlMaxBytes - 8
        let accepted = "https://" + String(repeating: "\u{7FFF}", count: fill / 3) + String(repeating: "a", count: fill % 3)
        #expect(accepted.utf8.count == PanelLimits.urlMaxBytes && WireFormat.isHttpsURL(accepted))
        let size = NativeCommand.panel(commandId: String(repeating: "Z", count: 64),
            .setAutoAcquire(origin: accepted, enabled: false, acknowledgeRisk: false, expectedEnabled: false)).jsonLine().count
        #expect(size < PanelLimits.commandMaxBytes)
        // Characters JSON would escape (and so grow) are refused.
        for bad in ["\"", "\\", "\u{01}", "\n"] {
            #expect(!WireFormat.isHttpsURL("https://a" + bad + "b.example"), "\(bad.unicodeScalars.map(\.value))")
        }
    }

    @Test func noCommandCarriesPreviewText() throws {
        // Load a preview and drive every action the model has; nothing written may hold the text.
        let marker = "SECRET-RESOURCE-TEXT-\u{1F512}"
        let text = String(repeating: marker + "\n", count: 30)
        var model = PanelModel(commands: CommandTracker(prefix: "t"))
        var sent: [NativeCommand] = model.apply(.running)
        _ = model.apply(.capabilities(try TestFrames.capabilities(offers: [TestFrames.offer()], origins: [TestFrames.origin()])))
        _ = model.apply(.grant(agentBrowserContext: false))
        let key = PreviewKey(resourceId: F.rid, version: F.v1)
        let requestSent = model.showPreview(key)
        let request = try #require(requestSent)
        sent.append(request)
        sent += TestFrames.answer(&model, first: request, with: TestFrames.chunks(of: text, key: key, size: 200))
        #expect(model.preview(key)?.isComplete == true)
        sent += [model.approve(key), model.decline(key), model.revoke(F.rid),
                 model.setAutoAcquire(origin: F.origin, enabled: true, acknowledgeRisk: true),
                 model.setAgentBrowserContext(true), model.refreshCapabilities(), model.pauseCommand()]
            .compactMap { $0 }
        #expect(sent.count > 5)
        for command in sent {
            let line = String(decoding: command.jsonLine(), as: UTF8.self)
            #expect(!line.contains("SECRET-RESOURCE-TEXT"))
        }
    }
}
