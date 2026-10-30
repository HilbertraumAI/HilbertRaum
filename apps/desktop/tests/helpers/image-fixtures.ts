// PNG / JPEG header fixtures for the vision and image-intake suites: just enough bytes for the header guards
// (D4 / SEC-6 in services/vision/limits.ts, the renderer prescreen in shared/image-headers.ts) to read the
// dimensions. No pixel data. `jpegHeader` replaces the byte-identical local copies in image-intake.test.ts and
// vision-limits.test.ts (chat-ui campaign).
//
// Both return types are INFERRED on purpose: TypeScript 5.7+ types a fresh `new Uint8Array(n)` as
// `Uint8Array<ArrayBuffer>`, which is a valid `BlobPart` (`new Blob([pngHeader(1, 1)])`, decode.test.ts), while an
// explicit `: Uint8Array` annotation widens it to `Uint8Array<ArrayBufferLike>`, which is not.

/** A PNG header — the 8-byte signature and an IHDR with width@16 / height@20 (big-endian u32) — then
 *  `tail`, marker bytes a leak check can search for. */
export function pngHeader(width: number, height: number, tail: readonly number[] = []) {
  const b = new Uint8Array(24 + tail.length)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const dv = new DataView(b.buffer)
  dv.setUint32(16, width)
  dv.setUint32(20, height)
  b.set(tail, 24)
  return b
}

/** A minimal JPEG: SOI + a baseline SOF0 segment carrying height then width (big-endian u16). */
export function jpegHeader(width: number, height: number) {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x11, // segment length
    0x08, // sample precision
    (height >> 8) & 0xff, height & 0xff, // height
    (width >> 8) & 0xff, width & 0xff, // width
    0x03, 0, 0, 0, 0, 0, 0, 0, 0 // components (unparsed tail)
  ])
}
