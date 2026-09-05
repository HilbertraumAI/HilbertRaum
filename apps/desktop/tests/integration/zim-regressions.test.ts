import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { MockEmbedder, encodeVector } from '../../src/main/services/embeddings'
import {
  ragSettingsFrom,
  retrieve,
  type RagRetrievalSettings,
  type RetrievalResult
} from '../../src/main/services/rag'
import type { Reranker } from '../../src/main/services/reranker'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import type { Citation, EvidenceSourceSnapshot } from '../../src/shared/types'
import { buildEvidenceSourceSnapshots } from '../../src/main/services/evidence-pack/snapshot'
import { collectPackCandidates, type ExternalCandidate } from '../../src/main/services/zim/arm'

// ZIM knowledge packs (PR #294 → #301) — desired-behaviour regressions for reviewed defects that
// a LATER phase repairs. Each is an `it.fails` BASELINE (Vitest: the test is reported green while
// its body throws, and turns red — "Expect test to fail" — the moment the body passes), so the
// owning phase is forced to flip it to a plain `it` when it lands the fix. The inventory
// `tests/fixtures/zim/required-checks.json` lists every one of them as `baseline-pending`, and
// `repo-hygiene.test.ts` refuses any `it.fails` in the ZIM suites that is not listed there.
//
// Shape rule (plan §0.3): every fixture, call and prerequisite check lives in a NON-inverted
// test or hook and asserts only facts that hold before AND after the fix (the call returned, the
// row exists). The inverted body asserts ONLY the desired behaviour — never the current wrong
// behaviour first, because a broken fixture, the broken code and the fixed code would then all
// report green. The prerequisite tests are ordinary `it`s: if the harness itself breaks, they go
// red instead of the baseline silently "passing".
//
// Baseline evidence (recorded 2026-09-05 on the merge commit, plain-`it` scratch run): H2 fails at
// `expected 'resolved' to be 'unresolved'`; M3 at `expected false to be true` (no archive chunk
// survives the topKFinal trim); M8 at `expected [ 'pack-A', 'pack-B' ] to include 'pack-C'`.
// The review's H1 (quadratic converter) is deliberately NOT here: a timing-only expected failure
// is prohibited (CI contention), P1 pins it with a work counter (T02).

const SETTINGS: RagRetrievalSettings = ragSettingsFrom(DEFAULT_SETTINGS)

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-zim-regr-')), 'test.sqlite'))
}

// ---- H2 — archive citations must never resolve to a same-titled document (P2, T03) -----

describe('H2 — evidence snapshot identity for archive citations', () => {
  let snap: EvidenceSourceSnapshot | undefined
  const docSha = 'cd'.repeat(32)

  beforeAll(() => {
    const db = freshDb()
    const now = new Date().toISOString()
    // A library document whose title happens to equal the cited Wikipedia article title.
    db.prepare(
      `INSERT INTO documents (id, title, mime_type, sha256, status, created_at, updated_at)
       VALUES (?, ?, 'application/pdf', ?, 'indexed', ?, ?)`
    ).run(randomUUID(), 'Treibhausgas', docSha, now, now)

    const citation: Citation = {
      label: 'S1',
      sourceTitle: 'Treibhausgas',
      pageNumber: null,
      section: 'Landwirtschaft',
      snippet: 'Methan aus der Landwirtschaft ist ein Treibhausgas.',
      sourceKind: 'archive',
      packId: 'pack-climate',
      archiveTitle: 'Wikipedia (DE)',
      articlePath: 'Treibhausgas'
      // NO documentId by construction (rag/index.ts archive citation branch).
    }
    ;[snap] = buildEvidenceSourceSnapshots(db, [citation], 'direct_excerpt')
  })

  it('prerequisite: the snapshot builder returns one snapshot for the archive citation', () => {
    expect(snap).toBeDefined()
    expect(snap!.kind).toBe('direct_excerpt')
    expect(snap!.documentTitle).toBe('Treibhausgas')
  })

  it.fails('H2 archive citation never resolves to a same-titled document', () => {
    expect(snap!.identity).toBe('unresolved')
    expect(snap!.documentSha256).toBeNull()
    expect(snap!.documentId).toBeNull()
  })
})

// ---- M3 — a failing reranker must not silently drop archive candidates (P4, T09) --------

async function seedDocument(
  db: Db,
  embedder: MockEmbedder,
  title: string,
  texts: string[]
): Promise<void> {
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
    ).run(chunkId, docId, i, texts[i], title, texts[i]!.split(/\s+/).length, now)
    db.prepare(
      `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(chunkId, embedder.id, encodeVector(vectors[i]!), vectors[i]!.length, now)
  }
}

function archiveCandidate(n: number, text: string): ExternalCandidate {
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

describe('M3 — reranker failure fallback', () => {
  let result: RetrievalResult | undefined
  let rerankCalls = 0

  beforeAll(async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    // topKFinal is 6 (DEFAULT_SETTINGS.ragTopKFinal): the defect only bites when at least that
    // many document chunks rank ahead of the appended-last archive candidates — eight here.
    await seedDocument(
      db,
      embedder,
      'notes.txt',
      Array.from(
        { length: 8 },
        (_, i) => `Treibhausgas Landwirtschaft Abschnitt ${i} über Methan und Emissionen.`
      )
    )
    const throwingReranker: Reranker = {
      async rerank() {
        rerankCalls++
        throw new Error('reranker model failed to load')
      }
    } as unknown as Reranker

    result = await retrieve(
      db,
      embedder,
      'Treibhausgas Landwirtschaft',
      SETTINGS,
      null,
      throwingReranker,
      undefined,
      async () => [
        archiveCandidate(0, 'Methan aus der Landwirtschaft ist ein Treibhausgas.'),
        archiveCandidate(1, 'Weitere Treibhausgase sind Lachgas und CO2.')
      ]
    )
  })

  it('prerequisite: the reranker was called and threw, and retrieval still produced a final set', () => {
    expect(rerankCalls).toBeGreaterThan(0)
    expect(result).toBeDefined()
    expect(result!.chunks.length).toBeGreaterThan(0)
    expect(result!.chunks.length).toBeLessThanOrEqual(SETTINGS.topKFinal)
  })

  it.fails('M3 failing reranker keeps archive candidates through final selection', () => {
    expect(result!.chunks.some((c) => c.sourceKind === 'archive')).toBe(true)
  })
})

// ---- M8 — every selected pack must be searched (P4, T15) -------------------------------

let server: http.Server
let port = 0
const searched: string[] = []

/** ~700 words per section, four distinct sections ⇒ ≥4 chunks per article. */
function longArticleHtml(title: string): string {
  const sections = ['Landwirtschaft', 'Industrie', 'Verkehr', 'Energie']
  const filler = (label: string): string =>
    Array.from({ length: 700 }, (_, i) => `${label}wort${i}`).join(' ')
  const body = sections
    .map(
      (h, i) =>
        `<section data-mw-section-id="${i + 1}"><div class="mw-heading mw-heading2">` +
        `<h2 id="s${i}">${h}</h2></div><p>${title} ${h} Treibhausgas. ${filler(h)}</p></section>`
    )
    .join('')
  return (
    `<!DOCTYPE html><html lang="de"><head><title>${title}</title></head><body><h1>${title}</h1>` +
    `<section data-mw-section-id="0"><p>Einleitung zu ${title}.</p></section>${body}</body></html>`
  )
}

function searchXml(bookUrlId: string, titles: string[]): string {
  const items = titles
    .map(
      (t) =>
        `<item><title>${t}</title><link>/content/${bookUrlId}/${encodeURIComponent(
          t.replace(/ /g, '_')
        )}</link><wordCount>3,000</wordCount></item>`
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><rss><channel><title>Search</title>${items}</channel></rss>`
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/search') {
      const book = url.searchParams.get('books.id') ?? ''
      searched.push(book)
      // A and B: five long articles each. C: the single relevant one.
      const titles =
        book === 'pack-C'
          ? ['Treibhausgas Bilanz']
          : Array.from({ length: 5 }, (_, i) => `${book} Artikel ${i}`)
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(searchXml(`book-${book}`, titles))
      return
    }
    if (url.pathname.startsWith('/raw/')) {
      const article = decodeURIComponent(url.pathname.split('/content/')[1] ?? '').replace(
        /_/g,
        ' '
      )
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(longArticleHtml(article))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

describe('M8 — per-pack allocation', () => {
  const packs = [
    { id: 'pack-A', title: 'Pack A' },
    { id: 'pack-B', title: 'Pack B' },
    { id: 'pack-C', title: 'Pack C' }
  ]
  let out: ExternalCandidate[] = []

  beforeAll(async () => {
    searched.length = 0
    out = await collectPackCandidates(port, packs, 'Wie entsteht Treibhausgas in der Landwirtschaft?')
  })

  it('prerequisite: the arm searched at least one pack and produced candidates', () => {
    expect(searched.length).toBeGreaterThan(0)
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((c) => c.sourceKind === 'archive')).toBe(true)
  })

  it.fails('M8 three productive packs are all searched', () => {
    expect(searched).toContain('pack-C')
  })
})
