// Generates the SYNTHETIC, content-free vision smoke fixtures (image-understanding plan §15).
//
// The fixtures are procedurally drawn here — no copyrighted source, no PII, no real document —
// so they are license-clean by construction (we author them). Re-run with `node make-fixtures.mjs`
// from this directory to regenerate. They stay tiny (a few KB) and are the only image bytes the
// repo carries; the multi-GB vision weights live OFF-repo on the smoke drive (§0: never commit
// weights/user data). The manual `HILBERTRAUM_VISION_SMOKE` harness analyzes `chart.png`.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Minimal truecolour-RGB PNG encoder (filter 0 per scanline, one zlib IDAT). */
function encodePng(width, height, rgb /* Uint8Array length w*h*3 */) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const typeBuf = Buffer.from(type, 'ascii')
    const body = Buffer.concat([typeBuf, data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0, 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type 2 = truecolour RGB
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  // Prefix each scanline with a 0 filter byte.
  const stride = width * 3
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgb.subarray(y * stride, y * stride + stride).copy?.(raw, y * (stride + 1) + 1)
    if (!rgb.subarray(0, 0).copy) {
      // rgb is a plain Uint8Array — copy manually.
      for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = rgb[y * stride + x]
    }
  }
  const idat = deflateSync(raw)
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// CRC32 (PNG polynomial).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A simple synthetic bar chart: white ground, dark axes, five labelled-height coloured bars. */
function makeChart() {
  const W = 320
  const H = 240
  const rgb = new Uint8Array(W * H * 3).fill(255) // white
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const i = (y * W + x) * 3
    rgb[i] = r
    rgb[i + 1] = g
    rgb[i + 2] = b
  }
  const rect = (x0, y0, x1, y1, r, g, b) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, r, g, b)
  }
  // Axes.
  rect(40, 20, 42, 210, 30, 30, 30) // y-axis
  rect(40, 208, 300, 210, 30, 30, 30) // x-axis
  // Five bars of increasing-then-dipping height (a recognisable "trend").
  const bars = [
    { h: 60, c: [0x2b, 0x6c, 0xb0] },
    { h: 110, c: [0x3c, 0x9a, 0x4e] },
    { h: 150, c: [0xd9, 0xa0, 0x27] },
    { h: 95, c: [0xc0, 0x47, 0x3a] },
    { h: 130, c: [0x7a, 0x4f, 0xa0] }
  ]
  bars.forEach((b, i) => {
    const x0 = 60 + i * 48
    rect(x0, 208 - b.h, x0 + 32, 208, b.c[0], b.c[1], b.c[2])
  })
  return { png: encodePng(W, H, rgb), W, H }
}

const { png, W, H } = makeChart()
const out = join(HERE, 'chart.png')
writeFileSync(out, png)
console.log(`wrote ${out} — ${png.length} bytes (${W}x${H} synthetic bar chart)`)
