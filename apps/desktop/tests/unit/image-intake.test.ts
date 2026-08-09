import { describe, it, expect } from 'vitest'
import {
  imageMimeFromName,
  isHeicName,
  outputMimeFor,
  prescreenPixelCount,
  DOWNSCALE_TARGET
} from '../../src/renderer/images/decode'
import {
  decodedPixelCount,
  DEFAULT_MAX_IMAGE_PIXELS,
  jpegPixelCount,
  pngPixelCount
} from '../../src/shared/image-headers'

// #118 / #124 intake-pipeline pure parts. `decodeImage` itself is untestable in jsdom (no
// `createImageBitmap` — exactly why the old post-decode 4096 px reject survived unnoticed), so
// the decisions are extracted pure and pinned here: the pre-decode header prescreen (mirrors
// main's D4 parse, runs BEFORE the decode spends memory), the WEBP intake/normalize mapping,
// and the HEIC extension detection.

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

describe('shared image-headers (moved from vision/limits for the renderer prescreen, #118)', () => {
  it('parses PNG and JPEG dimensions identically to the main-side D4 guard', () => {
    expect(pngPixelCount(pngHeader(640, 480))).toBe(640 * 480)
    expect(jpegPixelCount(jpegHeader(1024, 768))).toBe(1024 * 768)
    expect(decodedPixelCount(pngHeader(2, 2), 'image/png')).toBe(4)
    expect(decodedPixelCount(new Uint8Array([1, 2, 3]), 'image/png')).toBeNull()
    expect(decodedPixelCount(pngHeader(2, 2), 'image/webp')).toBeNull() // no WEBP parser — by design
  })
})

describe('prescreenPixelCount — the PRE-decode renderer guard (#118)', () => {
  it('accepts a modern 48 MP phone photo (8064×6048) — the old 4096 px reject is gone', () => {
    // The #118 failure scenario verbatim: a current phone photo. 8064×6048 ≈ 48.8 MP < 50 MP.
    expect(prescreenPixelCount(jpegHeader(8064, 6048), 'image/jpeg')).toBeNull()
    // A 600-dpi A4 scan (~5100×6600 ≈ 33.7 MP) — also fine; the downscale handles it.
    expect(prescreenPixelCount(pngHeader(5100, 6600), 'image/png')).toBeNull()
  })

  it('refuses a ~50 MP+ decode BEFORE createImageBitmap would spend the memory', () => {
    expect(60000 * 60000).toBeGreaterThan(DEFAULT_MAX_IMAGE_PIXELS)
    expect(prescreenPixelCount(pngHeader(60000, 60000), 'image/png')).toBe('tooLarge')
    expect(prescreenPixelCount(jpegHeader(60000, 60000), 'image/jpeg')).toBe('tooLarge')
  })

  it('passes a no-verdict header through (createImageBitmap decides — unlike main SEC-6)', () => {
    // Renderer posture: an unparseable/foreign container is NOT rejected here — the browser
    // decode is the authority and its failure maps to decodeFailed. Main keeps SEC-6 strict.
    expect(prescreenPixelCount(new Uint8Array(64).fill(0x41), 'image/png')).toBeNull()
    expect(prescreenPixelCount(new Uint8Array([0x52, 0x49, 0x46, 0x46]), 'image/webp')).toBeNull()
  })

  it('the downscale target stays below the budget (sanity: prescreen pass ⇒ downscale applies)', () => {
    expect(DOWNSCALE_TARGET).toBe(1536)
    expect(DOWNSCALE_TARGET * DOWNSCALE_TARGET).toBeLessThan(DEFAULT_MAX_IMAGE_PIXELS)
  })
})

describe('WEBP intake + HEIC detection (#124)', () => {
  it('imageMimeFromName accepts .webp and stays null for HEIC/unknown', () => {
    expect(imageMimeFromName('photo.webp')).toBe('image/webp')
    expect(imageMimeFromName('photo.WEBP')).toBe('image/webp')
    expect(imageMimeFromName('pic.png')).toBe('image/png')
    expect(imageMimeFromName('pic.jpeg')).toBe('image/jpeg')
    expect(imageMimeFromName('pic.heic')).toBeNull()
    expect(imageMimeFromName('pic.gif')).toBeNull()
  })

  it('outputMimeFor normalizes WEBP to PNG — the main-side accept set never sees WEBP', () => {
    expect(outputMimeFor('image/webp')).toBe('image/png')
    expect(outputMimeFor('image/png')).toBe('image/png')
    expect(outputMimeFor('image/jpeg')).toBe('image/jpeg')
  })

  it('isHeicName detects .heic/.heif case-insensitively', () => {
    expect(isHeicName('IMG_0001.HEIC')).toBe(true)
    expect(isHeicName('img.heif')).toBe(true)
    expect(isHeicName('img.jpg')).toBe(false)
    expect(isHeicName('heic.png')).toBe(false)
  })
})
