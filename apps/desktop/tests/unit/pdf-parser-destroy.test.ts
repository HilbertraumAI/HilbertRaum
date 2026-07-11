import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// GAP-3 (full-audit 2026-07-11): `PdfParser` used to await `loadingTask.promise` BEFORE the
// try/finally that destroys the loading task — a document that fails to OPEN (corrupt/password
// PDF) leaked the pdf.js transport state + up to `maxBytes` of buffer on every failed parse.
// The await now sits inside the try, so the finally's `loadingTask.destroy()` always runs.
//
// DEDICATED file for the module mock (the Phase-B workspace-vault-durability template): pdfjs is
// the external boundary here — the mock observes the destroy() call the real library gives us no
// seam for. The happy-path/scan-detection behavior stays covered by the real-pdfjs ingestion tests.

const { destroy, getDocument } = vi.hoisted(() => {
  const destroy = vi.fn(async () => {})
  return {
    destroy,
    getDocument: vi.fn(() => ({
      // The open itself fails — the corrupt/password-PDF shape.
      promise: Promise.reject(new Error('corrupt PDF')),
      destroy
    }))
  }
})

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument }))

import { PdfParser } from '../../src/main/services/ingestion/parsers/pdf'

describe('PdfParser — the loading task is destroyed when the document fails to OPEN (GAP-3)', () => {
  it('a corrupt buffer rejects AND destroy() ran (no leaked transport/buffer)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hilbertraum-pdfdestroy-')), 'corrupt.pdf')
    writeFileSync(file, 'not a pdf at all')

    await expect(PdfParser.parse(file)).rejects.toThrow(/corrupt PDF/)
    expect(getDocument).toHaveBeenCalledTimes(1)
    // Pre-fix the open await sat before the try/finally, so destroy() was never reached.
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})
