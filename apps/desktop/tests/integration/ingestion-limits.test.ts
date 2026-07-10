import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  processDocument,
  documentsDir,
  parseWithLimits,
  extractDocumentPreview,
  extractDocumentPreviewPage
} from '../../src/main/services/ingestion'
import {
  resolveIngestionLimits,
  withParseTimeout,
  declaredZipInflatedSize,
  DEFAULT_INGESTION_LIMITS
} from '../../src/main/services/ingestion/limits'
import { PdfParser } from '../../src/main/services/ingestion/parsers/pdf'
import { DocxParser } from '../../src/main/services/ingestion/parsers/docx'
import type {
  DocumentParser,
  ParseContext,
  ParsedDocument
} from '../../src/main/services/ingestion/parsers'
import { t } from '../../src/shared/i18n'
import { makeMixedPdf, makeDocx } from '../helpers/fixtures'

// Security audit 2026-06-13, M-1/M-2/M-3 — pre-parse resource caps. A crafted document
// must never OOM/hang the main process: a byte ceiling, a parse timeout, a PDF page cap,
// and a DOCX inflated-size ceiling all bound the work BEFORE the parser runs.

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hilbertraum-limits-'))
})
function write(name: string, data: string | Buffer): string {
  const p = join(tmp, name)
  writeFileSync(p, data)
  return p
}
function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-db-')), 'test.sqlite'))
}
function store(): string {
  return documentsDir(mkdtempSync(join(tmpdir(), 'hilbertraum-ws-')))
}

const FILE_TOO_LARGE = t('en', 'main.ingest.fileTooLarge')

describe('resolveIngestionLimits', () => {
  it('uses the documented defaults with no env overrides', () => {
    expect(resolveIngestionLimits({})).toEqual(DEFAULT_INGESTION_LIMITS)
  })

  it('applies positive-integer env overrides and ignores junk', () => {
    const limits = resolveIngestionLimits({
      HILBERTRAUM_MAX_DOC_BYTES: '1000',
      HILBERTRAUM_TEXT_MAX_BYTES: '500',
      HILBERTRAUM_PDF_MAX_PAGES: '7',
      HILBERTRAUM_PARSE_TIMEOUT_MS: 'not-a-number',
      HILBERTRAUM_DOCX_MAX_INFLATED_BYTES: '-5'
    })
    expect(limits.maxBytes).toBe(1000)
    expect(limits.textMaxBytes).toBe(500)
    expect(limits.pdfMaxPages).toBe(7)
    // Junk / non-positive values fall back to the defaults (never weaken to 0/NaN).
    expect(limits.parseTimeoutMs).toBe(DEFAULT_INGESTION_LIMITS.parseTimeoutMs)
    expect(limits.docxMaxInflatedBytes).toBe(DEFAULT_INGESTION_LIMITS.docxMaxInflatedBytes)
  })
})

describe('withParseTimeout', () => {
  it('resolves work that finishes within the budget', async () => {
    await expect(withParseTimeout(Promise.resolve(42), 1000, 'too slow')).resolves.toBe(42)
  })

  it('rejects with the supplied message when the budget elapses', async () => {
    // The 50 ms timer IS the simulated slow parse; the 1 ms budget expires first by timer-expiry
    // ordering, so the reject always wins — timeout semantics, not a sync point (TS-1).
    const slow = new Promise((resolve) => setTimeout(resolve, 50))
    await expect(withParseTimeout(slow, 1, 'too slow')).rejects.toThrow('too slow')
  })
})

describe('declaredZipInflatedSize', () => {
  it('sums the declared uncompressed sizes of a real .docx zip', () => {
    const docx = makeDocx(['hello world'])
    const size = declaredZipInflatedSize(docx)
    expect(size).not.toBeNull()
    expect(size).toBeGreaterThan(0)
    expect(Number.isFinite(size as number)).toBe(true)
  })

  it('returns null for a buffer that is not a parseable zip', () => {
    expect(declaredZipInflatedSize(Buffer.from('not a zip at all'))).toBeNull()
  })
})

describe('processDocument byte ceiling (M-1)', () => {
  it('rejects an oversized file before parsing, with friendly copy on the row', async () => {
    const db = freshDb()
    const storeDir = store()
    const src = write('big.txt', 'x'.repeat(4096))
    const queued = createQueuedDocument(db, src)
    const info = await processDocument(db, storeDir, queued.id, {
      limits: { ...DEFAULT_INGESTION_LIMITS, maxBytes: 1024 }
    })
    expect(info.status).toBe('failed')
    expect(info.errorMessage).toBe(FILE_TOO_LARGE)
  })

  it('imports a file that is within the byte ceiling', async () => {
    const db = freshDb()
    const storeDir = store()
    const src = write('ok.txt', 'small enough')
    const queued = createQueuedDocument(db, src)
    const info = await processDocument(db, storeDir, queued.id, {
      limits: { ...DEFAULT_INGESTION_LIMITS, maxBytes: 1024 }
    })
    expect(info.status).toBe('indexed')
  })
})

// PERF-4 — text/Markdown/CSV parsers read the whole file into ONE JS string (+ derived copies),
// so a near-`maxBytes` (1 GiB) file would blow V8's ~512 MB string limit and OOM-CRASH the main
// process. The string-safe `textMaxBytes` ceiling turns that into the EXISTING friendly
// `fileTooLarge` reject. Tested with a tiny injected `textMaxBytes` (no need to materialize 64 MiB):
// the cap is FORMAT-SCOPED — it bites text/CSV but not the streaming/page-bounded formats.
describe('text/CSV string-safe cap (PERF-4)', () => {
  // maxBytes stays huge; only the string-parser ceiling is tightened, so a reject here can ONLY
  // come from the format-narrowed textMaxBytes — not the generic byte ceiling.
  const TEXT_CAP = { ...DEFAULT_INGESTION_LIMITS, textMaxBytes: 100 }

  it('rejects an over-cap .txt with the friendly fileTooLarge message (no crash)', async () => {
    const db = freshDb()
    const storeDir = store()
    const queued = createQueuedDocument(db, write('big.txt', 'x'.repeat(200)))
    const info = await processDocument(db, storeDir, queued.id, { limits: TEXT_CAP })
    expect(info.status).toBe('failed')
    expect(info.errorMessage).toBe(FILE_TOO_LARGE)
  })

  it('rejects an over-cap .csv with the friendly fileTooLarge message (no crash)', async () => {
    const db = freshDb()
    const storeDir = store()
    const queued = createQueuedDocument(db, write('big.csv', `name,value\n${'a,1\n'.repeat(80)}`))
    const info = await processDocument(db, storeDir, queued.id, { limits: TEXT_CAP })
    expect(info.status).toBe('failed')
    expect(info.errorMessage).toBe(FILE_TOO_LARGE)
  })

  it('still imports a text file UNDER the string-safe cap', async () => {
    const db = freshDb()
    const storeDir = store()
    const queued = createQueuedDocument(db, write('ok.txt', 'plenty of room under one hundred bytes'))
    const info = await processDocument(db, storeDir, queued.id, { limits: TEXT_CAP })
    expect(info.status).toBe('indexed')
  })

  it('does NOT apply the text cap to a non-string format (PDF keeps the full maxBytes)', async () => {
    const db = freshDb()
    const storeDir = store()
    // A real PDF is comfortably larger than the 100-byte TEXT_CAP, yet PDF is page-bounded (not a
    // whole-file-to-string parser), so it must NOT be rejected for size — proving the cap is
    // format-scoped, not a global tightening of maxBytes.
    const pdf = write('doc.pdf', makeMixedPdf([{ kind: 'text', lines: ['Real readable PDF body text content here.'] }]))
    expect(statSync(pdf).size).toBeGreaterThan(TEXT_CAP.textMaxBytes)
    const queued = createQueuedDocument(db, pdf)
    const info = await processDocument(db, storeDir, queued.id, { limits: TEXT_CAP })
    expect(info.status).toBe('indexed')
  })
})

describe('PdfParser page cap (M-2)', () => {
  it('walks at most maxPages pages of a multi-page PDF', async () => {
    const pdf = write(
      'multi.pdf',
      makeMixedPdf([
        { kind: 'text', lines: ['Page one has plenty of real text content here.'] },
        { kind: 'text', lines: ['Page two also has real text content to extract.'] },
        { kind: 'text', lines: ['Page three would be indexed without the cap.'] }
      ])
    )
    const capped = await PdfParser.parse(pdf, { maxPages: 2 })
    expect(capped.segments).toHaveLength(2)
    const uncapped = await PdfParser.parse(pdf)
    expect(uncapped.segments).toHaveLength(3)
  })
})

describe('DocxParser inflated-size ceiling (M-3)', () => {
  it('throws friendly copy when declared inflation exceeds maxInflatedBytes', async () => {
    const docx = write('bomb.docx', makeDocx(['some body text that inflates']))
    await expect(DocxParser.parse(docx, { maxInflatedBytes: 1 })).rejects.toThrow(FILE_TOO_LARGE)
  })

  it('parses a normal DOCX under a generous ceiling', async () => {
    const docx = write('fine.docx', makeDocx(['a normal paragraph']))
    const out = await DocxParser.parse(docx, { maxInflatedBytes: DEFAULT_INGESTION_LIMITS.docxMaxInflatedBytes })
    expect(out.segments.map((s) => s.text).join(' ')).toContain('normal paragraph')
  })
})

// MAINT-4 / REL-5 — the ONE cap-enforcement decorator. Every parse entry point (ingest +
// both preview readers) routes through `parseWithLimits`, so the cap stack can never silently
// diverge per path again. A fake parser lets us prove the decorator's contract in isolation.
function fakeParser(
  impl: (source: string, ctx?: ParseContext) => Promise<ParsedDocument>
): DocumentParser {
  return { name: 'Fake', extensions: ['.fake'], mimeType: 'text/fake', parse: impl }
}

describe('parseWithLimits (MAINT-4/REL-5)', () => {
  it('injects maxPages/maxInflatedBytes from limits onto the parse context', async () => {
    let seen: ParseContext | undefined
    const parser = fakeParser(async (_s, ctx) => {
      seen = ctx
      return { segments: [], mimeType: 'text/fake' }
    })
    await parseWithLimits(
      parser,
      'doc.txt',
      { ocrEngine: null },
      { ...DEFAULT_INGESTION_LIMITS, pdfMaxPages: 11, docxMaxInflatedBytes: 22 }
    )
    expect(seen?.maxPages).toBe(11)
    expect(seen?.maxInflatedBytes).toBe(22)
  })

  it('lets a caller-set context cap win over the limits default (the layout seam)', async () => {
    let seen: ParseContext | undefined
    const parser = fakeParser(async (_s, ctx) => {
      seen = ctx
      return { segments: [], mimeType: 'text/fake' }
    })
    await parseWithLimits(
      parser,
      'doc.txt',
      { maxPages: 3 },
      { ...DEFAULT_INGESTION_LIMITS, pdfMaxPages: 5000 }
    )
    expect(seen?.maxPages).toBe(3)
  })

  it('rejects a wedged non-audio parse on the wall-clock timeout instead of hanging', async () => {
    const parser = fakeParser(() => new Promise<ParsedDocument>(() => {})) // never resolves
    await expect(
      parseWithLimits(parser, 'doc.txt', {}, { ...DEFAULT_INGESTION_LIMITS, parseTimeoutMs: 20 }, 'timed out')
    ).rejects.toThrow('timed out')
  })

  it('exempts audio from the wall-clock timeout (a long transcription is not killed)', async () => {
    const parser = fakeParser(async () => {
      // The 40 ms IS the simulated long transcription outlasting the 5 ms budget below —
      // timeout semantics, not a sync point (TS-1).
      await new Promise((r) => setTimeout(r, 40))
      return { segments: [{ text: 'hi' }], mimeType: 'audio/wav' }
    })
    // Timeout is 5 ms but the audio "parse" takes 40 ms — audio is exempt, so it still resolves.
    const out = await parseWithLimits(
      parser,
      'rec.wav',
      {},
      { ...DEFAULT_INGESTION_LIMITS, parseTimeoutMs: 5 },
      'timed out'
    )
    expect(out.segments[0].text).toBe('hi')
  })

  it('carries the abort signal and other caller-set fields through to the parser', async () => {
    const ac = new AbortController()
    let seen: ParseContext | undefined
    // rec.wav (audio) keeps it out of the timeout wrapper so we test pure pass-through.
    const parser = fakeParser(async (_s, ctx) => {
      seen = ctx
      return { segments: [], mimeType: 'audio/wav' }
    })
    await parseWithLimits(parser, 'rec.wav', { signal: ac.signal, workDir: '/w' }, DEFAULT_INGESTION_LIMITS)
    expect(seen?.signal).toBe(ac.signal)
    expect(seen?.workDir).toBe('/w')
  })
})

describe('preview path cap stack (REL-5)', () => {
  const threePagePdf = (): Buffer =>
    makeMixedPdf([
      { kind: 'text', lines: ['Page one has real readable content here.'] },
      { kind: 'text', lines: ['Page two also has real readable content.'] },
      { kind: 'text', lines: ['Page three would appear without the cap.'] }
    ])

  it('caps the preview re-parse at maxPages — formerly the preview ran uncapped', async () => {
    const db = freshDb()
    const storeDir = store()
    const q = createQueuedDocument(db, write('multi.pdf', threePagePdf()))
    await processDocument(db, storeDir, q.id) // generous default limits → all 3 pages indexed
    const capped = await extractDocumentPreview(db, storeDir, q.id, {}, {
      limits: { ...DEFAULT_INGESTION_LIMITS, pdfMaxPages: 2 }
    })
    expect(capped.segments).toHaveLength(2)
    // The default (generous) preview still returns all three — proves a cap, not a parse failure.
    const all = await extractDocumentPreview(db, storeDir, q.id)
    expect(all.segments).toHaveLength(3)
  })

  it('enforces maxInflatedBytes on a DOCX preview', async () => {
    const db = freshDb()
    const storeDir = store()
    const q = createQueuedDocument(db, write('doc.docx', makeDocx(['a paragraph that inflates past one byte'])))
    await processDocument(db, storeDir, q.id)
    await expect(
      extractDocumentPreview(db, storeDir, q.id, {}, {
        limits: { ...DEFAULT_INGESTION_LIMITS, docxMaxInflatedBytes: 1 }
      })
    ).rejects.toThrow(FILE_TOO_LARGE)
  })

  it('extractDocumentPreviewPage enforces the cap on every page request', async () => {
    const db = freshDb()
    const storeDir = store()
    const q = createQueuedDocument(db, write('multi.pdf', threePagePdf()))
    await processDocument(db, storeDir, q.id)
    const page = await extractDocumentPreviewPage(db, storeDir, q.id, 0, 50, {}, {
      limits: { ...DEFAULT_INGESTION_LIMITS, pdfMaxPages: 2 }
    })
    // The whole-document re-parse is bounded to 2 pages → the reported total reflects the cap, not 3.
    expect(page.totalSegments).toBe(2)
    expect(page.segments).toHaveLength(2)
  })
})
