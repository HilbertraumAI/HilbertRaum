import type { VisionErrorCode } from '../../../shared/types'

// Vision input caps (image-understanding plan §14), mirroring `ingestion/limits.ts`. The
// image is attacker-controllable (any file the user drops), so the byte cap is the
// main-process backstop against a crafted huge image OOMing the sidecar — net-new enforcement
// (SEC-3): `importDocuments` trusts caller paths, but `imageReadBytes`/`imageAnalyze` re-check
// the extension + cap themselves. The dimension cap is a renderer-side decode concern (V3);
// main can only enforce bytes + extension/MIME.

/** Max accepted image bytes. ~20 MiB default; env-overridable (`HILBERTRAUM_MAX_IMAGE_BYTES`). */
export const VISION_MAX_IMAGE_BYTES = readByteCap()

/** The image file extensions the picker + main-side guard accept (lower-case, with the dot). */
export const VISION_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg'])

/** The MIME types `ImageAnalyzeRequest.mimeType` may carry (the renderer-decided format). */
export const VISION_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg'])

function readByteCap(): number {
  const raw = process.env.HILBERTRAUM_MAX_IMAGE_BYTES?.trim()
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20 * 1024 * 1024
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
 * non-empty bytes within the cap, and a non-blank question. Returns the friendly
 * `VisionErrorCode` to reject with, or `null` when the request is acceptable. Pure — no I/O.
 */
export function validateAnalyzeRequest(
  imageBytes: unknown,
  mimeType: unknown,
  question: unknown,
  maxBytes: number = VISION_MAX_IMAGE_BYTES
): VisionErrorCode | null {
  if (typeof mimeType !== 'string' || !VISION_IMAGE_MIME_TYPES.has(mimeType)) {
    return 'unsupportedType'
  }
  if (!(imageBytes instanceof Uint8Array) || imageBytes.byteLength === 0) {
    // An empty/garbage payload can't decode — treat as undecodable rather than "too large".
    return 'decodeFailed'
  }
  if (imageBytes.byteLength > maxBytes) return 'tooLarge'
  if (typeof question !== 'string' || question.trim() === '') return 'emptyResponse'
  return null
}
