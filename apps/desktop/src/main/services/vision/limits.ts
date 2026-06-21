import type { VisionErrorCode } from '../../../shared/types'

// Vision input caps (image-understanding plan §14), mirroring `ingestion/limits.ts`. The
// image is attacker-controllable (any file the user drops), so the byte cap is the
// main-process backstop against a crafted huge image OOMing the sidecar — net-new enforcement
// (SEC-3): `imageReadBytes`/`imageAnalyze` re-check the extension + cap themselves.
//
// D4 (vuln-scan-2026-06-21): the byte cap alone does NOT stop a decompression bomb — a small
// (<20 MiB) PNG/JPEG can decode to enormous dimensions, and runtime.ts inlines the ORIGINAL
// bytes to the sidecar, where clip/llama.cpp allocates width*height*channels and OOMs. The
// renderer's MAX_DIMENSION downscale is for DISPLAY and does not bound what the sidecar decodes,
// so the authoritative main-side guard now parses the image header and rejects above a pixel
// budget too (no full decode — just the dimensions in the header).

/** Max accepted image bytes. ~20 MiB default; env-overridable (`HILBERTRAUM_MAX_IMAGE_BYTES`). */
export const VISION_MAX_IMAGE_BYTES = readByteCap()

/**
 * Max accepted DECODED pixel count (width*height). ~50 MP default (covers high-end cameras /
 * scans); env-overridable (`HILBERTRAUM_MAX_IMAGE_PIXELS`). A decompression bomb decodes far
 * above this and is rejected before its bytes ever reach the sidecar (D4).
 */
export const VISION_MAX_IMAGE_PIXELS = readPixelCap()

/** The image file extensions the picker + main-side guard accept (lower-case, with the dot). */
export const VISION_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg'])

/** The MIME types `ImageAnalyzeRequest.mimeType` may carry (the renderer-decided format). */
export const VISION_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg'])

function readByteCap(): number {
  const raw = process.env.HILBERTRAUM_MAX_IMAGE_BYTES?.trim()
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20 * 1024 * 1024
}

function readPixelCap(): number {
  const raw = process.env.HILBERTRAUM_MAX_IMAGE_PIXELS?.trim()
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50 * 1000 * 1000
}

function readU16BE(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1]
}
function readU32BE(b: Uint8Array, o: number): number {
  // `* 0x1000000` (not `<<24`) so the high byte stays unsigned (JS bit-ops are 32-bit signed).
  return b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]
}

/** PNG: 8-byte signature, then the IHDR chunk with width@16 and height@20 (big-endian u32). */
function pngPixelCount(b: Uint8Array): number | null {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (b.length < 24) return null
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return null
  const w = readU32BE(b, 16)
  const h = readU32BE(b, 20)
  return w > 0 && h > 0 ? w * h : null
}

/** JPEG: scan segment markers for a Start-Of-Frame (SOF0–SOF15) and read its height/width. */
function jpegPixelCount(b: Uint8Array): number | null {
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
 * Decoded pixel count (width*height) parsed from the image HEADER only — no full decode, so this
 * is cheap and safe on a bomb. Returns null when the dimensions can't be determined (the byte
 * cap then remains the only bound; a truly undecodable image fails downstream anyway).
 */
export function decodedPixelCount(bytes: Uint8Array, mimeType: string): number | null {
  if (mimeType === 'image/png') return pngPixelCount(bytes)
  if (mimeType === 'image/jpeg') return jpegPixelCount(bytes)
  return null
}

/** Lower-case extension (with the dot) of a filename/path, or '' when none. */
export function imageExtensionOf(pathOrName: string): string {
  const i = pathOrName.lastIndexOf('.')
  return i < 0 ? '' : pathOrName.slice(i).toLowerCase()
}

/** True for a supported image path/name (png/jpg/jpeg). */
export function isSupportedImagePath(pathOrName: string): boolean {
  return VISION_IMAGE_EXTENSIONS.has(imageExtensionOf(pathOrName))
}

/**
 * Validate an analyze request main-side (the authoritative guard, SEC-3): a supported MIME,
 * non-empty bytes within the byte cap, decoded dimensions within the pixel budget (D4 — defuses
 * a decompression bomb without depending on the renderer's display-only downscale), and a
 * non-blank question. Returns the friendly `VisionErrorCode` to reject with, or `null` when the
 * request is acceptable. Pure — header parse only, no full decode and no I/O.
 */
export function validateAnalyzeRequest(
  imageBytes: unknown,
  mimeType: unknown,
  question: unknown,
  maxBytes: number = VISION_MAX_IMAGE_BYTES,
  maxPixels: number = VISION_MAX_IMAGE_PIXELS
): VisionErrorCode | null {
  if (typeof mimeType !== 'string' || !VISION_IMAGE_MIME_TYPES.has(mimeType)) {
    return 'unsupportedType'
  }
  if (!(imageBytes instanceof Uint8Array) || imageBytes.byteLength === 0) {
    // An empty/garbage payload can't decode — treat as undecodable rather than "too large".
    return 'decodeFailed'
  }
  if (imageBytes.byteLength > maxBytes) return 'tooLarge'
  // D4: reject a decompression bomb (small file, enormous decoded bitmap) before its bytes are
  // inlined to the sidecar. Unknown dimensions (null) fall through — the byte cap still applies.
  const pixels = decodedPixelCount(imageBytes, mimeType)
  if (pixels !== null && pixels > maxPixels) return 'tooLarge'
  if (typeof question !== 'string' || question.trim() === '') return 'emptyResponse'
  return null
}
