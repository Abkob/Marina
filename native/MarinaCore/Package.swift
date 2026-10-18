// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "MarinaCore", platforms: [.iOS(.v17), .macOS(.v13)], products: [.library(name: "MarinaCore", targets: ["MarinaCore"])], targets: [.target(name: "MarinaCore"), .testTarget(name: "MarinaCoreTests", dependencies: ["MarinaCore"])])
