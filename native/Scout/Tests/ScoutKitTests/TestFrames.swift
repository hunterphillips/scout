import CryptoKit
import Foundation
@testable import ScoutKit

/// Builders for frames in tests. Wire types decode only, so these go through JSON.
enum TestFrames {
    typealias F = ContractFixtures

    static func offer(
        rid: String = F.rid, version: String = F.v1, origin: String = F.origin, revision: Int = 1
    ) -> [String: Any] {
        ["resourceId": rid, "version": version, "kind": "llms_txt", "siteOrigin": origin,
         "sourceUrl": origin + "/llms.txt", "byteLength": 100, "fetchedAt": 1, "resourceRevision": revision]
    }

    static func entry(
        rid: String = F.rid, origin: String = F.origin, state: String = "approved", defaultVersion: String? = F.v2,
        versions: [(String, String)] = [(F.v2, "approved")], revision: Int = 5
    ) -> [String: Any] {
        var e: [String: Any] = [
            "resourceId": rid, "kind": "llms_txt", "siteOrigin": origin, "sourceUrl": origin + "/llms.txt",
            "state": state, "resourceRevision": revision,
            "versions": versions.map { ["hash": $0.0, "state": $0.1, "byteLength": 1, "fetchedAt": 1] },
        ]
        if let defaultVersion { e["defaultVersion"] = defaultVersion }
        return e
    }

    static func origin(_ origin: String = F.origin, autoAcquire: Bool = false, permitted: Bool = true) -> [String: Any] {
        ["origin": origin, "autoAcquire": autoAcquire, "permitted": permitted]
    }

    static func capabilities(
        instance: String = "core-1", revision: Int = 1, offers: [[String: Any]] = [], library: [[String: Any]] = [],
        origins: [[String: Any]] = [], conflicts: [[String: Any]] = []
    ) throws -> Capabilities {
        let frame: [String: Any] = [
            "type": "capabilities", "coreInstanceId": instance, "revision": revision, "approvalRevision": 0, "truncated": false,
            "offers": offers, "library": library, "conflicts": conflicts, "origins": origins,
        ]
        return try JSONDecoder().decode(Capabilities.self, from: JSONSerialization.data(withJSONObject: frame))
    }

    /// A `results` frame for core instance "core-1" (TestFrames.capabilities' default).
    static func results(
        epoch: Int, job: String = "job-1", instance: String = "core-1", origin: String = F.origin, _ outcome: ResultsOutcome
    ) -> PanelState {
        .results(ResultsFrame(coreInstanceId: instance, visitEpoch: epoch, origin: origin, jobId: job, outcome: outcome))
    }

    static let descriptor = PreviewDescriptor(kind: .llmsTxt, siteOrigin: F.origin, sourceUrl: F.origin + "/llms.txt")

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// `text` cut into chunks of at most `size` bytes on code-point boundaries, as the core cuts it.
    /// Each carries commandId "x"; `answer` substitutes the ID of the command it answers.
    static func chunks(of text: String, key: PreviewKey, size: Int) -> [PreviewChunk] {
        let bytes = Data(text.utf8)
        let sha = sha256(bytes)
        var out: [PreviewChunk] = []
        var offset = 0
        repeat {
            var end = min(offset + size, bytes.count)
            while end < bytes.count && (bytes[end] & 0xC0) == 0x80 { end -= 1 }
            let last = end >= bytes.count
            out.append(PreviewChunk(
                commandId: "x", resourceId: key.resourceId, version: key.version, seq: out.count, offset: offset,
                totalBytes: bytes.count, text: String(decoding: bytes[offset..<end], as: UTF8.self), sha256: sha,
                descriptor: descriptor, nextCursor: last ? nil : "cur\(out.count + 1)"))
            offset = end
        } while offset < bytes.count
        return out
    }

    static func with(_ chunk: PreviewChunk, commandId: String) -> PreviewChunk {
        PreviewChunk(
            commandId: commandId, resourceId: chunk.resourceId, version: chunk.version, seq: chunk.seq,
            offset: chunk.offset, totalBytes: chunk.totalBytes, text: chunk.text, sha256: chunk.sha256,
            descriptor: chunk.descriptor, nextCursor: chunk.nextCursor)
    }

    /// Answers `first` and each follow-up request with the next chunk. Returns every command the model sent.
    static func answer(_ model: inout PanelModel, first: NativeCommand, with chunks: [PreviewChunk]) -> [NativeCommand] {
        var request: NativeCommand? = first
        var sent: [NativeCommand] = []
        for chunk in chunks {
            guard let id = request?.commandId else { break }
            let more = model.apply(.preview(with(chunk, commandId: id)))
            sent += more
            request = more.first
        }
        return sent
    }
}
