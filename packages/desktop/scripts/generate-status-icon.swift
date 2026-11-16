// Generate macOS template icons from the red Zhivex brand mark.
// Run: swift -module-cache-path /tmp/zhivex-swift-cache packages/desktop/scripts/generate-status-icon.swift packages/desktop/assets
import AppKit
import Foundation

let directory = URL(fileURLWithPath: CommandLine.arguments[1])
let source = NSImage(contentsOf: directory.appendingPathComponent("zhivex-logo.png"))!
var bounds = CGRect(origin: .zero, size: source.size)
let input = source.cgImage(forProposedRect: &bounds, context: nil, hints: nil)!
let width = input.width, height = input.height
let space = CGColorSpaceCreateDeviceRGB()
let format = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
let mask = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space, bitmapInfo: format)!
mask.draw(input, in: CGRect(x: 0, y: 0, width: width, height: height))
let pixels = mask.data!.bindMemory(to: UInt8.self, capacity: width * height * 4)
var left = width, top = height, right = 0, bottom = 0
for y in 0..<height {
    for x in 0..<width {
        let i = (y * width + x) * 4
        // Red coverage removes the black background while preserving antialiasing.
        let alpha = UInt8(max(0, Int(pixels[i]) - Int(max(pixels[i + 1], pixels[i + 2]))))
        pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = alpha
        if alpha > 0 { left = min(left, x); top = min(top, y); right = max(right, x); bottom = max(bottom, y) }
    }
}
precondition(right > left && bottom > top, "Brand mark has no red coverage")
let mark = mask.makeImage()!.cropping(to: CGRect(x: left, y: top, width: right - left + 1, height: bottom - top + 1))!
for scale in [1, 2] {
    let size = 18 * scale
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: space, bitmapInfo: format)!
    context.interpolationQuality = .high
    let available = CGFloat(16 * scale)
    let ratio = min(available / CGFloat(mark.width), available / CGFloat(mark.height))
    let w = CGFloat(mark.width) * ratio, h = CGFloat(mark.height) * ratio
    context.draw(mark, in: CGRect(x: (CGFloat(size) - w) / 2, y: (CGFloat(size) - h) / 2, width: w, height: h))
    let bitmap = NSBitmapImageRep(cgImage: context.makeImage()!)
    let output = directory.appendingPathComponent(scale == 1 ? "statusTemplate.png" : "statusTemplate@2x.png")
    try bitmap.representation(using: .png, properties: [:])!.write(to: output)
    print(output.path)
}
