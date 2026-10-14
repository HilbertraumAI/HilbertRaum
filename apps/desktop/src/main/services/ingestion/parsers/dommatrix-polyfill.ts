// Minimal `DOMMatrix` polyfill for the Electron MAIN process: exactly the members pdf.js reaches there.
//
// WHY THIS EXISTS. pdfjs-dist 6.0–6.2's legacy build evaluated a module-level
// `const SCALE_MATRIX = new DOMMatrix()` at import time, and in Node it only sets
// `globalThis.DOMMatrix` by `require("@napi-rs/canvas")`. We DELIBERATELY exclude
// `@napi-rs/canvas` from the packaged app (electron-builder.yml `files` negation — a
// platform-specific Skia `.node` we never import; keeps the portable bundle pure-JS /
// cross-OS, asserted by tests/integration/packaging.test.ts). So in the PACKAGED app the
// require fails, `globalThis.DOMMatrix` stays undefined, and `import`ing pdfjs throws
// "DOMMatrix is not defined" → PDF import breaks. In `npm run dev` the dep is present, so
// pdf.js polyfills itself and the bug is invisible — which is why it only surfaced from a
// built drive. pdfjs-dist 6.3 creates that matrix lazily (upstream pdf.js #21721), so its
// import no longer throws without one. The polyfill stays (wave DEP-6): it keeps pdf.js off
// the `@napi-rs/canvas` DOMMatrix and guards against a later release reintroducing the import-time use.
//
// WHAT pdf.js REACHES HERE (pdfjs-dist 6.4.299; #687). pdf.js installs `@napi-rs/canvas`'s DOMMatrix
// only `if (!globalThis.DOMMatrix)`, so installing this BEFORE the pdfjs import makes pdf.js use it,
// in dev and packaged alike. Node runs pdf.js's worker in-process, so the worker's code sees this global
// too. The main process extracts text (getTextContent) and counts operators (#575's scanned-page check);
// both load the page's fonts, and loading a Type3 font compiles any glyph that paints an image mask with
// `compileType3Glyph` (legacy/build/pdf.worker.mjs): `new DOMMatrix().scaleSelf(1 / w, -1 / h)
// .translateSelf(0, -h)`, then it reads a–f. So text extraction is NOT independent of the global
// DOMMatrix: a constructor-only shim throws there, and pdf.js drops the glyph with a warning that our
// `verbosity: 0` silences. Every other DOMMatrix use in pdf.js 6.4 (the array constructor, translate,
// scale, multiplySelf, preMultiplySelf, invertSelf) is canvas rendering, which never runs in this
// process: OCR rasterizes in the hidden renderer window with the browser's own DOMMatrix. Hence only the
// identity constructor, scaleSelf, translateSelf and a–f below. On a pdfjs-dist bump, re-grep both
// legacy build files for `DOMMatrix` before trusting that list.

/**
 * A 2D-affine matrix `[[a c e] [b d f] [0 0 1]]` mapping a point `(x, y)` to
 * `(a·x + c·y + e, b·x + d·y + f)`, always constructed as the identity.
 */
class DOMMatrixPolyfill {
  a = 1
  b = 0
  c = 0
  d = 1
  e = 0
  f = 0

  /** `this · scale(sx, sy)` in place (post-multiplied, as DOMMatrix does). */
  scaleSelf(sx = 1, sy = sx): this {
    return this.postMultiply(sx, 0, 0, sy, 0, 0)
  }

  /** `this · translate(tx, ty)` in place (post-multiplied, as DOMMatrix does). */
  translateSelf(tx = 0, ty = 0): this {
    return this.postMultiply(1, 0, 0, 1, tx, ty)
  }

  /** `this · m` in place, `m` given as its six 2D-affine components (the other matrix applies first). */
  private postMultiply(a: number, b: number, c: number, d: number, e: number, f: number): this {
    const t = { a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f }
    this.a = t.a * a + t.c * b
    this.b = t.b * a + t.d * b
    this.c = t.a * c + t.c * d
    this.d = t.b * c + t.d * d
    this.e = t.a * e + t.c * f + t.e
    this.f = t.b * e + t.d * f + t.f
    return this
  }
}

/**
 * Install the pure-JS `DOMMatrix` on `globalThis` **if none exists** — idempotent, and a
 * no-op where a real one is present (renderer/dev with `@napi-rs/canvas`). Call this before
 * importing pdfjs-dist in the main process.
 */
export function ensureDomMatrixPolyfill(): void {
  const g = globalThis as { DOMMatrix?: unknown }
  if (!g.DOMMatrix) {
    g.DOMMatrix = DOMMatrixPolyfill
  }
}
