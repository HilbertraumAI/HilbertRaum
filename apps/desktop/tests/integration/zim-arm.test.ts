import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { MockEmbedder, encodeVector } from '../../src/main/services/embeddings'
import { ragSettingsFrom, retrieve, type RagRetrievalSettings } from '../../src/main/services/rag'
import type { Reranker } from '../../src/main/services/reranker'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import { collectPackCandidates, queryTerms, overlapScore } from '../../src/main/services/zim/arm'

// The ZIM retrieval arm end-to-end against a fake kiwix-serve (real sockets — the
// node:http transport is load-bearing, see client.ts), and the retrieve() seam:
// external candidates ride rerank/interleave/dedup/budget/citations exactly like
// document chunks, and an arm failure never breaks the document ask.

const SETTINGS: RagRetrievalSettings = ragSettingsFrom(DEFAULT_SETTINGS)

let server: http.Server
let port = 0

function articleHtml(title: string, sections: Array<[string, string]>): string {
  const body = sections
    .map(
      ([h, text], i) =>
        `<section data-mw-section-id="${i + 1}"><div class="mw-heading mw-heading2"><h2 id="s${i}">${h}</h2></div><p>${text}</p></section>`
    )
    .join('')
  return `<!DOCTYPE html><html lang="de"><head><title>${title}</title></head><body><h1>${title}</h1><section data-mw-section-id="0"><p>Einleitung zu ${title}.</p></section>${body}</body></html>`
}

function searchXml(bookUrlId: string, titles: string[]): string {
  const items = titles
    .map(
      (t) =>
        `<item><title>${t}</title><link>/content/${bookUrlId}/${encodeURIComponent(t.replace(/ /g, '_'))}</link><wordCount>1,000</wordCount></item>`
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><rss><channel><title>Search</title>${items}</channel></rss>`
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/search') {
      const book = url.searchParams.get('books.id') ?? ''
      if (book === 'pack-broken') {
        res.writeHead(500)
        res.end('boom')
        return
      }
      const titles = book === 'pack-climate' ? ['Treibhausgas', 'Treibhauspotential'] : ['Schwefel']
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(searchXml(`book-${book}`, titles))
      return
    }
    if (url.pathname.startsWith('/raw/')) {
      const article = decodeURIComponent(url.pathname.split('/content/')[1] ?? '').replace(/_/g, ' ')
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        articleHtml(article, [
          ['Landwirtschaft', `${article} entsteht durch Methan aus der Landwirtschaft.`],
          ['Industrie', `${article} in der Industrie stammt aus Verbrennung.`],
          ['Trivia', 'Ein Abschnitt ohne die gesuchten Begriffe.']
        ])
      )
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

describe('collectPackCandidates', () => {
  it('produces archive candidates: search → fetch → segments → chunker → overlap pick', async () => {
    const packs = [{ id: 'pack-climate', title: 'Klimawandel von Wikipedia' }]
    const out = await collectPackCandidates(port, packs, 'Wie entsteht Treibhausgas in der Landwirtschaft?')
    expect(out.length).toBeGreaterThan(0)
    const first = out[0]!
    expect(first).toMatchObject({
      documentId: 'zim:pack-climate',
      sourceKind: 'archive',
      packId: 'pack-climate',
      archiveTitle: 'Klimawandel von Wikipedia',
      pageNumber: null
    })
    expect(first.chunkId).toMatch(/^zim:pack-climate:/)
    expect(first.sourceTitle).toBe('Treibhausgas')
    expect(first.articlePath).toBe('Treibhausgas')
    // The overlap picker prefers the section naming the query terms.
    expect(first.text).toContain('Landwirtschaft')
  })

  it('isolates a failing pack — the healthy pack still contributes', async () => {
    const packs = [
      { id: 'pack-broken', title: 'Broken' },
      { id: 'pack-chem', title: 'Chemie von Wikipedia' }
    ]
    const out = await collectPackCandidates(port, packs, 'Schwefel Verbrennung')
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((c) => c.packId === 'pack-chem')).toBe(true)
  })
})

describe('queryTerms / overlapScore', () => {
  it('extracts distinct unicode terms and counts containment', () => {
    const terms = queryTerms('Zu was wird Treibhausgas, Treibhausgas und CO2?')
    expect(terms).toContain('treibhausgas')
    expect(terms).toContain('co2')
    expect(terms).not.toContain('zu') // <3 chars dropped
    expect(terms.filter((t) => t === 'treibhausgas')).toHaveLength(1) // distinct
    expect(overlapScore('Treibhausgas aus CO2-Quellen', terms)).toBe(2)
    expect(overlapScore('nichts davon', terms)).toBe(0)
  })
})

// ---- the retrieve() seam ----------------------------------------------------------

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-zim-arm-')), 'test.sqlite'))
}

async function seedDocument(db: Db, embedder: MockEmbedder, title: string, texts: string[]): Promise<void> {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
  ).run(docId, title, now, now)
  const vectors = await embedder.embed(texts)
  for (let i = 0; i < texts.length; i++) {
    const chunkId = randomUUID()
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
    ).run(chunkId, docId, i, texts[i], title, texts[i].split(/\s+/).length, now)
    db.prepare(
      `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(chunkId, embedder.id, encodeVector(vectors[i]), vectors[i].length, now)
  }
}

function archiveCandidate(n: number, text: string) {
  return {
    chunkId: `zim:pack-1:Artikel#${n}`,
    documentId: 'zim:pack-1',
    text,
    sourceTitle: 'Artikel',
    pageNumber: null,
    sectionLabel: 'Abschnitt',
    score: 1,
    sourceKind: 'archive' as const,
    packId: 'pack-1',
    archiveTitle: 'Wikipedia (Test)',
    articlePath: 'Artikel'
  }
}

describe('retrieve() with an external arm', () => {
  it('interleaves document and archive candidates without a reranker and builds archive citations', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'notes.txt', [
      'Treibhausgase entstehen in der Landwirtschaft.',
      'Ganz anderes Thema ohne Bezug.'
    ])
    const r = await retrieve(db, embedder, 'Treibhausgas Landwirtschaft', SETTINGS, null, null, undefined, async () => [
      archiveCandidate(0, 'Methan aus der Landwirtschaft ist ein Treibhausgas.'),
      archiveCandidate(1, 'Weitere Treibhausgase sind Lachgas und CO2.')
    ])
    const kinds = new Set(r.chunks.map((c) => c.sourceKind ?? 'document'))
    expect(kinds).toEqual(new Set(['document', 'archive']))
    // Interleave: the first archive chunk sits at position 2, not appended at the end.
    expect(r.chunks[1]?.sourceKind).toBe('archive')
    const archiveCitation = r.citations.find((c) => c.sourceKind === 'archive')
    expect(archiveCitation).toMatchObject({
      sourceTitle: 'Artikel',
      section: 'Abschnitt',
      packId: 'pack-1',
      archiveTitle: 'Wikipedia (Test)',
      articlePath: 'Artikel'
    })
    expect(archiveCitation?.documentId).toBeUndefined()
    expect(archiveCitation?.chunkId).toBeUndefined()
    const docCitation = r.citations.find((c) => c.sourceKind !== 'archive')
    expect(docCitation?.documentId).toBeTruthy()
  })

  it('lets a reranker rank archive chunks above documents on one scale', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'notes.txt', ['Ein Dokument über etwas anderes.'])
    const fakeReranker: Reranker = {
      async rerank(_q, docs) {
        // Highest score to the archive text (it contains "Methan").
        return docs.map((text, index) => ({ index, score: text.includes('Methan') ? 10 : 0 }))
      }
    } as Reranker
    const r = await retrieve(db, embedder, 'Methan', SETTINGS, null, fakeReranker, undefined, async () => [
      archiveCandidate(0, 'Methan aus der Landwirtschaft.')
    ])
    expect(r.chunks[0]?.sourceKind).toBe('archive')
    expect(r.chunks[0]?.label).toBe('S1')
  })

  it('a packs-only scope skips the document arms entirely (live-demo finding 2026-09-05)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    // A document that WOULD match the question — it must not surface when the user
    // selected packs and no document sources (the empty composed doc-scope used to fall
    // through to whole-corpus, and an invoice claimed the packs-only answer's slots).
    await seedDocument(db, embedder, 'invoice.pdf', ['Treibhausgase entstehen in der Landwirtschaft.'])
    const scope = { packIds: ['pack-1'], collectionIds: null, documentIds: null }
    const r = await retrieve(db, embedder, 'Treibhausgas', SETTINGS, scope, null, undefined, async () => [
      archiveCandidate(0, 'Methan aus der Landwirtschaft ist ein Treibhausgas.')
    ])
    expect(r.chunks.length).toBeGreaterThan(0)
    expect(r.chunks.every((c) => c.sourceKind === 'archive')).toBe(true)
    // Counter-check: the same scope WITH a collection selected keeps the document arms.
    const both = await retrieve(
      db,
      embedder,
      'Treibhausgas',
      SETTINGS,
      { ...scope, collectionIds: ['some-collection'] },
      null,
      undefined,
      async () => [archiveCandidate(0, 'Methan aus der Landwirtschaft ist ein Treibhausgas.')]
    )
    expect(both.chunks.some((c) => c.sourceKind === 'archive')).toBe(true)
  })

  it('a throwing arm never breaks the document ask', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'notes.txt', ['Treibhausgase entstehen in der Landwirtschaft.'])
    const r = await retrieve(db, embedder, 'Treibhausgas', SETTINGS, null, null, undefined, async () => {
      throw new Error('drive unplugged')
    })
    expect(r.chunks.length).toBeGreaterThan(0)
    expect(r.chunks.every((c) => c.sourceKind !== 'archive')).toBe(true)
  })

  // L6 (PR #294 review): the original test compared two calls of the NEW code with each other, which
  // proves nothing about master. This one replays a fixed seed against a result captured from master
  // bfdb514a's retrieve() BEFORE the arm existed (tests/fixtures/zim/no-arm-retrieval-master-bfdb514a.json,
  // generated by a scratch capture run on a detached bfdb514a checkout, 2026-09-05), so the no-arm path
  // is pinned against pre-change behaviour — chunks, scores, labels, citations, deep-equal.
  it('without an arm the pipeline reproduces the pre-change master bfdb514a fixture (L6, T01/T09 no-arm baseline)', async () => {
    const fixture = JSON.parse(
      readFileSync(join(process.cwd(), 'tests', 'fixtures', 'zim', 'no-arm-retrieval-master-bfdb514a.json'), 'utf8')
    ) as {
      now: string
      query: string
      documents: Array<{
        id: string
        title: string
        chunks: Array<{ id: string; text: string; pageNumber: number | null; sectionLabel: string | null }>
      }>
      result: unknown
    }
    const db = freshDb()
    const embedder = new MockEmbedder()
    for (const d of fixture.documents) {
      db.prepare(
        `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
      ).run(d.id, d.title, fixture.now, fixture.now)
      const vectors = await embedder.embed(d.chunks.map((c) => c.text))
      d.chunks.forEach((c, i) => {
        db.prepare(
          `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(c.id, d.id, i, c.text, d.title, c.pageNumber, c.sectionLabel, c.text.split(/s+/).length, fixture.now)
        db.prepare(
          `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(c.id, embedder.id, encodeVector(vectors[i]), vectors[i].length, fixture.now)
      })
    }
    const noArm = await retrieve(db, embedder, fixture.query, SETTINGS, null, null, undefined)
    expect(noArm.chunks.length).toBeGreaterThan(0)
    expect(noArm).toEqual(fixture.result)
    // The seam is optional in both spellings: an explicitly-absent arm is the same as none.
    const explicitlyAbsent = await retrieve(db, embedder, fixture.query, SETTINGS, null, null, undefined, null)
    expect(explicitlyAbsent).toEqual(fixture.result)
  })
})
