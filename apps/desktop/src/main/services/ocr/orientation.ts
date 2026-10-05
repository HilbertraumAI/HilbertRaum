import { crc32 } from 'node:zlib'

// Page orientation for OCR (#538). Pure byte handling — no decoder, no canvas.
//
// tesseract.js turns an image upright only from its EXIF orientation: `setImage` scans the first
// 500 bytes for a BIG-endian Orientation entry (`01 12 00 03 00 00 00 01 00 <v>`) and the WASM core
// applies it with an exact right-angle turn. Two consequences:
//   - a little-endian (`II`) EXIF block — what many phones and cameras write — is never seen, so a
//     photo held sideways reaches recognition sideways (measured: 0 of 68 words; the same photo with
//     a big-endian block: 68 of 68);
//   - the core's own `rotateRadians` option is no substitute for a right-angle turn: it turns inside
//     the original frame, so a sideways A4 page loses its top and bottom lines (measured: 63 of 68).
// So every turn the OCR makes is expressed the way the core reads it: a big-endian Orientation
// marker placed first in the file (a PNG `eXIf` chunk right after IHDR, a JPEG APP1 right after
// SOI), carrying the image's OWN orientation (either byte order) composed with the turn wanted.
// `tests/unit/ocr-orientation.test.ts` runs tesseract.js's own `setImage` against these markers.

/** A clockwise turn, in degrees, applied to an image before it is read. */
export type OcrTurn = 0 | 90 | 180 | 270

export const OCR_TURNS: readonly OcrTurn[] = [0, 90, 180, 270]

/**
 * The orientation data on the drive: `ocr/osd.traineddata.gz` (Tesseract OSD, legacy engine).
 * It sits beside the language files but is NOT a recognition language — the factory leaves it out
 * of the list it reads with (an LSTM-only start on it would fail and take OCR down).
 */
export const OCR_ORIENTATION_LANG = 'osd'

const ORIENTATION_TAG = 0x0112
const TIFF_SHORT = 3
/** EXIF orientation as (mirrored first?, then the clockwise turn that displays it upright). */
const ORIENTATIONS: Record<number, { mirror: boolean; turn: OcrTurn }> = {
  1: { mirror: false, turn: 0 },
  2: { mirror: true, turn: 0 },
  3: { mirror: false, turn: 180 },
  4: { mirror: true, turn: 180 },
  5: { mirror: true, turn: 270 },
  6: { mirror: false, turn: 90 },
  7: { mirror: true, turn: 90 },
  8: { mirror: false, turn: 270 }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function isPng(image: Buffer): boolean {
  return image.length >= 33 && image.subarray(0, 8).equals(PNG_SIGNATURE)
}

function isJpeg(image: Buffer): boolean {
  return image.length >= 4 && image[0] === 0xff && image[1] === 0xd8
}

/** The Orientation value of a TIFF block (`II`/`MM` header + IFD0), or 1. Bounds-checked. */
function tiffOrientation(tiff: Buffer): number {
  if (tiff.length < 8) return 1
  const order = tiff.toString('latin1', 0, 2)
  if (order !== 'II' && order !== 'MM') return 1
  const le = order === 'II'
  const u16 = (at: number): number => (le ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at))
  const u32 = (at: number): number => (le ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at))
  if (u16(2) !== 42) return 1
  const ifd = u32(4)
  if (ifd + 2 > tiff.length) return 1
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > tiff.length) return 1
    if (u16(entry) !== ORIENTATION_TAG) continue
    if (u16(entry + 2) !== TIFF_SHORT) return 1
    const value = u16(entry + 8)
    return ORIENTATIONS[value] ? value : 1
  }
  return 1
}

/**
 * The image's own EXIF orientation (1–8; 1 when absent or unreadable), from a JPEG APP1 `Exif`
 * block or a PNG `eXIf` chunk, in either byte order. Never throws on malformed input.
 */
export function imageOrientation(image: Buffer): number {
  try {
    if (isJpeg(image)) {
      let at = 2
      // Markers before the scan data; a bounded walk (each step advances by at least 2 bytes).
      while (at + 4 <= image.length && image[at] === 0xff) {
        const marker = image[at + 1]
        if (marker === 0xda || marker === 0xd9) break
        const length = image.readUInt16BE(at + 2)
        if (length < 2) break
        const body = image.subarray(at + 4, Math.min(image.length, at + 2 + length))
        if (marker === 0xe1 && body.toString('latin1', 0, 6) === 'Exif\0\0') {
          return tiffOrientation(body.subarray(6))
        }
        at += 2 + length
      }
      return 1
    }
    if (isPng(image)) {
      let at = 8
      while (at + 12 <= image.length) {
        const length = image.readUInt32BE(at)
        const type = image.toString('latin1', at + 4, at + 8)
        if (type === 'IDAT' || type === 'IEND') break
        if (type === 'eXIf') return tiffOrientation(image.subarray(at + 8, Math.min(image.length, at + 8 + length)))
        at += 12 + length
      }
    }
  } catch {
    // A truncated block reads as "no orientation".
  }
  return 1
}

/** The EXIF orientation that shows an image of orientation `own` turned a further `turn` clockwise. */
export function composeOrientation(own: number, turn: OcrTurn): number {
  const base = ORIENTATIONS[own] ?? ORIENTATIONS[1]
  const total = ((base.turn + turn) % 360) as OcrTurn
  for (const [value, o] of Object.entries(ORIENTATIONS)) {
    if (o.mirror === base.mirror && o.turn === total) return Number(value)
  }
  return 1
}

/** A big-endian TIFF block holding one Orientation entry — the byte run tesseract.js matches. */
function orientationTiff(orientation: number): Buffer {
  const tiff = Buffer.alloc(26)
  tiff.write('MM', 0, 'latin1')
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4) // IFD0 right after the header
  tiff.writeUInt16BE(1, 8) // one entry
  tiff.writeUInt16BE(ORIENTATION_TAG, 10)
  tiff.writeUInt16BE(TIFF_SHORT, 12)
  tiff.writeUInt32BE(1, 14) // count
  tiff.writeUInt16BE(orientation, 18) // value, left-justified in the 4-byte field
  // bytes 22–25: no next IFD
  return tiff
}

/**
 * `image` as tesseract.js should read it after a further clockwise `turn`: unchanged when there is
 * nothing to say (no own orientation, no turn), else with an orientation marker placed first. A
 * file that is neither a well-formed PNG nor a JPEG is returned unchanged (it is read as it is).
 */
export function orientImage(image: Buffer, turn: OcrTurn): Buffer {
  const own = imageOrientation(image)
  if (own === 1 && turn === 0) return image
  const tiff = orientationTiff(composeOrientation(own, turn))
  if (isPng(image) && image.toString('latin1', 12, 16) === 'IHDR' && image.readUInt32BE(8) === 13) {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(tiff.length, 0)
    head.write('eXIf', 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), tiff])), 0)
    return Buffer.concat([image.subarray(0, 33), head, tiff, crc, image.subarray(33)])
  }
  if (isJpeg(image)) {
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
    const head = Buffer.from([0xff, 0xe1, 0, 0])
    head.writeUInt16BE(payload.length + 2, 2)
    return Buffer.concat([image.subarray(0, 2), head, payload, image.subarray(2)])
  }
  return image
}
