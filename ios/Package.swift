// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CentreCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "CentreCore", targets: ["CentreCore"]), .executable(name: "CentreCoreVerify", targets: ["CentreCoreVerify"])],
    targets: [.target(name: "CentreCore"), .executableTarget(name: "CentreCoreVerify", dependencies: ["CentreCore"], path: "Verification"), .testTarget(name: "CentreCoreTests", dependencies: ["CentreCore"],exclude:["Fixtures"])],
    swiftLanguageModes: [.v5]
)
