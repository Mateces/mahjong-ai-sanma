#!/usr/bin/env swift
import Cocoa

let tileWidth: CGFloat = 80
let tileHeight: CGFloat = 120

// Tiles with their display strings. Honors use CJK text chars so they
// render as flat glyphs (not Apple emoji).
let glyphs: [(String, String)] = [
  ("1m", "\u{1F007}"), ("2m", "\u{1F008}"), ("3m", "\u{1F009}"), ("4m", "\u{1F00A}"), ("5m", "\u{1F00B}"),
  ("6m", "\u{1F00C}"), ("7m", "\u{1F00D}"), ("8m", "\u{1F00E}"), ("9m", "\u{1F00F}"),
  ("1p", "\u{1F019}"), ("2p", "\u{1F01A}"), ("3p", "\u{1F01B}"), ("4p", "\u{1F01C}"), ("5p", "\u{1F01D}"),
  ("6p", "\u{1F01E}"), ("7p", "\u{1F01F}"), ("8p", "\u{1F020}"), ("9p", "\u{1F021}"),
  ("1s", "\u{1F010}"), ("2s", "\u{1F011}"), ("3s", "\u{1F012}"), ("4s", "\u{1F013}"), ("5s", "\u{1F014}"),
  ("6s", "\u{1F015}"), ("7s", "\u{1F016}"), ("8s", "\u{1F017}"), ("9s", "\u{1F018}"),
  ("E", "\u{1F000}"), ("S", "\u{1F001}"), ("W", "\u{1F002}"), ("N", "\u{1F003}"),
  ("P", "\u{1F006}"), ("F", "\u{1F005}"), ("C", "\u{1F004}\u{FE0E}"),
  ("back", "\u{1F02B}"),
  ("0m", "\u{1F00B}"), ("0p", "\u{1F01D}"), ("0s", "\u{1F014}"),
]

let outDir = "assets/tiles"
let whiteDir = "assets/tiles/white"
let fm = FileManager.default
try? fm.createDirectory(atPath: outDir, withIntermediateDirectories: true)
try? fm.createDirectory(atPath: whiteDir, withIntermediateDirectories: true)

func renderTile(name: String, emoji: String, color: NSColor) -> NSImage {
  let img = NSImage(size: NSSize(width: tileWidth, height: tileHeight))
  img.lockFocus()
  guard let ctx = NSGraphicsContext.current?.cgContext else { return img }
  ctx.clear(CGRect(x: 0, y: 0, width: tileWidth, height: tileHeight))

  let fontSize: CGFloat = min(tileWidth, tileHeight) * 0.85
  let font = NSFont.systemFont(ofSize: fontSize)

  let attrs: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: color,
  ]
  let str = NSAttributedString(string: emoji, attributes: attrs)
  let line = CTLineCreateWithAttributedString(str)
  let bounds = CTLineGetBoundsWithOptions(line, [])
  let x = (tileWidth - bounds.width) / 2 - bounds.minX
  let y = (tileHeight - bounds.height) / 2 - bounds.minY
  ctx.textPosition = CGPoint(x: x, y: y)
  CTLineDraw(line, ctx)
  img.unlockFocus()
  return img
}

func trimImage(_ img: NSImage) -> NSImage {
  guard let tiff = img.tiffRepresentation,
        let rep = NSBitmapImageRep(data: tiff),
        let cgImg = rep.cgImage
  else { return img }

  let data = rep.bitmapData!
  let w = Int(rep.pixelsWide)
  let h = Int(rep.pixelsHigh)
  let bpp = Int(rep.bitsPerPixel) / 8
  let rowBytes = Int(rep.bytesPerRow)

  var minX = w, maxX = 0, minY = h, maxY = 0
  for y in 0..<h {
    for x in 0..<w {
      let offset = y * rowBytes + x * bpp
      let a = data[offset + bpp - 1] // alpha channel
      if a > 10 { // threshold to ignore anti-aliasing fringe
        if x < minX { minX = x }
        if x > maxX { maxX = x }
        if y < minY { minY = y }
        if y > maxY { maxY = y }
      }
    }
  }

  if maxX < minX || maxY < minY { return img }
  let padding: CGFloat = 0
  let cropRect = CGRect(
    x: CGFloat(minX) - padding,
    y: CGFloat(minY) - padding,
    width: CGFloat(maxX - minX + 1) + padding * 2,
    height: CGFloat(maxY - minY + 1) + padding * 2
  )
  let nsRect = NSRect(
    x: cropRect.origin.x,
    y: cropRect.origin.y,
    width: cropRect.width,
    height: cropRect.height
  )
  let trimmed = NSImage(size: nsRect.size)
  trimmed.lockFocus()
  guard let ctx = NSGraphicsContext.current?.cgContext else { return img }
  ctx.clear(CGRect(origin: .zero, size: nsRect.size))
  ctx.draw(cgImg.cropping(to: cropRect)!, in: CGRect(origin: .zero, size: nsRect.size))
  trimmed.unlockFocus()
  return trimmed
}

func savePNG(_ img: NSImage, path: String) {
  guard let tiff = img.tiffRepresentation,
        let rep = NSBitmapImageRep(data: tiff),
        let png = rep.representation(using: .png, properties: [:])
  else { return }
  try? png.write(to: URL(fileURLWithPath: path))
}

for (name, emoji) in glyphs {
  // Black version
  let blackImg = trimImage(renderTile(name: name, emoji: emoji, color: .black))
  savePNG(blackImg, path: "\(outDir)/\(name).png")
  print("wrote \(outDir)/\(name).png")

  // White version
  let whiteImg = trimImage(renderTile(name: name, emoji: emoji, color: .white))
  savePNG(whiteImg, path: "\(whiteDir)/\(name).png")
}

print("done")
