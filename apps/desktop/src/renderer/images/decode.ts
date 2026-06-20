// Client-side image decode / downscale / EXIF-normalization (image-understanding §11) —
// NO native dependency: only built-in browser APIs in the sandboxed renderer
// (`createImageBitmap`, `OffscreenCanvas`/`<canvas>`, `convertToBlob`/`toBlob`,
// `FileReader`). Both intake paths converge here: drag-drop passes the dropped `File`
// (already a `Blob`); the picker wraps its `imageReadBytes` `Uint8Array` as a `Blob`. So
// `decodeFailed`, the dimension cap, and the EXIF/downscale normalization apply identically
// regardless of source.
//
// The preview MUST be a `data:` URL, never `blob:` — the prod CSP is `img-src 'self' data:`
// (main/index.ts) and does NOT list `blob:`, so a `URL.createObjectURL` preview would be
// CSP-blocked (SEC-1). This module therefore returns a `data:` URL only.

import type { VisionErrorCode } from '../../shared/types'

export type ImageMime = 'image/png' | 'image/jpeg'

export interface DecodedImage {
  /** The (possibly downscaled / re-encoded, EXIF-stripped) bytes to ship to `imageAnalyze`. */
  bytes: Uint8Array
  /** Output format = the input MIME (PNG stays PNG; JPEG re-encodes at quality 0.9). */
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
export type DecodeImage = (blob: Blob, mimeType: ImageMime) => Promise<DecodedImage>

/** Client byte cap — mirrors the main-side `VISION_MAX_IMAGE_BYTES` default (~20 MiB). The
 *  fast client reject (here) + the authoritative main-side re-check are deliberate (SEC-3). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** Hard dimension reject (longest side); decoding a larger image risks OOM (§14). */
const MAX_DIMENSION = 4096
/** Client downscale target (longest side) — a real CPU-prefill latency lever (§11/V1). */
const DOWNSCALE_TARGET = 1536
/** JPEG re-encode quality (§11). PNG re-encodes losslessly (quality is ignored). */
const JPEG_QUALITY = 0.9

/** PNG/JPEG MIME for a filename/path, or null when the extension isn't supported. */
export function imageMimeFromName(name: string): ImageMime | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  return null
}

/** The supported MIME a `File` carries, falling back to its name (some OSes leave type ''). */
export function imageMimeOfFile(file: File): ImageMime | null {
  if (file.type === 'image/png' || file.type === 'image/jpeg') return file.type
  return imageMimeFromName(file.name)
}

/**
 * Decode → (optionally) downscale → re-encode → preview, per §11. Throws `ImageDecodeError`
 * with a friendly code on failure. `createImageBitmap({ imageOrientation: 'from-image' })`
 * requests EXIF-corrected orientation at decode; drawing the corrected bitmap to a canvas and
 * re-encoding bakes in the orientation and strips metadata, so the model never sees a sideways
 * image. Best-effort fallback: if canvas re-encode is unavailable/fails (but decode
 * succeeded), the original bytes are sent — the model's `clip` preprocessing resizes anyway,
 * so only the payload/EXIF optimization is lost, not correctness.
 */
export async function decodeImage(blob: Blob, mimeType: ImageMime): Promise<DecodedImage> {
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
  if (Math.max(width, height) > MAX_DIMENSION) {
    bitmap.close?.()
    throw new ImageDecodeError('tooLarge')
  }

  const scale = Math.min(1, DOWNSCALE_TARGET / Math.max(width, height))
  const targetW = Math.max(1, Math.round(width * scale))
  const targetH = Math.max(1, Math.round(height * scale))

  try {
    const { blob: outBlob, dataUrl } = await rasterize(bitmap, targetW, targetH, mimeType)
    bitmap.close?.()
    const bytes = new Uint8Array(await outBlob.arrayBuffer())
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ImageDecodeError('tooLarge')
    return { bytes, mimeType, dataUrl, width: targetW, height: targetH }
  } catch (e) {
    bitmap.close?.()
    if (e instanceof ImageDecodeError) throw e
    // Best-effort fallback: original bytes + a FileReader data URL.
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (bytes.byteLength === 0) throw new ImageDecodeError('decodeFailed')
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ImageDecodeError('tooLarge')
    const dataUrl = await blobToDataUrl(blob)
    return { bytes, mimeType, dataUrl, width, height }
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

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}
