import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import {
  imageOrientation,
  orientImage,
  type OcrTurn
} from '../../src/main/services/ocr/orientation'
import { readUpright, OCR_ACCEPT_CONFIDENCE } from '../../src/main/services/ocr/upright'
import type { OcrEngine, OcrOrientation } from '../../src/main/services/ocr'
import { TINY_JPEG, TINY_PNG } from '../helpers/fixtures'
import { fakeOcrEngine } from '../helpers/ocr-fixtures'

// #538 — turning a page upright. tesseract.js applies an image's EXIF orientation with an exact
// right-angle turn, but it finds the orientation only as a BIG-endian byte run in the first 500
// bytes (`setImage.js`), so a little-endian block (many phones) is ignored and the photo is read
// sideways. The app therefore expresses every turn as an orientation marker tesseract.js reads.
// These tests run tesseract.js's OWN `setImage` (with a fake WASM core that records what it is
// told), so a tesseract.js bump that changes how orientation is found reds here, not on a
// customer's sideways scan.

const requireFromApp = createRequire(import.meta.url)
const setImage = requireFromApp('tesseract.js/src/worker-script/utils/setImage.js') as (
  TessModule: unknown,
  api: unknown,
  image: Buffer,
  angle?: number
) => void

/** The EXIF orientation tesseract.js 7 hands its core for these bytes. */
function orientationSeenByTesseract(image: Buffer): number {
  let seen = -1
  const TessModule = { FS: { writeFile: () => undefined } }
  const api = {
    SetImageFile: (exif: number) => {
      seen = exif
      return 0
    }
  }
  setImage(TessModule, api, image)
  return seen
}

/** TINY_JPEG with an EXIF APP1 block (Orientation only) in the given byte order, right after SOI. */
function jpegWithExif(orientation: number, order: 'II' | 'MM'): Buffer {
  const tiff = Buffer.alloc(26)
  const le = order === 'II'
  tiff.write(order, 0, 'latin1')
  const u16 = (v: number, at: number): void => void (le ? tiff.writeUInt16LE(v, at) : tiff.writeUInt16BE(v, at))
  const u32 = (v: number, at: number): void => void (le ? tiff.writeUInt32LE(v, at) : tiff.writeUInt32BE(v, at))
  u16(42, 2)
  u32(8, 4)
  u16(1, 8)
  u16(0x0112, 10)
  u16(3, 12)
  u32(1, 14)
  u16(orientation, 18)
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const head = Buffer.from([0xff, 0xe1, 0, 0])
  head.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([TINY_JPEG.subarray(0, 2), head, payload, TINY_JPEG.subarray(2)])
}

describe('orientation markers, as tesseract.js reads them (#538)', () => {
  it('a little-endian EXIF photo: ignored by tesseract.js as it comes, honoured once oriented', () => {
    const phone = jpegWithExif(6, 'II')
    expect(imageOrientation(phone)).toBe(6)
    expect(orientationSeenByTesseract(phone)).toBe(1) // the defect: read sideways
    expect(orientationSeenByTesseract(orientImage(phone, 0))).toBe(6)
  })

  it.each([
    // [what, image, turn, orientation tesseract.js must apply]
    ['PNG, upright page turned 90°', TINY_PNG, 90, 6],
    ['PNG, upright page turned 270°', TINY_PNG, 270, 8],
    ['JPEG, upright page turned 180°', TINY_JPEG, 180, 3],
    ['big-endian EXIF 6, turned a further 270° (back to upright)', jpegWithExif(6, 'MM'), 270, 1],
    ['little-endian EXIF 3, turned a further 90°', jpegWithExif(3, 'II'), 90, 8],
    ['mirrored EXIF 2, turned 90° (the mirror stays)', jpegWithExif(2, 'II'), 90, 7]
  ] as Array<[string, Buffer, OcrTurn, number]>)('%s', (_what, image, turn, expected) => {
    expect(orientationSeenByTesseract(orientImage(image, turn))).toBe(expected)
  })

  it('an image with nothing to say is passed through untouched (clean pages cost nothing)', () => {
    expect(orientImage(TINY_PNG, 0)).toBe(TINY_PNG)
    expect(orientImage(TINY_JPEG, 0)).toBe(TINY_JPEG)
  })

  it('malformed or hostile EXIF reads as "no orientation" and never throws', () => {
    const truncated = jpegWithExif(6, 'II').subarray(0, 20)
    const hugeIfd = jpegWithExif(6, 'MM')
    const ifd = 2 + 4 + 6 + 8 // SOI, APP1 header, "Exif\0\0", then IFD0 at TIFF offset 8
    hugeIfd.writeUInt16BE(0xffff, ifd) // an entry count far past the block…
    hugeIfd.writeUInt16BE(0x0100, ifd + 2) // …and no Orientation where one fits: the walk must stop
    const badValue = jpegWithExif(9, 'II')
    for (const image of [truncated, hugeIfd, badValue, Buffer.alloc(0), Buffer.from('not an image')]) {
      expect(imageOrientation(image)).toBe(1)
      expect(() => orientImage(image, 90)).not.toThrow()
    }
  })
})

describe('readUpright — the reading policy (#538)', () => {
  /**
   * A fake engine whose reading confidence depends on the turn it is asked for, and whose OSD
   * answer is fixed. Records every call so the cost contract (how many readings) is observable.
   */
  function engineFor(
    confidenceAt: Partial<Record<OcrTurn, number>>,
    osd: OcrOrientation | null | 'absent'
  ): OcrEngine & { calls: string[] } {
    const calls: string[] = []
    const engine: OcrEngine & { calls: string[] } = {
      ...fakeOcrEngine({ id: 'fake', languages: ['deu'] }),
      calls,
      recognize: async (_image, opts) => {
        const turn = opts?.turn ?? 0
        calls.push(`read@${turn}`)
        return { text: `text@${turn}`, confidence: confidenceAt[turn] ?? 30 }
      },
      ...(osd === 'absent'
        ? {}
        : {
            detectOrientation: async () => {
              calls.push('osd')
              return osd
            }
          })
    }
    return engine
  }
  const img = Buffer.from('page')

  it('a confident reading is kept as is — no orientation check, one reading', async () => {
    const engine = engineFor({ 0: OCR_ACCEPT_CONFIDENCE }, { turn: 90, confidence: 9 })
    const r = await readUpright(engine, img)
    expect(r).toMatchObject({ turn: 0, text: 'text@0' })
    expect(engine.calls).toEqual(['read@0'])
  })

  it('an unsure reading asks OSD and keeps the reading at the turn it names when that is more confident', async () => {
    const engine = engineFor({ 0: 55, 270: 94 }, { turn: 270, confidence: 2 })
    const r = await readUpright(engine, img)
    expect(r).toMatchObject({ turn: 270, text: 'text@270', confidence: 94 })
    expect(engine.calls).toEqual(['read@0', 'osd', 'read@270'])
  })

  it('a wrong OSD answer cannot make a page worse: the more confident reading wins', async () => {
    const engine = engineFor({ 0: 53, 90: 38 }, { turn: 90, confidence: 1 })
    expect(await readUpright(engine, img)).toMatchObject({ turn: 0, confidence: 53 })
  })

  it('without orientation detection (no OSD file) the page is read once, as it comes', async () => {
    const engine = engineFor({ 0: 40 }, 'absent')
    expect(await readUpright(engine, img)).toMatchObject({ turn: 0 })
    expect(engine.calls).toEqual(['read@0'])
  })

  it('a previous page’s turn is tried first; when OSD declines, upright is tried before giving up', async () => {
    const sideways = engineFor({ 90: 92 }, null)
    expect(await readUpright(sideways, img, { first: 90 })).toMatchObject({ turn: 90 })
    expect(sideways.calls).toEqual(['read@90'])

    const uprightAfterSideways = engineFor({ 90: 31, 0: 88 }, null)
    expect(await readUpright(uprightAfterSideways, img, { first: 90 })).toMatchObject({ turn: 0, confidence: 88 })
    expect(uprightAfterSideways.calls).toEqual(['read@90', 'osd', 'read@0'])
  })
})
