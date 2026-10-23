import Foundation
import CoreImage

// Usage: swift scripts/verify-qr.swift <directory> <image-and-expected-text-basename>...
guard CommandLine.arguments.count >= 3 else { fatalError("Provide a directory and QR basenames") }
let directory = URL(fileURLWithPath: CommandLine.arguments[1])
for name in CommandLine.arguments.dropFirst(2) {
    guard let image = CIImage(contentsOf: directory.appendingPathComponent(name + ".png")),
          let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: CIContext(options: [.useSoftwareRenderer: true]), options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]) else {
        fatalError("Cannot open QR image")
    }
    let decoded = detector.features(in: image).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
    let expected = try String(contentsOf: directory.appendingPathComponent(name + ".txt"), encoding: .utf8)
    guard decoded == [expected] else { fatalError("QR decode mismatch: " + name) }
    print("PASS " + name + " independently decoded; scheme=" + (URL(string: expected)?.scheme ?? "unknown"))
}
