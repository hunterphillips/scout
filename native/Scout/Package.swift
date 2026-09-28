// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Scout",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "ScoutApp", targets: ["ScoutApp"]),
        .library(name: "ScoutKit", targets: ["ScoutKit"]),
    ],
    targets: [
        .executableTarget(name: "ScoutApp", dependencies: ["ScoutKit"]),
        .target(name: "ScoutKit"),
        .testTarget(name: "ScoutKitTests", dependencies: ["ScoutKit"]),
    ]
)
