// Pure PNG/JPEG header parsing shared by BOTH processes (#118). Main uses it for the
// authoritative D4 pixel-bomb guard (`services/vision/limits.ts`, env-overridable cap);
// the renderer uses it as a PRE-decode OOM guard in `renderer/images/decode.ts` — the old
// renderer check ran AFTER `createImageBitmap` had already spent the decode memory, so it
// never served its stated purpose. Header-only: no full decode, cheap and safe on a bomb.

function readU16BE(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1]
}
function readU32BE(b: Uint8Array, o: number): number {
  // `* 0x1000000` (not `<<24`) so the high byte stays unsigned (JS bit-ops are 32-bit signed).
  return b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]
}

/** PNG: 8-byte signature, then the IHDR chunk with width@16 and height@20 (big-endian u32). */
export function pngPixelCount(b: Uint8Array): number | null {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (b.length < 24) return null
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return null
  const w = readU32BE(b, 16)
  const h = readU32BE(b, 20)
  return w > 0 && h > 0 ? w * h : null
}

/** JPEG: scan segment markers for a Start-Of-Frame (SOF0–SOF15) and read its height/width. */
export function jpegPixelCount(b: Uint8Array): number | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let o = 2
  while (o + 1 < b.length) {
    if (b[o] !== 0xff) {
      o++
      continue
    }
    // Collapse any run of 0xff fill bytes; the marker is the first non-0xff after them.
    let marker = b[o + 1]
    while (marker === 0xff && o + 2 < b.length) {
      o++
      marker = b[o + 1]
    }
    o += 2
    // Markers with no payload length: SOI/EOI and the restart markers RST0–RST7.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (o + 1 >= b.length) break
    const len = readU16BE(b, o)
    // SOF markers (0xC0–0xCF) carry the frame dimensions — except DHT(C4), JPG(C8), DAC(CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (o + 6 >= b.length) break
      const h = readU16BE(b, o + 3) // length(2) precision(1) THEN height(2), width(2)
      const w = readU16BE(b, o + 5)
      return w > 0 && h > 0 ? w * h : null
    }
    if (len < 2) break // malformed segment length — stop scanning
    o += len
  }
  return null
}

/**
 * Decoded pixel count (width*height) parsed from the image HEADER only. Returns null when the
 * dimensions can't be determined (unknown MIME — e.g. WEBP has no parser here — or a
 * malformed/forged header). Main's `validateAnalyzeRequest` treats a `null` for a CLAIMED
 * png/jpeg as suspicious and rejects it (SEC-6); the renderer prescreen treats `null` as
 * "no verdict" and lets `createImageBitmap` decide (its decode failure is the reject).
 */
export function decodedPixelCount(bytes: Uint8Array, mimeType: string): number | null {
  if (mimeType === 'image/png') return pngPixelCount(bytes)
  if (mimeType === 'image/jpeg') return jpegPixelCount(bytes)
  return null
}

/**
 * The DEFAULT decoded-pixel budget (~50 MP — covers high-end cameras/scans). Main's
 * authoritative cap (`VISION_MAX_IMAGE_PIXELS`) starts from this and is env-overridable;
 * the renderer prescreen uses the default directly (no env access in the sandbox).
 */
export const DEFAULT_MAX_IMAGE_PIXELS = 50 * 1000 * 1000
