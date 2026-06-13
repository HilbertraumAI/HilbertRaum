import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  processDocument,
  reindexDocument,
  deleteDocument,
  extractDocumentPreview,
  listDocuments,
  reconcileStuckDocuments,
  expandPaths,
  documentsDir
} from '../../src/main/services/ingestion'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import { selectParser } from '../../src/main/services/ingestion/parsers'
import { TxtParser } from '../../src/main/services/ingestion/parsers/txt'
import { MarkdownParser } from '../../src/main/services/ingestion/parsers/markdown'
import { CsvParser } from '../../src/main/services/ingestion/parsers/csv'
import { PdfParser } from '../../src/main/services/ingestion/parsers/pdf'
import { DocxParser } from '../../src/main/services/ingestion/parsers/docx'
import { makePdf, makeDocx } from '../helpers/fixtures'

let tmp: string
function dir(): string {
  return tmp
}
function write(name: string, data: string | Buffer): string {
  const p = join(tmp, name)
  writeFileSync(p, data)
  return p
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hilbertraum-ingest-'))
})

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-db-')), 'test.sqlite'))
}
function store(): string {
  // A workspace 'documents' dir for stored copies.
  return documentsDir(mkdtempSync(join(tmpdir(), 'hilbertraum-ws-')))
}

// ---- Parser unit coverage --------------------------------------------------------

describe('parser registry', () => {
  it('selects parsers by extension and returns null for unsupported types', () => {
    expect(selectParser('a.txt')?.name).toBe('TxtParser')
    expect(selectParser('A.MD')?.name).toBe('MarkdownParser')
    expect(selectParser('x.pdf')?.name).toBe('PdfParser')
    expect(selectParser('x.docx')?.name).toBe('DocxParser')
    expect(selectParser('data.csv')?.name).toBe('CsvParser')
    expect(selectParser('image.png')?.name).toBe('image') // photos OCR on import (Phase 38)
    expect(selectParser('blob.xyz')).toBeNull()
  })
})

describe('TxtParser', () => {
  it('reads the whole file as one segment', async () => {
    const p = write('a.txt', 'hello world\nsecond line')
    const out = await TxtParser.parse(p)
    expect(out.mimeType).toBe('text/plain')
    expect(out.segments).toHaveLength(1)
    expect(out.segments[0].text).toContain('second line')
  })
})

describe('MarkdownParser', () => {
  it('splits into sections by heading and labels each segment', async () => {
    const md = ['Intro line', '', '# Title', 'body a', '', '## Sub', 'body b'].join('\n')
    const p = write('a.md', md)
    const out = await MarkdownParser.parse(p)
    const labels = out.segments.map((s) => s.sectionLabel)
    expect(labels).toEqual([null, 'Title', 'Sub'])
    expect(out.segments[1].text).toContain('body a')
    expect(out.segments[2].text).toContain('body b')
  })
})

describe('CsvParser', () => {
  it('renders rows as header: value lines', async () => {
    const p = write('a.csv', 'name,role\nAda,Engineer\nGrace,Admiral')
    const out = await CsvParser.parse(p)
    expect(out.mimeType).toBe('text/csv')
    expect(out.segments).toHaveLength(1)
    expect(out.segments[0].text).toContain('name: Ada')
    expect(out.segments[0].text).toContain('role: Admiral')
  })
})

describe('PdfParser', () => {
  it('extracts text with a page number from a real PDF', async () => {
    const p = write('a.pdf', makePdf('Hello PDF World with enough readable words on the page'))
    const out = await PdfParser.parse(p)
    expect(out.mimeType).toBe('application/pdf')
    expect(out.segments.length).toBeGreaterThanOrEqual(1)
    expect(out.segments[0].pageNumber).toBe(1)
    expect(out.segments[0].text).toContain('Hello PDF World')
  })
})

describe('DocxParser', () => {
  it('extracts paragraph text from a real .docx', async () => {
    const p = write('a.docx', makeDocx(['First paragraph.', 'Second paragraph.']))
    const out = await DocxParser.parse(p)
    expect(out.segments.map((s) => s.text)).toEqual(['First paragraph.', 'Second paragraph.'])
  })
})

// ---- Pipeline + status tracking --------------------------------------------------

describe('ingestion pipeline', () => {
  it('takes a txt file to indexed, copies it into the workspace, and stores chunks', async () => {
    const db = freshDb()
    const storeDir = store()
    const src = write('notes.txt', Array.from({ length: 1200 }, (_, i) => `word${i}`).join(' '))

    const queued = createQueuedDocument(db, src)
    expect(queued.status).toBe('queued')
    expect(queued.originalPath).toBe(src)

    const info = await processDocument(db, storeDir, queued.id)
    expect(info.status).toBe('indexed')
    expect(info.chunkCount).toBeGreaterThan(1)
    expect(info.mimeType).toBe('text/plain')

    // The original was copied into the workspace store (self-contained drive).
    const row = db.prepare('SELECT stored_path, sha256 FROM documents WHERE id = ?').get(queued.id) as {
      stored_path: string
      sha256: string
    }
    expect(existsSync(row.stored_path)).toBe(true)
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/)

    // Chunks carry the document title as their source label.
    const chunk = db
      .prepare('SELECT source_label, token_count, chunk_index FROM chunks WHERE document_id = ? ORDER BY chunk_index LIMIT 1')
      .get(queued.id) as { source_label: string; token_count: number; chunk_index: number }
    expect(chunk.source_label).toBe('notes.txt')
    expect(chunk.chunk_index).toBe(0)
    expect(chunk.token_count).toBeGreaterThan(0)
  })

  it('records per-page metadata on chunks from a PDF', async () => {
    const db = freshDb()
    const storeDir = store()
    const src = write('doc.pdf', makePdf('Page one content here with plenty of readable words'))
    const queued = createQueuedDocument(db, src)
    const info = await processDocument(db, storeDir, queued.id)
    expect(info.status).toBe('indexed')
    const chunk = db.prepare('SELECT page_number FROM chunks WHERE document_id = ? LIMIT 1').get(queued.id) as {
      page_number: number
    }
    expect(chunk.page_number).toBe(1)
  })

  it('marks a corrupt PDF as failed with an error message instead of crashing', async () => {
    const db = freshDb()
    const storeDir = store()
    const src = write('broken.pdf', 'this is not a real pdf at all')
    const queued = createQueuedDocument(db, src)
    const info = await processDocument(db, storeDir, queued.id)
    expect(info.status).toBe('failed')
    expect(info.errorMessage).toBeTruthy()
    // No chunks were left behind by the failed run.
    expect(info.chunkCount).toBe(0)
  })

  it('marks an unsupported file type as failed', async () => {
    const db = freshDb()
    const storeDir = store()
    const src = write('data.xyz', 'binary-ish')
    const queued = createQueuedDocument(db, src)
    const info = await processDocument(db, storeDir, queued.id)
    expect(info.status).toBe('failed')
    expect(info.errorMessage).toContain('Unsupported file type')
  })

  it('re-indexes a document, replacing its chunks', async () => {
    const db = freshDb()
    const storeDir = store()
    const src = write('r.txt', 'alpha beta gamma delta')
    const queued = createQueuedDocument(db, src)
    await processDocument(db, storeDir, queued.id)
    const before = listDocuments(db)[0].chunkCount
    const reindexed = await reindexDocument(db, storeDir, queued.id)
    expect(reindexed.status).toBe('indexed')
    expect(reindexed.chunkCount).toBe(before)
    // Exactly one set of chunks remains (no duplication).
    const n = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?').get(queued.id) as {
      n: number
    }
    expect(n.n).toBe(before)
  })

  it('deletes a document, its chunks, and the workspace copy', async () => {
    const db = freshDb()
    const storeDir = store()
    const src = write('d.txt', 'one two three')
    const queued = createQueuedDocument(db, src)
    await processDocument(db, storeDir, queued.id)
    const stored = (db.prepare('SELECT stored_path FROM documents WHERE id = ?').get(queued.id) as {
      stored_path: string
    }).stored_path
    expect(existsSync(stored)).toBe(true)

    deleteDocument(db, queued.id)
    expect(listDocuments(db)).toHaveLength(0)
    expect(existsSync(stored)).toBe(false)
    const n = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?').get(queued.id) as {
      n: number
    }
    expect(n.n).toBe(0)
  })
})

describe('reconcileStuckDocuments', () => {
  it('fails documents left non-terminal by a previous run, sparing live ones', () => {
    const db = freshDb()
    const status = (id: string): string =>
      (db.prepare('SELECT status FROM documents WHERE id = ?').get(id) as { status: string }).status

    const stuck = createQueuedDocument(db, write('s.txt', 'x'))
    // Simulate a crash mid-ingestion in a PREVIOUS run: non-terminal + an old timestamp.
    db.prepare("UPDATE documents SET status = 'extracting', updated_at = ? WHERE id = ?").run(
      '2000-01-01T00:00:00.000Z',
      stuck.id
    )
    // A live row from THIS run keeps its fresh (now) timestamp.
    const live = createQueuedDocument(db, write('l.txt', 'y'))
    db.prepare("UPDATE documents SET status = 'embedding' WHERE id = ?").run(live.id)

    const n = reconcileStuckDocuments(db, '2020-01-01T00:00:00.000Z')
    expect(n).toBe(1)
    expect(status(stuck.id)).toBe('failed')
    expect(status(live.id)).toBe('embedding') // spared (updated after the cutoff)
  })
})

describe('listDocuments stale-embedding flag', () => {
  it('flags indexed docs whose vectors were produced by a different embedder', async () => {
    const db = freshDb()
    const storeDir = store()
    const embedder = createMockEmbedder()
    const src = write('e.txt', 'alpha beta gamma delta epsilon zeta')
    const q = createQueuedDocument(db, src)
    await processDocument(db, storeDir, q.id, { embedder, embeddingModelId: embedder.id })

    // Active model matches the vectors → not stale.
    expect(listDocuments(db, embedder.id)[0].staleEmbeddings).toBe(false)
    // Active model differs → stale (search is scoped by model id, so it can't find it).
    expect(listDocuments(db, 'some-other-model')[0].staleEmbeddings).toBe(true)
    // No active-model context → not evaluated.
    expect(listDocuments(db)[0].staleEmbeddings).toBeUndefined()
  })
})

// Post-MVP: the read-only in-app preview re-parses the stored copy (chunks overlap, so
// concatenating them would duplicate text at every boundary).
describe('extractDocumentPreview', () => {
  it('returns the parsed segments from the stored copy with page/section labels', async () => {
    const db = freshDb()
    const storeDir = store()
    const src = write('notes.md', '# Intro\nalpha beta\n\n# Details\ngamma delta')
    const q = createQueuedDocument(db, src)
    await processDocument(db, storeDir, q.id)

    const preview = await extractDocumentPreview(db, storeDir, q.id)
    expect(preview.title).toBe('notes.md')
    expect(preview.segments.length).toBeGreaterThanOrEqual(2)
    expect(preview.segments.map((s) => s.sectionLabel)).toContain('Details')
    expect(preview.segments.map((s) => s.text).join('\n')).toContain('gamma delta')
  })

  it('falls back to the original file when the stored copy is gone, and errors when both are', async () => {
    const db = freshDb()
    const storeDir = store()
    const src = write('plain.txt', 'still here')
    const q = createQueuedDocument(db, src)
    // Never processed → no stored copy yet; preview reads the original.
    const preview = await extractDocumentPreview(db, storeDir, q.id)
    expect(preview.segments[0].text).toContain('still here')

    rmSync(src)
    await expect(extractDocumentPreview(db, storeDir, q.id)).rejects.toThrow(/no longer on disk/)
  })

  it('throws on an unknown document id', async () => {
    await expect(extractDocumentPreview(freshDb(), store(), 'nope')).rejects.toThrow(/Unknown document/)
  })
})

describe('expandPaths', () => {
  it('walks folders for supported files and always includes explicitly-picked files', () => {
    const sub = join(dir(), 'sub')
    mkdirSync(sub)
    write('top.txt', 'x')
    write('ignore.xyz', 'x')
    writeFileSync(join(sub, 'nested.md'), '# h')
    const explicit = write('explicit.xyz', 'x') // unsupported but explicitly chosen

    const files = expandPaths([dir(), explicit])
    // Folder walk keeps supported files only; the explicit png is still included.
    expect(files.some((f) => f.endsWith('top.txt'))).toBe(true)
    expect(files.some((f) => f.endsWith('nested.md'))).toBe(true)
    expect(files.filter((f) => f.endsWith('ignore.xyz'))).toHaveLength(0)
    expect(files.filter((f) => f.endsWith('explicit.xyz'))).toHaveLength(1)
  })
})
