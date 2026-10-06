import Foundation

/// `~/.scout/config.json`, written by `scripts/setup.mjs`. Extra keys are ignored.
public struct ScoutConfig: Sendable, Equatable, Decodable {
    public let nodePath: String
    public let scoutRoot: String
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
