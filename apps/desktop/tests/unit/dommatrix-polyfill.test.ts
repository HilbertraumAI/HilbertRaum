import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureDomMatrixPolyfill } from '../../src/main/services/ingestion/parsers/dommatrix-polyfill'
import { makeType3MaskGlyphPdf } from '../helpers/fixtures'

// Guards the "DOMMatrix is not defined" PDF-import failure from a packaged drive. pdfjs-dist 6.0–6.2
// evaluated `new DOMMatrix()` at import time (6.3+ does it lazily). In Node it only polyfills one from
// `@napi-rs/canvas`, which we exclude from the bundle. The parser installs this pure-JS matrix first, so
// pdf.js uses it in the main process, including pdf.js 6.4's Type3 glyph compiler (`scaleSelf` →
// `translateSelf`). These tests pin (a) the install contract, (b) the math of exactly the members that
// compiler calls, and (c) that pdf.js really compiles a glyph on it (#687).

interface Matrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
  scaleSelf(sx?: number, sy?: number): Matrix
  translateSelf(tx?: number, ty?: number): Matrix
}
type MatrixCtor = new () => Matrix

const g = globalThis as { DOMMatrix?: unknown }
const hadReal = 'DOMMatrix' in globalThis
const original = g.DOMMatrix

beforeEach(() => {
  delete g.DOMMatrix
})
afterEach(() => {
  if (hadReal) g.DOMMatrix = original
  else delete g.DOMMatrix
})

/** The constructor `ensureDomMatrixPolyfill` installs on a global with none. */
function installed(): MatrixCtor {
  ensureDomMatrixPolyfill()
  return g.DOMMatrix as MatrixCtor
}

function toArr(m: Matrix): number[] {
  return [m.a, m.b, m.c, m.d, m.e, m.f]
}

describe('ensureDomMatrixPolyfill', () => {
  it('installs a DOMMatrix when none exists, and a second call keeps it', () => {
    const Ctor = installed()
    expect(typeof Ctor).toBe('function')
    ensureDomMatrixPolyfill()
    expect(g.DOMMatrix).toBe(Ctor)
  })

  it('does not override an existing (real) DOMMatrix', () => {
    class Realish {}
    g.DOMMatrix = Realish
    ensureDomMatrixPolyfill()
    expect(g.DOMMatrix).toBe(Realish)
  })
})

describe('the installed DOMMatrix — the members pdf.js 6.4 calls in the main process', () => {
  it('constructs the identity, and the in-place scaleSelf → translateSelf chain composes like DOMMatrix', () => {
    const Ctor = installed()
    expect(toArr(new Ctor())).toEqual([1, 0, 0, 1, 0, 0])
    // pdf.js 6.4 runs exactly this chain in the MAIN process (compileType3Glyph in legacy/build/pdf.worker.mjs,
    // reached by getTextContent/getOperatorList on a Type3 image-mask font; Node runs pdf.js's worker in-process,
    // on this polyfill) and reads a–f off the result. Post-multiplied, as DOMMatrix does: w = 4, h = 2, so the
    // translation is scaled (f = −0.5 · −2 = 1), not added raw (−2).
    expect(toArr(new Ctor().scaleSelf(1 / 4, -1 / 2).translateSelf(0, -2))).toEqual([0.25, 0, 0, -0.5, 0, 1])
    // The other order: a scale after a translation leaves the translation alone (pre-multiplying would
    // scale it to 10, 21).
    expect(toArr(new Ctor().translateSelf(5, 7).scaleSelf(2, 3))).toEqual([2, 0, 0, 3, 5, 7])
    // scaleSelf's second factor defaults to the first, as in DOMMatrix.
    expect(toArr(new Ctor().scaleSelf(2))).toEqual([2, 0, 0, 2, 0, 0])
  })
})

// The polyfill under REAL pdf.js 6.4 (#687). getTextContent loads every font a page sets; loading a Type3
// font compiles its glyphs, and a glyph that paints an image mask goes through compileType3Glyph — so plain
// text extraction is NOT independent of the global DOMMatrix. pdf.js catches a per-glyph failure and only
// WARNS, and PdfParser passes `verbosity: 0`, so a PdfParser text test cannot tell a working polyfill from a
// broken one: this drives pdf.js directly at verbosity 1 and keys on the warning.
describe('the installed DOMMatrix under pdf.js 6.4 — a Type3 image-mask glyph during getTextContent (#687)', () => {
  const LINE = 'A page whose second line is set in a Type3 font'
  const GLYPH_FAILED = 'Warning: Type3 font resource "A" is not available.'

  /** Extract page 1's text with `install` providing the global DOMMatrix; returns the text + pdf.js's warnings. */
  async function extract(install: () => void): Promise<{ text: string; warnings: string[] }> {
    // pdf.js's first import installs `@napi-rs/canvas`'s DOMMatrix (present in dev) on an empty global, so
    // empty it again after the import: the glyph compiler must meet only what `install` provides.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    delete g.DOMMatrix
    install()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const task = pdfjs.getDocument({ data: new Uint8Array(makeType3MaskGlyphPdf(LINE)), verbosity: 1 })
    try {
      const content = await (await (await task.promise).getPage(1)).getTextContent()
      return {
        text: content.items.map((i) => ('str' in i ? i.str : '')).join(''),
        warnings: warn.mock.calls.map((args) => String(args[0]))
      }
    } finally {
      warn.mockRestore()
      await task.destroy()
    }
  }

  it('compiles the glyph on the polyfill: the text arrives and pdf.js reports no failed glyph', async () => {
    const { text, warnings } = await extract(ensureDomMatrixPolyfill)
    expect(text).toContain(LINE)
    expect(warnings.filter((w) => w.includes('Type3'))).toEqual([])
  })

  it('control: a constructor-only DOMMatrix fails the same glyph and pdf.js warns (why the members above stay)', async () => {
    const { text, warnings } = await extract(() => {
      g.DOMMatrix = class {
        a = 1
        b = 0
        c = 0
        d = 1
        e = 0
        f = 0
      }
    })
    // The text still arrives — which is why only the warning can tell.
    expect(text).toContain(LINE)
    expect(warnings).toContain(GLYPH_FAILED)
  })
})
