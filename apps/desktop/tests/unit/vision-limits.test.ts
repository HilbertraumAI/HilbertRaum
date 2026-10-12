import { describe, it, expect } from 'vitest'
import { validateAnalyzeRequest, VISION_MAX_IMAGE_BYTES, VISION_MAX_IMAGE_PIXELS } from '../../src/main/services/vision/limits'
import { decodedPixelCount } from '../../src/shared/image-headers'
import { pngHeader } from '../helpers/image-fixtures'

// D4 (vuln-scan-2026-06-21): the authoritative main-side guard must defuse a decompression bomb
// (small file, enormous decoded bitmap) by parsing the image HEADER for width*height — the byte
// cap alone passes a <20 MiB PNG/JPEG that decodes to billions of pixels and OOMs the sidecar.

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

  it('admits exactly the shipped byte cap, refuses one byte more, and rejects empty bytes and a blank question', () => {
    const atCap = new Uint8Array(VISION_MAX_IMAGE_BYTES)
    atCap.set(pngHeader(10, 10))
    expect(validateAnalyzeRequest(atCap, 'image/png', Q)).toBeNull() // exactly at the ~20 MiB cap: admitted
    const overCap = new Uint8Array(VISION_MAX_IMAGE_BYTES + 1)
    overCap.set(pngHeader(10, 10))
    expect(validateAnalyzeRequest(overCap, 'image/png', Q)).toBe('tooLarge') // one byte more: refused
    expect(validateAnalyzeRequest(new Uint8Array(0), 'image/png', Q)).toBe('decodeFailed')
    // #120 item 1: a blank question is an INPUT problem with its own code — no longer the
    // misleading 'emptyResponse' (whose copy means "the model returned an empty answer").
    expect(validateAnalyzeRequest(pngHeader(10, 10), 'image/png', '   ')).toBe('emptyQuestion')
    expect(validateAnalyzeRequest(pngHeader(10, 10), 'image/png', undefined)).toBe('emptyQuestion')
  })

  it('admits exactly the shipped pixel budget and refuses one pixel more', () => {
    expect(validateAnalyzeRequest(pngHeader(VISION_MAX_IMAGE_PIXELS, 1), 'image/png', Q)).toBeNull()
    expect(validateAnalyzeRequest(pngHeader(VISION_MAX_IMAGE_PIXELS + 1, 1), 'image/png', Q)).toBe('tooLarge')
  })

  it('rejects a CLAIMED png/jpeg whose header will not parse (SEC-6 — no byte-cap-only fall-through)', () => {
    // A non-empty payload (passes the empty/byte-cap checks) that CLAIMS png/jpeg but whose header
    // is unparseable → null pixel count. Previously this fell through to byte-cap-only, disabling
    // the pixel-bomb guard; it must now be rejected as undecodable.
    const garbagePng = new Uint8Array(64).fill(0x41) // "AAAA…", not a PNG signature
    const garbageJpeg = new Uint8Array([0xff, 0xd8, 0x12, 0x34, 0x56, 0x78]) // SOI then junk, no SOF
    expect(decodedPixelCount(garbagePng, 'image/png')).toBeNull() // precondition
    expect(decodedPixelCount(garbageJpeg, 'image/jpeg')).toBeNull()
    expect(validateAnalyzeRequest(garbagePng, 'image/png', Q)).toBe('decodeFailed')
    expect(validateAnalyzeRequest(garbageJpeg, 'image/jpeg', Q)).toBe('decodeFailed')
  })
})
