// Generate the app icons from the brand mark (◈) — a blue diamond outline with a small
// filled diamond on a TRANSPARENT background (matches build/icon.svg and the in-app gate
// mark). Produces build/icon.png (512×512, used by electron-builder for mac/Linux and as
// the dev BrowserWindow icon) and build/icon.ico (multi-size, used for the Windows .exe).
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

const ACCENT = '#2f6fed'

/** Render the brand mark at `size`×`size` and return the PNG bytes. Transparent canvas;
 *  geometry is the build/icon.svg path data scaled from its 64-unit viewBox. */
function renderPng(size) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const k = size / 64
  const diamond = (cx, cy, r) => {
    ctx.beginPath()
    ctx.moveTo(cx, cy - r)
    ctx.lineTo(cx + r, cy)
    ctx.lineTo(cx, cy + r)
    ctx.lineTo(cx - r, cy)
    ctx.closePath()
  }

  const cx = 32 * k
  const cy = 32 * k
  // Outer diamond outline.
  ctx.lineJoin = 'round'
  ctx.lineWidth = 5 * k
  ctx.strokeStyle = ACCENT
  diamond(cx, cy, 26 * k)
  ctx.stroke()
  // Inner filled diamond.
  ctx.fillStyle = ACCENT
  diamond(cx, cy, 11 * k)
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
