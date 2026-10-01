import CryptoKit
import Foundation

/// Which version a preview shows.
public struct PreviewKey: Sendable, Equatable, Hashable {
    public let resourceId: String
    public let version: String

    public init(resourceId: String, version: String) {
        self.resourceId = resourceId
        self.version = version
    }
}

/// Builds one version's text from its `preview` chunks. Chunks must arrive in `seq` order,
/// each starting where the last ended, with the same `totalBytes`, blob hash, and descriptor;
/// the last one (no `nextCursor`) must end exactly at `totalBytes`, and the SHA-256 of all
/// the bytes must equal the chunks' `sha256`. Only then is the preview `complete`, and only a
/// complete preview may be approved. Any violation fails the preview for good; the user
/// restarts it from the first chunk. Chunks for another resource or version are ignored.
public struct PreviewAssembler: Sendable, Equatable {
    public enum Failure: Sendable, Equatable {
        case outOfOrder
        case overlap
        case oversized
        /// `totalBytes`, `sha256`, or the descriptor changed between chunks, or a chunk made no progress.
        case inconsistent
        case hashMismatch
        /// The core refused the `preview` command.
        case refused(AckFailureCode)
    }

    public enum Phase: Sendable, Equatable {
        case loading
        case complete
        case failed(Failure)
    }

    public enum Outcome: Sendable, Equatable {
        case accepted
        /// Another version's chunk, a replay of one already taken, or one after the end.
        case ignored
        case rejected(Failure)
    }

    public let key: PreviewKey
    public private(set) var phase: Phase = .loading
    public private(set) var bytes = Data()
    public private(set) var totalBytes: Int?
    public private(set) var sha256: String?
    public private(set) var descriptor: PreviewDescriptor?
    private var nextSeq = 0
    private var nextCursor: String?

    public init(key: PreviewKey) {
        self.key = key
    }

    public var isComplete: Bool { phase == .complete }

    /// The text received so far. Chunks never split a code point, so a partial preview decodes cleanly.
    public var text: String { String(decoding: bytes, as: UTF8.self) }

    /// The request for the first chunk, or the next one while loading.
    public func requestNext() -> PanelRequest? {
        guard phase == .loading else { return nil }
        if nextSeq == 0 {
            return .preview(resourceId: key.resourceId, version: key.version, cursor: nil)
        }
        guard let nextCursor else { return nil }
        return .preview(resourceId: key.resourceId, version: key.version, cursor: nextCursor)
    }

    public mutating func accept(_ chunk: PreviewChunk) -> Outcome {
        guard chunk.resourceId == key.resourceId, chunk.version == key.version else { return .ignored }
        guard phase == .loading else { return .ignored }
        if chunk.seq < nextSeq { return .ignored }
        guard chunk.seq == nextSeq else { return fail(.outOfOrder) }
        guard chunk.offset == bytes.count else {
            return fail(chunk.offset < bytes.count ? .overlap : .outOfOrder)
        }
        if let totalBytes, let sha256, let descriptor {
            guard chunk.totalBytes == totalBytes, chunk.sha256 == sha256, chunk.descriptor == descriptor else {
                return fail(.inconsistent)
            }
        }
        guard chunk.totalBytes <= PanelLimits.resourceMaxBytes else { return fail(.oversized) }
        let piece = Data(chunk.text.utf8)
        guard piece.count <= PanelLimits.previewChunkMaxBytes,
              chunk.offset + piece.count <= chunk.totalBytes else { return fail(.oversized) }
        let end = chunk.offset + piece.count
        if chunk.nextCursor != nil {
            // A middle chunk must make progress and leave something for the next one.
            guard !piece.isEmpty, end < chunk.totalBytes else { return fail(.inconsistent) }
        } else {
            guard end == chunk.totalBytes else { return fail(.inconsistent) }
        }

        totalBytes = chunk.totalBytes
        sha256 = chunk.sha256
        descriptor = chunk.descriptor
        bytes.append(piece)
        nextSeq += 1
        nextCursor = chunk.nextCursor
        if chunk.nextCursor == nil {
            let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            guard digest == chunk.sha256 else { return fail(.hashMismatch) }
            phase = .complete
        }
        return .accepted
    }

    /// The core answered a `preview` command for this version with a failure ack.
    public mutating func refused(_ code: AckFailureCode) {
        guard phase == .loading else { return }
        phase = .failed(.refused(code))
    }

    private mutating func fail(_ failure: Failure) -> Outcome {
        phase = .failed(failure)
        return .rejected(failure)
    }
}
