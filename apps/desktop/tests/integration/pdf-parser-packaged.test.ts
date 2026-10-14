import Module from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PDF_SCAN_DETECTED_MESSAGE, PdfParser } from '../../src/main/services/ingestion/parsers/pdf'
import { makeMixedPdf, makePdf, makeScanOnlyPdf } from '../helpers/fixtures'

// #685: PdfParser as it runs in the PACKAGED main process, where `@napi-rs/canvas` cannot load
// (electron-builder.yml excludes it). Every other PDF test runs where npm installed that optional
// dependency of pdfjs-dist, so pdf.js fills in what it lacks from the native Skia addon there and a
// main-process path that needs the addon would pass CI and fail only on a built drive, which is how
// 6.0–6.2's "DOMMatrix is not defined" import failure shipped. pdf.js `require`s the addon at its first
// import whatever the app does (legacy/build/pdf.mjs, src/display/node_utils.js), so this file makes it
// unresolvable before that import. It relies on the fork pool giving each test file its own process,
// which the first precondition below checks.

const g = globalThis as { DOMMatrix?: unknown; Path2D?: unknown }
const resolver = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string }
const realResolve = resolver._resolveFilename
const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-pdf-packaged-'))

function writePdf(name: string, bytes: Buffer): string {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

let firstImportWarnings: string[] = []
let firstParse: Awaited<ReturnType<typeof PdfParser.parse>>

beforeAll(async () => {
  // A process that already loaded pdf.js with the addon would carry Skia's Path2D (Node has none).
  expect(g.Path2D, 'this file must be the first to load pdf.js in its process').toBeUndefined()
  expect(g.DOMMatrix).toBeUndefined()
  resolver._resolveFilename = function (request: string, ...rest: unknown[]): string {
    if (/^@napi-rs\/canvas(-|$)/.test(request)) {
      throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' })
    }
    return realResolve.call(this, request, ...rest)
  }
  // pdf.js prints its load-time warnings before any `getDocument({ verbosity: 0 })` can silence them.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    firstParse = await PdfParser.parse(writePdf('letter.pdf', makePdf('Heizkosten 1.234,56 EUR netto')))
    firstImportWarnings = warn.mock.calls.map((args) => String(args[0]))
  } finally {
    warn.mockRestore()
  }
})

afterAll(() => {
  resolver._resolveFilename = realResolve
})

describe('PdfParser without @napi-rs/canvas — the packaged main process (#685)', () => {
  it('pdf.js loads on the pure-JS DOMMatrix and misses only the canvas and Path2D', () => {
    expect(firstParse.segments).toEqual([{ text: 'Heizkosten 1.234,56 EUR netto', pageNumber: 1 }])
    // The parser's DOMMatrix is the one in place: the polyfill refuses an init, which Skia's accepts.
    // Without the install there would be none at all; installed after pdf.js loaded, pdf.js would have
    // warned `Cannot polyfill \`DOMMatrix\`` on its way, a third line in the list below.
    const Matrix = g.DOMMatrix as new (init?: unknown) => unknown
    expect(() => new Matrix([1, 0, 0, 1, 0, 0])).toThrow('only `new DOMMatrix()` is supported')
    expect(g.Path2D).toBeUndefined()
    // Exactly what pdf.js could not fill in. A pdf.js bump that needs more from the addon adds a line
    // here; one that stops requiring it drops the first (then the comments in dommatrix-polyfill.ts,
    // pdf.ts and electron-builder.yml need the same correction).
    expect(firstImportWarnings.filter((w) => w.includes('Cannot')).map((w) => w.split(':')[1]!.trim())).toEqual([
      'Cannot load "@napi-rs/canvas" package',
      'Cannot polyfill `Path2D`, rendering may be broken.'
    ])
  })

  it('a scan is detected, and a text PDF’s scanned pages are found (#575), with no addon', async () => {
    await expect(PdfParser.parse(writePdf('scan.pdf', makeScanOnlyPdf(2)))).rejects.toThrow(PDF_SCAN_DETECTED_MESSAGE)
    const letter = writePdf(
      'mixed.pdf',
      makeMixedPdf([
        { kind: 'text', lines: ['Dear customer, this letter confirms your annual statement.'] },
        { kind: 'image' },
        { kind: 'blank' }
      ])
    )
    expect((await PdfParser.parse(letter, { detectScannedPages: true })).scannedPages).toEqual([2])
  })
})
