// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ClippyCore",
    platforms: [.iOS(.v18), .macOS(.v14)],
    products: [.library(name: "ClippyCore", targets: ["ClippyCore"])],
    targets: [
        .target(name: "ClippyCore"),
        .testTarget(name: "ClippyCoreTests", dependencies: ["ClippyCore"])
    ]
)
