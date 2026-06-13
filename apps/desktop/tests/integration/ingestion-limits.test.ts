import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import { createQueuedDocument, processDocument, documentsDir } from '../../src/main/services/ingestion'
import {
  resolveIngestionLimits,
  withParseTimeout,
  declaredZipInflatedSize,
  DEFAULT_INGESTION_LIMITS
} from '../../src/main/services/ingestion/limits'
import { PdfParser } from '../../src/main/services/ingestion/parsers/pdf'
import { DocxParser } from '../../src/main/services/ingestion/parsers/docx'
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
      HILBERTRAUM_PDF_MAX_PAGES: '7',
      HILBERTRAUM_PARSE_TIMEOUT_MS: 'not-a-number',
      HILBERTRAUM_DOCX_MAX_INFLATED_BYTES: '-5'
    })
    expect(limits.maxBytes).toBe(1000)
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
