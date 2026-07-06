// Minimal, correct 2D-affine `DOMMatrix` polyfill for the Electron MAIN process.
//
// WHY THIS EXISTS. pdfjs-dist v6's legacy build evaluates a module-level
// `const SCALE_MATRIX = new DOMMatrix()` at import time, and in Node it only sets
// `globalThis.DOMMatrix` by `require("@napi-rs/canvas")`. We DELIBERATELY exclude
// `@napi-rs/canvas` from the packaged app (electron-builder.yml `files` negation — a
// platform-specific Skia `.node` we never import; keeps the portable bundle pure-JS /
// cross-OS, asserted by tests/integration/packaging.test.ts). So in the PACKAGED app the
// require fails, `globalThis.DOMMatrix` stays undefined, and `import`ing pdfjs throws
// "DOMMatrix is not defined" → PDF import breaks. In `npm run dev` the dep is present, so
// pdf.js polyfills itself and the bug is invisible — which is why it only surfaced from a
// built drive.
//
// pdf.js guards with `if (!globalThis.DOMMatrix)`, so installing this BEFORE the pdfjs
// import makes it skip the `@napi-rs/canvas` path entirely. Our main-process path does
// TEXT EXTRACTION only (getTextContent) — pdf.js hands text transforms back as plain
// arrays, independent of the global DOMMatrix — so the matrix only needs to *exist* for
// the import to succeed. The methods are nonetheless implemented correctly (2D affine) so
// nothing breaks if a code path ever touches them. Real rasterization (OCR) runs in the
// hidden renderer window with the browser's own DOMMatrix and never uses this.

type MatrixLike = { a: number; b: number; c: number; d: number; e: number; f: number }

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === 'number')
}

/**
 * A 2D-affine matrix `[[a c e] [b d f] [0 0 1]]` mapping a point `(x, y)` to
 * `(a·x + c·y + e, b·x + d·y + f)`. Implements the subset of the `DOMMatrix` API pdfjs-dist
 * touches (construction from an array / matrix, multiply/translate/scale, and self-inverse).
 */
class DOMMatrixPolyfill implements MatrixLike {
  a = 1
  b = 0
  c = 0
  d = 1
  e = 0
  f = 0

  constructor(init?: number[] | MatrixLike | string) {
    if (init == null) return // identity
    if (typeof init === 'string') return // CSS transform strings are unused here → identity
    if (isNumberArray(init)) {
      if (init.length === 6) {
        ;[this.a, this.b, this.c, this.d, this.e, this.f] = init
      } else if (init.length === 16) {
        // 4×4 column-major → take the 2D-affine components (m11,m12,m21,m22,m41,m42).
        this.a = init[0]
        this.b = init[1]
        this.c = init[4]
        this.d = init[5]
        this.e = init[12]
        this.f = init[13]
      }
      return
    }
    // DOMMatrix-like object.
    this.a = init.a
    this.b = init.b
    this.c = init.c
    this.d = init.d
    this.e = init.e
    this.f = init.f
  }

  get is2D(): boolean {
    return true
  }

  get isIdentity(): boolean {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0
  }

  // DOMMatrix 4×4 accessors mapped onto the 2D-affine components (the rest are the identity's).
  get m11(): number { return this.a }
  get m12(): number { return this.b }
  get m13(): number { return 0 }
  get m14(): number { return 0 }
  get m21(): number { return this.c }
  get m22(): number { return this.d }
  get m23(): number { return 0 }
  get m24(): number { return 0 }
  get m31(): number { return 0 }
  get m32(): number { return 0 }
  get m33(): number { return 1 }
  get m34(): number { return 0 }
  get m41(): number { return this.e }
  get m42(): number { return this.f }
  get m43(): number { return 0 }
  get m44(): number { return 1 }

  /** `this · other` (other applied first), returned as a new matrix. */
  multiply(other: MatrixLike): DOMMatrixPolyfill {
    return new DOMMatrixPolyfill([
      this.a * other.a + this.c * other.b,
      this.b * other.a + this.d * other.b,
      this.a * other.c + this.c * other.d,
      this.b * other.c + this.d * other.d,
      this.a * other.e + this.c * other.f + this.e,
      this.b * other.e + this.d * other.f + this.f
    ])
  }

  private setFrom(m: MatrixLike): this {
    this.a = m.a
    this.b = m.b
    this.c = m.c
    this.d = m.d
    this.e = m.e
    this.f = m.f
    return this
  }

  multiplySelf(other: MatrixLike): this {
    return this.setFrom(this.multiply(other))
  }

  preMultiplySelf(other: MatrixLike): this {
    return this.setFrom(new DOMMatrixPolyfill(other).multiply(this))
  }

  translate(tx = 0, ty = 0): DOMMatrixPolyfill {
    return this.multiply({ a: 1, b: 0, c: 0, d: 1, e: tx, f: ty })
  }

  translateSelf(tx = 0, ty = 0): this {
    return this.setFrom(this.translate(tx, ty))
  }

  scale(sx = 1, sy = sx): DOMMatrixPolyfill {
    return this.multiply({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 })
  }

  scaleSelf(sx = 1, sy = sx): this {
    return this.setFrom(this.scale(sx, sy))
  }

  invertSelf(): this {
    const det = this.a * this.d - this.b * this.c
    if (det === 0) {
      // Singular — DOMMatrix marks the result non-invertible (all NaN). Match that.
      this.a = this.b = this.c = this.d = this.e = this.f = NaN
      return this
    }
    const { a, b, c, d, e, f } = this
    this.a = d / det
    this.b = -b / det
    this.c = -c / det
    this.d = a / det
    this.e = (c * f - d * e) / det
    this.f = (b * e - a * f) / det
    return this
  }

  inverse(): DOMMatrixPolyfill {
    return new DOMMatrixPolyfill(this).invertSelf()
  }

  transformPoint(point: { x?: number; y?: number } = {}): { x: number; y: number; z: number; w: number } {
    const x = point.x ?? 0
    const y = point.y ?? 0
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 }
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

export { DOMMatrixPolyfill }
