import Foundation
import CoreImage
import AppKit
let directory = CommandLine.arguments[1]
let names = CommandLine.arguments.count > 2 ? Array(CommandLine.arguments.dropFirst(2)) : ["old", "new"]
for name in names {
    let file = URL(fileURLWithPath: directory).appendingPathComponent(name + ".png")
    guard let image = CIImage(contentsOf: file), let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: CIContext(options: [.useSoftwareRenderer: true]), options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]) else { fatalError("Cannot open QR") }
    let decoded = detector.features(in: image).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
    let expected = try String(contentsOf: URL(fileURLWithPath: directory).appendingPathComponent(name + ".txt"), encoding: .utf8)
    guard decoded == [expected] else { fatalError("QR decode mismatch: " + name) }
    print("PASS " + name + " QR independently decoded; scheme=" + (URL(string: expected)?.scheme ?? "unknown"))
}
