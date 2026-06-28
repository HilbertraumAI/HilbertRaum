// Vector ↔ BLOB codec (LOCKED encoding, spec §6). A vector is a `Float32Array`; it is stored
// in `embeddings.vector_blob` as the raw little-endian Float32 bytes and decoded back into a
// `Float32Array` on read.
//
// Lives in its own module (not the `embeddings` barrel) so the resident-vector cache
// (`resident-cache.ts`) can decode without importing the barrel that re-exports it — i.e. with
// no `index ↔ resident-cache` import cycle. Re-exported from `./index` for the existing
// barrel callers.

// EMB-4 / MAINT-5 (backend audit 2026-06-27): the BLOB encoding is LOCKED to little-endian
// Float32 (spec §6) — `encodeVector` writes the host's NATIVE Float32 bytes and `decodeVector`
// reinterprets them, so a big-endian host would silently corrupt every stored vector. Assert
// little-endian at module load so such a host fails loudly at startup rather than poisoning the
// index. All supported targets (x86/ARM) are little-endian; this guards the locked assumption.
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1
if (!HOST_IS_LITTLE_ENDIAN) {
  throw new Error('codec.ts: big-endian host unsupported — vector_blob is little-endian Float32 (spec §6)')
}

/** Encode a vector to the raw Float32 bytes stored in `embeddings.vector_blob`. */
export function encodeVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}

/**
 * Decode a stored BLOB back into a `Float32Array` of `dimensions` floats, or `null` when the
 * blob is unusable so EVERY caller can skip the row uniformly (DATA-2 / EMB-2, backend audit
 * 2026-06-27). A physically truncated `vector_blob` (`length < dimensions*4`, e.g. a partial
 * write) or a non-positive `dimensions` would otherwise make `new Float32Array(…)` throw a
 * RangeError and abort the whole scan/compare task. The guard formerly lived at each call site
 * (resident-cache, node-vectors) but NOT on the compare path (`doctasks/manager.ts`); it now
 * lives here once. It is a single cheap length comparison — negligible on the hot resident-cache
 * vector scan.
 *
 * SQLite blobs can land on an unaligned byte offset, so on the valid path we copy into a fresh,
 * 4-byte-aligned buffer before viewing it as Float32 (avoids a RangeError on the offset too).
 */
export function decodeVector(blob: Uint8Array, dimensions: number): Float32Array | null {
  if (dimensions <= 0 || blob.length < dimensions * 4) return null
  const bytes = Uint8Array.prototype.slice.call(blob, 0, dimensions * 4) // copy → offset 0, aligned
  return new Float32Array(bytes.buffer, bytes.byteOffset, dimensions)
}
