// Vector ↔ BLOB codec (LOCKED encoding, spec §6). A vector is a `Float32Array`; it is stored
// in `embeddings.vector_blob` as the raw little-endian Float32 bytes and decoded back into a
// `Float32Array` on read.
//
// Lives in its own module (not the `embeddings` barrel) so the resident-vector cache
// (`resident-cache.ts`) can decode without importing the barrel that re-exports it — i.e. with
// no `index ↔ resident-cache` import cycle. Re-exported from `./index` for the existing
// barrel callers.

/** Encode a vector to the raw Float32 bytes stored in `embeddings.vector_blob`. */
export function encodeVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}

/**
 * Decode a stored BLOB back into a `Float32Array` of `dimensions` floats.
 * SQLite blobs can land on an unaligned byte offset, so we copy into a fresh,
 * 4-byte-aligned buffer before viewing it as Float32 (avoids a RangeError).
 */
export function decodeVector(blob: Uint8Array, dimensions: number): Float32Array {
  const bytes = Uint8Array.prototype.slice.call(blob, 0, dimensions * 4) // copy → offset 0, aligned
  return new Float32Array(bytes.buffer, bytes.byteOffset, dimensions)
}
