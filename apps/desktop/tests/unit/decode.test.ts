// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import {
  decodeImage,
  imageMimeFromName,
  imageMimeOfFile,
  ImageDecodeError
} from '../../src/renderer/images/decode'

// TEST-4 / plan §17 rows 2 & 3: the CLIENT-side guards (the fast reject before the authoritative
// main-side re-check, SEC-3). Two paths the main guard cannot cover: an unsupported MIME (the
// screen maps a null mime to `unsupportedType`) and an OVER-DIMENSION bitmap (decoding a huge
// image risks OOM, so it is rejected as `tooLarge` BEFORE rasterizing). jsdom has no
// `createImageBitmap`, so we stub it to drive the dimension branch deterministically.

const origCreateImageBitmap = (globalThis as { createImageBitmap?: unknown }).createImageBitmap

afterEach(() => {
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = origCreateImageBitmap
})

function stubCreateImageBitmap(width: number, height: number): void {
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
    width,
    height,
    close() {}
  })
}

describe('client image MIME guard (unsupportedType source)', () => {
  it('returns null for an unsupported extension (→ the screen shows unsupportedType)', () => {
    expect(imageMimeFromName('photo.gif')).toBeNull()
    expect(imageMimeFromName('scan.tiff')).toBeNull()
    expect(imageMimeFromName('notes.pdf')).toBeNull()
  })

  it('maps supported PNG/JPEG names + falls back to the name when a File has no type', () => {
    expect(imageMimeFromName('a.png')).toBe('image/png')
    expect(imageMimeFromName('a.JPG')).toBe('image/jpeg')
    // A File whose OS-supplied type is '' must fall back to the name (some OSes leave type blank).
    const gif = { type: '', name: 'animation.gif' } as unknown as File
    expect(imageMimeOfFile(gif)).toBeNull()
    const png = { type: '', name: 'shot.png' } as unknown as File
    expect(imageMimeOfFile(png)).toBe('image/png')
  })
})

describe('client decode dimension cap (tooLarge)', () => {
  it('rejects an over-dimension bitmap as tooLarge before rasterizing', async () => {
    stubCreateImageBitmap(5000, 100) // longest side 5000 > MAX_DIMENSION (4096)
    await expect(decodeImage(new Blob([new Uint8Array([1, 2, 3])]), 'image/png')).rejects.toMatchObject({
      code: 'tooLarge'
    })
    await expect(decodeImage(new Blob([new Uint8Array([1, 2, 3])]), 'image/png')).rejects.toBeInstanceOf(
      ImageDecodeError
    )
  })

  it('rejects a zero-dimension (undecodable) bitmap as decodeFailed', async () => {
    stubCreateImageBitmap(0, 0)
    await expect(decodeImage(new Blob([new Uint8Array([1, 2, 3])]), 'image/png')).rejects.toMatchObject({
      code: 'decodeFailed'
    })
  })

  it('maps a createImageBitmap throw to decodeFailed', async () => {
    ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => {
      throw new Error('not an image')
    }
    await expect(decodeImage(new Blob([new Uint8Array([9])]), 'image/jpeg')).rejects.toMatchObject({
      code: 'decodeFailed'
    })
  })
})
