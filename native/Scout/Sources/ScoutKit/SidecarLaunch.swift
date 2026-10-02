import Foundation

/// `~/.scout/config.json`, written by `scripts/setup.mjs`. Extra keys are ignored.
public struct ScoutConfig: Sendable, Equatable, Decodable {
    public static let defaultChromeBundleId = "com.google.Chrome"

    public let nodePath: String
    public let scoutRoot: String
    /// The browser recommended links open in (the same key the core reads); nil when absent or
    /// not a string.
    public let chromeBundleId: String?

    private enum CodingKeys: String, CodingKey {
        case nodePath, scoutRoot, chromeBundleId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        nodePath = try container.decode(String.self, forKey: .nodePath)
        scoutRoot = try container.decode(String.self, forKey: .scoutRoot)
        // A bad value here is the core's to refuse; it must not hide the sidecar settings.
        chromeBundleId = try? container.decodeIfPresent(String.self, forKey: .chromeBundleId)
    }

    /// The bundle id links open in: the config's `chromeBundleId` when it matches the core's
    /// pattern (`[A-Za-z0-9.-]+`, config.ts), else Chrome's. An unreadable config means Chrome too.
    public static func chromeBundleId(configURL: URL = SidecarLaunch.defaultConfigURL) -> String {
        guard let data = try? Data(contentsOf: configURL),
              let config = try? JSONDecoder().decode(ScoutConfig.self, from: data),
              let id = config.chromeBundleId, isBundleId(id) else { return defaultChromeBundleId }
        return id
    }

    static func isBundleId(_ id: String) -> Bool {
        !id.isEmpty && id.utf8.allSatisfy { byte in
            byte == UInt8(ascii: ".") || byte == UInt8(ascii: "-") || (0x30...0x39).contains(byte)
                || (0x41...0x5A).contains(byte) || (0x61...0x7A).contains(byte)
        }
    }
}

public struct LaunchSpec: Sendable, Equatable {
    public let executable: URL
    public let arguments: [String]
    /// The child's working directory. Nil inherits the app's (`/` when Finder-launched).
    public let currentDirectoryURL: URL?

    public init(executable: URL, arguments: [String], currentDirectoryURL: URL? = nil) {
        self.executable = executable
        self.arguments = arguments
        self.currentDirectoryURL = currentDirectoryURL
    }
}

/// Resolves how to start the sidecar. A Finder-launched app has a minimal PATH, so only
/// the absolute paths from the config are used; there is no fallback to PATH.
public enum SidecarLaunch: Sendable, Equatable {
    case ready(LaunchSpec)
    case setupNeeded(String)

    public static var defaultConfigURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".scout/config.json")
    }

    public static func resolve(configURL: URL = defaultConfigURL) -> SidecarLaunch {
        // Nothing retries, so every message tells the user to reopen the app.
        let rerun = ", then reopen Scout."
        guard let data = try? Data(contentsOf: configURL) else {
            return .setupNeeded("No config at \(configURL.path). Run scripts/setup.mjs\(rerun)")
        }
        guard let config = try? JSONDecoder().decode(ScoutConfig.self, from: data) else {
            return .setupNeeded("Config at \(configURL.path) is missing nodePath or scoutRoot. Run scripts/setup.mjs\(rerun)")
        }
        let files = FileManager.default
        guard config.nodePath.hasPrefix("/") else {
            return .setupNeeded("nodePath must be absolute: \(config.nodePath). Fix \(configURL.path)\(rerun)")
        }
        var isDirectory: ObjCBool = false
        guard files.fileExists(atPath: config.nodePath, isDirectory: &isDirectory),
              !isDirectory.boolValue,
              files.isExecutableFile(atPath: config.nodePath)
        else {
            return .setupNeeded("nodePath is missing or not executable: \(config.nodePath). Fix \(configURL.path)\(rerun)")
        }
        guard config.scoutRoot.hasPrefix("/") else {
            return .setupNeeded("scoutRoot must be absolute: \(config.scoutRoot). Fix \(configURL.path)\(rerun)")
        }
        let root = URL(fileURLWithPath: config.scoutRoot, isDirectory: true)
        let mainJS = root
            .appendingPathComponent("packages/scout-core/dist/main.js").path
        guard files.fileExists(atPath: mainJS, isDirectory: &isDirectory), !isDirectory.boolValue else {
            return .setupNeeded("scout-core is not built: \(mainJS) is missing. Run npm run build in \(config.scoutRoot)\(rerun)")
        }
        return .ready(LaunchSpec(
            executable: URL(fileURLWithPath: config.nodePath),
            arguments: [mainJS, "--stdio"],
            currentDirectoryURL: root
        ))
    }
}
