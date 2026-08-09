import type { VisionErrorCode } from '../../../shared/types'
import { decodedPixelCount, DEFAULT_MAX_IMAGE_PIXELS } from '../../../shared/image-headers'

// #118: the PNG/JPEG header parsers moved to `shared/image-headers.ts` so the renderer can run
// the SAME parse as a PRE-decode guard (the old renderer check ran after createImageBitmap had
// already spent the decode memory). Re-exported here so main-side callers/tests are unchanged.
export { decodedPixelCount } from '../../../shared/image-headers'

// Vision input caps (image-understanding plan §14), mirroring `ingestion/limits.ts`. The
// image is attacker-controllable (any file the user drops), so the byte cap is the
// main-process backstop against a crafted huge image OOMing the sidecar — net-new enforcement
// (SEC-3): `imageReadBytes`/`imageAnalyze` re-check the extension + cap themselves.
//
// D4 (vuln-scan-2026-06-21; wording corrected 2026-08-09, #120 item 5): the byte cap alone
// does NOT stop a decompression bomb — a small (<20 MiB) PNG/JPEG can decode to enormous
// dimensions, and runtime.ts inlines the REQUEST bytes to the sidecar (normally the renderer's
// downscaled re-encode, but renderer output is attacker-controllable — threat #1 — so nothing
// upstream can be trusted), where clip/llama.cpp allocates width*height*channels and OOMs.
// The renderer's 1536 px downscale is client hygiene and does not bound what the sidecar
// decodes, so the authoritative main-side guard parses the image header and rejects above a
// pixel budget too (no full decode — just the dimensions in the header).

/** Max accepted image bytes. ~20 MiB default; env-overridable (`HILBERTRAUM_MAX_IMAGE_BYTES`). */
export const VISION_MAX_IMAGE_BYTES = readByteCap()

/**
 * Max accepted DECODED pixel count (width*height). ~50 MP default (covers high-end cameras /
 * scans); env-overridable (`HILBERTRAUM_MAX_IMAGE_PIXELS`). A decompression bomb decodes far
 * above this and is rejected before its bytes ever reach the sidecar (D4).
 */
export const VISION_MAX_IMAGE_PIXELS = readPixelCap()

/**
 * The image file extensions the INTAKE path accepts (picker filter + `imageReadBytes`,
 * lower-case, with the dot). WEBP joined 2026-08-09 (#124) under the normalize-in-renderer
 * decision: the renderer decodes WEBP natively (Chromium) and re-encodes to PNG before
 * `imageAnalyze`, so the ANALYZE accept set + the SEC-3/D4 parsers below never see WEBP.
 */
export const VISION_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp'
])

/** The MIME types `ImageAnalyzeRequest.mimeType` may carry (the renderer-decided format).
 *  Deliberately PNG/JPEG only — WEBP is normalized renderer-side (#124), so no WEBP header
 *  parser ever joins the attacker-facing D4 surface. */
export const VISION_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg'])

function readByteCap(): number {
  const raw = process.env.HILBERTRAUM_MAX_IMAGE_BYTES?.trim()
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20 * 1024 * 1024
}

function readPixelCap(): number {
  const raw = process.env.HILBERTRAUM_MAX_IMAGE_PIXELS?.trim()
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_IMAGE_PIXELS
}

/** Lower-case extension (with the dot) of a filename/path, or '' when none. */
export function imageExtensionOf(pathOrName: string): string {
  const i = pathOrName.lastIndexOf('.')
  return i < 0 ? '' : pathOrName.slice(i).toLowerCase()
}

/** True for an intake-supported image path/name (png/jpg/jpeg/webp — see the extension set). */
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
  // inlined to the sidecar.
  const pixels = decodedPixelCount(imageBytes, mimeType)
  // SEC-6 (backend-audit-2026-06-27): the MIME is already known to be png/jpeg here, so a `null`
  // pixel count means a CLAIMED png/jpeg whose header won't parse — malformed or forged bytes.
  // It previously fell through to byte-cap-only, silently disabling the pixel-bomb guard; treat
  // it as undecodable and reject rather than admit unverifiable bytes to the sidecar.
  if (pixels === null) return 'decodeFailed'
  if (pixels > maxPixels) return 'tooLarge'
  // #120 item 1: a blank question is an INPUT problem — its own code, not 'emptyResponse'
  // (whose copy means "the model returned an empty answer"). The renderer pre-guards blank
  // questions (visionSession `noop`), so this backstop fires only for non-renderer callers.
  if (typeof question !== 'string' || question.trim() === '') return 'emptyQuestion'
  return null
}
