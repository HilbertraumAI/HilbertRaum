import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { MockEmbedder, VectorIndex, encodeVector, type Embedder } from '../../src/main/services/embeddings'
import {
  corpusNeedsReindex,
  detectFilenameScope,
  ragSettingsFrom,
  retrieve,
  type ExternalRetrievalOutput,
  type RagRetrievalSettings,
  type RetrievalResult
} from '../../src/main/services/rag'
import { keywordSearchChunks } from '../../src/main/services/rag/hybrid'
import { buildScopeFilter } from '../../src/main/services/retrieval-scope'
import { documentsInScope } from '../../src/main/services/skills/scope-documents'
import { aggregateExtractions } from '../../src/main/services/analysis/extract'
import {
  addToCollection,
  createCollection,
  getBuiltinCollection,
  linkConversationDocument,
  parseDocumentScope,
  resolveScope
} from '../../src/main/services/collections'
import type { Reranker } from '../../src/main/services/reranker'
import { DEFAULT_SETTINGS, MAX_SELECTED_PACKS } from '../../src/shared/types'
import type { Citation, EvidencePackOptions, EvidenceSourceSnapshot } from '../../src/shared/types'
import {
  appendMessage,
  createConversation,
  exportTranscript,
  getConversation,
  setScope
} from '../../src/main/services/chat'
import { ZimService } from '../../src/main/services/zim'
import { readZimHeader, servingNameFor } from '../../src/main/services/zim/identity'
import type { SpawnFn } from '../../src/main/services/runtime/sidecar'
import { ServeFakeChild, serveGate, type ServeGate } from '../helpers/zim-fakes'
import { packUuid, writeZimFixture } from '../helpers/zim-header'
import {
  buildEvidenceSourceSnapshots,
  createEvidenceReviewFromMessage
} from '../../src/main/services/evidence-pack/snapshot'
import { computeEvidenceReviewFreshness } from '../../src/main/services/evidence-pack/freshness'
import { getEvidenceReview, parseSourceSnapshots } from '../../src/main/services/evidence-reviews'
import { buildEvidencePackModel } from '../../src/main/services/evidence-pack/pack-model'
import { escapeHtml, renderEvidencePackHtml } from '../../src/main/services/evidence-pack/render-html'
import { EVIDENCE_PACK_OPTION_DEFAULTS } from '../../src/shared/evidence-review'
import { t } from '../../src/shared/i18n'
import {
  ARTICLES_PER_PACK,
  MAX_EXTERNAL_CANDIDATES,
  collectPackCandidates,
  packQuota,
  type ExternalCandidate
} from '../../src/main/services/zim/arm'
// The chip/footer phrase is a PURE function of the stored scope (no React state), so the node
// test can pin "the chip agrees with the resolved scope" (T10) directly against it.
import { scopeSources } from '../../src/renderer/chat/ScopePopover'

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
// Baseline evidence (recorded 2026-09-05 on the merge commit, plain-`it` scratch run): H2 failed at
// `expected 'resolved' to be 'unresolved'`; M3 at `expected false to be true` (no archive chunk
// survives the topKFinal trim); M8 at `expected [ 'pack-A', 'pack-B' ] to include 'pack-C'`.
// H2 was REPAIRED by P2 (the archive guard in `evidence-pack/snapshot.ts`, the read whitelist in
// `evidence-reviews.ts`, the explicit archive branches in `freshness.ts`/`source-context.ts`), so
// its case is a plain `it` from here on and T03-b below extends it to the full T03 matrix. M3 and
// M8 stay `it.fails` baselines until P4 lands their fixes.
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

  it('H2 archive citation never resolves to a same-titled document', () => {
    expect(snap!.identity).toBe('unresolved')
    expect(snap!.documentSha256).toBeNull()
    expect(snap!.documentId).toBeNull()
  })
})

// ---- T03 — the full archive-identity matrix + the legacy document control (P2, H2) ------

/**
 * A `Db` façade that counts the `documents` statements actually EXECUTED through it.
 * `prepareCached` compiles via `db.prepare` and caches per `Db` OBJECT, so a fresh façade
 * observes every statement the builder runs. Compilations are deliberately not counted: the
 * builder prepares both document statements up front, and what must never happen for an
 * archive citation is that one of them is RUN against the workspace.
 */
function documentsQueryCounter(db: Db): { db: Db; executed: () => number } {
  let executed = 0
  const wrapStatement = (stmt: object): object =>
    new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown
        if (typeof value !== 'function') return value
        const fn = value as (...args: unknown[]) => unknown
        return (...args: unknown[]): unknown => {
          if (prop === 'get' || prop === 'all' || prop === 'run') executed += 1
          return fn.apply(target, args)
        }
      }
    })
  const facade = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown
      if (typeof value !== 'function') return value
      const fn = value as (...args: unknown[]) => unknown
      if (prop !== 'prepare') return (...args: unknown[]): unknown => fn.apply(target, args)
      return (sql: string): unknown => {
        const stmt = fn.apply(target, [sql]) as object
        return /\bFROM documents\b/i.test(sql) ? wrapStatement(stmt) : stmt
      }
    }
  })
  return { db: facade, executed: () => executed }
}

describe('T03 — archive identity, freshness and the legacy document control (P2, H2)', () => {
  it('T03 multiple same-title documents, an absent source and accidental document-ID fields on an archive citation all stay unresolved with freshness explicitly unverifiable; a legacy document citation resolves as before', () => {
    const db = freshDb()
    const now = new Date().toISOString()
    const seedDoc = (title: string, sha: string): string => {
      const id = randomUUID()
      db.prepare(
        `INSERT INTO documents (id, title, mime_type, sha256, status, created_at, updated_at)
         VALUES (?, ?, 'application/pdf', ?, 'indexed', ?, ?)`
      ).run(id, title, sha, now, now)
      return id
    }
    // (a) TWO documents carry the cited article's title; (f) one uniquely-titled document is
    // the legacy control; `deletedId` never had a row (the pinned-but-deleted control).
    const twinA = seedDoc('Treibhausgas', 'aa'.repeat(32))
    seedDoc('Treibhausgas', 'bb'.repeat(32))
    const legacyId = seedDoc('Klimabericht.pdf', 'cc'.repeat(32))
    const deletedId = randomUUID()
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM documents WHERE title = ?').get('Treibhausgas') as {
        n: number
      }).n
    ).toBe(2)

    const archive = (
      label: string,
      title: string,
      path: string,
      extra: Partial<Citation> = {}
    ): Citation => ({
      label,
      sourceTitle: title,
      pageNumber: null,
      section: 'Landwirtschaft',
      snippet: `${title}: Methan aus der Landwirtschaft.`,
      sourceKind: 'archive',
      packId: 'pack-climate',
      archiveTitle: 'Wikipedia (DE)',
      articlePath: path,
      ...extra
    })

    const citations: Citation[] = [
      archive('S1', 'Treibhausgas', 'A/Treibhausgas'), // (a) two same-title documents
      archive('S2', 'Gletscherschmelze', 'A/Gletscherschmelze'), // (b) no document of that title
      archive('S3', 'Treibhausgas', 'A/Treibhausgas_2', { documentId: twinA }), // (c) stray doc id
      {
        label: 'S4',
        sourceTitle: 'Klimabericht.pdf',
        pageNumber: 4,
        section: null,
        snippet: 'Der Bericht nennt Methan.'
      }, // (f) legacy citation, unique title
      { label: 'S5', sourceTitle: 'Verschollen.pdf', documentId: deletedId } // (f) pinned, deleted
    ]

    const snaps = buildEvidenceSourceSnapshots(db, citations, 'direct_excerpt')
    expect(snaps.map((s) => s.key)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5'])

    // (a) + (b) + (c): every archive source is unresolved with NO document identity, hash,
    // mime type or availability — including the one whose citation also carried a real id.
    for (const s of snaps.slice(0, 3)) {
      expect(s.identity).toBe('unresolved')
      expect(s.documentId).toBeNull()
      expect(s.documentSha256).toBeNull()
      expect(s.mimeType).toBeNull()
      expect(s.availabilityAtCreation).toBeNull()
      expect(s.sourceKind).toBe('archive')
      expect(s.archiveTitle).toBe('Wikipedia (DE)')
      expect(s.packId).toBe('pack-climate')
    }
    // The display title stays the ARTICLE title; the locator is the citation's own path.
    expect(snaps[0]!.documentTitle).toBe('Treibhausgas')
    expect(snaps[0]!.articlePath).toBe('A/Treibhausgas')
    expect(snaps[1]!.documentTitle).toBe('Gletscherschmelze')
    expect(snaps[1]!.articlePath).toBe('A/Gletscherschmelze')
    expect(snaps[2]!.articlePath).toBe('A/Treibhausgas_2')

    // (f) the legacy resolver is byte-for-byte what it was: unique title ⇒ resolved/available
    // with that row's id, sha and mime; a pinned id whose row is gone ⇒ resolved + missing.
    expect(snaps[3]).toMatchObject({
      identity: 'resolved',
      availabilityAtCreation: 'available',
      documentId: legacyId,
      documentTitle: 'Klimabericht.pdf',
      documentSha256: 'cc'.repeat(32),
      mimeType: 'application/pdf',
      sourceKind: 'document',
      archiveTitle: null,
      packId: null,
      articlePath: null
    })
    expect(snaps[4]).toMatchObject({
      identity: 'resolved',
      availabilityAtCreation: 'missing',
      documentId: deletedId,
      documentSha256: null,
      mimeType: null,
      sourceKind: 'document',
      archiveTitle: null,
      packId: null,
      articlePath: null
    })

    // No `documents` query RUNS for an archive citation — proved directly, not merely implied
    // by the null fields: the counting façade sees zero executions for an archive-only list
    // against the very workspace that still holds both same-titled documents...
    const counter = documentsQueryCounter(db)
    const archiveOnly = buildEvidenceSourceSnapshots(
      counter.db,
      [archive('S1', 'Treibhausgas', 'A/Treibhausgas')],
      'direct_excerpt'
    )
    expect(archiveOnly[0]!.identity).toBe('unresolved')
    expect(counter.executed()).toBe(0)
    // ...and DOES see the legacy title lookup, so the zero above means "never run", not
    // "never observable".
    expect(buildEvidenceSourceSnapshots(counter.db, [citations[3]!], 'direct_excerpt')[0]!.identity).toBe(
      'resolved'
    )
    expect(counter.executed()).toBeGreaterThan(0)

    // (d) READ time: stored JSON that claims a resolved identity, a document id and a sha
    // ALONGSIDE the archive marker is repaired down, never up — the archive marker wins.
    const tampered = parseSourceSnapshots(
      JSON.stringify([
        {
          key: 'S1',
          documentTitle: 'Treibhausgas',
          kind: 'direct_excerpt',
          identity: 'resolved',
          documentId: twinA,
          documentSha256: 'aa'.repeat(32),
          mimeType: 'application/pdf',
          availabilityAtCreation: 'available',
          sourceKind: 'archive',
          archiveTitle: 'Wikipedia (DE)',
          packId: 'pack-climate',
          articlePath: 'A/Treibhausgas'
        }
      ])
    )
    expect(tampered).toHaveLength(1)
    expect(tampered[0]).toMatchObject({
      identity: 'unresolved',
      documentId: null,
      documentSha256: null,
      mimeType: null,
      availabilityAtCreation: null,
      sourceKind: 'archive',
      archiveTitle: 'Wikipedia (DE)',
      packId: 'pack-climate',
      articlePath: 'A/Treibhausgas'
    })

    // (e) A REAL review over the mixed citation list, through the persisted row.
    const conv = createConversation(db, { title: 'Klimafragen', modelId: 'test-model-q4' })
    appendMessage(db, {
      conversationId: conv.id,
      role: 'user',
      content: 'Wie entsteht Treibhausgas in der Landwirtschaft?'
    })
    const msg = appendMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: 'Methan entsteht in der Landwirtschaft. [S1]\n\nDer Bericht bestätigt das. [S4]',
      citations,
      coverage: { mode: 'relevance', chunksCovered: 5, chunksTotal: 9 }
    })
    const detail = createEvidenceReviewFromMessage(db, msg.id)
    const stored = new Map(detail.sources.map((s) => [s.key, s]))
    expect(stored.get('S1')).toMatchObject({
      sourceKind: 'archive',
      identity: 'unresolved',
      documentId: null,
      documentSha256: null,
      documentTitle: 'Treibhausgas',
      archiveTitle: 'Wikipedia (DE)',
      packId: 'pack-climate',
      articlePath: 'A/Treibhausgas'
    })
    expect(stored.get('S4')).toMatchObject({
      sourceKind: 'document',
      identity: 'resolved',
      documentId: legacyId,
      documentSha256: 'cc'.repeat(32),
      archiveTitle: null,
      packId: null,
      articlePath: null
    })

    const stateOf = (
      fresh: ReturnType<typeof computeEvidenceReviewFreshness>,
      key: string
    ): string => {
      const source = (fresh?.sources ?? []).find((s) => s.key === key)
      return source ? source.state : `no source named ${key}`
    }
    const before = computeEvidenceReviewFreshness(db, detail.id)
    expect(before).not.toBeNull()
    expect(stateOf(before, 'S1')).toBe('unverifiable')
    expect(stateOf(before, 'S2')).toBe('unverifiable')
    expect(stateOf(before, 'S3')).toBe('unverifiable')
    expect(stateOf(before, 'S4')).toBe('unchanged')
    expect(stateOf(before, 'S5')).toBe('missing')
    expect(before!.outdated).toBe(false)

    // The same-titled decoy document changes. Under the defect S1/S3 were pinned to it, so
    // this UPDATE would have reported 'changed' and flipped the review outdated; archive
    // identity and hash verification are unavailable by construction, so nothing moves.
    db.prepare('UPDATE documents SET sha256 = ? WHERE id = ?').run('ee'.repeat(32), twinA)
    const after = computeEvidenceReviewFreshness(db, detail.id)
    expect(stateOf(after, 'S1')).toBe('unverifiable')
    expect(stateOf(after, 'S3')).toBe('unverifiable')
    expect(stateOf(after, 'S4')).toBe('unchanged')
    expect(after!.outdated).toBe(false)

    // The control in the other direction: the legacy document's own hash change IS drift.
    db.prepare('UPDATE documents SET sha256 = ? WHERE id = ?').run('dd'.repeat(32), legacyId)
    const drifted = computeEvidenceReviewFreshness(db, detail.id)
    expect(stateOf(drifted, 'S4')).toBe('changed')
    expect(stateOf(drifted, 'S1')).toBe('unverifiable')
    expect(drifted!.outdated).toBe(true)
  })
})

// ---- T04 — the archive locator survives the WHOLE evidence chain (P2, M11) --------------

describe('T04 — mixed review: archive locator through storage, reopen, model, Markdown and HTML (P2, M11)', () => {
  // ONE fixture shared by the prerequisites and the integration case: a mixed answer whose
  // [S1] is a library document and whose [S2] is a knowledge-pack article carrying long,
  // non-ASCII AND hostile text inside the same locator values (#294 review M11).
  const DOC_SHA = 'ab'.repeat(32)
  const PACK_UUID = '3f8c1b5e-2a47-4d90-9c6b-7e0f1a2b3c4d'
  const ARCHIVE_TITLE = `Wikipedia (DE) – Klimawandel <script>alert("x&y'z")</script>`
  const ARTICLE_PATH = 'Treibhausgas/Übersicht_ß?x=1&y="2"<b>'
  const ARTICLE_TITLE = 'Treibhausgas'

  interface Fixture {
    db: Db
    conversationId: string
    documentId: string
    detail: ReturnType<typeof createEvidenceReviewFromMessage>
  }

  function seedMixedReview(): Fixture {
    const db = freshDb()
    const now = new Date().toISOString()
    const documentId = randomUUID()
    db.prepare(
      `INSERT INTO documents (id, title, mime_type, sha256, status, created_at, updated_at)
       VALUES (?, ?, 'application/pdf', ?, 'indexed', ?, ?)`
    ).run(documentId, 'Vertrag.pdf', DOC_SHA, now, now)

    const citations: Citation[] = [
      {
        label: 'S1',
        sourceTitle: 'Vertrag.pdf',
        documentId,
        pageNumber: 12,
        section: null,
        snippet: 'Kündigung mit einer Frist von 30 Tagen.'
      },
      {
        label: 'S2',
        sourceTitle: ARTICLE_TITLE,
        pageNumber: null,
        section: 'Landwirtschaft',
        snippet: 'Methan aus der Landwirtschaft ist ein Treibhausgas.',
        sourceKind: 'archive',
        packId: PACK_UUID,
        archiveTitle: ARCHIVE_TITLE,
        articlePath: ARTICLE_PATH
        // NO documentId by construction (the rag/index.ts archive citation branch).
      }
    ]

    const conv = createConversation(db, { title: 'Klimafragen', modelId: 'test-model-q4' })
    appendMessage(db, {
      conversationId: conv.id,
      role: 'user',
      content: 'Was steht im Vertrag und wie entsteht Treibhausgas?'
    })
    const msg = appendMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content:
        'Die Kündigungsfrist beträgt 30 Tage. [S1]\n\nMethan entsteht in der Landwirtschaft. [S2]',
      citations,
      coverage: { mode: 'relevance', chunksCovered: 2, chunksTotal: 9 }
    })
    const detail = createEvidenceReviewFromMessage(db, msg.id, {
      appVersion: '0.1.52-test',
      modelDisplayName: () => 'Test Model'
    })
    return { db, conversationId: conv.id, documentId, detail }
  }

  let fx: Fixture | undefined

  beforeAll(() => {
    fx = seedMixedReview()
  })

  it('prerequisite: the mixed review persisted with exactly the two snapshots S1 (document) and S2 (archive)', () => {
    expect(fx).toBeDefined()
    expect(fx!.detail.sources.map((s) => s.key)).toEqual(['S1', 'S2'])
    expect(fx!.detail.sources.map((s) => s.documentTitle)).toEqual(['Vertrag.pdf', ARTICLE_TITLE])
  })

  it('prerequisite: the workspace really holds the cited library document with the seeded hash', () => {
    const row = fx!.db
      .prepare('SELECT title, sha256 FROM documents WHERE id = ?')
      .get(fx!.documentId) as { title: string; sha256: string } | undefined
    expect(row).toBeDefined()
    expect(row!.title).toBe('Vertrag.pdf')
    expect(row!.sha256).toBe(DOC_SHA)
  })

  it("T04 a mixed review's archive locator (pack id + article path + archive title) survives stored JSON, reopen, the export model and the Markdown / HTML renderers with escaping, in EN and DE, without an invented document identity", () => {
    const { db, detail } = fx!

    // (a) CREATE — the two snapshots the resolver produced.
    const created = new Map(detail.sources.map((s) => [s.key, s]))
    expect(created.get('S2')).toMatchObject({
      identity: 'unresolved',
      documentId: null,
      documentSha256: null,
      sourceKind: 'archive',
      documentTitle: ARTICLE_TITLE,
      archiveTitle: ARCHIVE_TITLE,
      packId: PACK_UUID,
      articlePath: ARTICLE_PATH,
      sectionLabel: 'Landwirtschaft'
    })
    expect(created.get('S1')).toMatchObject({
      identity: 'resolved',
      documentId: fx!.documentId,
      documentSha256: DOC_SHA,
      sourceKind: 'document',
      archiveTitle: null,
      packId: null,
      articlePath: null
    })

    // (b) STORAGE CONTRACT — the four fields are LITERALLY in the persisted JSON, so the
    // read side is not repairing a shape the writer never wrote (raw SELECT, no parser).
    const rawJson = (
      db.prepare('SELECT source_snapshot_json FROM evidence_reviews WHERE id = ?').get(detail.id) as {
        source_snapshot_json: string | null
      }
    ).source_snapshot_json
    expect(typeof rawJson).toBe('string')
    const rawSources = JSON.parse(rawJson!) as Array<Record<string, unknown>>
    expect(rawSources.map((s) => s.key)).toEqual(['S1', 'S2'])
    expect(rawSources[1]).toMatchObject({
      sourceKind: 'archive',
      archiveTitle: ARCHIVE_TITLE,
      packId: PACK_UUID,
      articlePath: ARTICLE_PATH,
      documentId: null,
      documentSha256: null
    })
    expect(rawSources[0]).toMatchObject({
      sourceKind: 'document',
      archiveTitle: null,
      packId: null,
      articlePath: null,
      documentSha256: DOC_SHA
    })
    // Present as OWN keys on BOTH elements — not merely "undefined equals null".
    for (const field of ['sourceKind', 'archiveTitle', 'packId', 'articlePath']) {
      expect(Object.prototype.hasOwnProperty.call(rawSources[0]!, field), `S1.${field}`).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(rawSources[1]!, field), `S2.${field}`).toBe(true)
    }

    // (c) REOPEN — the read whitelist (`parseSourceSnapshots`) hands back the same facts.
    const reopened = getEvidenceReview(db, detail.id)
    expect(reopened).not.toBeNull()
    const read = new Map(reopened!.sources.map((s) => [s.key, s]))
    expect(read.get('S2')).toMatchObject({
      identity: 'unresolved',
      documentId: null,
      documentSha256: null,
      sourceKind: 'archive',
      documentTitle: ARTICLE_TITLE,
      archiveTitle: ARCHIVE_TITLE,
      packId: PACK_UUID,
      articlePath: ARTICLE_PATH
    })
    expect(read.get('S1')).toMatchObject({
      identity: 'resolved',
      documentId: fx!.documentId,
      documentSha256: DOC_SHA,
      sourceKind: 'document',
      archiveTitle: null,
      packId: null,
      articlePath: null
    })

    // (d) FRESHNESS — archive unverifiable by construction, document unchanged, not outdated.
    const fresh = computeEvidenceReviewFreshness(db, detail.id)
    expect(fresh).not.toBeNull()
    const stateOf = (
      verdict: ReturnType<typeof computeEvidenceReviewFreshness>,
      key: string
    ): string => {
      const source = (verdict?.sources ?? []).find((s) => s.key === key)
      return source ? source.state : `no source named ${key}`
    }
    expect(stateOf(fresh, 'S2')).toBe('unverifiable')
    expect(stateOf(fresh, 'S1')).toBe('unchanged')
    expect(fresh!.outdated).toBe(false)

    // (e) EXPORT MODEL — EN and DE carry the exact locator; the archive is counted once, as
    // an ARCHIVE, never as an unresolved document identity.
    const packOptions = (language: 'en' | 'de'): EvidencePackOptions => ({
      language,
      ...EVIDENCE_PACK_OPTION_DEFAULTS
    })
    const META = {
      packId: '00000000-0000-4000-8000-0000000004a0',
      generatedAt: '2026-09-05T12:00:00.000Z',
      format: 'html'
    } as const
    const models = {
      en: buildEvidencePackModel(reopened!, packOptions('en'), META, fresh),
      de: buildEvidencePackModel(reopened!, packOptions('de'), META, fresh)
    }
    for (const lang of ['en', 'de'] as const) {
      const model = models[lang]
      expect(model.evidence.find((s) => s.key === 'S2')).toMatchObject({
        index: 2,
        sourceKind: 'archive',
        identity: 'unresolved',
        documentTitle: ARTICLE_TITLE,
        archiveTitle: ARCHIVE_TITLE,
        packId: PACK_UUID,
        articlePath: ARTICLE_PATH,
        documentSha256: null,
        mimeType: null
      })
      expect(model.evidence.find((s) => s.key === 'S1')).toMatchObject({
        index: 1,
        sourceKind: 'document',
        identity: 'resolved',
        documentTitle: 'Vertrag.pdf',
        documentSha256: DOC_SHA,
        mimeType: 'application/pdf',
        archiveTitle: null,
        packId: null,
        articlePath: null
      })
      expect(model.honesty.archiveSources).toBe(1)
      expect(model.honesty.unresolvedSources).toBe(0)
      expect(model.honesty.missingSources).toBe(0)
    }

    // (f) HTML — both languages: escaped exactly once, hostile source text never raw, the
    // ARCHIVE identity warning instead of the legacy document one, and the §16.1.7 rows.
    for (const lang of ['en', 'de'] as const) {
      const html = renderEvidencePackHtml(models[lang])
      const unavailable = escapeHtml(t(lang, 'review.summary.unavailable'))
      expect(html).toContain(`<html lang="${lang}">`)
      // The locator, escaped exactly once, on the archive card.
      expect(html).toContain(escapeHtml(ARCHIVE_TITLE))
      expect(html).toContain(escapeHtml(ARTICLE_PATH))
      expect(html).toContain(PACK_UUID)
      expect(html).toContain(
        `<p>${escapeHtml(t(lang, 'packExport.evidence.archive'))}: ${escapeHtml(ARCHIVE_TITLE)}</p>`
      )
      expect(html).toContain(
        `<p class="mono">${escapeHtml(t(lang, 'packExport.evidence.packId'))}: ${escapeHtml(PACK_UUID)} · ${escapeHtml(t(lang, 'packExport.evidence.article'))}: ${escapeHtml(ARTICLE_PATH)}</p>`
      )
      // ...and NEVER raw — nor double-escaped (`&amp;lt;` would prove a second pass).
      expect(html).not.toContain('<script>')
      expect(html).not.toContain(`alert("x&y'z")`)
      expect(html).not.toContain('y="2"<b>')
      expect(html).not.toContain('&amp;lt;script&amp;gt;')
      // The archive card's OWN identity warning, never the legacy document claim.
      expect(html).toContain(escapeHtml(t(lang, 'packExport.evidence.archiveIdentity')))
      expect(html).not.toContain(escapeHtml(t(lang, 'packExport.evidence.identityUnresolved')))
      // §16.1.6 counts: the archive line fires, the unresolved-document one does not.
      expect(html).toContain(escapeHtml(t(lang, 'review.summary.sourcesArchive.one', { count: 1 })))
      expect(html).not.toContain(
        escapeHtml(t(lang, 'review.summary.sourcesUnresolved.one', { count: 1 }))
      )
      // §16.1.7 source register: the archive row states its own type + availability and has
      // NO hash cell; the document row keeps its mime type and its SHA-256.
      expect(html).toContain(
        `<tr><td><a href="#src-2">${escapeHtml(ARTICLE_TITLE)}</a></td><td>${escapeHtml(t(lang, 'packExport.sources.typeArchive'))}</td><td>${unavailable}</td><td>${escapeHtml(t(lang, 'packExport.sources.availabilityArchive'))}</td></tr>`
      )
      expect(html).toContain(
        `<tr><td><a href="#src-1">Vertrag.pdf</a></td><td>application/pdf</td><td><span class="mono">${DOC_SHA}</span></td><td>${escapeHtml(t(lang, 'packExport.sources.availabilityAvailable'))}</td></tr>`
      )
    }

    // (i) NO INVENTED IDENTITY: the library document's hash appears EXACTLY ONCE in the whole
    // pack — its own register row — and never anywhere on the archive card.
    const enHtml = renderEvidencePackHtml(models.en)
    expect(enHtml.split(DOC_SHA).length - 1).toBe(1)

    // (g) MARKDOWN transcript — the archive line keeps the article title, the pack title, the
    // pack id and the article path; the document line is the unchanged legacy shape.
    const markdown = exportTranscript(db, fx!.conversationId).markdown
    expect(markdown.split('\n').filter((l) => l.startsWith('- ['))).toEqual([
      '- [S1] Vertrag.pdf, p. 12',
      `- [S2] ${ARTICLE_TITLE}, Landwirtschaft — knowledge pack: ${ARCHIVE_TITLE}; pack id ${PACK_UUID}; article ${ARTICLE_PATH}`
    ])

    // (h) DELETED PACK — nothing in a stored review reads `knowledge_packs`: registering the
    // pack and then deleting its row leaves every read and rendered fact byte-identical.
    const stamp = new Date().toISOString()
    db.prepare(
      `INSERT INTO knowledge_packs (id, title, leaf, recorded_path, enabled, added_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    ).run(PACK_UUID, 'Wikipedia (DE)', 'wikipedia_de.zim', 'K:/zim/wikipedia_de.zim', stamp, stamp)
    const packCount = (): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM knowledge_packs WHERE id = ?').get(PACK_UUID) as {
        n: number
      }).n
    expect(packCount()).toBe(1)
    const withPack = JSON.stringify(getEvidenceReview(db, detail.id)?.sources)
    db.prepare('DELETE FROM knowledge_packs WHERE id = ?').run(PACK_UUID)
    expect(packCount()).toBe(0)
    const afterDelete = getEvidenceReview(db, detail.id)
    expect(JSON.stringify(afterDelete?.sources)).toBe(withPack)
    expect(afterDelete!.sources.find((s) => s.key === 'S2')).toMatchObject({
      identity: 'unresolved',
      sourceKind: 'archive',
      archiveTitle: ARCHIVE_TITLE,
      packId: PACK_UUID,
      articlePath: ARTICLE_PATH
    })
    const freshAfter = computeEvidenceReviewFreshness(db, detail.id)
    expect(stateOf(freshAfter, 'S2')).toBe('unverifiable')
    expect(freshAfter!.outdated).toBe(false)
    expect(
      renderEvidencePackHtml(buildEvidencePackModel(afterDelete!, packOptions('en'), META, freshAfter))
    ).toBe(enHtml)
  })
})

// ---- M3 — a failing reranker must not silently drop archive candidates (P4, T09) --------

/** Seed one indexed document with chunks + real vectors; returns its id (P4 needs the id). */
async function seedDocument(
  db: Db,
  embedder: MockEmbedder,
  title: string,
  texts: string[]
): Promise<string> {
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
  return docId
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
      async () =>
        testArm(
          archiveCandidate(0, 'Methan aus der Landwirtschaft ist ein Treibhausgas.'),
          archiveCandidate(1, 'Weitere Treibhausgase sind Lachgas und CO2.')
        )
    )
  })

  it('prerequisite: the reranker was called and threw, and retrieval still produced a final set', () => {
    expect(rerankCalls).toBeGreaterThan(0)
    expect(result).toBeDefined()
    expect(result!.chunks.length).toBeGreaterThan(0)
    expect(result!.chunks.length).toBeLessThanOrEqual(SETTINGS.topKFinal)
  })

  // FLIPPED by P4 (#301, plan §9.21 (b), §0.3 item 2). Demonstration on the repaired code, this
  // worktree, before the flip: `× M3 — reranker failure fallback > M3 failing reranker keeps
  // archive candidates through final selection → Expect test to fail` (vitest 3.2.6). The fix is
  // the `reranked` flag in `retrieve()`: the round-robin interleave now runs whenever no reranker
  // RANKED the candidates — absent or threw alike — instead of hanging off an `else if` that the
  // catch path skipped.
  it('M3 failing reranker keeps archive candidates through final selection', () => {
    expect(result!.chunks.some((c) => c.sourceKind === 'archive')).toBe(true)
  })
})

// ---- T09-c — the reranker matrix and the abort discipline (P4, M3, plan §9.21 (b)) ------

const T09_QUESTION = 'Treibhausgas Landwirtschaft'

/** Eight document chunks that all answer the question — with `topKFinal` = 6 they fill every
 *  final slot, which is the exact state in which appended-last archive candidates disappear. */
async function seedT09Corpus(): Promise<{ db: Db; embedder: MockEmbedder }> {
  const db = freshDb()
  const embedder = new MockEmbedder()
  await seedDocument(
    db,
    embedder,
    'notes.txt',
    Array.from(
      { length: 8 },
      (_, i) => `Treibhausgas Landwirtschaft Abschnitt ${i} über Methan und Emissionen.`
    )
  )
  return { db, embedder }
}

/** Two archive candidates carrying a marker term the document chunks never use, so a reranker
 *  can prefer them without the assertion depending on the seeded wording. */
function t09Archives(): ExternalCandidate[] {
  return [
    archiveCandidate(0, 'Wikipedia-Auszug: Methan aus der Landwirtschaft ist ein Treibhausgas.'),
    archiveCandidate(1, 'Wikipedia-Auszug: Weitere Treibhausgase sind Lachgas und CO2.')
  ]
}

/** The arm's result shape (#301 P4, plan §9.21 (e)3): `{ candidates, outcomes }`. The M3/T09/T10
 *  cases are about the CANDIDATE pipeline (interleave, abort discipline, scope), so they report no
 *  outcomes — T15-b and T16-a own the outcome contract. */
function testArm(...candidates: ExternalCandidate[]): ExternalRetrievalOutput {
  return { candidates, outcomes: [] }
}

/** A reranker that prefers the archive marker; `calls` proves it actually ran. */
function markerReranker(calls: { n: number }): Reranker {
  return {
    async rerank(_q: string, docs: string[]) {
      calls.n++
      return docs.map((text, index) => ({ index, score: text.includes('Wikipedia-Auszug') ? 10 : 1 }))
    }
  } as unknown as Reranker
}

describe('T09 — reranker present / absent / throwing, and abort as a refusal (P4, M3)', () => {
  it('prerequisite: the seeded documents alone fill every final slot (the state the defect hid in)', async () => {
    const { db, embedder } = await seedT09Corpus()
    const documentsOnly = await retrieve(db, embedder, T09_QUESTION, SETTINGS, null, null)
    expect(documentsOnly.chunks.length).toBe(SETTINGS.topKFinal)
    expect(documentsOnly.chunks.every((c) => c.sourceKind !== 'archive')).toBe(true)
  })

  it('T09 reranker present / absent / throwing with ≥ 8 document candidates plus archives: archive candidates survive final selection on failure and an abort is never converted into an ordinary fallback', async () => {
    // ---- (1) reranker PRESENT: relevance decides, and it may put archives first.
    const present = await seedT09Corpus()
    const calls = { n: 0 }
    const ranked = await retrieve(
      present.db,
      present.embedder,
      T09_QUESTION,
      SETTINGS,
      null,
      markerReranker(calls),
      undefined,
      async () => testArm(...t09Archives())
    )
    expect(calls.n).toBe(1)
    expect(ranked.chunks[0]?.sourceKind).toBe('archive')
    expect(ranked.citations[0]).toMatchObject({
      label: 'S1',
      sourceKind: 'archive',
      packId: 'pack-1',
      archiveTitle: 'Wikipedia (Test)',
      articlePath: 'Artikel'
    })

    // ---- (2) reranker ABSENT: the round-robin interleave keeps both sources in the FINAL set.
    const absent = await seedT09Corpus()
    const interleaved = await retrieve(
      absent.db,
      absent.embedder,
      T09_QUESTION,
      SETTINGS,
      null,
      null,
      undefined,
      async () => testArm(...t09Archives())
    )
    expect(interleaved.chunks.some((c) => c.sourceKind === 'archive')).toBe(true)
    expect(interleaved.chunks.some((c) => c.sourceKind !== 'archive')).toBe(true)
    expect(interleaved.chunks[1]?.sourceKind).toBe('archive')
    expect(interleaved.citations.filter((c) => c.sourceKind === 'archive').length).toBeGreaterThan(0)

    // ---- (3) reranker THROWING (M3): the same interleave, reached through the catch path.
    // Inspected on the FINAL chunks AND citations, not on a helper's intermediate order.
    const failing = await seedT09Corpus()
    const threw = await retrieve(
      failing.db,
      failing.embedder,
      T09_QUESTION,
      SETTINGS,
      null,
      { async rerank() { throw new Error('reranker model failed to load') } } as unknown as Reranker,
      undefined,
      async () => testArm(...t09Archives())
    )
    expect(threw.chunks.length).toBeLessThanOrEqual(SETTINGS.topKFinal)
    expect(threw.chunks.some((c) => c.sourceKind === 'archive')).toBe(true)
    expect(threw.chunks.some((c) => c.sourceKind !== 'archive')).toBe(true)
    const archiveCitation = threw.citations.find((c) => c.sourceKind === 'archive')
    expect(archiveCitation).toMatchObject({
      packId: 'pack-1',
      archiveTitle: 'Wikipedia (Test)',
      articlePath: 'Artikel'
    })
    expect(archiveCitation?.documentId).toBeUndefined()
    // Labels stay dense over the merged set: S1…Sn with no gap.
    expect(threw.chunks.map((c) => c.label)).toEqual(threw.chunks.map((_, i) => `S${i + 1}`))

    // ---- (4) ABORT is never a fallback (T09): a reranker-side AbortError REJECTS the ask
    // instead of resolving with a quietly documents-only answer.
    const abortA = await seedT09Corpus()
    await expect(
      retrieve(
        abortA.db,
        abortA.embedder,
        T09_QUESTION,
        SETTINGS,
        null,
        {
          async rerank() {
            throw new DOMException('The operation was aborted', 'AbortError')
          }
        } as unknown as Reranker,
        undefined,
        async () => testArm(...t09Archives())
      )
    ).rejects.toMatchObject({ name: 'AbortError' })

    // ---- (5) arm-side AbortError (a plain Error with the name, the spelling §9.20 pins).
    const abortB = await seedT09Corpus()
    await expect(
      retrieve(abortB.db, abortB.embedder, T09_QUESTION, SETTINGS, null, null, undefined, async () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      })
    ).rejects.toMatchObject({ name: 'AbortError' })

    // ---- (6) an ALREADY-aborted signal: the ask is cancelled, so even an ordinary arm failure
    // must not be swallowed into a documents-only answer.
    const abortC = await seedT09Corpus()
    const already = new AbortController()
    already.abort()
    await expect(
      retrieve(
        abortC.db,
        abortC.embedder,
        T09_QUESTION,
        SETTINGS,
        null,
        null,
        already.signal,
        async () => {
          throw new Error('drive unplugged')
        }
      )
    ).rejects.toThrow('drive unplugged')

    // ---- (7) MID-FLIGHT abort: the user stops the ask while the arm is running.
    const abortD = await seedT09Corpus()
    const midFlight = new AbortController()
    await expect(
      retrieve(
        abortD.db,
        abortD.embedder,
        T09_QUESTION,
        SETTINGS,
        null,
        null,
        midFlight.signal,
        async () => {
          midFlight.abort()
          throw new DOMException('The operation was aborted', 'AbortError')
        }
      )
    ).rejects.toMatchObject({ name: 'AbortError' })

    // ---- (8) counter-check: with a LIVE signal an ordinary arm failure is still swallowed —
    // an unplugged pack drive must never break asking (P4's outcome step reports it instead).
    const tolerated = await seedT09Corpus()
    const live = new AbortController()
    const degraded = await retrieve(
      tolerated.db,
      tolerated.embedder,
      T09_QUESTION,
      SETTINGS,
      null,
      null,
      live.signal,
      async () => {
        throw new Error('drive unplugged')
      }
    )
    expect(degraded.chunks.length).toBeGreaterThan(0)
    expect(degraded.chunks.every((c) => c.sourceKind !== 'archive')).toBe(true)
  })
})

// ---- T10-a — the effective document scope under `documentsOff` (P4, M10, §9.21 (a)) ----

const T10_QUESTION = 'Treibhausgas Landwirtschaft'

interface ScopeHarness {
  db: Db
  embedder: MockEmbedder
  notesId: string
  attachmentId: string
  projectId: string
  libraryId: string
}

/**
 * A real migrated temp-file DB with: one indexed, chunked, embedded document filed in a project
 * (`notes.txt`, `tree_status='ready'`, extraction records), one attachment document, and NO
 * archived document — the exact state in which `canIterateResident()` is true, so the resident
 * fast path (which bypasses the SQL builder) is really exercised.
 */
async function seedScopeHarness(): Promise<ScopeHarness> {
  const db = freshDb()
  const embedder = new MockEmbedder()
  const notesId = await seedDocument(db, embedder, 'notes.txt', [
    'Treibhausgas Landwirtschaft: Methan und Emissionen im Betrieb.',
    'Treibhausgas Landwirtschaft: Lachgas aus Düngemitteln.'
  ])
  const attachmentId = await seedDocument(db, embedder, 'attachment.txt', [
    'Treibhausgas Landwirtschaft: die angehängte Datei über Emissionen.'
  ])
  const libraryId = getBuiltinCollection(db, 'library')!.id
  const projectId = createCollection(db, 'Klima').id
  addToCollection(db, [notesId], libraryId)
  addToCollection(db, [notesId], projectId)
  db.prepare("UPDATE documents SET tree_status = 'ready' WHERE id = ?").run(notesId)
  const now = new Date().toISOString()
  const chunkId = (
    db.prepare('SELECT id FROM chunks WHERE document_id = ? LIMIT 1').get(notesId) as unknown as {
      id: string
    }
  ).id
  for (const [type, value, normalized] of [
    ['generic', 'Methan', 'methan'],
    ['__scan__', '', 'ok']
  ] as const) {
    db.prepare(
      `INSERT INTO extraction_records (id, document_id, chunk_id, record_type, value_text,
         normalized_value, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), notesId, chunkId, type, value, normalized, randomUUID(), now)
  }
  return { db, embedder, notesId, attachmentId, projectId, libraryId }
}

/** An embedder that must never be called: reaching it means the document arm was not skipped. */
function throwingEmbedder(calls: { n: number }): Embedder {
  return {
    id: new MockEmbedder().id,
    dimensions: 384,
    async embed(): Promise<Float32Array[]> {
      calls.n++
      throw new Error('the embedder must not be reached in a documents-off ask')
    }
  }
}

/** Record every SQL string a `retrieve` call compiles (the resident-cache load and the FTS
 *  query are both visible there — no ESM module spy needed, which does not work here). */
function sqlSpy(db: Db): { seen: string[]; restore: () => void } {
  const original = db.prepare.bind(db)
  const seen: string[] = []
  ;(db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    seen.push(sql)
    return original(sql)
  }
  return { seen, restore: () => Reflect.deleteProperty(db as unknown as object, 'prepare') }
}

describe('T10 — effective document scope under the documents-off flag (P4, M10)', () => {
  it('prerequisite: without the flag every route reads the seeded corpus (documents, keyword, skills, filename, reindex, extracts, resident vectors)', async () => {
    const h = await seedScopeHarness()
    const conv = createConversation(h.db, { mode: 'documents' })
    setScope(h.db, conv.id, { collectionIds: [h.projectId], documentIds: [], packIds: ['p1'] })
    const scope = resolveScope(h.db, conv.id)
    expect(scope.noDocuments).toBeUndefined()
    expect(buildScopeFilter(scope, 'd.id')?.sql).not.toBe('0')
    expect(documentsInScope(h.db, scope, { requireChunks: true }).map((d) => d.title)).toEqual([
      'notes.txt'
    ])
    expect(
      keywordSearchChunks(h.db, T10_QUESTION, 10, {
        embeddingModelId: h.embedder.id,
        collectionIds: scope.collectionIds
      }).length
    ).toBeGreaterThan(0)
    // A corpus invisible to another embedder is exactly the REINDEX_NEEDED state.
    expect(corpusNeedsReindex(h.db, 'some-other-model', scope)).toBe(true)
    expect(aggregateExtractions(h.db, scope, 'generic').items.length).toBeGreaterThan(0)
    // The resident fast path is genuinely live here: no scope ids, no archived documents.
    expect(
      (
        h.db
          .prepare("SELECT COUNT(*) AS n FROM documents WHERE lifecycle = 'archived'")
          .get() as unknown as { n: number }
      ).n
    ).toBe(0)
    const [queryVector] = await h.embedder.embed([T10_QUESTION])
    const wholeCorpus = new VectorIndex(h.db, h.embedder, { embeddingModelId: h.embedder.id })
    expect(wholeCorpus.search(queryVector!, 10).length).toBeGreaterThan(0)
  })

  it('T10 every scope truth-table row through persist / parse / resolve, resident-vector and scoped-SQL paths and the keyword / skills / filename / whole-doc / reindex routes: exact allowed document ids, no implicit all-documents expansion, attachments per policy, chip agrees; true packs-only mode calls no embedder and loads no document cache', async () => {
    const h = await seedScopeHarness()
    const rawScope = (id: string): string | null =>
      (
        h.db.prepare('SELECT scope_v2_json AS j FROM conversations WHERE id = ?').get(id) as unknown as {
          j: string | null
        }
      ).j

    // ---- (A) PERSISTENCE through BOTH owners, and byte-identity for a documents-ON scope.
    const conv = createConversation(h.db, { mode: 'documents' })
    setScope(h.db, conv.id, { collectionIds: [], documentIds: [], packIds: ['p1'] })
    expect(rawScope(conv.id)).toBe('{"collectionIds":[],"documentIds":[],"packIds":["p1"]}')
    setScope(h.db, conv.id, { collectionIds: [], documentIds: [], packIds: ['p1'], documentsOff: true })
    expect(rawScope(conv.id)).toBe(
      '{"collectionIds":[],"documentIds":[],"packIds":["p1"],"documentsOff":true}'
    )
    expect(getConversation(h.db, conv.id)!.scope).toEqual({
      collectionIds: [],
      documentIds: [],
      includeArchived: false,
      packIds: ['p1'],
      documentsOff: true
    })
    // Only the literal `true` survives the whitelist — a hand-edited row cannot fake the flag.
    expect(parseDocumentScope('{"collectionIds":[],"documentIds":[],"documentsOff":"yes"}')?.documentsOff)
      .toBeUndefined()
    expect(parseDocumentScope('{"collectionIds":[],"documentIds":[],"documentsOff":1}')?.documentsOff)
      .toBeUndefined()

    // ---- (B) THE TRUTH TABLE (§5.4), each row through createConversation / setScope /
    // conversation_documents → resolveScope, asserting the EXACT resolved shape.
    const row = (
      scope: Parameters<typeof setScope>[2],
      opts: { attach?: boolean; legacyIds?: string[]; legacyCollection?: string } = {}
    ): ReturnType<typeof resolveScope> => {
      const c = createConversation(h.db, { mode: 'documents' })
      if (opts.legacyIds) {
        h.db
          .prepare('UPDATE conversations SET scope_json = ? WHERE id = ?')
          .run(JSON.stringify(opts.legacyIds), c.id)
      } else if (opts.legacyCollection) {
        h.db
          .prepare('UPDATE conversations SET collection_id = ? WHERE id = ?')
          .run(opts.legacyCollection, c.id)
      } else {
        setScope(h.db, c.id, scope)
      }
      if (opts.attach) linkConversationDocument(h.db, c.id, h.attachmentId)
      return resolveScope(h.db, c.id)
    }

    // Row 1 — legacy empty, no attachments: the whole corpus, exactly as before.
    const r1 = row({ collectionIds: [], documentIds: [] })
    expect(r1).toMatchObject({ collectionIds: null, documentIds: null, hasExplicitDocSelection: false })
    expect(r1.noDocuments).toBeUndefined()

    // Row 2 — legacy empty with an attachment: the attachment only (unchanged behaviour).
    const r2 = row({ collectionIds: [], documentIds: [] }, { attach: true })
    expect(r2.documentIds).toEqual([h.attachmentId])
    expect(r2.noDocuments).toBeUndefined()

    // Row 3 — a pack added FROM "All documents": documents stay on (the combination the
    // superseded `packsOnly` derivation made inexpressible is expressible again).
    const r3 = row({ collectionIds: [], documentIds: [], packIds: ['p1'] })
    expect(r3).toMatchObject({ collectionIds: null, documentIds: null, packIds: ['p1'] })
    expect(r3.noDocuments).toBeUndefined()

    // Row 4 — documents off, no attachments: the explicit deny-all state.
    const r4 = row({ collectionIds: [], documentIds: [], packIds: ['p1'], documentsOff: true })
    expect(r4).toMatchObject({
      collectionIds: null,
      documentIds: null,
      packIds: ['p1'],
      hasExplicitDocSelection: false,
      noDocuments: true
    })

    // Row 5 — documents off WITH attachments: exactly the attachments; the retained project
    // and hand-picked documents are dropped, and they never re-enter as a hand-pick.
    const r5 = row(
      {
        collectionIds: [h.projectId],
        documentIds: [h.notesId],
        packIds: ['p1'],
        documentsOff: true
      },
      { attach: true }
    )
    expect(r5.documentIds).toEqual([h.attachmentId])
    expect(r5.collectionIds).toBeNull()
    expect(r5.hasExplicitDocSelection).toBe(false)
    expect(r5.noDocuments).toBeUndefined()

    // Row 6 — explicit documents/projects + packs, no flag: the union and the attachment rules
    // are untouched.
    const r6 = row({ collectionIds: [h.projectId], documentIds: [h.notesId], packIds: ['p1'] }, { attach: true })
    expect(r6.collectionIds).toEqual([h.projectId])
    expect(r6.documentIds).toEqual([h.notesId, h.attachmentId])
    expect(r6.hasExplicitDocSelection).toBe(true)
    expect(r6.noDocuments).toBeUndefined()

    // Row 7 — documents off, then the LAST pack and attachment removed: still no documents.
    // No implicit all-documents expansion; an explicit reset is the only way back.
    const last = createConversation(h.db, { mode: 'documents' })
    setScope(h.db, last.id, { collectionIds: [], documentIds: [], packIds: ['p1'], documentsOff: true })
    linkConversationDocument(h.db, last.id, h.attachmentId)
    expect(resolveScope(h.db, last.id).documentIds).toEqual([h.attachmentId])
    h.db.prepare('DELETE FROM conversation_documents WHERE conversation_id = ?').run(last.id)
    setScope(h.db, last.id, { collectionIds: [], documentIds: [], documentsOff: true })
    const r7 = resolveScope(h.db, last.id)
    expect(r7).toMatchObject({ collectionIds: null, documentIds: null, packIds: null, noDocuments: true })
    // The explicit reset (the popover's button) restores all documents.
    setScope(h.db, last.id, { collectionIds: [], documentIds: [] })
    expect(resolveScope(h.db, last.id).noDocuments).toBeUndefined()

    // Legacy rows (1–2 of the table) can never carry the flag: neither fallback ever
    // resolves to deny-all, whatever the legacy column holds.
    expect(row({ collectionIds: [], documentIds: [] }, { legacyIds: [h.notesId] })).toMatchObject({
      documentIds: [h.notesId],
      hasExplicitDocSelection: true
    })
    expect(row({ collectionIds: [], documentIds: [] }, { legacyIds: [h.notesId] }).noDocuments).toBeUndefined()
    expect(
      row({ collectionIds: [], documentIds: [] }, { legacyCollection: h.projectId }).noDocuments
    ).toBeUndefined()

    // ---- (C) EVERY CONSUMER honours the resolved deny-all state.
    const denyAll = r4
    // The one SQL builder is fail-closed — and stays fail-closed under a contradictory spread.
    expect(buildScopeFilter(denyAll, 'd.id')).toEqual({ sql: '0', params: [] })
    expect(buildScopeFilter(denyAll, 'c.document_id')).toEqual({ sql: '0', params: [] })
    expect(buildScopeFilter({ ...denyAll, documentIds: [h.notesId] }, 'd.id')).toEqual({
      sql: '0',
      params: []
    })
    // Skills / whole-document / compare routing all read `documentsInScope`.
    expect(documentsInScope(h.db, denyAll, { requireChunks: true })).toEqual([])
    expect(documentsInScope(h.db, denyAll, { requireChunks: false })).toEqual([])
    // Filename auto-scope runs over that same (now empty) list — no match can be invented.
    expect(
      detectFilenameScope(
        'was steht in notes.txt?',
        documentsInScope(h.db, denyAll, { requireChunks: true })
      )
    ).toBeNull()
    // Keyword arm: the pass-through reaches the same fail-closed builder.
    expect(
      keywordSearchChunks(h.db, T10_QUESTION, 10, {
        embeddingModelId: h.embedder.id,
        noDocuments: true
      })
    ).toEqual([])
    // Re-index honesty: no indexed document in scope ⇒ false ⇒ the no-context answer, never
    // the REINDEX answer (the prerequisite test proves the same call is `true` without the flag).
    expect(corpusNeedsReindex(h.db, 'some-other-model', denyAll)).toBe(false)
    // Aggregation/extracts.
    const aggregated = aggregateExtractions(h.db, denyAll, 'generic')
    expect(aggregated.items).toEqual([])
    expect(aggregated.scannedChunks).toBe(0)
    expect(aggregated.totalChunks).toBe(0)
    // The three `registerRagIpc.ts` routing helpers are module-private; each splices this same
    // builder into ` AND ${filter.sql}`. Replicating that one-line composition shows the `0`
    // reaches them: the scan marker is not found and both counters read 0.
    const recFilter = buildScopeFilter(denyAll, 'document_id')!
    expect(
      h.db
        .prepare(
          `SELECT 1 FROM extraction_records WHERE record_type = ? AND ${recFilter.sql} LIMIT 1`
        )
        .get('__scan__', ...recFilter.params)
    ).toBeUndefined()
    const docFilter = buildScopeFilter(denyAll, 'd.id')!
    expect(
      (
        h.db
          .prepare(
            `SELECT COUNT(*) AS n FROM documents d WHERE d.tree_status = 'ready' AND ${docFilter.sql}`
          )
          .get(...docFilter.params) as unknown as { n: number }
      ).n
    ).toBe(0)
    expect(
      (
        h.db
          .prepare(
            `SELECT COUNT(*) AS n FROM documents d WHERE d.status = 'indexed'
               AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id)
               AND d.fully_chunked IS NULL AND ${docFilter.sql}`
          )
          .get(...docFilter.params) as unknown as { n: number }
      ).n
    ).toBe(0)

    // ---- (D) THE RESIDENT-VECTOR BYPASS, with REAL embeddings and no archived documents —
    // the state in which `canIterateResident()` is true and the SQL builder is never consulted.
    const [queryVector] = await h.embedder.embed([T10_QUESTION])
    const ordinary = new VectorIndex(h.db, h.embedder, { embeddingModelId: h.embedder.id })
    expect(ordinary.search(queryVector!, 10).length).toBeGreaterThan(0)
    const denied = new VectorIndex(h.db, h.embedder, {
      embeddingModelId: h.embedder.id,
      noDocuments: true
    })
    expect(denied.search(queryVector!, 10)).toEqual([])

    // ---- (E) TRUE PACKS-ONLY: no query embedding, no resident-cache load, no FTS — the arm
    // still runs and its candidates are the whole answer.
    const packsOnly = await seedScopeHarness()
    const embedCalls = { n: 0 }
    const spy = sqlSpy(packsOnly.db)
    let armCalls = 0
    const result = await retrieve(
      packsOnly.db,
      throwingEmbedder(embedCalls),
      T10_QUESTION,
      SETTINGS,
      denyAll,
      null,
      undefined,
      async () => {
        armCalls++
        return testArm(archiveCandidate(0, 'Methan aus der Landwirtschaft ist ein Treibhausgas.'))
      }
    )
    spy.restore()
    expect(embedCalls.n).toBe(0)
    expect(armCalls).toBe(1)
    expect(result.chunks.length).toBe(1)
    expect(result.chunks.every((c) => c.sourceKind === 'archive')).toBe(true)
    expect(spy.seen.filter((sql) => /FROM embeddings/i.test(sql))).toEqual([])
    expect(spy.seen.filter((sql) => /chunks_fts/i.test(sql))).toEqual([])
    // The counter-check (D4's rejection, pinned): the SAME scope WITHOUT the flag keeps the
    // document arms — it is the flag, never the emptiness, that turns them off.
    const withDocuments = await retrieve(
      packsOnly.db,
      packsOnly.embedder,
      T10_QUESTION,
      SETTINGS,
      { ...denyAll, noDocuments: undefined },
      null,
      undefined,
      async () => testArm(archiveCandidate(0, 'Methan aus der Landwirtschaft ist ein Treibhausgas.'))
    )
    expect(withDocuments.chunks.some((c) => c.sourceKind !== 'archive')).toBe(true)

    // ---- (F) THE CHIP AGREES with the resolved scope: the stored scope that resolves to
    // deny-all renders as the packs phrase plus the honest "documents off" tail, and with no
    // pack ticked it names the state instead of a corpus. (The popover's own emit/tick cases
    // are pinned in tests/renderer/KnowledgePacks.test.tsx.)
    const tt = ((key: string, params?: Record<string, string | number>) =>
      t('en', key as never, params as never)) as unknown as Parameters<typeof scopeSources>[2]
    const tCount = ((key: string, count: number) =>
      t('en', `${key}.${count === 1 ? 'one' : 'other'}` as never, { count } as never)) as unknown as Parameters<
      typeof scopeSources
    >[3]
    const chip = scopeSources(
      { collectionIds: [], documentIds: [], packIds: ['p1'], documentsOff: true },
      [],
      tt,
      tCount,
      [{ id: 'p1', title: 'Wikipedia (DE)' } as never]
    )
    expect(chip).toBe(`Pack: Wikipedia (DE) · ${t('en', 'chat.scope.documentsOffSuffix')}`)
    expect(
      scopeSources({ collectionIds: [], documentIds: [], documentsOff: true }, [], tt, tCount, [])
    ).toBe(t('en', 'chat.scope.documentsOffNoPacks'))
    // Without the flag the same empty scope still means the whole corpus (null = no phrase).
    expect(scopeSources({ collectionIds: [], documentIds: [] }, [], tt, tCount, [])).toBeNull()
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
    const produced = await collectPackCandidates(
      port,
      packs,
      'Wie entsteht Treibhausgas in der Landwirtschaft?'
    )
    out = produced.candidates
  })

  it('prerequisite: the arm searched at least one pack and produced candidates', () => {
    expect(searched.length).toBeGreaterThan(0)
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((c) => c.sourceKind === 'archive')).toBe(true)
  })

  // FLIPPED from `it.fails` to `it` by #301 P4 (plan §9.21 (c), §0.3 item 2). The inverted
  // baseline was demonstrated RED against the repaired arm first — "Expect test to fail" on
  // 2026-09-06 — and only then flipped, so a green here is the fix, not a broken fixture.
  it('M8 three productive packs are all searched', () => {
    expect(searched).toContain('pack-C')
  })
})

// ---- T15 — allocation, concurrency, the selection cap, the deadline and abort (P4, M8) ---
//
// The M8 case above proves only that a third pack is reached. This one is the whole contract of
// plan §9.21 (c): WHICH candidates are admitted (not merely which packs were searched), that the
// answer does not depend on which pack happened to finish first, that at most two packs are in
// flight, that a persisted 13-pack selection is trimmed in title order and told so, that the
// per-ask deadline truncates instead of hanging, and that an abort stops the work dead.
//
// Everything ordering-related is established with controlled promises (entered/release pairs on
// the fixture server) and counters, never with a sleep.

describe('T15 — fair allocation, bounded concurrency, the selection cap, the deadline and abort (P4, M8)', () => {
  let t15Server: http.Server
  let t15Port = 0
  /** How each book answers `/search`. */
  const t15Behaviour = new Map<string, 'long' | 'short' | 'empty' | 'fail'>()
  /** Serving name per book id — a hit's `urlId` must equal the published name for that pack. */
  const t15Names = new Map<string, string>()
  /** Every request path the fixture received, in arrival order. */
  let t15Requests: string[] = []
  /** The `books.id` of every `/search`, in arrival order. */
  let t15Searches: string[] = []
  /** The concurrency oracle: handlers currently inside the fixture, and the maximum seen. */
  let t15InFlight = 0
  let t15MaxInFlight = 0
  /** Per-request parking. Returning a promise holds the RESPONSE until it resolves. */
  let t15Hold: ((kind: 'search' | 'raw', book: string) => Promise<void> | undefined) | null = null

  const t15Reset = (): void => {
    t15Requests = []
    t15Searches = []
    t15InFlight = 0
    t15MaxInFlight = 0
    t15Hold = null
  }
  /** One event-loop turn through the TIMER and POLL phases, so real loopback I/O has a chance
   *  to land: a `setImmediate` spin completes hundreds of rounds in microseconds and would
   *  "prove" that a socket never answered. Used to let already-scheduled work run before a
   *  "nothing more happened" assertion — never as the proof of an ordering (the gates do that). */
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1))
  const waitUntil = async (cond: () => boolean, rounds = 500): Promise<boolean> => {
    for (let i = 0; i < rounds; i++) {
      if (cond()) return true
      await tick()
    }
    return cond()
  }

  beforeAll(async () => {
    t15Server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      t15Requests.push(`${url.pathname}${url.search}`)
      t15InFlight++
      t15MaxInFlight = Math.max(t15MaxInFlight, t15InFlight)
      const leave = (): void => {
        t15InFlight--
      }
      if (url.pathname === '/search') {
        const book = url.searchParams.get('books.id') ?? ''
        t15Searches.push(book)
        const send = (): void => {
          leave()
          const behaviour = t15Behaviour.get(book) ?? 'long'
          if (behaviour === 'fail') {
            res.writeHead(500)
            res.end('boom')
            return
          }
          const titles =
            behaviour === 'empty'
              ? []
              : behaviour === 'short'
                ? [`${book} Artikel 0`]
                : Array.from({ length: ARTICLES_PER_PACK }, (_, i) => `${book} Artikel ${i}`)
          res.writeHead(200, { 'content-type': 'application/xml' })
          res.end(searchXml(t15Names.get(book) ?? `book-${book}`, titles))
        }
        const held = t15Hold?.('search', book)
        if (held) void held.then(send)
        else send()
        return
      }
      if (url.pathname.startsWith('/raw/')) {
        const article = decodeURIComponent(url.pathname.split('/content/')[1] ?? '').replace(/_/g, ' ')
        const book = article.split(' Artikel')[0] ?? ''
        const send = (): void => {
          leave()
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(longArticleHtml(article))
        }
        const held = t15Hold?.('raw', book)
        if (held) void held.then(send)
        else send()
        return
      }
      leave()
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => t15Server.listen(0, '127.0.0.1', resolve))
    t15Port = (t15Server.address() as AddressInfo).port
  })

  afterAll(() => new Promise<void>((resolve) => t15Server.close(() => resolve())))

  /** N packs named so their `title COLLATE NOCASE, id` order IS their array order. */
  const t15Packs = (n: number, prefix = 'pk'): Array<{ id: string; title: string }> =>
    Array.from({ length: n }, (_, i) => {
      const id = `${prefix}-${String(i).padStart(2, '0')}`
      t15Behaviour.set(id, 'long')
      t15Names.set(id, `book-${id}`)
      return { id, title: `Pack ${id}` }
    })

  /** A REAL `ZimService` over a real temp DB with fake children, the fixture server as its
   *  sidecar, and (optionally) a tiny per-ask deadline — the P3a/P3b harness shape. */
  function t15Service(opts: { externalDeadlineMs?: number } = {}): {
    db: Db
    zimDir: string
    svc: ZimService
    addPack(leaf: string): Promise<string>
    close(): Promise<void>
  } {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-t15-'))
    const zimDir = join(root, 'zim')
    mkdirSync(zimDir, { recursive: true })
    const libraryDir = join(root, 'library')
    mkdirSync(libraryDir, { recursive: true })
    const db = openDatabase(join(root, 'test.sqlite'))
    let pid = 6100
    const spawn: SpawnFn = () => new ServeFakeChild(pid++, 'exit-on-sigterm')
    const manageSpawn: SpawnFn = (_command, args) => {
      const libraryXmlPath = args[0] as string
      const zimPath = args[2] as string
      const child = new ServeFakeChild(pid++, 'exit-on-sigterm')
      queueMicrotask(() => {
        if (child.killed) return
        const leaf = basename(zimPath)
        appendFileSync(
          libraryXmlPath,
          `<book id="${readZimHeader(zimPath).uuid}" path="${zimPath.replace(/\\/g, '/')}" ` +
            `title="Title of ${leaf}" description="Test archive" language="deu" ` +
            `date="2026-07-01" articleCount="41" mediaCount="7" />\n`
        )
        child.emit('exit', 0, null)
      })
      return child
    }
    const svc = new ZimService({
      rootPath: root,
      isDev: true,
      deps: {
        resolveTools: () => ({ serve: '/bin/kiwix-serve', manage: '/bin/kiwix-manage' }),
        spawn,
        manageSpawn,
        findPort: async () => t15Port,
        probe: async () => true,
        verifyBinary: async () => 'ok',
        healthTimeoutMs: 1_000,
        healthIntervalMs: 1,
        killGraceMs: 5,
        forceKillWaitMs: 5,
        libraryDir,
        externalDeadlineMs: opts.externalDeadlineMs
      }
    })
    return {
      db,
      zimDir,
      svc,
      addPack: async (leaf) => {
        const file = writeZimFixture(join(zimDir, leaf), packUuid('7f7f7f7f', leaf.slice(0, 6)), {
          trailing: `body of ${leaf}`
        })
        const pack = await svc.registerPack(db, file)
        t15Behaviour.set(pack.id, 'short')
        t15Names.set(pack.id, servingNameFor(file))
        return pack.id
      },
      close: async () => {
        await svc.stop()
      }
    }
  }

  const QUESTION = 'Wie entsteht Treibhausgas in der Landwirtschaft?'

  it("T15 1 / 3 / 7 / 12 packs and a 13-pack persisted selection with short / empty / long / failed packs and varied completion order: search participation AND candidate admission are fair, at most 24 candidates, MAX_SELECTED_PACKS = 12 enforced in the popover and by trimming with a 'not searched: selection limit' outcome, concurrency ≤ 2, a late most-relevant hit reaches the reranker, no work after abort", async () => {
    // ---- (1) 1 / 3 / 7 / 12 PRODUCTIVE PACKS: the quota arithmetic, in pack order --------
    for (const n of [1, 3, 7, 12]) {
      t15Reset()
      const packs = t15Packs(n, `n${n}`)
      const { candidates, outcomes } = await collectPackCandidates(t15Port, packs, QUESTION)
      // EVERY pack is searched — the M8 defect was that the budget ran out first.
      expect(t15Searches.sort(), `N = ${n}`).toEqual(packs.map((p) => p.id).sort())
      expect(candidates.length, `N = ${n}`).toBeLessThanOrEqual(MAX_EXTERNAL_CANDIDATES)
      expect(outcomes, `N = ${n}`).toHaveLength(n)
      for (const [i, pack] of packs.entries()) {
        const outcome = outcomes.find((o) => o.packId === pack.id)!
        expect(outcome, `N = ${n} pack ${i}`).toMatchObject({
          title: pack.title,
          status: 'searched',
          reason: null
        })
        // Each pack fetched articles only until it held its provisional quota, and admission
        // gave it exactly that (or everything it had, when the archive was shorter).
        expect(outcome.admitted, `N = ${n} pack ${i}`).toBe(
          Math.min(outcome.found, packQuota(i, n))
        )
        expect(outcome.admitted, `N = ${n} pack ${i}`).toBeGreaterThan(0)
        expect(
          candidates.filter((c) => c.packId === pack.id),
          `N = ${n} pack ${i}`
        ).toHaveLength(outcome.admitted)
      }
      // With more material than budget, the budget is spent to the last slot.
      if (n >= 3) expect(candidates, `N = ${n}`).toHaveLength(MAX_EXTERNAL_CANDIDATES)
      // A single pack is bounded by ARTICLES_PER_PACK, not by the 24-candidate ceiling.
      if (n === 1) {
        expect(t15Requests.filter((r) => r.startsWith('/raw/'))).toHaveLength(ARTICLES_PER_PACK)
      }
    }

    // ---- (2) SHORT / EMPTY / FAILED PACKS: their slots are reclaimed, and they are REPORTED
    {
      t15Reset()
      const packs = t15Packs(7, 'mix')
      t15Behaviour.set(packs[1]!.id, 'short')
      t15Behaviour.set(packs[3]!.id, 'empty')
      t15Behaviour.set(packs[5]!.id, 'fail')
      const { candidates, outcomes } = await collectPackCandidates(t15Port, packs, QUESTION)
      const outcomeOf = (i: number) => outcomes.find((o) => o.packId === packs[i]!.id)!
      // A pack whose `/search` answered 500 is a FAILED pack for this ask — not a silent
      // absence, which is exactly what the pre-P4 arm produced.
      expect(outcomeOf(5)).toMatchObject({ status: 'failed', reason: 'search-failed', found: 0, admitted: 0 })
      // Zero hits is a SUCCESSFUL search (§2.5 item 4), never a failure.
      expect(outcomeOf(3)).toMatchObject({ status: 'searched', reason: null, found: 0, admitted: 0 })
      expect(outcomeOf(1)).toMatchObject({ status: 'searched', reason: null })
      expect(outcomeOf(1).found).toBeGreaterThan(0)
      // The four productive packs all reached the candidate set…
      for (const i of [0, 2, 4, 6]) expect(outcomeOf(i).admitted).toBeGreaterThan(0)
      // …and every empty/failed pack's slots went to them: nothing was left unused while a
      // productive pack still had fetched material waiting.
      expect(candidates.length).toBeLessThanOrEqual(MAX_EXTERNAL_CANDIDATES)
      expect(candidates.length).toBe(outcomes.reduce((sum, o) => sum + o.admitted, 0))
      for (const outcome of outcomes) expect(outcome.admitted).toBe(
        Math.min(outcome.found, outcome.admitted || outcome.found)
      )
      // The failed and empty packs were still ASKED — participation is not silently skipped.
      expect(t15Searches.sort()).toEqual(packs.map((p) => p.id).sort())
    }

    // ---- (3) VARIED COMPLETION ORDER + CONCURRENCY ≤ 2 + THE LATE BEST HIT --------------
    // Every `/search` is parked and released LAST-IN-FIRST-OUT, so packs finish in a
    // different order than they started. The admitted set must be byte-identical to the
    // unparked run: assembly reads the PACK order, never the settle order.
    let baseline: string[] = []
    {
      t15Reset()
      const packs = t15Packs(7, 'ord')
      baseline = (await collectPackCandidates(t15Port, packs, QUESTION)).candidates.map(
        (c) => c.chunkId
      )
      expect(t15MaxInFlight).toBeGreaterThan(0)
    }
    {
      t15Reset()
      const packs = t15Packs(7, 'ord')
      const arrival: string[] = []
      const released: string[] = []
      // Each search is held until the SECOND worker's search has also entered, and the pair is
      // then answered last-in-first-out — a genuine entered/release pair, not a delay.
      let parked: { book: string; gate: ServeGate<void> } | null = null
      const release = (entry: { book: string; gate: ServeGate<void> }): void => {
        released.push(entry.book)
        entry.gate.release()
      }
      t15Hold = (kind, book) => {
        if (kind !== 'search') return undefined
        arrival.push(book)
        const entry = { book, gate: serveGate<void>() }
        if (parked) {
          const first = parked
          parked = null
          release(entry) // the LATER arrival is answered FIRST
          release(first)
        } else if (arrival.length === packs.length) {
          release(entry) // the last, unpaired pack
        } else {
          parked = entry
        }
        return entry.gate.wait()
      }
      const { candidates, outcomes } = await collectPackCandidates(t15Port, packs, QUESTION)
      // The release order really WAS different from the arrival order…
      expect(released).toHaveLength(arrival.length)
      expect(released).not.toEqual(arrival)
      // …and the result is exactly the same as the unparked run.
      expect(candidates.map((c) => c.chunkId)).toEqual(baseline)
      // Bounded concurrency: two packs in flight, never a third (the parked server is what
      // makes this observable — with instant responses the counter would rarely exceed 1).
      expect(t15MaxInFlight).toBe(2)
      // The LATE pack — the last one released — still has its best hit admitted, because
      // admission happens only after every pack settled. Its first candidate is in the first
      // round of the round-robin, ahead of every other pack's second.
      const late = released[released.length - 1]!
      const lateIndex = packs.findIndex((p) => p.id === late)
      expect(outcomes.find((o) => o.packId === late)!.admitted).toBeGreaterThan(0)
      const firstRound = candidates.slice(0, packs.length).map((c) => c.packId)
      expect(firstRound).toContain(late)
      expect(candidates.find((c) => c.packId === late)!.chunkId).toBe(
        baseline[lateIndex] // its top hit, in its own position in the first round
      )
    }

    // ---- (4) A PERSISTED 13-PACK SELECTION: trimmed in title order, and TOLD SO ---------
    // Driven the way a real ask is: the scope is persisted on a conversation, resolved by
    // `resolveScope`, and handed to the REAL service — no hand-made pack list anywhere.
    {
      const h = t15Service()
      try {
        t15Reset()
        const ids: string[] = []
        for (let i = 1; i <= MAX_SELECTED_PACKS + 1; i++) {
          ids.push(await h.addPack(`p${String(i).padStart(2, '0')}.zim`))
        }
        const conv = createConversation(h.db, { title: 'Cap' })
        setScope(h.db, conv.id, { collectionIds: [], documentIds: [], packIds: ids })
        const scope = resolveScope(h.db, conv.id)
        expect(scope.packIds).toHaveLength(MAX_SELECTED_PACKS + 1)

        const { candidates, outcomes } = await h.svc.runArm(h.db, scope.packIds, QUESTION)
        expect(outcomes).toHaveLength(MAX_SELECTED_PACKS + 1) // every id gets an answer
        // `title COLLATE NOCASE, id` puts "Title of p13.zim" last, so THAT is the pack the cap
        // trims — deterministically, whatever order the ids were persisted in.
        const trimmed = outcomes.filter((o) => o.reason === 'selection-limit')
        expect(trimmed).toHaveLength(1)
        expect(trimmed[0]).toMatchObject({
          packId: ids[MAX_SELECTED_PACKS]!,
          title: 'Title of p13.zim',
          status: 'skipped',
          found: 0,
          admitted: 0
        })
        // …and it was never searched: the cap is applied BEFORE any request goes out.
        expect(t15Searches).not.toContain(ids[MAX_SELECTED_PACKS]!)
        expect(new Set(t15Searches).size).toBe(MAX_SELECTED_PACKS)
        expect(outcomes.filter((o) => o.status === 'searched')).toHaveLength(MAX_SELECTED_PACKS)
        // The global budget still holds across twelve packs, two candidates each.
        expect(candidates.length).toBeLessThanOrEqual(MAX_EXTERNAL_CANDIDATES)
        expect(candidates).toHaveLength(MAX_EXTERNAL_CANDIDATES)
        expect(outcomes.reduce((sum, o) => sum + o.admitted, 0)).toBe(candidates.length)
      } finally {
        await h.close()
      }
    }

    // ---- (5) THE PER-ASK DEADLINE truncates and the ask still answers -------------------
    {
      const h = t15Service({ externalDeadlineMs: 150 })
      try {
        t15Reset()
        const ids: string[] = []
        for (let i = 1; i <= 5; i++) ids.push(await h.addPack(`d${i}.zim`))
        // Nothing is ever released: every search hangs, so the deadline is the only way out.
        t15Hold = (kind) => (kind === 'search' ? new Promise<void>(() => {}) : undefined)
        const { candidates, outcomes } = await h.svc.runArm(h.db, ids, QUESTION)
        // The ask RESOLVES — a truncated archive arm must not fail the question.
        expect(candidates).toEqual([])
        expect(outcomes).toHaveLength(5)
        // The two packs that were in flight when the deadline fired are `timeout`; the three
        // that were never started are `deadline`. Both are `skipped`/`failed` with a reason —
        // never a silent absence.
        const timedOut = outcomes.filter((o) => o.reason === 'timeout')
        const notStarted = outcomes.filter((o) => o.reason === 'deadline')
        expect(timedOut).toHaveLength(2)
        expect(timedOut.every((o) => o.status === 'failed')).toBe(true)
        expect(notStarted).toHaveLength(3)
        expect(notStarted.every((o) => o.status === 'skipped')).toBe(true)
        expect(new Set(t15Searches).size).toBe(2) // only the two in-flight packs were asked
        t15Hold = null
      } finally {
        await h.close()
      }
    }

    // ---- (6) NO WORK AFTER ABORT -------------------------------------------------------
    {
      const h = t15Service()
      try {
        t15Reset()
        const ids: string[] = []
        for (let i = 1; i <= 4; i++) ids.push(await h.addPack(`a${i}.zim`))
        const gates: Array<ServeGate<void>> = []
        t15Hold = (kind) => {
          if (kind !== 'search') return undefined
          const gate = serveGate<void>()
          gates.push(gate)
          return gate.wait()
        }
        const ctrl = new AbortController()
        const asking = h.svc.runArm(h.db, ids, QUESTION, ctrl.signal)
        // Handled so an abort rejection never becomes an unhandled rejection.
        const settled = asking.then(
          () => null,
          (err: unknown) => err
        )
        // Both workers are really inside a parked request before the abort — the entered half
        // of the entered/release pair.
        expect(await waitUntil(() => gates.length >= 2)).toBe(true)
        const requestsAtAbort = t15Requests.length
        ctrl.abort() // the user cancelled the ask
        t15Hold = null
        for (const gate of gates) gate.release()
        const err = await settled
        // A cancellation is an AbortError, NEVER an outcome and never a partial answer.
        expect(err).toMatchObject({ name: 'AbortError' })
        for (let i = 0; i < 20; i++) await tick()
        expect(t15Requests).toHaveLength(requestsAtAbort) // not one request after the abort
      } finally {
        t15Hold = null
        await h.close()
      }
    }
  }, 60_000)
})
