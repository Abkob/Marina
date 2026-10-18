import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import Foundation
let root = URL(fileURLWithPath: CommandLine.arguments[1])
let source = root.appendingPathComponent("../../public/icons/icon-512.png")
let output = root.appendingPathComponent("App/Assets.xcassets/AppIcon.appiconset")
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
guard let imageSource = CGImageSourceCreateWithURL(source as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(imageSource, 0, nil),
      let canvas = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { fatalError("Existing Marina app icon is missing or invalid") }
canvas.setFillColor(CGColor(gray: 1, alpha: 1))
canvas.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
canvas.interpolationQuality = .high
canvas.draw(image, in: CGRect(x: 0, y: 0, width: 1024, height: 1024))
guard let rendered = canvas.makeImage(), let destination = CGImageDestinationCreateWithURL(output.appendingPathComponent("Icon.png") as CFURL, UTType.png.identifier as CFString, 1, nil) else { fatalError("Cannot create app icon") }
CGImageDestinationAddImage(destination, rendered, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Cannot write app icon") }
try Data("{\"images\":[{\"filename\":\"Icon.png\",\"idiom\":\"universal\",\"platform\":\"ios\",\"size\":\"1024x1024\"}],\"info\":{\"author\":\"xcode\",\"version\":1}}".utf8).write(to: output.appendingPathComponent("Contents.json"))
