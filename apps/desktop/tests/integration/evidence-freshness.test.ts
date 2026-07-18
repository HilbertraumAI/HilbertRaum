import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { installOfflineNetworkGuard } from '../../src/main/services/offlineGuard'

// EP-1 Phase 4 (plan §9, spec §21/§15.4–15.5/§25/§28.6–28.7) — the freshness engine,
// acknowledge lifecycle, export gate + pack recording, and source-in-context, end to end
// against a real SQLite workspace.
//
// HARD RULES pinned here (plan §9 boundaries):
//  - Freshness is a comparison of STORED facts only. None of the seeded documents has any
//    file on disk (stored_path NULL, no bytes anywhere) — any attempt to re-read/re-hash a
//    source file would throw, so every green assertion is structural proof of no file I/O
//    against sources (spec §21.2).
//  - No model call and no network: the freshness/context paths take (db, ids) only — no
//    runtime/embedder in their signatures — and the REAL offline guard runs across every
//    test (afterEach asserts zero violations).
//  - Unresolved-identity sources NEVER flip to 'changed' (they cannot be compared).
//  - `outdated` never erases `ready` (it is a derived overlay; acknowledge writes only its
//    own column — status/completed_at/updated_at byte-identical).

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showSaveDialog: async () => ({ canceled: true, filePath: undefined }) }
}))

import { registerEvidenceReviewsIpc } from '../../src/main/ipc/registerEvidenceReviewsIpc'
import { IPC } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import { createEvidenceReviewFromMessage } from '../../src/main/services/evidence-pack/snapshot'
import {
  acknowledgeEvidenceReviewFreshness,
  computeEvidenceReviewFreshness,
  freshnessFingerprint,
  parseFreshnessAck
} from '../../src/main/services/evidence-pack/freshness'
import { getEvidenceSourceContext } from '../../src/main/services/evidence-pack/source-context'
import {
  exportEvidencePackToFile,
  EvidencePackOutdatedError
} from '../../src/main/services/evidence-pack/export'
import {
  getEvidenceReview,
  listEvidenceExports,
  markEvidenceReviewReady,
  updateEvidenceReviewItem
} from '../../src/main/services/evidence-reviews'
import { createAuditRecorder } from '../../src/main/services/audit'
import type { AppContext } from '../../src/main/services/context'
import type {
  Citation,
  CoverageInfo,
  EvidenceReviewFreshness,
  EvidenceReviewSummary,
  EvidenceSourceContext
} from '../../src/shared/types'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

let offlineViolations: string[] = []
let uninstallGuard: () => void = () => {}

beforeEach(() => {
  ipcState.handlers.clear()
  offlineViolations = []
  uninstallGuard = installOfflineNetworkGuard({
    offline: true,
    onViolation: (host) => offlineViolations.push(host)
  })
})

afterEach(() => {
  uninstallGuard()
  expect(offlineViolations).toEqual([])
})

function freshDb(): { db: Db; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-epfresh-'))
  return { db: openDatabase(join(root, 'test.sqlite')), root }
}

/** Documents are DB rows ONLY — no stored file exists anywhere (see module header). */
function seedDocument(db: Db, opts: { title: string; sha256?: string | null }): string {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO documents (id, title, mime_type, sha256, status, created_at, updated_at)
     VALUES (?, ?, 'application/pdf', ?, 'indexed', ?, ?)`
  ).run(id, opts.title, opts.sha256 === undefined ? 'ab'.repeat(32) : opts.sha256, now, now)
  return id
}

function seedChunk(
  db: Db,
  opts: { documentId: string; index: number; text: string; page?: number | null; section?: string | null }
): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.documentId,
    opts.index,
    opts.text,
    `S${opts.index + 1}`,
    opts.page ?? null,
    opts.section ?? null,
    new Date().toISOString()
  )
  return id
}

function seedAnswer(
  db: Db,
  opts: { content: string; citations?: Citation[] | null; coverage?: CoverageInfo | null }
): { conversationId: string; messageId: string } {
  const conv = createConversation(db, { title: 'Freshness chat', modelId: 'm1' })
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'Question?' })
  const msg = appendMessage(db, {
    conversationId: conv.id,
    role: 'assistant',
    content: opts.content,
    citations: opts.citations ?? null,
    coverage: opts.coverage ?? null
  })
  return { conversationId: conv.id, messageId: msg.id }
}

/** One relevance review over a resolved doc (S1) + an unresolved legacy citation (S2). */
function seedReview(db: Db): { reviewId: string; messageId: string; docId: string } {
  const docId = seedDocument(db, { title: 'contract.pdf', sha256: 'aa'.repeat(32) })
  const { messageId } = seedAnswer(db, {
    content: 'Claim one. [S1]\n\nClaim two. [S2]',
    citations: [
      { label: 'S1', sourceTitle: 'contract.pdf', documentId: docId, snippet: 'Either party may terminate.' },
      { label: 'S2', sourceTitle: 'nowhere.pdf', snippet: 'Legacy excerpt.' }
    ],
    coverage: { mode: 'relevance', chunksCovered: 2, chunksTotal: 5 }
  })
  const detail = createEvidenceReviewFromMessage(db, messageId, {})
  return { reviewId: detail.id, messageId, docId }
}

function reviewHeadRow(db: Db, reviewId: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM evidence_reviews WHERE id = ?').get(reviewId) as Record<
    string,
    unknown
  >
}

describe('freshness engine (spec §21.2) — stored-fact comparison only', () => {
  it('an untouched workspace reads unchanged / unverifiable, not outdated', () => {
    const { db } = freshDb()
    const { reviewId } = seedReview(db)
    const fresh = computeEvidenceReviewFreshness(db, reviewId)
    expect(fresh).toEqual({
      reviewId,
      outdated: false,
      answerState: 'unchanged',
      coverageState: 'unchanged',
      sources: [
        { key: 'S1', state: 'unchanged' },
        { key: 'S2', state: 'unverifiable' }
      ],
      acknowledgedAt: null
    })
    expect(computeEvidenceReviewFreshness(db, 'nope')).toBeNull()
  })

  it('a CHANGED stored hash flips the source to changed and the review to outdated — decisions intact (spec §15.5/§28.6)', () => {
    const { db } = freshDb()
    const { reviewId, docId } = seedReview(db)
    const detail = getEvidenceReview(db, reviewId)!
    const item = detail.items[0]!
    updateEvidenceReviewItem(db, item.id, { decision: 'supported', reviewerNote: 'checked' })
    // Re-ingestion updated the STORED hash (no file involved — stored facts only).
    db.prepare('UPDATE documents SET sha256 = ? WHERE id = ?').run('ff'.repeat(32), docId)

    const fresh = computeEvidenceReviewFreshness(db, reviewId)!
    expect(fresh.outdated).toBe(true)
    expect(fresh.sources).toContainEqual({ key: 'S1', state: 'changed' })
    // The unresolved source stays unverifiable — NEVER 'changed' (binding watch-out).
    expect(fresh.sources).toContainEqual({ key: 'S2', state: 'unverifiable' })
    // Decisions are untouched by the freshness check (spec §28.6 "decisions remain intact").
    const after = getEvidenceReview(db, reviewId)!
    expect(after.items[0]).toMatchObject({ decision: 'supported', reviewerNote: 'checked' })
  })

  it('a DELETED source reads missing WITHOUT flipping outdated (spec §25.2/§28.7)', () => {
    const { db } = freshDb()
    const { reviewId, docId } = seedReview(db)
    db.prepare('DELETE FROM documents WHERE id = ?').run(docId)
    const fresh = computeEvidenceReviewFreshness(db, reviewId)!
    expect(fresh.sources).toContainEqual({ key: 'S1', state: 'missing' })
    expect(fresh.outdated).toBe(false)
  })

  it('an UNRESOLVED source never flips to changed, whatever happens to same-titled documents', () => {
    const { db } = freshDb()
    // Two docs sharing the title → the citation stays unresolved at creation.
    seedDocument(db, { title: 'dup.pdf', sha256: 'aa'.repeat(32) })
    const second = seedDocument(db, { title: 'dup.pdf', sha256: 'bb'.repeat(32) })
    const { messageId } = seedAnswer(db, {
      content: 'Ambiguous claim. [S1]',
      citations: [{ label: 'S1', sourceTitle: 'dup.pdf', snippet: 'x' }],
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId, {})
    expect(detail.sources[0]!.identity).toBe('unresolved')
    // Both mutate AND delete the same-titled documents — the verdict must stay honest.
    db.prepare('UPDATE documents SET sha256 = ? WHERE id = ?').run('cc'.repeat(32), second)
    let fresh = computeEvidenceReviewFreshness(db, detail.id)!
    expect(fresh.sources).toEqual([{ key: 'S1', state: 'unverifiable' }])
    expect(fresh.outdated).toBe(false)
    db.prepare("DELETE FROM documents WHERE title = 'dup.pdf'").run()
    fresh = computeEvidenceReviewFreshness(db, detail.id)!
    expect(fresh.sources).toEqual([{ key: 'S1', state: 'unverifiable' }])
    expect(fresh.outdated).toBe(false)
  })

  it('a resolved source with an absent stored hash reads unverifiable — unknown is not drift', () => {
    const { db } = freshDb()
    const docId = seedDocument(db, { title: 'nohash.pdf', sha256: null })
    const { messageId } = seedAnswer(db, {
      content: 'Claim. [S1]',
      citations: [{ label: 'S1', sourceTitle: 'nohash.pdf', documentId: docId, snippet: 'x' }],
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId, {})
    const fresh = computeEvidenceReviewFreshness(db, detail.id)!
    expect(fresh.sources).toEqual([{ key: 'S1', state: 'unverifiable' }])
    expect(fresh.outdated).toBe(false)
  })

  it('answer-text drift and coverage drift each flip outdated (spec §21.2)', () => {
    const { db } = freshDb()
    const first = seedReview(db)
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('Rewritten.', first.messageId)
    let fresh = computeEvidenceReviewFreshness(db, first.reviewId)!
    expect(fresh.answerState).toBe('changed')
    expect(fresh.outdated).toBe(true)

    const second = seedReview(db)
    db.prepare('UPDATE messages SET coverage_json = ? WHERE id = ?').run(
      JSON.stringify({ mode: 'relevance', chunksCovered: 1, chunksTotal: 5 }),
      second.messageId
    )
    fresh = computeEvidenceReviewFreshness(db, second.reviewId)!
    expect(fresh.coverageState).toBe('changed')
    expect(fresh.outdated).toBe(true)
  })

  it('the outdated overlay never erases ready (spec §18.4)', () => {
    const { db } = freshDb()
    const { reviewId, docId } = seedReview(db)
    const detail = getEvidenceReview(db, reviewId)!
    for (const item of detail.items) {
      updateEvidenceReviewItem(db, item.id, { decision: 'supported' })
    }
    expect(markEvidenceReviewReady(db, reviewId)?.review.status).toBe('ready')
    db.prepare('UPDATE documents SET sha256 = ? WHERE id = ?').run('ff'.repeat(32), docId)
    const fresh = computeEvidenceReviewFreshness(db, reviewId)!
    expect(fresh.outdated).toBe(true)
    const after = getEvidenceReview(db, reviewId)!
    expect(after.status).toBe('ready')
    expect(after.completedAt).toBeTruthy()
  })
})

describe('acknowledge lifecycle (spec §15.5/§21.3/§28.6)', () => {
  it('no-ops on a non-outdated review (nothing to acknowledge — no phantom record)', () => {
    const { db } = freshDb()
    const { reviewId } = seedReview(db)
    const result = acknowledgeEvidenceReviewFreshness(db, reviewId)!
    expect(result.acknowledgedAt).toBeNull()
    expect(reviewHeadRow(db, reviewId).freshness_ack_json).toBeNull()
    expect(acknowledgeEvidenceReviewFreshness(db, 'nope')).toBeNull()
  })

  it('persists across reads, never rewrites lifecycle stamps, and works on a READY review', () => {
    const { db } = freshDb()
    const { reviewId, docId } = seedReview(db)
    const detail = getEvidenceReview(db, reviewId)!
    for (const item of detail.items) updateEvidenceReviewItem(db, item.id, { decision: 'supported' })
    expect(markEvidenceReviewReady(db, reviewId)?.review.status).toBe('ready')
    const before = reviewHeadRow(db, reviewId)

    db.prepare('UPDATE documents SET sha256 = ? WHERE id = ?').run('ff'.repeat(32), docId)
    const acked = acknowledgeEvidenceReviewFreshness(db, reviewId)!
    expect(acked.outdated).toBe(true)
    expect(acked.acknowledgedAt).toBeTruthy()

    // The acknowledge is NOT blocked by the ready-state write-guard, and it writes ONLY
    // its own column — status/completed_at/updated_at byte-identical (spec §18.4).
    const after = reviewHeadRow(db, reviewId)
    expect(after.status).toBe(before.status)
    expect(after.completed_at).toBe(before.completed_at)
    expect(after.updated_at).toBe(before.updated_at)
    expect(parseFreshnessAck(after.freshness_ack_json as string | null)).toMatchObject({
      acknowledgedAt: acked.acknowledgedAt
    })

    // A fresh computation (a "restart" — nothing cached) still reports it acknowledged.
    expect(computeEvidenceReviewFreshness(db, reviewId)!.acknowledgedAt).toBe(acked.acknowledgedAt)
  })

  it('LAPSES when the drift changes afterwards (fingerprint mismatch → new warning)', () => {
    const { db } = freshDb()
    const { reviewId, docId, messageId } = seedReview(db)
    db.prepare('UPDATE documents SET sha256 = ? WHERE id = ?').run('ff'.repeat(32), docId)
    const acked = acknowledgeEvidenceReviewFreshness(db, reviewId)!
    expect(acked.acknowledgedAt).toBeTruthy()
    // NEW drift: the answer text changes too — the stored fingerprint no longer matches.
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('Rewritten.', messageId)
    const fresh = computeEvidenceReviewFreshness(db, reviewId)!
    expect(fresh.outdated).toBe(true)
    expect(fresh.acknowledgedAt).toBeNull()
    // Acknowledging AGAIN covers the new drift.
    expect(acknowledgeEvidenceReviewFreshness(db, reviewId)!.acknowledgedAt).toBeTruthy()
  })

  it('a malformed stored ack record reads as not acknowledged (never unlocks the gate)', () => {
    const { db } = freshDb()
    const { reviewId, docId } = seedReview(db)
    db.prepare('UPDATE documents SET sha256 = ? WHERE id = ?').run('ff'.repeat(32), docId)
    db.prepare('UPDATE evidence_reviews SET freshness_ack_json = ? WHERE id = ?').run(
      '{not json',
      reviewId
    )
    expect(computeEvidenceReviewFreshness(db, reviewId)!.acknowledgedAt).toBeNull()
  })

  it('freshnessFingerprint ignores unchanged facts and orders deterministically', () => {
    expect(
      freshnessFingerprint({
        answerState: 'unchanged',
        coverageState: 'unchanged',
        sources: [
          { key: 'S2', state: 'changed' },
          { key: 'S1', state: 'missing' }
        ]
      })
    ).toBe('src:S1=missing;src:S2=changed')
  })
})

describe('export after drift (spec §28.6/§28.7 + §20.1 refresh step)', () => {
  it('a changed source BLOCKS export until acknowledged; afterwards the pack records the mismatch', async () => {
    const { db, root } = freshDb()
    const { reviewId, docId } = seedReview(db)
    db.prepare('UPDATE documents SET sha256 = ? WHERE id = ?').run('ff'.repeat(32), docId)

    // Un-acknowledged outdated → refused BEFORE any dialog (no file, no row).
    let dialogShown = false
    await expect(
      exportEvidencePackToFile(db, reviewId, {}, {
        chooseDestination: async () => {
          dialogShown = true
          return join(root, 'refused.html')
        }
      })
    ).rejects.toBeInstanceOf(EvidencePackOutdatedError)
    expect(dialogShown).toBe(false)
    expect(existsSync(join(root, 'refused.html'))).toBe(false)
    expect(listEvidenceExports(db, reviewId)).toEqual([])

    // Acknowledge → export succeeds; the pack RECORDS the mismatch (spec §28.6).
    expect(acknowledgeEvidenceReviewFreshness(db, reviewId)!.acknowledgedAt).toBeTruthy()
    const dest = join(root, 'acked.html')
    const record = await exportEvidencePackToFile(db, reviewId, {}, {
      chooseDestination: async () => dest
    })
    expect(record).not.toBeNull()
    const html = readFileSync(dest, 'utf8')
    expect(html).toContain('This review is outdated')
    expect(html).toContain('1 source document has changed since this review was created.')
    expect(html).toContain('The reviewer acknowledged this change on')
    expect(html).toContain('Changed since review') // §16.1.7 availability at export
    expect(html).toContain('Availability at export')
  })

  it('a deleted source does NOT block export; the pack carries the missing-source warning (spec §28.7)', async () => {
    const { db, root } = freshDb()
    const { reviewId, docId } = seedReview(db)
    db.prepare('DELETE FROM documents WHERE id = ?').run(docId)
    const dest = join(root, 'missing.html')
    const record = await exportEvidencePackToFile(db, reviewId, {}, {
      chooseDestination: async () => dest
    })
    expect(record).not.toBeNull()
    const html = readFileSync(dest, 'utf8')
    // The persisted snippet remains visible (spec §28.7) with the §15.4 warning…
    expect(html).toContain('Either party may terminate.')
    expect(html).toContain('no longer present in the workspace')
    expect(html).toContain('1 source document is no longer present in the workspace.')
    // …and the review is NOT outdated: no acknowledge was needed, no outdated banner.
    expect(html).not.toContain('This review is outdated')
  })
})

describe('IPC surface (new P4 channels + real overlay)', () => {
  function makeCtx(db: Db, root: string): AppContext {
    return {
      db,
      paths: { workspacePath: root, rootPath: root, configPath: join(root, 'config.json') },
      workspace: { isUnlocked: () => true },
      runtime: {
        active: () => {
          throw new Error('model runtime must never be touched on the evidence surface')
        },
        start: async () => {
          throw new Error('model runtime must never start on the evidence surface')
        }
      },
      manifestsDir: null,
      isDev: true,
      audit: createAuditRecorder(() => db)
    } as unknown as AppContext
  }

  it('refreshState + acknowledge round-trip; detail/summary reads carry the REAL overlay', async () => {
    const { db, root } = freshDb()
    registerEvidenceReviewsIpc(makeCtx(db, root))
    const { reviewId, messageId, docId } = seedReview(db)
    db.prepare('UPDATE documents SET sha256 = ? WHERE id = ?').run('ff'.repeat(32), docId)

    const { result: freshRaw } = await invoke(handlers, IPC.refreshEvidenceReviewState, reviewId)
    const fresh = freshRaw as EvidenceReviewFreshness
    expect(fresh.outdated).toBe(true)
    expect(fresh.acknowledgedAt).toBeNull()

    // The entry-point summary + the detail read now report the computed overlay (the chat
    // chip renders from this) — while the stored status row is untouched.
    const { result: summaryRaw } = await invoke(handlers, IPC.getEvidenceReviewForMessage, messageId)
    expect((summaryRaw as EvidenceReviewSummary).outdated).toBe(true)
    const { result: detailRaw } = await invoke(handlers, IPC.getEvidenceReview, reviewId)
    expect((detailRaw as { outdated: boolean }).outdated).toBe(true)
    expect(reviewHeadRow(db, reviewId).status).toBe('draft')

    const { result: ackRaw } = await invoke(
      handlers,
      IPC.acknowledgeEvidenceReviewFreshness,
      reviewId
    )
    expect((ackRaw as EvidenceReviewFreshness).acknowledgedAt).toBeTruthy()
    // Acknowledged ≠ fresh: the overlay stays true (the drift still exists).
    const { result: stillRaw } = await invoke(handlers, IPC.getEvidenceReviewForMessage, messageId)
    expect((stillRaw as EvidenceReviewSummary).outdated).toBe(true)

    // Malformed ids refuse.
    const { result: badFresh } = await invoke(handlers, IPC.refreshEvidenceReviewState, 42)
    expect(badFresh).toBeNull()
    const { result: badAck } = await invoke(handlers, IPC.acknowledgeEvidenceReviewFreshness, '')
    expect(badAck).toBeNull()
  })

  it('sourceContext rejects unknown review ids, unknown keys, and unresolved sources', async () => {
    const { db, root } = freshDb()
    registerEvidenceReviewsIpc(makeCtx(db, root))
    const { reviewId } = seedReview(db)
    const { result: unknownReview } = await invoke(handlers, IPC.getEvidenceSourceContext, 'nope', 'S1')
    expect(unknownReview).toBeNull()
    const { result: unknownKey } = await invoke(handlers, IPC.getEvidenceSourceContext, reviewId, 'S9')
    expect(unknownKey).toBeNull()
    // S2 is the unresolved legacy citation — there is no document to read.
    const { result: unresolved } = await invoke(handlers, IPC.getEvidenceSourceContext, reviewId, 'S2')
    expect(unresolved).toBeNull()
    const { result: malformed } = await invoke(handlers, IPC.getEvidenceSourceContext, reviewId, 7)
    expect(malformed).toBeNull()
  })
})

describe('source-in-context (D-5) — stored extraction only', () => {
  it('locates the persisted snippet in the stored chunks with neighbor context + hash state', () => {
    const { db } = freshDb()
    const docId = seedDocument(db, { title: 'contract.pdf', sha256: 'aa'.repeat(32) })
    seedChunk(db, { documentId: docId, index: 0, text: 'Preamble text before the clause.', page: 11 })
    const chunkId = seedChunk(db, {
      documentId: docId,
      index: 1,
      text: 'Clause 5: Either party may terminate with 30 days notice.',
      page: 12,
      section: 'Termination'
    })
    seedChunk(db, { documentId: docId, index: 2, text: 'Following clause about fees.', page: 13 })
    const { messageId } = seedAnswer(db, {
      content: 'Claim. [S1]',
      citations: [
        {
          label: 'S1',
          sourceTitle: 'contract.pdf',
          documentId: docId,
          chunkId,
          snippet: 'Either party may terminate with 30 days notice.'
        }
      ],
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 3 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId, {})
    const ctx = getEvidenceSourceContext(db, detail.id, 'S1')!
    expect(ctx).toMatchObject({
      availability: 'available',
      hashState: 'match',
      located: true,
      match: 'Either party may terminate with 30 days notice.',
      pageNumber: 12,
      sectionLabel: 'Termination',
      documentTitle: 'contract.pdf'
    })
    expect(ctx.before).toContain('Preamble text before the clause.')
    expect(ctx.before).toContain('Clause 5: ')
    expect(ctx.after).toContain('Following clause about fees.')
  })

  it('reports mismatch hash state after the stored hash changed; searches when the chunk id is stale', () => {
    const { db } = freshDb()
    const docId = seedDocument(db, { title: 'contract.pdf', sha256: 'aa'.repeat(32) })
    seedChunk(db, { documentId: docId, index: 0, text: 'The clause: terminate at will.', page: 1 })
    const { messageId } = seedAnswer(db, {
      content: 'Claim. [S1]',
      citations: [
        {
          label: 'S1',
          sourceTitle: 'contract.pdf',
          documentId: docId,
          chunkId: 'stale-chunk-id-from-before-reindex',
          snippet: 'terminate at will.'
        }
      ],
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId, {})
    db.prepare('UPDATE documents SET sha256 = ? WHERE id = ?').run('ff'.repeat(32), docId)
    const ctx = getEvidenceSourceContext(db, detail.id, 'S1')!
    expect(ctx.hashState).toBe('mismatch')
    expect(ctx.located).toBe(true) // found via stored-text search despite the stale id
    expect(ctx.match).toBe('terminate at will.')
  })

  it('NEVER serves another document through a foreign chunk id (cross-document leak guard)', () => {
    const { db } = freshDb()
    const docId = seedDocument(db, { title: 'a.pdf', sha256: 'aa'.repeat(32) })
    const otherDoc = seedDocument(db, { title: 'b.pdf', sha256: 'bb'.repeat(32) })
    // The FOREIGN document contains the snippet text; the snapshotted doc does not.
    const foreignChunk = seedChunk(db, {
      documentId: otherDoc,
      index: 0,
      text: 'SECRET-OTHER-DOC terminate at will.'
    })
    const { messageId } = seedAnswer(db, {
      content: 'Claim. [S1]',
      citations: [
        {
          label: 'S1',
          sourceTitle: 'a.pdf',
          documentId: docId,
          // A corrupted/hostile snapshot pointing at ANOTHER document's chunk.
          chunkId: foreignChunk,
          snippet: 'terminate at will.'
        }
      ],
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId, {})
    const ctx = getEvidenceSourceContext(db, detail.id, 'S1')!
    // The foreign chunk is refused; a.pdf has no chunk with the text → honest not-located,
    // and no byte of the other document's text leaks.
    expect(ctx.located).toBe(false)
    expect(ctx.before ?? '').not.toContain('SECRET-OTHER-DOC')
    expect(ctx.after ?? '').not.toContain('SECRET-OTHER-DOC')
  })

  it('a deleted document reads missing with the persisted snippet retained (spec §15.4)', () => {
    const { db } = freshDb()
    const { reviewId, docId } = seedReview(db)
    db.prepare('DELETE FROM documents WHERE id = ?').run(docId)
    const ctx = getEvidenceSourceContext(db, reviewId, 'S1')!
    expect(ctx).toMatchObject({
      availability: 'missing',
      located: false,
      snippet: 'Either party may terminate.',
      documentTitle: 'contract.pdf'
    })
  })

  it('an unlocatable snippet reads located:false — never guessed context', () => {
    const { db } = freshDb()
    const { reviewId, docId } = seedReview(db)
    // The document exists but its stored chunks do not contain the snippet.
    seedChunk(db, { documentId: docId, index: 0, text: 'Completely different content now.' })
    const ctx = getEvidenceSourceContext(db, reviewId, 'S1')!
    expect(ctx.availability).toBe('available')
    expect(ctx.located).toBe(false)
    expect(ctx.before).toBeNull()
    expect(ctx.match).toBeNull()
  })

  it('a truncated (…-terminated) snippet still locates by its prefix', () => {
    const { db } = freshDb()
    const docId = seedDocument(db, { title: 'long.pdf', sha256: 'aa'.repeat(32) })
    const longText = `Start. ${'clause text '.repeat(80)}End.`
    seedChunk(db, { documentId: docId, index: 0, text: longText })
    const { messageId } = seedAnswer(db, {
      content: 'Claim. [S1]',
      citations: [
        {
          label: 'S1',
          sourceTitle: 'long.pdf',
          documentId: docId,
          // The stored-snippet shape for long chunks: a prefix + '…' (truncateSnippet).
          snippet: `${longText.slice(0, 200)}…`
        }
      ],
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId, {})
    const ctx = getEvidenceSourceContext(db, detail.id, 'S1')!
    expect(ctx.located).toBe(true)
    expect(ctx.match).toBe(longText.slice(0, 200))
  })
})
