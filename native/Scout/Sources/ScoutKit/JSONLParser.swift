import Foundation

/// Splits the sidecar's stdout into lines and decodes each as a `PanelState`.
/// Chunks may end mid-line; the remainder is kept for the next `append`.
/// Unknown or malformed lines are dropped and counted, never thrown.
/// Each byte is scanned for a newline once and the consumed prefix is dropped once per
/// `append`, so a large line arriving in many chunks costs linear time.
public struct JSONLParser: Sendable {
    /// A line longer than this (newline excluded) is discarded and counted, whether it arrives
    /// whole or in pieces.
    public static let maxLineBytes = 1 << 20

    public private(set) var ignoredLineCount = 0
    private var buffer = Data()
    /// Bytes of `buffer` already scanned without finding a newline.
    private var scanned = 0
    /// Discarding an oversized line until its newline arrives.
    private var skipping = false

    public init() {}

    public mutating func append(_ chunk: Data) -> [PanelState] {
        buffer.append(chunk)
        var states: [PanelState] = []
        var lineStart = buffer.startIndex
        var searchFrom = buffer.startIndex + scanned
        while let newline = buffer[searchFrom...].firstIndex(of: 0x0A) {
            if skipping {
                skipping = false
            } else if buffer.distance(from: lineStart, to: newline) > Self.maxLineBytes {
                ignoredLineCount += 1
            } else if let state = Self.decode(buffer[lineStart..<newline]) {
                states.append(state)
            } else if !Self.isBlank(buffer[lineStart..<newline]) {
                ignoredLineCount += 1
            }
            lineStart = buffer.index(after: newline)
            searchFrom = lineStart
        }
        if lineStart != buffer.startIndex {
            buffer = Data(buffer[lineStart...])
        }
        scanned = buffer.count
        if buffer.count > Self.maxLineBytes {
            buffer.removeAll()
            scanned = 0
            if !skipping { ignoredLineCount += 1 }
            skipping = true
        }
        return states
    }

    /// Call at end of stream. An unfinished last line counts as one ignored line.
    public mutating func finish() {
        let leftover = buffer.allSatisfy { $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }
        buffer.removeAll()
        scanned = 0
        if !leftover && !skipping { ignoredLineCount += 1 }
        skipping = false
    }

    private static func decode(_ slice: Data.SubSequence) -> PanelState? {
        var line = Data(slice)
        if line.last == 0x0D { line.removeLast() }
        if isBlank(line[...]) { return nil }
        return PanelState.decode(line: line)
    }

    private static func isBlank(_ slice: Data.SubSequence) -> Bool {
        slice.allSatisfy { $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }
    }
}
