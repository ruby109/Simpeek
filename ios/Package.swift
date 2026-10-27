// swift-tools-version:5.9
import PackageDescription

// For apps that prefer linking SimPeek over injection: add this package and call
// `SimPeek.start()` early, inside `#if DEBUG && targetEnvironment(simulator)`.
let package = Package(
    name: "SimPeek",
    platforms: [.iOS(.v15)],
    products: [.library(name: "SimPeek", targets: ["SimPeek"])],
    targets: [.target(name: "SimPeek", path: "Sources/SimPeek")]
)
