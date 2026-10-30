// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { decodeImage, ImageDecodeError } from '../../src/renderer/images/decode'
import { pngHeader } from '../helpers/image-fixtures'

// TEST-4 / plan §17 rows 2 & 3: the CLIENT-side guards (the fast reject before the authoritative
// main-side re-check, SEC-3). #118 REPLACED the old post-decode `MAX_DIMENSION = 4096` hard
// reject (which ran AFTER createImageBitmap had spent the decode memory, and refused routine
// 48 MP phone photos) with a PRE-decode header prescreen against the ~50 MP budget — the pins
// below assert both halves: a large-but-decodable bitmap proceeds, and a header-declared bomb
// is refused BEFORE createImageBitmap is ever called. jsdom has no createImageBitmap, so it is
// stubbed; jsdom's canvas has no 2d context, so `rasterize` fails and decodeImage takes its
// best-effort original-bytes fallback (which #124 disables for WEBP — also pinned here).
// This suite is the only one that runs the real `decodeImage` (ImagesScreen mocks the module);
// the pure helpers it calls (the MIME guard, the prescreen bound) are image-intake.test.ts's.

const origCreateImageBitmap = (globalThis as { createImageBitmap?: unknown }).createImageBitmap

afterEach(() => {
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = origCreateImageBitmap
})

function stubCreateImageBitmap(width: number, height: number): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async () => ({ width, height, close() {} }))
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = stub
  return stub
}

describe('decode pipeline size guards (#118: prescreen replaced the 4096 px reject)', () => {
  it('a >4096 px bitmap is NO LONGER rejected — it proceeds into the pipeline', async () => {
    // The old behavior (rejects.toMatchObject({code:'tooLarge'})) is the #118 bug. 5000 px is a
    // routine modern input; in jsdom the rasterize step is unavailable, so the best-effort
    // fallback resolves with the original bytes — the point is: NOT a tooLarge reject.
    stubCreateImageBitmap(5000, 100)
    const out = await decodeImage(new Blob([new Uint8Array([1, 2, 3])]), 'image/png')
    expect(out.mimeType).toBe('image/png')
    expect(out.width).toBe(5000)
  })

  it('refuses a header-declared ~50 MP+ bomb BEFORE createImageBitmap is called (pre-decode)', async () => {
    const bitmapSpy = stubCreateImageBitmap(100, 100)
    await expect(
      decodeImage(new Blob([pngHeader(60000, 60000)]), 'image/png')
    ).rejects.toMatchObject({ code: 'tooLarge' })
    // The whole point of the prescreen: the decode memory was never spent.
    expect(bitmapSpy).not.toHaveBeenCalled()
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
    await expect(decodeImage(new Blob([new Uint8Array([9])]), 'image/jpeg')).rejects.toBeInstanceOf(
      ImageDecodeError
    )
  })
})

describe('WEBP normalization (#124)', () => {
  it('DISABLES the original-bytes fallback for WEBP — a failed re-encode is decodeFailed', async () => {
    // jsdom: rasterize fails (no 2d context). PNG/JPEG fall back to original bytes (above);
    // WEBP must NOT — main accepts PNG/JPEG only, so original WEBP bytes would be rejected there.
    stubCreateImageBitmap(100, 100)
    await expect(
      decodeImage(new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])]), 'image/webp')
    ).rejects.toMatchObject({ code: 'decodeFailed' })
  })
})
