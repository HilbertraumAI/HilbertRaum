// PNG header fixtures for the vision suites: just enough bytes for the main-side header guard (D4 / SEC-6 in
// services/vision/limits.ts) to read the dimensions. No pixel data.

/** A PNG header — the 8-byte signature and an IHDR with width@16 / height@20 (big-endian u32) — then
 *  `tail`, marker bytes a leak check can search for. */
export function pngHeader(width: number, height: number, tail: readonly number[] = []): Uint8Array {
  const b = new Uint8Array(24 + tail.length)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const dv = new DataView(b.buffer)
  dv.setUint32(16, width)
  dv.setUint32(20, height)
  b.set(tail, 24)
  return b
}
