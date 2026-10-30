import { describe, it, expect } from 'vitest'
import {
  imageMimeFromName,
  imageMimeOfFile,
  isHeicName,
  isPdfName,
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
import { jpegHeader, pngHeader } from '../helpers/image-fixtures'

// #118 / #124 intake-pipeline pure parts. `decodeImage` itself needs `createImageBitmap` (jsdom
// has none — exactly why the old post-decode 4096 px reject survived unnoticed), so the decisions
// are extracted pure and pinned here: the pre-decode header prescreen (mirrors main's D4 parse,
// runs BEFORE the decode spends memory), the WEBP intake/normalize mapping, and the HEIC and PDF
// detection. This suite owns every pure helper in decode.ts and shared/image-headers.ts;
// decode.test.ts runs the `decodeImage` pipeline on a stubbed `createImageBitmap`.

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

  // The shipped budget, pinned at both edges where the prescreen uses it. decode.test.ts owns the
  // ordering: the refusal lands BEFORE createImageBitmap would spend the memory.
  it('admits exactly the ~50 MP budget and refuses one pixel more, before any decode (#118)', () => {
    expect(prescreenPixelCount(pngHeader(DEFAULT_MAX_IMAGE_PIXELS, 1), 'image/png')).toBeNull()
    expect(prescreenPixelCount(pngHeader(DEFAULT_MAX_IMAGE_PIXELS + 1, 1), 'image/png')).toBe('tooLarge')
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
  it('imageMimeFromName maps PNG/JPEG/WEBP names (any case) and stays null for everything else', () => {
    expect(imageMimeFromName('photo.webp')).toBe('image/webp')
    expect(imageMimeFromName('photo.WEBP')).toBe('image/webp')
    expect(imageMimeFromName('pic.png')).toBe('image/png')
    expect(imageMimeFromName('pic.jpeg')).toBe('image/jpeg')
    expect(imageMimeFromName('a.JPG')).toBe('image/jpeg')
    expect(imageMimeFromName('pic.heic')).toBeNull()
    expect(imageMimeFromName('pic.gif')).toBeNull()
    expect(imageMimeFromName('scan.tiff')).toBeNull()
    // #539: a PDF is never an accepted image type — its detection is a separate branch (isPdfName).
    expect(imageMimeFromName('notes.pdf')).toBeNull()
  })

  it('imageMimeOfFile falls back to the name when the OS leaves File.type blank', () => {
    expect(imageMimeOfFile(new File([], 'shot.png', { type: '' }))).toBe('image/png')
    expect(imageMimeOfFile(new File([], 'animation.gif', { type: '' }))).toBeNull()
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

describe('PDF detection (#539)', () => {
  it('isPdfName detects a PDF by extension (any case) or by its MIME type', () => {
    expect(isPdfName('scan.pdf')).toBe(true)
    expect(isPdfName('Scan 2026.PDF')).toBe(true)
    expect(isPdfName('scan', 'application/pdf')).toBe(true)
    expect(isPdfName('scan.pdf', '')).toBe(true)
    expect(isPdfName('pdf.png')).toBe(false)
    expect(isPdfName('notes.pdf.docx')).toBe(false)
    expect(isPdfName('photo.jpg', 'image/jpeg')).toBe(false)
  })
})
