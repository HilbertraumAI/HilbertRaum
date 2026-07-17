import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  processDocument,
  reindexDocument,
  deleteDocument,
  extractDocumentPreview,
  extractDocumentPreviewPage,
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

// `save-export.ts` (the export side of the F-22/F-10 round-trip tests below) imports electron at module
// top; on CI the electron binary is absent — mock the transport like save-export-bom.test.ts does.
// `bomFor` itself is pure.
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showSaveDialog: async () => ({ canceled: true }) }
}))
import { bomFor } from '../../src/main/ipc/save-export'

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

  // RAG-N4: `#` lines INSIDE a fenced code block are code (shell comments, C `#define`, diff
  // hunks), not headings. Without fence tracking they split the block + stamp bogus sectionLabels.
  it('does not treat `#` lines inside a fenced code block as headings (RAG-N4)', async () => {
    const md = [
      '# Real Heading',
      'intro prose',
      '',
      '```sh',
      '# this is a shell comment, not a heading',
      'echo hi',
      '#define NOT_A_HEADING 1',
      '```',
      'more prose after the fence'
    ].join('\n')
    const p = write('fenced.md', md)
    const out = await MarkdownParser.parse(p)
    // Exactly ONE section ("Real Heading"); the fenced `#` lines do not fragment it.
    expect(out.segments).toHaveLength(1)
    expect(out.segments[0].sectionLabel).toBe('Real Heading')
    // The whole fenced block (incl. its `#` lines) stays inside that one segment.
    expect(out.segments[0].text).toContain('# this is a shell comment')
    expect(out.segments[0].text).toContain('#define NOT_A_HEADING 1')
    expect(out.segments[0].text).toContain('more prose after the fence')
  })

  // RAG-N4: a tilde fence behaves the same, and a heading AFTER a closed fence still splits.
  it('still splits on a real heading after a closed ~~~ fence (RAG-N4 — no over-suppression)', async () => {
    const md = ['# One', '~~~', '# not a heading', '~~~', '# Two', 'tail'].join('\n')
    const p = write('tilde.md', md)
    const out = await MarkdownParser.parse(p)
    expect(out.segments.map((s) => s.sectionLabel)).toEqual(['One', 'Two'])
    expect(out.segments[0].text).toContain('# not a heading')
  })

  // F-22 (audit 2026-07-16): a leading UTF-8 BOM (kept by `readFile(..,'utf8')`) made line 1 read
  // '\uFEFF# Title', which fails the `^`-anchored HEADING regex — the document's FIRST heading lost
  // section detection and merged into the label-less preamble. Self-inflicted on round-trip: the app's
  // own .md exports prepend the BOM via `bomFor` (P4), so this replays an export→re-import with the
  // REAL export prefix. BOM-writing editors (Notepad UTF-8-with-BOM) hit the same path.
  it("detects the FIRST heading of a BOM'd file — the app-export round-trip (F-22)", async () => {
    const transcript = ['# My Chat', 'hello there', '', '## Sub', 'body b'].join('\n')
    expect(bomFor('exported.md')).toBe('\uFEFF') // the exact prefix saveTextExport writes
    const p = write('exported.md', bomFor('exported.md') + transcript)
    const out = await MarkdownParser.parse(p)
    expect(out.segments.map((s) => s.sectionLabel)).toEqual(['My Chat', 'Sub'])
    // The invisible U+FEFF must not survive into the first chunkable segment either.
    expect(out.segments[0].text.charCodeAt(0)).not.toBe(0xfeff)
  })
})

describe('TxtParser — BOM handling (F-22)', () => {
  it('strips a single leading BOM from the segment text', async () => {
    const p = write('noted.txt', '\uFEFF' + 'plain note text')
    const out = await TxtParser.parse(p)
    expect(out.segments[0].text).toBe('plain note text')
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

  // BL-5: a data row WIDER than the header used to drop its overflow cells (header.map only),
  // losing content silently — unsearchable, no failure signal. Now every overflow cell rides
  // along under a generated `colN` label.
  it('keeps cells in rows wider than the header (BL-5 — no silent truncation)', async () => {
    const p = write('ragged.csv', 'name,role\nAda,Engineer,extra-note,second-extra')
    const out = await CsvParser.parse(p)
    const text = out.segments[0].text
    expect(text).toContain('name: Ada')
    expect(text).toContain('role: Engineer')
    // The two cells beyond the 2-column header are labelled colN (1-based), not dropped.
    expect(text).toContain('col3: extra-note')
    expect(text).toContain('col4: second-extra')
  })

  // The narrower-than-header case is unchanged: a named column with no value still reads as
  // "Header: " (so a sparse row keeps its column structure).
  it('still emits empty named columns for a row narrower than the header', async () => {
    const p = write('narrow.csv', 'name,role,team\nAda,Engineer')
    const out = await CsvParser.parse(p)
    const text = out.segments[0].text
    expect(text).toContain('name: Ada')
    expect(text).toContain('role: Engineer')
    expect(text).toContain('team:')
  })

  // RAG-N5: a .tsv is tab-delimited. papaparse delimiter auto-detection ties tab with comma on
  // field-count consistency here and (checking comma first) picks COMMA, so a comma INSIDE a cell
  // ("Lovelace, Ada") shatters the row and mis-pairs header:value — silently (the doc still
  // 'indexed'). Pinning delimiter='\t' for .tsv keeps the tab columns correct.
  it('parses a .tsv by TAB, not papaparse comma auto-detection (RAG-N5)', async () => {
    const p = write('people.tsv', 'last, first\trole\nLovelace, Ada\tEngineer\nHopper, Grace\tAdmiral')
    expect(selectParser('people.tsv')?.name).toBe('CsvParser')
    const out = await CsvParser.parse(p)
    const text = out.segments[0].text
    expect(text).toContain('last, first: Lovelace, Ada')
    expect(text).toContain('role: Engineer')
    expect(text).toContain('last, first: Hopper, Grace')
    expect(text).toContain('role: Admiral')
  })

  // Don't-regress: a .csv with comma-separated cells is still comma-parsed (unchanged path).
  it('still parses a .csv by comma (RAG-N5 — no regression)', async () => {
    const p = write('plain.csv', 'name,role\nAda,Engineer')
    const out = await CsvParser.parse(p)
    expect(out.segments[0].text).toContain('name: Ada')
    expect(out.segments[0].text).toContain('role: Engineer')
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
    // Persisted as the softened, localizable canonical English with the extension (§7).
    expect(info.errorMessage).toContain("isn't supported")
    expect(info.errorMessage).toContain('.xyz')
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

describe('ingestion pipeline — chunk-insert rollback (T3: no partial chunks survive a failure)', () => {
  it('rolls back the whole chunk-insert transaction on an injected mid-loop failure; connection not poisoned', async () => {
    // Drive the REAL processDocument (ingestion/index.ts:750 BEGIN…COMMIT, the ~1000-insert loop —
    // the highest-blast-radius transaction in the codebase). Mirror the data-layer-hardening gold
    // standard: wrap the connection so the SECOND `INSERT INTO chunks` throws — after BEGIN, the
    // re-index DELETEs, AND the first chunk has already been inserted INSIDE the transaction — and
    // assert (a) NOTHING partial persisted (the first chunk was rolled back with the failing second)
    // AND (b) the shared connection is not poisoned.
    const db = freshDb()
    const storeDir = store()
    const src = write('rollback.txt', Array.from({ length: 1200 }, (_, i) => `word${i}`).join(' '))
    const queued = createQueuedDocument(db, src)

    // Everything except the targeted chunk insert hits the real connection (so BEGIN/COMMIT/ROLLBACK,
    // the DELETEs, and setStatus are genuine); the throw is one-shot so a later clean run recovers.
    let inserts = 0
    let armed = true
    const wrapped = new Proxy(db as object, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const stmt = (target as Db).prepare(sql)
            if (armed && sql.includes('INSERT INTO chunks')) {
              return {
                run: (...args: unknown[]): unknown => {
                  inserts++
                  if (inserts >= 2) {
                    armed = false
                    throw new Error('injected: chunk insert failed mid-transaction')
                  }
                  return (stmt as { run: (...a: unknown[]) => unknown }).run(...args)
                }
              }
            }
            return stmt
          }
        }
        const val = (target as Record<string | symbol, unknown>)[prop]
        return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val
      }
    }) as unknown as Db

    // processDocument NEVER throws — it records the failure on the row.
    const info = await processDocument(wrapped, storeDir, queued.id)

    // (a) The doc failed and NO partial chunks survived — the first, already-inserted chunk was
    // rolled back with the failing second (not committed half-way).
    expect(info.status).toBe('failed')
    expect(info.errorMessage).toMatch(/injected/)
    expect(info.chunkCount).toBe(0)
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?').get(queued.id) as { n: number }).n
    ).toBe(0)
    expect(inserts).toBe(2) // the loop genuinely reached the second insert (the rollback un-did the first)

    // (b) The shared connection is not poisoned — a fresh transaction opens cleanly (it would throw
    // "cannot start a transaction within a transaction" if a BEGIN were left dangling).
    expect(() => {
      db.exec('BEGIN')
      db.exec('COMMIT')
    }).not.toThrow()

    // A clean re-process (the injection was one-shot) indexes the document normally — full recovery.
    const info2 = await processDocument(db, storeDir, queued.id)
    expect(info2.status).toBe('indexed')
    expect(info2.chunkCount).toBeGreaterThan(1)
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

  it('HR_FORCE_REINDEX flags every indexed doc stale regardless of embedder', async () => {
    const db = freshDb()
    const storeDir = store()
    const embedder = createMockEmbedder()
    const src = write('f.txt', 'alpha beta gamma delta epsilon zeta')
    const q = createQueuedDocument(db, src)
    await processDocument(db, storeDir, q.id, { embedder, embeddingModelId: embedder.id })

    process.env.HR_FORCE_REINDEX = '1'
    try {
      // Forced stale even though the active model MATCHES the vectors…
      expect(listDocuments(db, embedder.id)[0].staleEmbeddings).toBe(true)
      // …and even with NO active-model context (the lever doesn't need one).
      expect(listDocuments(db)[0].staleEmbeddings).toBe(true)
    } finally {
      delete process.env.HR_FORCE_REINDEX
    }
    // Flag cleared → back to normal: matching model ⇒ not stale.
    expect(listDocuments(db, embedder.id)[0].staleEmbeddings).toBe(false)
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

  // FE-6 (Wave P5): the renderer-facing reader returns a BOUNDED page + a cursor, while the
  // internal full reader stays unpaginated for skills + compare/translate.
  it('extractDocumentPreviewPage returns a bounded first page + an advancing cursor', async () => {
    const db = freshDb()
    const storeDir = store()
    const src = write('paged.md', '# A\nalpha\n\n# B\nbeta\n\n# C\ngamma')
    const q = createQueuedDocument(db, src)
    await processDocument(db, storeDir, q.id)

    const full = await extractDocumentPreview(db, storeDir, q.id)
    const total = full.segments.length
    expect(total).toBeGreaterThanOrEqual(2)
    // The internal full reader carries NO pagination metadata, so its consumers are unaffected.
    expect(full.totalSegments).toBeUndefined()
    expect(full.nextOffset).toBeUndefined()

    // Page 1: a bounded slice, the true total, and a cursor to the next offset.
    const limit = total - 1
    const page1 = await extractDocumentPreviewPage(db, storeDir, q.id, 0, limit)
    expect(page1.segments).toEqual(full.segments.slice(0, limit))
    expect(page1.totalSegments).toBe(total)
    expect(page1.nextOffset).toBe(limit)

    // Page 2 from the cursor: the remaining segments; cursor null on the last page.
    expect(page1.nextOffset).not.toBeNull()
    const page2 = await extractDocumentPreviewPage(db, storeDir, q.id, page1.nextOffset!, limit)
    expect(page2.segments).toEqual(full.segments.slice(limit))
    expect(page2.totalSegments).toBe(total)
    expect(page2.nextOffset).toBeNull()
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
    // Folder walk keeps supported files only; the explicit .xyz is still included.
    expect(files.some((f) => f.endsWith('top.txt'))).toBe(true)
    expect(files.some((f) => f.endsWith('nested.md'))).toBe(true)
    expect(files.filter((f) => f.endsWith('ignore.xyz'))).toHaveLength(0)
    expect(files.filter((f) => f.endsWith('explicit.xyz'))).toHaveLength(1)
  })

  // ING-4 (Wave P5): the walk switched to readdir withFileTypes (one syscall/entry), but a
  // Dirent does not follow symlinks, so symlinks fall back to statSync to keep the old
  // link-following expansion set. These prove that set is unchanged. Symlink creation needs a
  // privilege on Windows (Developer Mode / admin), so skip cleanly where it isn't available.
  const symlinkOk = ((): boolean => {
    try {
      const base = mkdtempSync(join(tmpdir(), 'hilbertraum-symtest-'))
      writeFileSync(join(base, 't.txt'), 'x')
      symlinkSync(join(base, 't.txt'), join(base, 'l.txt'))
      return true
    } catch {
      return false
    }
  })()

  // full-audit 2026-07-11 CODE-46: make a silent skip observable — on a machine without symlink
  // privilege (Windows without Developer Mode/admin) the three `skipIf(!symlinkOk)` tests below
  // just vanish from the run with no trace. A one-line warn tells the developer why.
  if (!symlinkOk) {
    console.warn(
      'ingestion.test: symlink creation unavailable (needs Developer Mode/admin on Windows) — ' +
        'the 3 symlink-following expandPaths tests are SKIPPED here.'
    )
  }

  // CODE-46 positive control: on the Linux CI leg symlinks MUST be creatable, so the trio above
  // MUST actually run there. If CI ever loses its Ubuntu job, these three tests would silently
  // stop executing everywhere (all runners lack the privilege) and their regressions would go
  // unnoticed; this assertion reddens instead, flagging the lost coverage (not a real symlink
  // regression). It is a no-op off Linux-CI, so local Windows/mac runs stay green.
  it('symlink support is present on Linux CI so the skipIf trio actually runs (CODE-46)', () => {
    if (process.env.CI && process.platform === 'linux') {
      expect(symlinkOk).toBe(true)
    }
  })

  it.skipIf(!symlinkOk)('follows a symlink to a supported file during the walk', () => {
    const root = join(dir(), 'root')
    mkdirSync(root)
    const target = write('target.md', '# hi') // lives OUTSIDE root
    symlinkSync(target, join(root, 'linked.md'))
    const files = expandPaths([root])
    // linked.md is only reachable by following the symlink → proves the link is followed + added.
    expect(files.some((f) => f.endsWith('linked.md'))).toBe(true)
  })

  it.skipIf(!symlinkOk)('follows a symlink to a directory during the walk', () => {
    const root = join(dir(), 'root')
    mkdirSync(root)
    const realDir = join(dir(), 'realdir') // OUTSIDE root
    mkdirSync(realDir)
    writeFileSync(join(realDir, 'inside.txt'), 'x')
    symlinkSync(realDir, join(root, 'linkdir'), 'dir')
    const files = expandPaths([root])
    // inside.txt is only reachable by walking through the directory symlink.
    expect(files.some((f) => f.endsWith('inside.txt'))).toBe(true)
  })

  // REL-9: a symlinked directory pointing back into one of its own ancestors (`a/loop -> root`)
  // is a cycle the link-following fallback would recurse on forever → stack overflow. The
  // recursion-path realpath guard must TERMINATE the walk (and still find the real file once).
  it.skipIf(!symlinkOk)('terminates on a symlink cycle without a stack overflow (REL-9)', () => {
    const root = join(dir(), 'cycleroot')
    mkdirSync(root)
    const a = join(root, 'a')
    mkdirSync(a)
    writeFileSync(join(a, 'real.txt'), 'x')
    symlinkSync(root, join(a, 'loop'), 'dir') // a/loop -> root (an ancestor) ⇒ a cycle
    // The walk must terminate AND discover the genuine file EXACTLY ONCE. Without the guard the
    // cycle re-walks `a` via every `…/loop/a` literal path, re-adding real.txt on each pass (and,
    // depending on the OS path/symlink limit, recursing until ENAMETOOLONG/ELOOP/stack overflow).
    const files = expandPaths([root])
    expect(files.filter((f) => f.endsWith('real.txt'))).toHaveLength(1)
  })
})
