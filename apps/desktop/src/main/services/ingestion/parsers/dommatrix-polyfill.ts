// Minimal `DOMMatrix` polyfill for the Electron MAIN process: exactly the members pdf.js reaches there.
//
// WHY THIS EXISTS. Node has no DOMMatrix, and pdf.js brings none of its own. At its first import
// pdf.js ALWAYS `require`s `@napi-rs/canvas` (legacy/build/pdf.mjs, `src/display/node_utils.js`; the
// same block in 6.3.289 and 6.4.299) and copies that native addon's DOMMatrix and Path2D onto
// `globalThis` only where the global is missing. So this polyfill does NOT keep pdf.js off the addon
// (`npm run dev` and the test suite load the Skia `.node` whatever is installed); it decides which
// DOMMatrix pdf.js gets. Packaged, the addon is excluded (electron-builder.yml `files` negation: a
// platform-specific `.node`, kept out so the portable bundle stays pure-JS / cross-OS; asserted by
// tests/integration/packaging.test.ts). There the require fails and, without this polyfill, the
// main process has no DOMMatrix at all; pdf.js prints two warnings to stderr at that first import
// (`Cannot load "@napi-rs/canvas"`, ``Cannot polyfill `Path2D` ``), before any `verbosity: 0` applies.
// Nothing here reads Path2D (canvas rendering only) and the app log does not capture them (#685,
// measured in a packaged build). pdfjs-dist 6.0–6.2 also built a matrix at import time, so the
// packaged import threw "DOMMatrix is not defined" while dev, with the addon's, worked; 6.3 builds it
// lazily (upstream pdf.js #21721). tests/integration/pdf-parser-packaged.test.ts runs the parser with
// the addon unloadable.
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
// identity constructor (an init throws), scaleSelf, translateSelf and a–f below. On a pdfjs-dist bump,
// re-grep both legacy build files for `DOMMatrix` before trusting that list.

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

  constructor(init?: unknown) {
    // An init is a use this polyfill was not built for (a pdf.js bump moving a canvas path into this
    // process, or another library): throw rather than hand back a silently wrong identity. Inside a
    // Type3 glyph pdf.js swallows the throw per glyph and our `verbosity: 0` hides its warning, so the
    // guard that sees it is dommatrix-polyfill.test.ts (real pdf.js at verbosity 1) — re-run it on a bump.
    if (init !== undefined) throw new TypeError('DOMMatrix polyfill: only `new DOMMatrix()` is supported')
  }

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
 * no-op where one is present (a browser context, or a process that imported pdf.js first, which
 * then holds `@napi-rs/canvas`'s wherever that addon loads). Call this before importing pdfjs-dist
 * in the main process.
 */
export function ensureDomMatrixPolyfill(): void {
  const g = globalThis as { DOMMatrix?: unknown }
  if (!g.DOMMatrix) {
    g.DOMMatrix = DOMMatrixPolyfill
  }
}
