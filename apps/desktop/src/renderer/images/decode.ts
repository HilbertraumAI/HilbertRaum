// Client-side image decode / downscale / EXIF-normalization (image-understanding §11) —
// NO native dependency: only built-in browser APIs in the sandboxed renderer
// (`createImageBitmap`, `OffscreenCanvas`/`<canvas>`, `convertToBlob`/`toBlob`,
// `FileReader`). Both intake paths converge here: drag-drop passes the dropped `File`
// (already a `Blob`); the picker wraps its `imageReadBytes` `Uint8Array` as a `Blob`. So
// `decodeFailed`, the pixel prescreen, and the EXIF/downscale normalization apply identically
// regardless of source.
//
// #118: the old post-decode `MAX_DIMENSION = 4096` hard reject is GONE — it ran AFTER
// `createImageBitmap` had already spent the decode memory (so it never served its stated OOM
// rationale) and refused mainstream inputs (a 48 MP phone photo is 8064×6048) that the very
// next step downscales to 1536 px anyway. The pre-decode guard that replaced it mirrors the
// main-side header parse (`shared/image-headers.ts`) BEFORE `createImageBitmap` — pure and
// unit-testable — against the same ~50 MP budget main enforces authoritatively (D4).
//
// #124: WEBP is accepted as INPUT and normalized here — Chromium decodes it natively, and the
// re-encode ships PNG — so the main-side accept set and the SEC-3/D4 parsers never see WEBP.
// Consequently the best-effort original-bytes fallback is DISABLED for WEBP (those bytes would
// be rejected main-side); a WEBP that cannot re-encode fails as `decodeFailed`.
//
// The preview MUST be a `data:` URL, never `blob:` — the prod CSP is `img-src 'self' data:`
// (main/index.ts) and does NOT list `blob:`, so a `URL.createObjectURL` preview would be
// CSP-blocked (SEC-1). This module therefore returns a `data:` URL only.

import type { VisionErrorCode } from '../../shared/types'
import { decodedPixelCount, DEFAULT_MAX_IMAGE_PIXELS } from '../../shared/image-headers'

/** The MIME an analyze request may SHIP (the main-side accept set — PNG/JPEG only). */
export type ImageMime = 'image/png' | 'image/jpeg'
/** The MIME an INTAKE may carry: WEBP decodes here and is normalized to PNG (#124). */
export type ImageInputMime = ImageMime | 'image/webp'

export interface DecodedImage {
  /** The (possibly downscaled / re-encoded, EXIF-stripped) bytes to ship to `imageAnalyze`. */
  bytes: Uint8Array
  /** Output format: PNG stays PNG, JPEG re-encodes at quality 0.9, WEBP normalizes to PNG. */
  mimeType: ImageMime
  /** A `data:` URL for the CSP-safe preview (never `blob:`). */
  dataUrl: string
  width: number
  height: number
}

/** A typed decode failure carrying the friendly `VisionErrorCode` the screen maps to copy. */
export class ImageDecodeError extends Error {
  constructor(public readonly code: VisionErrorCode) {
    super(code)
    this.name = 'ImageDecodeError'
  }
}

/** Test seam / injection point — the screen takes this so jsdom tests inject a fake decode. */
export type DecodeImage = (blob: Blob, mimeType: ImageInputMime) => Promise<DecodedImage>

/** Client byte cap — mirrors the main-side `VISION_MAX_IMAGE_BYTES` default (~20 MiB). The
 *  fast client reject (here) + the authoritative main-side re-check are deliberate (SEC-3). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** Client downscale target (longest side) — a real CPU-prefill latency lever (§11/V1). */
export const DOWNSCALE_TARGET = 1536
/** JPEG re-encode quality (§11). PNG re-encodes losslessly (quality is ignored). */
const JPEG_QUALITY = 0.9

/** Supported MIME for a filename/path, or null when the extension isn't supported. */
export function imageMimeFromName(name: string): ImageInputMime | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  return null
}

/** The supported MIME a `File` carries, falling back to its name (some OSes leave type ''). */
export function imageMimeOfFile(file: File): ImageInputMime | null {
  if (file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp') {
    return file.type
  }
  return imageMimeFromName(file.name)
}

/** iPhone HEIC/HEIF by extension (#124): kept UNSUPPORTED (no Chromium decode; a decoder would
 *  be a new native dep) but detected at intake so the copy can say "convert to JPEG" instead of
 *  the generic unsupported banner. */
export function isHeicName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.heic') || lower.endsWith('.heif')
}

/**
 * PRE-decode prescreen (#118): the main-side header parse, run BEFORE `createImageBitmap`, so
 * an absurd decoded size is refused before the decode memory is spent. Returns `tooLarge` above
 * the ~50 MP budget (main's authoritative D4 cap uses the same default), `null` otherwise —
 * including when the header yields no verdict (unknown container, e.g. WEBP, or a header this
 * parse can't read): unlike main's SEC-6 posture, the renderer lets `createImageBitmap` decide
 * those, since its own decode failure is the reject and Chromium bounds its decoder. Pure —
 * unit-testable in jsdom, which `createImageBitmap` paths are not.
 */
export function prescreenPixelCount(bytes: Uint8Array, mimeType: ImageInputMime): VisionErrorCode | null {
  const pixels = decodedPixelCount(bytes, mimeType)
  if (pixels !== null && pixels > DEFAULT_MAX_IMAGE_PIXELS) return 'tooLarge'
  return null
}

/** The output (analyze/ship) MIME for an intake MIME: WEBP normalizes to PNG (#124). */
export function outputMimeFor(input: ImageInputMime): ImageMime {
  return input === 'image/jpeg' ? 'image/jpeg' : 'image/png'
}

/**
 * Prescreen → decode → (optionally) downscale → re-encode → preview, per §11. Throws
 * `ImageDecodeError` with a friendly code on failure. `createImageBitmap({ imageOrientation:
 * 'from-image' })` requests EXIF-corrected orientation at decode; drawing the corrected bitmap
 * to a canvas and re-encoding bakes in the orientation and strips metadata (best-effort — see
 * the fallback), so the model never sees a sideways image. Best-effort fallback: if canvas
 * re-encode is unavailable/fails (but decode succeeded), the ORIGINAL bytes are sent — the
 * model's `clip` preprocessing resizes anyway, so only the payload/EXIF optimization is lost,
 * not correctness. The fallback is DISABLED for WEBP input (#124): main accepts PNG/JPEG only,
 * so original WEBP bytes would be rejected there — it fails as `decodeFailed` instead.
 */
export async function decodeImage(blob: Blob, mimeType: ImageInputMime): Promise<DecodedImage> {
  const inputBytes = new Uint8Array(await blob.arrayBuffer())
  // #118: the pre-decode OOM guard — header parse BEFORE the decode spends the memory. Any
  // decodable size below the budget proceeds; the downscale below handles the rest.
  const prescreen = prescreenPixelCount(inputBytes, mimeType)
  if (prescreen) throw new ImageDecodeError(prescreen)

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch {
    throw new ImageDecodeError('decodeFailed')
  }
  const { width, height } = bitmap
  if (width === 0 || height === 0) {
    bitmap.close?.()
    throw new ImageDecodeError('decodeFailed')
  }

  const outMime = outputMimeFor(mimeType)
  const scale = Math.min(1, DOWNSCALE_TARGET / Math.max(width, height))
  const targetW = Math.max(1, Math.round(width * scale))
  const targetH = Math.max(1, Math.round(height * scale))

  try {
    const { blob: outBlob, dataUrl } = await rasterize(bitmap, targetW, targetH, outMime)
    bitmap.close?.()
    const bytes = new Uint8Array(await outBlob.arrayBuffer())
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ImageDecodeError('tooLarge')
    return { bytes, mimeType: outMime, dataUrl, width: targetW, height: targetH }
  } catch (e) {
    bitmap.close?.()
    if (e instanceof ImageDecodeError) throw e
    // #124: no original-bytes fallback for WEBP — main-side accepts PNG/JPEG only.
    if (mimeType === 'image/webp') throw new ImageDecodeError('decodeFailed')
    // Best-effort fallback: original bytes + a FileReader data URL. NB the EXIF strip is
    // best-effort overall — this path ships the original bytes with metadata intact.
    if (inputBytes.byteLength === 0) throw new ImageDecodeError('decodeFailed')
    if (inputBytes.byteLength > MAX_IMAGE_BYTES) throw new ImageDecodeError('tooLarge')
    const dataUrl = await blobToDataUrl(blob)
    return { bytes: inputBytes, mimeType: outMime, dataUrl, width, height }
  }
}

/** Draw the bitmap at the target size and re-encode to `mime`. Prefers OffscreenCanvas. */
async function rasterize(
  bitmap: ImageBitmap,
  w: number,
  h: number,
  mime: ImageMime
): Promise<{ blob: Blob; dataUrl: string }> {
  const quality = mime === 'image/jpeg' ? JPEG_QUALITY : undefined
  if (typeof OffscreenCanvas !== 'undefined') {
    const oc = new OffscreenCanvas(w, h)
    const ctx = oc.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(bitmap, 0, 0, w, h)
    const blob = await oc.convertToBlob({ type: mime, quality })
    return { blob, dataUrl: await blobToDataUrl(blob) }
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.drawImage(bitmap, 0, 0, w, h)
  const dataUrl = canvas.toDataURL(mime, quality)
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), mime, quality)
  })
  return { blob, dataUrl }
}

/** A `data:` URL for a Blob (CSP-safe preview). Exported for the history fast-path (#121). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}
