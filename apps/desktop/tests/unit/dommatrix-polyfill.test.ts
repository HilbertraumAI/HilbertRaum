import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DOMMatrixPolyfill,
  ensureDomMatrixPolyfill
} from '../../src/main/services/ingestion/parsers/dommatrix-polyfill'

// Guards the "DOMMatrix is not defined" PDF-import failure from a packaged drive: pdfjs-dist
// v6 evaluates `new DOMMatrix()` at import time and, in Node, only polyfills it from
// `@napi-rs/canvas`, which we exclude from the bundle. The parser installs this pure-JS
// matrix first. These tests pin (a) the math pdf.js relies on and (b) the install contract.

const IDENTITY: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0]

function toArr(m: DOMMatrixPolyfill): number[] {
  return [m.a, m.b, m.c, m.d, m.e, m.f]
}

describe('DOMMatrixPolyfill', () => {
  it('defaults to the identity and constructs from a 6-tuple', () => {
    expect(toArr(new DOMMatrixPolyfill())).toEqual(IDENTITY)
    expect(new DOMMatrixPolyfill()).toHaveProperty('isIdentity', true)
    expect(toArr(new DOMMatrixPolyfill([2, 0, 0, 3, 5, 7]))).toEqual([2, 0, 0, 3, 5, 7])
  })

  it('extracts the 2D-affine components from a 4x4 (16-length) array', () => {
    // column-major m11,m12,..,m41,m42 at indices 0,1,4,5,12,13
    const m = new DOMMatrixPolyfill([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 5, 7, 0, 1])
    expect(toArr(m)).toEqual([2, 0, 0, 3, 5, 7])
  })

  it('copies from a DOMMatrix-like object', () => {
    expect(toArr(new DOMMatrixPolyfill({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }))).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('translate maps points correctly', () => {
    const p = new DOMMatrixPolyfill().translate(10, 20).transformPoint({ x: 1, y: 1 })
    expect([p.x, p.y]).toEqual([11, 21])
  })

  it('scale maps points correctly', () => {
    const p = new DOMMatrixPolyfill().scale(2, 3).transformPoint({ x: 4, y: 5 })
    expect([p.x, p.y]).toEqual([8, 15])
  })

  it('multiply composes transforms (translate then scale applied to a point)', () => {
    // this = scale(2,2) · translate(10,0): the point is translated first, then scaled.
    const m = new DOMMatrixPolyfill().scale(2, 2).multiply(new DOMMatrixPolyfill().translate(10, 0))
    const p = m.transformPoint({ x: 1, y: 1 })
    expect([p.x, p.y]).toEqual([22, 2])
  })

  it('invertSelf yields the true inverse (M · M⁻¹ = identity)', () => {
    const m = new DOMMatrixPolyfill([2, 1, 1, 3, 5, 7])
    const round = m.multiply(new DOMMatrixPolyfill(m).invertSelf())
    for (const [got, want] of [
      [round.a, 1], [round.b, 0], [round.c, 0], [round.d, 1], [round.e, 0], [round.f, 0]
    ]) {
      expect(got).toBeCloseTo(want, 10)
    }
  })

  it('a singular matrix inverts to NaN (matches DOMMatrix)', () => {
    const m = new DOMMatrixPolyfill([1, 2, 2, 4, 0, 0]).invertSelf() // det = 0
    expect(Number.isNaN(m.a)).toBe(true)
  })
})

describe('ensureDomMatrixPolyfill', () => {
  const hadReal = 'DOMMatrix' in globalThis
  const original = (globalThis as { DOMMatrix?: unknown }).DOMMatrix

  beforeEach(() => {
    delete (globalThis as { DOMMatrix?: unknown }).DOMMatrix
  })
  afterEach(() => {
    if (hadReal) (globalThis as { DOMMatrix?: unknown }).DOMMatrix = original
    else delete (globalThis as { DOMMatrix?: unknown }).DOMMatrix
  })

  it('installs the polyfill when none exists', () => {
    ensureDomMatrixPolyfill()
    expect((globalThis as { DOMMatrix?: unknown }).DOMMatrix).toBe(DOMMatrixPolyfill)
    // and the installed constructor actually works
    const Ctor = (globalThis as { DOMMatrix?: unknown }).DOMMatrix as unknown as typeof DOMMatrixPolyfill
    expect(toArr(new Ctor([1, 0, 0, 1, 2, 3]))).toEqual([1, 0, 0, 1, 2, 3])
  })

  it('does not override an existing (real) DOMMatrix', () => {
    class Realish {}
    ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = Realish
    ensureDomMatrixPolyfill()
    expect((globalThis as { DOMMatrix?: unknown }).DOMMatrix).toBe(Realish)
  })
})
