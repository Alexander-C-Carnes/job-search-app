// Draws the app icon (a résumé page on the app's red) as a 1024px PNG: swift make_icon.swift out.png
import AppKit

let size: CGFloat = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                           bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

let red = NSColor(srgbRed: 0xE5 / 255, green: 0x08 / 255, blue: 0x15 / 255, alpha: 1)
let dark = NSColor(srgbRed: 0xA8 / 255, green: 0x05 / 255, blue: 0x0F / 255, alpha: 1)
let tile = NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824), xRadius: 185, yRadius: 185)
NSGradient(starting: red, ending: dark)!.draw(in: tile, angle: -90)

// The page.
let page = NSRect(x: 300, y: 215, width: 424, height: 560)
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.25)
shadow.shadowOffset = NSSize(width: 0, height: -14)
shadow.shadowBlurRadius = 30
NSGraphicsContext.saveGraphicsState()
shadow.set()
NSColor.white.setFill()
NSBezierPath(roundedRect: page, xRadius: 28, yRadius: 28).fill()
NSGraphicsContext.restoreGraphicsState()

// A name line, then text lines.
red.setFill()
NSBezierPath(roundedRect: NSRect(x: 350, y: 680, width: 220, height: 34), xRadius: 17, yRadius: 17).fill()
NSColor(white: 0.78, alpha: 1).setFill()
for (i, w) in [324.0, 290, 324, 250, 324, 210].enumerated() {
    NSBezierPath(roundedRect: NSRect(x: 350, y: 610 - Double(i) * 58, width: w, height: 22), xRadius: 11, yRadius: 11).fill()
}

// A check mark: tailored and checked.
let badge = NSRect(x: 585, y: 165, width: 220, height: 220)
NSColor.white.setFill()
NSBezierPath(ovalIn: badge).fill()
let check = NSBezierPath()
check.move(to: NSPoint(x: 640, y: 278))
check.line(to: NSPoint(x: 683, y: 232))
check.line(to: NSPoint(x: 755, y: 318))
check.lineWidth = 30
check.lineCapStyle = .round
check.lineJoinStyle = .round
red.setStroke()
check.stroke()

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
