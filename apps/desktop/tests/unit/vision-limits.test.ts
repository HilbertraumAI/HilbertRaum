import { describe, it, expect } from 'vitest'
import {
  decodedPixelCount,
  validateAnalyzeRequest,
  VISION_MAX_IMAGE_PIXELS
} from '../../src/main/services/vision/limits'

// D4 (vuln-scan-2026-06-21): the authoritative main-side guard must defuse a decompression bomb
// (small file, enormous decoded bitmap) by parsing the image HEADER for width*height — the byte
// cap alone passes a <20 MiB PNG/JPEG that decodes to billions of pixels and OOMs the sidecar.

/** A 24-byte PNG header (signature + IHDR width@16/height@20, big-endian) — no pixel data. */
function pngHeader(w: number, h: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const dv = new DataView(b.buffer)
  dv.setUint32(16, w)
  dv.setUint32(20, h)
  return b
}

/** A minimal JPEG: SOI + a baseline SOF0 segment carrying height then width (big-endian u16). */
function jpegHeader(w: number, h: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x11, // segment length
    0x08, // sample precision
    (h >> 8) & 0xff, h & 0xff, // height
    (w >> 8) & 0xff, w & 0xff, // width
    0x03, 0, 0, 0, 0, 0, 0, 0, 0 // components (unparsed tail)
  ])
}

describe('decodedPixelCount (D4 header parse)', () => {
  it('reads PNG dimensions from the IHDR', () => {
    expect(decodedPixelCount(pngHeader(640, 480), 'image/png')).toBe(640 * 480)
  })

  it('reads JPEG dimensions from the SOF0 marker', () => {
    expect(decodedPixelCount(jpegHeader(1024, 768), 'image/jpeg')).toBe(1024 * 768)
  })

  it('returns null for an unparseable / non-image payload', () => {
    expect(decodedPixelCount(new Uint8Array([1, 2, 3, 4]), 'image/png')).toBeNull()
    expect(decodedPixelCount(new Uint8Array([0xff, 0xd8, 0x00]), 'image/jpeg')).toBeNull()
  })
})

describe('validateAnalyzeRequest pixel budget (D4)', () => {
  const Q = 'what is in this image?'

  it('accepts a normal small image', () => {
    expect(validateAnalyzeRequest(pngHeader(100, 100), 'image/png', Q)).toBeNull()
    expect(validateAnalyzeRequest(jpegHeader(800, 600), 'image/jpeg', Q)).toBeNull()
  })

  it('rejects a PNG decompression bomb (tiny file, billions of pixels) as tooLarge', () => {
    // 60000×60000 = 3.6e9 px ≫ the 50 MP budget, yet only 24 bytes — far under the byte cap.
    const bomb = pngHeader(60000, 60000)
    expect(bomb.byteLength).toBeLessThan(1000) // a *tiny* file the byte cap would wave through…
    expect(60000 * 60000).toBeGreaterThan(VISION_MAX_IMAGE_PIXELS) // …but a huge decoded bitmap.
    expect(validateAnalyzeRequest(bomb, 'image/png', Q)).toBe('tooLarge')
  })

  it('rejects a JPEG decompression bomb as tooLarge', () => {
    expect(validateAnalyzeRequest(jpegHeader(60000, 60000), 'image/jpeg', Q)).toBe('tooLarge')
  })

  it('still rejects on the byte cap and on empty/blank before the pixel check', () => {
    // Byte cap (tiny maxBytes) fires before dimensions are even consulted.
    expect(validateAnalyzeRequest(pngHeader(10, 10), 'image/png', Q, 4)).toBe('tooLarge')
    expect(validateAnalyzeRequest(new Uint8Array(0), 'image/png', Q)).toBe('decodeFailed')
    expect(validateAnalyzeRequest(pngHeader(10, 10), 'image/png', '   ')).toBe('emptyResponse')
  })

  it('honours an explicit maxPixels argument', () => {
    expect(validateAnalyzeRequest(pngHeader(100, 100), 'image/png', Q, undefined, 9999)).toBe(
      'tooLarge'
    )
    expect(validateAnalyzeRequest(pngHeader(100, 100), 'image/png', Q, undefined, 20000)).toBeNull()
  })
})
