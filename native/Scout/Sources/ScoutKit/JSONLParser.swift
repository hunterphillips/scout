import Foundation

/// Splits the sidecar's stdout into lines and decodes each as a `PanelState`.
/// Chunks may end mid-line; the remainder is kept for the next `append`.
/// Unknown or malformed lines are dropped and counted, never thrown.
public struct JSONLParser: Sendable {
    /// A line longer than this with no newline yet is discarded and counted.
    public static let maxLineBytes = 1 << 20

    public private(set) var ignoredLineCount = 0
    private var buffer = Data()

    public init() {}

    public mutating func append(_ chunk: Data) -> [PanelState] {
        buffer.append(chunk)
        var states: [PanelState] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            var line = Data(buffer[buffer.startIndex..<newline])
            buffer = Data(buffer[buffer.index(after: newline)...])
            if line.last == 0x0D { line.removeLast() }
            if line.allSatisfy({ $0 == 0x20 || $0 == 0x09 }) { continue }
            if let state = PanelState.decode(line: line) {
                states.append(state)
            } else {
                ignoredLineCount += 1
            }
        }
        if buffer.count > Self.maxLineBytes {
            buffer.removeAll()
            ignoredLineCount += 1
        }
        return states
    }
}
