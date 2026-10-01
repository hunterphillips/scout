import Foundation
import Testing
@testable import ScoutKit

@Suite struct PreviewAssemblerTests {
    typealias F = ContractFixtures
    let key = PreviewKey(resourceId: F.rid, version: F.v1)

    @Test func assemblesMultiByteTextSplitAcrossChunks() {
        let text = String(repeating: "naïve café ✓ 日本語 🧭\n", count: 40)
        let chunks = TestFrames.chunks(of: text, key: key, size: 37)
        #expect(chunks.count > 10)
        var a = PreviewAssembler(key: key)
        #expect(a.requestNext() == .preview(resourceId: F.rid, version: F.v1, cursor: nil))
        for (i, chunk) in chunks.enumerated() {
            #expect(!a.isComplete)
            #expect(a.accept(chunk) == .accepted)
            if i < chunks.count - 1 {
                #expect(a.requestNext() == .preview(resourceId: F.rid, version: F.v1, cursor: "cur\(i + 1)"))
            }
        }
        #expect(a.isComplete)
        #expect(a.text == text)
        #expect(a.requestNext() == nil)
        #expect(a.descriptor == TestFrames.descriptor)
    }

    @Test func assemblesTheFixtureChunks() throws {
        guard case let .preview(first) = try F.frame("frame.preview.first.json"),
              case let .preview(last) = try F.frame("frame.preview.last.json") else {
            Issue.record("fixtures"); return
        }
        var a = PreviewAssembler(key: key)
        #expect(a.accept(first) == .accepted)
        #expect(a.accept(last) == .accepted)
        #expect(a.isComplete)
        #expect(a.text == String(repeating: "# Guide — naïve café ✓ 日本語\n", count: 3))
    }

    @Test func emptyResourceIsOneEmptyChunk() {
        var a = PreviewAssembler(key: key)
        #expect(a.accept(TestFrames.chunks(of: "", key: key, size: 10)[0]) == .accepted)
        #expect(a.isComplete && a.text.isEmpty)
    }

    @Test func rejectsOutOfOrderChunk() {
        let chunks = TestFrames.chunks(of: String(repeating: "x", count: 100), key: key, size: 30)
        var a = PreviewAssembler(key: key)
        #expect(a.accept(chunks[0]) == .accepted)
        #expect(a.accept(chunks[2]) == .rejected(.outOfOrder))
        #expect(a.phase == .failed(.outOfOrder))
        #expect(a.accept(chunks[1]) == .ignored)
        #expect(!a.isComplete && a.requestNext() == nil)
    }

    @Test func replayedChunkIsIgnored() {
        let chunks = TestFrames.chunks(of: String(repeating: "x", count: 100), key: key, size: 30)
        var a = PreviewAssembler(key: key)
        _ = a.accept(chunks[0])
        _ = a.accept(chunks[1])
        #expect(a.accept(chunks[0]) == .ignored)
        #expect(a.phase == .loading)
    }

    @Test func rejectsOverlapAndInconsistentChunks() {
        let chunks = TestFrames.chunks(of: String(repeating: "x", count: 100), key: key, size: 30)
        var overlap = PreviewAssembler(key: key)
        _ = overlap.accept(chunks[0])
        let shifted = PreviewChunk(
            commandId: "x", resourceId: F.rid, version: F.v1, seq: 1, offset: 10, totalBytes: 100,
            text: "x", sha256: chunks[0].sha256, descriptor: TestFrames.descriptor, nextCursor: "c")
        #expect(overlap.accept(shifted) == .rejected(.overlap))

        var total = PreviewAssembler(key: key)
        _ = total.accept(chunks[0])
        let grown = PreviewChunk(
            commandId: "x", resourceId: F.rid, version: F.v1, seq: 1, offset: 30, totalBytes: 101,
            text: chunks[1].text, sha256: chunks[1].sha256, descriptor: TestFrames.descriptor, nextCursor: "c")
        #expect(total.accept(grown) == .rejected(.inconsistent))

        var descriptor = PreviewAssembler(key: key)
        _ = descriptor.accept(chunks[0])
        let other = PreviewChunk(
            commandId: "x", resourceId: F.rid, version: F.v1, seq: 1, offset: 30, totalBytes: 100,
            text: chunks[1].text, sha256: chunks[1].sha256,
            descriptor: PreviewDescriptor(kind: .agentsMd, siteOrigin: F.origin, sourceUrl: F.origin + "/AGENTS.md"),
            nextCursor: "c")
        #expect(descriptor.accept(other) == .rejected(.inconsistent))
    }

    @Test func rejectsOversizedPreview() {
        var a = PreviewAssembler(key: key)
        let chunk = PreviewChunk(
            commandId: "x", resourceId: F.rid, version: F.v1, seq: 0, offset: 0,
            totalBytes: PanelLimits.resourceMaxBytes + 1, text: "abc", sha256: F.v2,
            descriptor: TestFrames.descriptor, nextCursor: "c")
        #expect(a.accept(chunk) == .rejected(.oversized))
    }

    @Test func lastChunkMustEndAtTotalBytes() {
        var a = PreviewAssembler(key: key)
        let short = PreviewChunk(
            commandId: "x", resourceId: F.rid, version: F.v1, seq: 0, offset: 0, totalBytes: 10,
            text: "abc", sha256: F.v2, descriptor: TestFrames.descriptor, nextCursor: nil)
        #expect(a.accept(short) == .rejected(.inconsistent))
    }

    @Test func hashMismatchNeverCompletes() {
        let chunks = TestFrames.chunks(of: "hello world", key: key, size: 100)
        let wrong = PreviewChunk(
            commandId: "x", resourceId: F.rid, version: F.v1, seq: 0, offset: 0, totalBytes: chunks[0].totalBytes,
            text: chunks[0].text, sha256: String(repeating: "0", count: 64), descriptor: TestFrames.descriptor,
            nextCursor: nil)
        var a = PreviewAssembler(key: key)
        #expect(a.accept(wrong) == .rejected(.hashMismatch))
        #expect(!a.isComplete)
        #expect(a.phase == .failed(.hashMismatch))
    }

    @Test func wrongVersionChunkIsIgnored() {
        let other = PreviewKey(resourceId: F.rid, version: F.v2)
        let chunks = TestFrames.chunks(of: "hello", key: other, size: 100)
        var a = PreviewAssembler(key: key)
        #expect(a.accept(chunks[0]) == .ignored)
        #expect(a.phase == .loading && a.bytes.isEmpty)
        #expect(a.accept(TestFrames.chunks(of: "hello", key: key, size: 100)[0]) == .accepted)
        #expect(a.isComplete)
    }

    @Test func refusalFailsALoadingPreviewOnly() {
        var a = PreviewAssembler(key: key)
        a.refused(.notFound)
        #expect(a.phase == .failed(.refused(.notFound)))
        var done = PreviewAssembler(key: key)
        _ = done.accept(TestFrames.chunks(of: "hi", key: key, size: 10)[0])
        done.refused(.unavailable)
        #expect(done.isComplete)
    }
}
