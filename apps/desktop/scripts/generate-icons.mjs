// Generate the app icons from the brand mark — the sealed rounded square (the private
// room) holding a single teal dot at its exact centre (your data), in its app-icon
// treatment: light-ink square (#E8EDF2) + teal dot (#57D0A4) on an OPAQUE brand surface
// (#0E1319). Unlike the transparent in-app mark/favicon, the OS icon carries its own
// background. Geometry mirrors build/icon.svg (512-unit viewBox). Produces build/icon.png
// (512×512, used by electron-builder for mac/Linux and as the dev BrowserWindow icon) and
// build/icon.ico (multi-size, used for the Windows .exe).
//
// Fully offline: renders with @napi-rs/canvas (already present as a pdfjs transitive dep)
// and hand-assembles a PNG-embedded ICO container — no network, no extra tooling.
//
// Re-run after editing the logo:  node apps/desktop/scripts/generate-icons.mjs
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'

const buildDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')

// Brand colours (docs/design-guidelines brand-refresh record / build/icon.svg).
const SURFACE = '#0e1319' // opaque brand surface (OS icon background)
const INK = '#e8edf2' // light square — reads on the dark surface
const DOT = '#57d0a4' // the teal dot, always

/** Trace a rounded rectangle path (x,y,w,h with corner radius r). */
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Render the brand mark at `size`×`size` and return the PNG bytes. Geometry is the
 *  build/icon.svg path data scaled from its 512-unit viewBox. */
function renderPng(size) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const k = size / 512

  // Opaque brand surface.
  ctx.fillStyle = SURFACE
  ctx.fillRect(0, 0, size, size)

  // Sealed rounded square (light ink, stroke only).
  ctx.lineJoin = 'round'
  ctx.lineWidth = 26 * k
  ctx.strokeStyle = INK
  roundRectPath(ctx, 146 * k, 146 * k, 220 * k, 220 * k, 66 * k)
  ctx.stroke()

  // The teal dot at the exact centre.
  ctx.fillStyle = DOT
  ctx.beginPath()
  ctx.arc(256 * k, 256 * k, 29 * k, 0, Math.PI * 2)
  ctx.fill()

  return canvas.toBuffer('image/png')
}

/** Assemble a PNG-embedded ICO from per-size PNG buffers (Vista+/Electron support it). */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length
  entries.forEach((e, i) => {
    const o = i * 16
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 0) // width (0 ⇒ 256)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1) // height
    dir.writeUInt8(0, o + 2) // palette
    dir.writeUInt8(0, o + 3) // reserved
    dir.writeUInt16LE(1, o + 4) // color planes
    dir.writeUInt16LE(32, o + 6) // bits per pixel
    dir.writeUInt32LE(e.png.length, o + 8) // bytes of image data
    dir.writeUInt32LE(offset, o + 12) // offset to image data
    offset += e.png.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

const png512 = renderPng(512)
writeFileSync(join(buildDir, 'icon.png'), png512)

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const ico = buildIco(icoSizes.map((size) => ({ size, png: renderPng(size) })))
writeFileSync(join(buildDir, 'icon.ico'), ico)

console.log(`Wrote build/icon.png (512) and build/icon.ico (${icoSizes.join(', ')})`)
