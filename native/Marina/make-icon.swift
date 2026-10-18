import AppKit
import Foundation
let root = URL(fileURLWithPath: CommandLine.arguments[1])
let source = root.appendingPathComponent("../../public/icons/icon-512.png")
let output = root.appendingPathComponent("App/Assets.xcassets/AppIcon.appiconset")
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
guard let image = NSImage(contentsOf: source) else { fatalError("Existing Marina app icon is missing") }
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor.white.setFill(); NSRect(x: 0, y: 0, width: 1024, height: 1024).fill(); image.draw(in: NSRect(x: 0, y: 0, width: 1024, height: 1024)); NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent("Icon.png"))
try Data("{\"images\":[{\"filename\":\"Icon.png\",\"idiom\":\"universal\",\"platform\":\"ios\",\"size\":\"1024x1024\"}],\"info\":{\"author\":\"xcode\",\"version\":1}}".utf8).write(to: output.appendingPathComponent("Contents.json"))
