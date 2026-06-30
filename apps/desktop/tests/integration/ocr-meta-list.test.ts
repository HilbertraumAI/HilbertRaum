import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  setDocumentOcr,
  getDocument,
  getDocumentOcrPages,
  listDocuments
} from '../../src/main/services/ingestion'
import { ocrMetaFromJson, parseOcrMeta } from '../../src/main/services/ingestion/ocr-meta'

// PERF-3 (full-audit-2026-06-29 follow-up, Phase 4): `listDocuments` must read the OCR badge from
// the cheap `ocr_meta_json` sidecar, NEVER from the multi-MB `ocr_json` blob (which reconstructs
// every page's text just to read `pages.length`). These tests pin: (a) the list SQL omits
// `ocr_json` and selects the sidecar; (b) the badge is correct even when the blob is poisoned
// (proving the blob is never materialized on the list path); (c) an old workspace with `ocr_json`
// but no sidecar opens, backfills, and reports the correct page count.

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hilbertraum-ocrmeta-'))
})

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-db-')), 'test.sqlite'))
}

function makeDoc(db: Db, name = 'scan.pdf'): string {
  const p = join(tmp, name)
  writeFileSync(p, 'placeholder')
  return createQueuedDocument(db, p).id
}

const TWO_PAGES = [
  { pageNumber: 1, text: 'Erste Seite über Auftragsbestätigung und Lieferung.' },
  { pageNumber: 2, text: 'Zweite Seite über Rechnungen und Zahlungen.' }
]

describe('OCR metadata sidecar (PERF-3)', () => {
  it('setDocumentOcr writes both ocr_json and ocr_meta_json; clearing nulls both', () => {
    const db = freshDb()
    const id = makeDoc(db)
    setDocumentOcr(db, id, { pages: TWO_PAGES, engineId: 'tesseract.js-7.0.0', languages: ['deu', 'eng'] })

    const row = db
      .prepare('SELECT ocr_json, ocr_meta_json FROM documents WHERE id = ?')
      .get(id) as { ocr_json: string | null; ocr_meta_json: string | null }
    expect(row.ocr_json).toBeTruthy()
    expect(row.ocr_meta_json).toBeTruthy()
    // The sidecar is metadata-only — it must NOT carry page text.
    expect(row.ocr_meta_json).not.toContain('Auftragsbestätigung')
    expect(row.ocr_meta_json).not.toContain('Rechnungen')
    const meta = parseOcrMeta(row.ocr_meta_json)
    expect(meta).toEqual({
      pageCount: 2,
      languages: ['deu', 'eng'],
      engineId: 'tesseract.js-7.0.0',
      createdAt: expect.any(String)
    })

    // Clearing OCR nulls both columns (lock-step).
    setDocumentOcr(db, id, null)
    const cleared = db
      .prepare('SELECT ocr_json, ocr_meta_json FROM documents WHERE id = ?')
      .get(id) as { ocr_json: string | null; ocr_meta_json: string | null }
    expect(cleared.ocr_json).toBeNull()
    expect(cleared.ocr_meta_json).toBeNull()
  })

  it('listDocuments SQL omits ocr_json and selects ocr_meta_json (no page-text materialization)', () => {
    const db = freshDb()
    const id = makeDoc(db)
    setDocumentOcr(db, id, { pages: TWO_PAGES, engineId: 'tesseract.js-7.0.0', languages: ['deu'] })

    // Capture every SQL prepared while listing. The doc-list query must read the cheap sidecar
    // and never the blob; if a future change re-selects `ocr_json` this reds.
    const prepared: string[] = []
    const orig = db.prepare.bind(db)
    Object.defineProperty(db, 'prepare', {
      configurable: true,
      writable: true,
      value: (sql: string) => {
        prepared.push(sql)
        return orig(sql)
      }
    })
    try {
      listDocuments(db, null)
    } finally {
      Object.defineProperty(db, 'prepare', { configurable: true, writable: true, value: orig })
    }

    const listSql = prepared.find((s) => /FROM documents WHERE status != 'deleted'/.test(s))
    expect(listSql).toBeDefined()
    expect(listSql).not.toMatch(/\bocr_json\b/)
    expect(listSql).toMatch(/\bocr_meta_json\b/)
  })

  it('reports the OCR badge from the sidecar even when ocr_json is poisoned (blob never parsed)', () => {
    const db = freshDb()
    const id = makeDoc(db)
    setDocumentOcr(db, id, { pages: TWO_PAGES, engineId: 'tesseract.js-7.0.0', languages: ['deu', 'eng'] })

    // Poison the blob with a DIFFERENT, unparseable payload. If the list path read/parsed
    // `ocr_json` the badge would be wrong or throw; reading the sidecar keeps it correct.
    db.prepare('UPDATE documents SET ocr_json = ? WHERE id = ?').run('{ this is not valid json', id)

    const listed = listDocuments(db, null).find((d) => d.id === id)
    expect(listed?.ocr).toEqual({
      pageCount: 2,
      languages: ['deu', 'eng'],
      engineId: 'tesseract.js-7.0.0',
      createdAt: expect.any(String)
    })
  })

  it('migrates an old workspace: ocr_json present, no sidecar → backfills, correct page count', () => {
    const path = join(tmp, 'old.sqlite')
    const nodeRequire = createRequire(process.execPath)
    const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')

    // An "old" documents table: has `ocr_json` but NO `ocr_meta_json` column at all.
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE documents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, original_path TEXT, stored_path TEXT,
      mime_type TEXT, size_bytes INTEGER, sha256 TEXT, status TEXT NOT NULL,
      error_message TEXT, summary_json TEXT, origin_json TEXT, ocr_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    const blob = JSON.stringify({
      pages: TWO_PAGES,
      engineId: 'tesseract.js-7.0.0',
      languages: ['deu', 'eng'],
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    old
      .prepare(
        `INSERT INTO documents (id, title, status, ocr_json, created_at, updated_at)
         VALUES ('old-1', 'scan.pdf', 'indexed', ?, '2026-01-01', '2026-01-01')`
      )
      .run(blob)
    old.close()

    // openDatabase runs the migration: ALTER adds `ocr_meta_json`, then the one-time backfill.
    const db = openDatabase(path)
    const row = db
      .prepare('SELECT ocr_meta_json, updated_at FROM documents WHERE id = ?')
      .get('old-1') as { ocr_meta_json: string | null; updated_at: string }
    expect(row.ocr_meta_json).toBeTruthy()
    expect(parseOcrMeta(row.ocr_meta_json)).toEqual({
      pageCount: 2,
      languages: ['deu', 'eng'],
      engineId: 'tesseract.js-7.0.0',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    // The backfill is transparent: it must NOT bump updated_at.
    expect(row.updated_at).toBe('2026-01-01')

    // The list path now reports the correct badge — without the blob ever being parsed on the list.
    const listed = listDocuments(db, null).find((d) => d.id === 'old-1')
    expect(listed?.ocr?.pageCount).toBe(2)
    expect(listed?.ocr?.languages).toEqual(['deu', 'eng'])
    // The full blob is still intact for the page-text getter (re-index reuse path).
    expect(getDocumentOcrPages(db, 'old-1')?.length).toBe(2)

    // Re-open is a no-op (already backfilled): nothing throws, badge stays correct.
    db.close()
    const again = openDatabase(path)
    expect(getDocument(again, 'old-1')?.ocr?.pageCount).toBe(2)
  })
})

describe('ocrMetaFromJson / parseOcrMeta (unit)', () => {
  it('counts only well-formed pages and never returns text', () => {
    const meta = ocrMetaFromJson(
      JSON.stringify({
        pages: [
          { pageNumber: 1, text: 'a' },
          { pageNumber: 2, text: 'b' },
          { pageNumber: 'x', text: 'bad' }, // invalid pageNumber → not counted
          { pageNumber: 3 } // missing text → not counted
        ],
        engineId: 'e',
        languages: ['deu', 5, 'eng'],
        createdAt: 'when'
      })
    )
    expect(meta).toEqual({ pageCount: 2, languages: ['deu', 'eng'], engineId: 'e', createdAt: 'when' })
  })

  it('returns null for absent / malformed / empty OCR (badge then absent, mirrors parseOcr)', () => {
    expect(ocrMetaFromJson(null)).toBeNull()
    expect(ocrMetaFromJson(undefined)).toBeNull()
    expect(ocrMetaFromJson('not json')).toBeNull()
    expect(ocrMetaFromJson(JSON.stringify({ pages: [] }))).toBeNull()
    expect(ocrMetaFromJson(JSON.stringify({ pages: [{ pageNumber: 'x', text: 1 }] }))).toBeNull()
  })

  it('parseOcrMeta round-trips and tolerates a malformed sidecar', () => {
    const round = parseOcrMeta(JSON.stringify({ pageCount: 4, languages: ['eng'], engineId: 'e', createdAt: 't' }))
    expect(round).toEqual({ pageCount: 4, languages: ['eng'], engineId: 'e', createdAt: 't' })
    expect(parseOcrMeta(null)).toBeNull()
    expect(parseOcrMeta('{ bad')).toBeNull()
    expect(parseOcrMeta(JSON.stringify({ pageCount: 0 }))).toBeNull()
    expect(parseOcrMeta(JSON.stringify({ pageCount: -1 }))).toBeNull()
  })
})
