import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'node:path'

// Conversation-scoped batch reads + transactional bulk decision sweeps for the
// evidence-review surface — the three storage-layer findings of one remediation phase:
//
//  AUD-12  Opening a conversation used to read the chip state one message at a time: a full
//          head row + every item row + a gate derivation PER candidate answer, each behind
//          its own IPC round trip, awaited SERIALLY. The cost of opening a documents-mode
//          conversation therefore grew with its history. `listEvidenceReviewSummariesForConversation`
//          answers for the whole conversation in a FIXED number of statements. The renderer
//          half (exactly one IPC round trip per conversation open) is pinned in
//          tests/renderer/ChatReviewChipBatch.test.tsx.
//
//  AUD-13  The three sanctioned bulk decision actions used to fan out into one write per
//          item — each re-reading the review head for the ready guard, re-stamping the head,
//          and re-reading the item back. Besides the redundant work, a failure part-way
//          through left the review HALF-swept. `applyEvidenceReviewBulkAction` is ONE
//          transaction: it lands whole or not at all.
//
//  AUD-14  `evidence_reviews.conversation_id` exists solely to serve conversation-scoped
//          reads, and had no index — every one of them SCANNED the table. The additive
//          `idx_evidence_reviews_conversation` closes it.
//
// Statement counting is REAL instrumentation, not a source-shape guess: the Db handle is
// wrapped in a proxy whose prepared statements record their SQL text as they EXECUTE, so a
// regression to per-item/per-message reads shows up as a count, not as prose.

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
import {
  applyEvidenceReviewBulkAction,
  countEvidenceReviewsForConversation,
  getEvidenceReview,
  getEvidenceReviewForMessage,
  listEvidenceReviewSummariesForConversation,
  markEvidenceReviewReady,
  updateEvidenceReviewItem
} from '../../src/main/services/evidence-reviews'
import type { Citation, EvidenceReviewItem, EvidenceReviewSummary } from '../../src/shared/types'
import { freshWorkspaceDb } from '../helpers/db-fixtures'
import { capturePrepares } from '../helpers/db-spy'
import { evidenceIpcContext, seedEvidenceReview, seedSourceDocument } from '../helpers/evidence-fixtures'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

/** An id node:sqlite cannot bind (measured on Node v24.13.0: ERR_INVALID_ARG_TYPE), so only the
 *  handler's `safeId` turns it into an unknown id. `{}` or an array would not do: `{}` binds as an
 *  empty named-parameter bag (reads NULL) and an array throws a different named-parameter error. */
const UNBINDABLE_ID: unknown = true

/**
 * A Db facade that RECORDS the SQL text of every statement it executes. `prepareCached`
 * keys its statement cache on the Db object, so the proxy gets its own cache and every
 * prepare — cached or not — is funnelled through here. Everything still runs against the
 * real SQLite database; the proxy only observes.
 */
function recordingDb(db: Db): { db: Db; executed: string[] } {
  const executed: string[] = []
  const wrapStatement = (sql: string, stmt: object): object =>
    new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target)
        if (typeof value !== 'function') return value
        if (prop === 'get' || prop === 'all' || prop === 'run' || prop === 'iterate') {
          return (...args: unknown[]) => {
            executed.push(sql)
            return (value as (...a: unknown[]) => unknown).apply(target, args)
          }
        }
        return (value as (...a: unknown[]) => unknown).bind(target)
      }
    })
  const proxy = new Proxy(db as unknown as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      if (prop === 'prepare') {
        return (sql: string) =>
          wrapStatement(sql, (value as (s: string) => object).call(target, sql))
      }
      if (prop === 'exec') {
        return (sql: string) => {
          executed.push(sql)
          return (value as (s: string) => unknown).call(target, sql)
        }
      }
      return (value as (...a: unknown[]) => unknown).bind(target)
    }
  })
  return { db: proxy as unknown as Db, executed }
}

/** How many recorded statements match `needle` (a substring of the SQL text). */
function countMatching(executed: readonly string[], needle: string): number {
  return executed.filter((sql) => sql.includes(needle)).length
}

/** EXPLAIN QUERY PLAN for `sql` (one bound id), flattened for substring assertions. */
function plan(db: Db, sql: string, param: string): string {
  const rows = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(param) as unknown as Array<{
    detail: string
  }>
  return rows.map((r) => r.detail).join(' | ')
}

/** Seed one documents-mode conversation with `answers` cited assistant answers (each
 *  preceded by its question turn). Returns the conversation id, the answer message ids and
 *  the id of the source document they all cite (drift is injected through it). */
function seedConversation(
  db: Db,
  answers: number
): { conversationId: string; messageIds: string[]; documentId: string } {
  const docId = seedSourceDocument(db, { title: 'contract.pdf', sha256: 'ab'.repeat(32) })
  const conv = createConversation(db, { title: 'Batch chat', modelId: 'm1' })
  const messageIds: string[] = []
  for (let i = 1; i <= answers; i++) {
    appendMessage(db, { conversationId: conv.id, role: 'user', content: `Question ${i}?` })
    const citations: Citation[] = [
      {
        label: 'S1',
        sourceTitle: 'contract.pdf',
        documentId: docId,
        snippet: `Persisted excerpt ${i} — long enough to look like a real one.`
      } as Citation
    ]
    const msg = appendMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      // A heading + two claims: the review carries a heading item (exempt from the gate)
      // and two required items, so gates and bulk sweeps have something to bite on.
      content: `# Finding ${i}\n\nClaim ${i}a rests on the source. [S1]\n\nClaim ${i}b does too.`,
      citations,
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 4 }
    })
    messageIds.push(msg.id)
  }
  return { conversationId: conv.id, messageIds, documentId: docId }
}

beforeEach(() => {
  ipcState.handlers.clear()
})

// ---- AUD-12: the conversation-scoped summary batch ------------------------------------

describe('AUD-12 — evidence-review chip state loads per CONVERSATION, not per message', () => {
  it('reads a 30-answer conversation in a FIXED number of statements (was one head+item read per message)', () => {
    const REVIEWS = 30
    const raw = freshWorkspaceDb('evbatch').db
    const { conversationId, messageIds } = seedConversation(raw, REVIEWS)
    for (const id of messageIds) seedEvidenceReview(raw, { messageId: id })

    // The batch read: TWO statements for the whole conversation, whatever its length.
    const batch = recordingDb(raw)
    const summaries = listEvidenceReviewSummariesForConversation(batch.db, conversationId)
    expect(summaries).toHaveLength(REVIEWS)
    expect(batch.executed).toHaveLength(2)
    expect(countMatching(batch.executed, 'FROM evidence_reviews WHERE conversation_id = ?')).toBe(1)
    expect(countMatching(batch.executed, 'JOIN evidence_reviews r ON r.id = i.review_id')).toBe(1)
  })

  it('is summary-for-summary IDENTICAL to the per-message read (gate included)', () => {
    const db = freshWorkspaceDb('evbatch').db
    const { conversationId, messageIds } = seedConversation(db, 3)
    const created = messageIds.map((id) => seedEvidenceReview(db, { messageId: id }))
    // Decide one required item of the middle review so the gates genuinely differ.
    const middle = created[1]!
    const required = middle.items.find((i) => i.blockKind !== 'heading')!
    expect(updateEvidenceReviewItem(db, required.id, { decision: 'supported' })).not.toBeNull()
    // …and mark the last one ready so a non-draft status is covered too.
    const last = created[2]!
    for (const item of last.items) {
      if (item.blockKind !== 'heading') updateEvidenceReviewItem(db, item.id, { decision: 'supported' })
    }
    expect(markEvidenceReviewReady(db, last.id)?.review.status).toBe('ready')

    const byMessage = new Map(
      listEvidenceReviewSummariesForConversation(db, conversationId).map((s) => [s.messageId, s])
    )
    expect(byMessage.size).toBe(3)
    for (const messageId of messageIds) {
      expect(byMessage.get(messageId)).toEqual(getEvidenceReviewForMessage(db, messageId))
    }
  })

  it('scopes strictly to the conversation, and reads empty for one with no reviews', () => {
    const db = freshWorkspaceDb('evbatch').db
    const a = seedConversation(db, 2)
    const b = seedConversation(db, 2)
    seedEvidenceReview(db, { messageId: a.messageIds[0]! })
    seedEvidenceReview(db, { messageId: b.messageIds[1]! })

    expect(listEvidenceReviewSummariesForConversation(db, a.conversationId).map((s) => s.messageId)).toEqual([
      a.messageIds[0]
    ])
    expect(listEvidenceReviewSummariesForConversation(db, b.conversationId).map((s) => s.messageId)).toEqual([
      b.messageIds[1]
    ])
    expect(listEvidenceReviewSummariesForConversation(db, 'no-such-conversation')).toEqual([])
  })

  it('over IPC: one call carries the whole conversation WITH the derived outdated overlay', async () => {
    const { db, root } = freshWorkspaceDb('evbatch')
    const { conversationId, messageIds, documentId } = seedConversation(db, 2)
    const first = seedEvidenceReview(db, { messageId: messageIds[0]! })
    seedEvidenceReview(db, { messageId: messageIds[1]! })
    registerEvidenceReviewsIpc(evidenceIpcContext(db, root).ctx)

    const before = (
      await invoke(handlers, IPC.getEvidenceReviewSummariesForConversation, conversationId)
    ).result as EvidenceReviewSummary[]
    expect(before).toHaveLength(2)
    expect(before.every((s) => s.outdated === false)).toBe(true)

    // The source document changes under the reviews → BOTH must report outdated (the overlay is
    // derived at the boundary, never stored; the service read above keeps the constant false).
    db.prepare('UPDATE documents SET sha256 = ? WHERE id = ?').run('ff'.repeat(32), documentId)
    const after = (
      await invoke(handlers, IPC.getEvidenceReviewSummariesForConversation, conversationId)
    ).result as EvidenceReviewSummary[]
    expect(after.every((s) => s.outdated === true)).toBe(true)
    // Apart from the overlay, each element is the service's summary for its message.
    expect(after.find((s) => s.id === first.id)).toEqual({
      ...getEvidenceReviewForMessage(db, messageIds[0]!),
      outdated: true
    })
  })

  it('over IPC: a malformed conversation id reads as "no reviews" (never a throw)', async () => {
    const { db, root } = freshWorkspaceDb('evbatch')
    registerEvidenceReviewsIpc(evidenceIpcContext(db, root).ctx)
    expect((await invoke(handlers, IPC.getEvidenceReviewSummariesForConversation, '')).result).toEqual([])
    expect((await invoke(handlers, IPC.getEvidenceReviewSummariesForConversation, 42)).result).toEqual([])
    expect(
      (await invoke(handlers, IPC.getEvidenceReviewSummariesForConversation, null)).result
    ).toEqual([])
    expect(
      (await invoke(handlers, IPC.getEvidenceReviewSummariesForConversation, UNBINDABLE_ID)).result
    ).toEqual([])
  })
})

// ---- AUD-13: bulk actions are ONE transaction -----------------------------------------

/** Decisions of a review's items, keyed by item id — the sweep's observable effect. */
function decisionsOf(db: Db, reviewId: string): Record<string, string> {
  const detail = getEvidenceReview(db, reviewId)!
  return Object.fromEntries(detail.items.map((i) => [i.id, i.decision]))
}

describe('AUD-13 — bulk decision actions apply in ONE transaction', () => {
  /** A review whose items span every case a sweep has to handle. */
  function seedReviewForSweep(db: Db): { reviewId: string; items: EvidenceReviewItem[] } {
    const { messageIds } = seedConversation(db, 1)
    const detail = seedEvidenceReview(db, { messageId: messageIds[0]! })
    return { reviewId: detail.id, items: detail.items }
  }

  it('sweeps N items with ONE guard read, ONE update and ONE head stamp (was N of each)', () => {
    const raw = freshWorkspaceDb('evbatch').db
    const { reviewId, items } = seedReviewForSweep(raw)
    const undecided = items.filter((i) => i.decision === 'not_reviewed')
    expect(undecided.length).toBeGreaterThan(1) // the sweep must be genuinely plural

    // The batched action: constant statement counts, however many items it sweeps.
    const batched = recordingDb(raw)
    const after = applyEvidenceReviewBulkAction(batched.db, reviewId, 'undecided_follow_up')
    expect(after).not.toBeNull()
    expect(countMatching(batched.executed, 'SELECT * FROM evidence_reviews WHERE id = ?')).toBe(1)
    expect(
      countMatching(batched.executed, 'UPDATE evidence_reviews SET updated_at = ? WHERE id = ?')
    ).toBe(1)
    expect(countMatching(batched.executed, 'UPDATE evidence_review_items SET decision')).toBe(1)
    // …and it really is a transaction.
    expect(countMatching(batched.executed, 'BEGIN')).toBe(1)
    expect(countMatching(batched.executed, 'COMMIT')).toBe(1)
    // Every previously-undecided item moved; nothing else did.
    for (const item of undecided) {
      expect(after!.find((i) => i.id === item.id)!.decision).toBe('follow_up')
    }
  })

  it('ATOMIC: a failure part-way through leaves the review COMPLETELY unchanged', () => {
    const db = freshWorkspaceDb('evbatch').db
    const { reviewId } = seedReviewForSweep(db)
    // Give the review a mixed starting state worth preserving.
    const start = getEvidenceReview(db, reviewId)!
    const first = start.items.find((i) => i.blockKind !== 'heading')!
    expect(updateEvidenceReviewItem(db, first.id, { decision: 'supported' })).not.toBeNull()
    const before = decisionsOf(db, reviewId)
    const stampBefore = getEvidenceReview(db, reviewId)!.updatedAt

    // Fail the sweep AFTER its item UPDATE has already been applied inside the transaction:
    // the head activity stamp is the sweep's last statement, so aborting it is exactly the
    // "half-applied" scenario a per-item fan-out could crash into for real.
    db.exec(
      `CREATE TRIGGER fail_bulk_touch BEFORE UPDATE OF updated_at ON evidence_reviews
         BEGIN SELECT RAISE(ABORT, 'injected bulk failure'); END`
    )
    expect(() => applyEvidenceReviewBulkAction(db, reviewId, 'clear_decisions')).toThrow(
      /injected bulk failure/
    )
    db.exec('DROP TRIGGER fail_bulk_touch')

    // NOTHING moved: not one decision, not the activity stamp.
    expect(decisionsOf(db, reviewId)).toEqual(before)
    expect(getEvidenceReview(db, reviewId)!.updatedAt).toBe(stampBefore)
    // …and the review is still usable — the same sweep now succeeds.
    expect(applyEvidenceReviewBulkAction(db, reviewId, 'clear_decisions')).not.toBeNull()
    for (const decision of Object.values(decisionsOf(db, reviewId))) {
      expect(decision).toBe('not_reviewed')
    }
  })

  it('headings→N/A touches ONLY headings; follow-up spares already-decided items', () => {
    const db = freshWorkspaceDb('evbatch').db
    const { reviewId } = seedReviewForSweep(db)
    const start = getEvidenceReview(db, reviewId)!
    const heading = start.items.find((i) => i.blockKind === 'heading')!
    const [claimA, claimB] = start.items.filter((i) => i.blockKind !== 'heading')
    expect(updateEvidenceReviewItem(db, claimA!.id, { decision: 'supported' })).not.toBeNull()
    // The snapshot builder already defaults headings to 'not_applicable' — reset it so the
    // sweep has real work to do (and so a no-op sweep can be told apart from a real one).
    expect(updateEvidenceReviewItem(db, heading.id, { decision: 'not_reviewed' })).not.toBeNull()

    const swept = applyEvidenceReviewBulkAction(db, reviewId, 'headings_not_applicable')!
    expect(swept.find((i) => i.id === heading.id)!.decision).toBe('not_applicable')
    expect(swept.find((i) => i.id === claimA!.id)!.decision).toBe('supported')
    expect(swept.find((i) => i.id === claimB!.id)!.decision).toBe('not_reviewed')

    const followUp = applyEvidenceReviewBulkAction(db, reviewId, 'undecided_follow_up')!
    expect(followUp.find((i) => i.id === claimB!.id)!.decision).toBe('follow_up')
    expect(followUp.find((i) => i.id === claimA!.id)!.decision).toBe('supported')
    expect(followUp.find((i) => i.id === heading.id)!.decision).toBe('not_applicable')

    const cleared = applyEvidenceReviewBulkAction(db, reviewId, 'clear_decisions')!
    for (const item of cleared) expect(item.decision).toBe('not_reviewed')
  })

  it('a sweep that matches nothing writes nothing — the activity stamp does not move', () => {
    const db = freshWorkspaceDb('evbatch').db
    const { reviewId } = seedReviewForSweep(db)
    expect(applyEvidenceReviewBulkAction(db, reviewId, 'clear_decisions')).not.toBeNull()
    const stamp = getEvidenceReview(db, reviewId)!.updatedAt
    const again = recordingDb(db)
    expect(applyEvidenceReviewBulkAction(again.db, reviewId, 'clear_decisions')).not.toBeNull()
    expect(
      countMatching(again.executed, 'UPDATE evidence_reviews SET updated_at = ? WHERE id = ?')
    ).toBe(0)
    expect(getEvidenceReview(db, reviewId)!.updatedAt).toBe(stamp)
  })

  it('refuses on an unknown id and on a READY review (reopen first)', () => {
    const db = freshWorkspaceDb('evbatch').db
    const { reviewId } = seedReviewForSweep(db)
    expect(applyEvidenceReviewBulkAction(db, 'no-such-review', 'clear_decisions')).toBeNull()

    for (const item of getEvidenceReview(db, reviewId)!.items) {
      if (item.blockKind !== 'heading') updateEvidenceReviewItem(db, item.id, { decision: 'supported' })
    }
    expect(markEvidenceReviewReady(db, reviewId)?.review.status).toBe('ready')
    const before = decisionsOf(db, reviewId)
    expect(applyEvidenceReviewBulkAction(db, reviewId, 'clear_decisions')).toBeNull()
    expect(decisionsOf(db, reviewId)).toEqual(before)
  })

  it('over IPC: applies once, refuses unknown ids AND unrecognized action names', async () => {
    const { db, root } = freshWorkspaceDb('evbatch')
    const { reviewId } = seedReviewForSweep(db)
    registerEvidenceReviewsIpc(evidenceIpcContext(db, root).ctx)

    const applied = (
      await invoke(handlers, IPC.applyEvidenceReviewBulkAction, reviewId, 'undecided_follow_up')
    ).result as EvidenceReviewItem[]
    expect(applied.map((i) => [i.blockKind, i.decision])).toEqual([
      ['heading', 'not_applicable'],
      ['paragraph', 'follow_up'],
      ['paragraph', 'follow_up']
    ])
    const afterApply = decisionsOf(db, reviewId)

    // The forbidden blanket claim has no name on this channel; nor does anything malformed.
    for (const bad of ['supported', 'mark_all_supported', 'CLEAR_DECISIONS', '', null, 7, {}]) {
      expect(
        (await invoke(handlers, IPC.applyEvidenceReviewBulkAction, reviewId, bad)).result
      ).toBeNull()
    }
    // …and none of those refusals moved a decision (a mis-routed clear or follow-up sweep would).
    expect(decisionsOf(db, reviewId)).toEqual(afterApply)
    expect(
      (await invoke(handlers, IPC.applyEvidenceReviewBulkAction, '', 'clear_decisions')).result
    ).toBeNull()
    expect(
      (await invoke(handlers, IPC.applyEvidenceReviewBulkAction, UNBINDABLE_ID, 'clear_decisions')).result
    ).toBeNull()
  })
})

// ---- AUD-14: the conversation_id index ------------------------------------------------

// TS-5 idiom: assert the index NAME the planner picks for the statements production PREPARES
// (captured with capturePrepares), never its phrasing — EXPLAIN QUERY PLAN detail strings
// ("SCAN", "COVERING", "USE TEMP B-TREE") are unstable planner output that shifts with the
// SQLite bundled by the pinned Node, with no behavior change. Which INDEX serves the query is
// the actual contract. Only TEETH asserts SCAN: dropping the index must produce one — that is
// the finding itself. The COUNT row also asserts SEARCH: a covering-index scan names the index too.
describe('AUD-14 — conversation-scoped review reads are index SEARCHes, not table SCANs', () => {
  const COUNT_SQL = 'SELECT COUNT(*) AS n FROM evidence_reviews WHERE conversation_id = ?'
  /** The two conversation-scoped HEAD reads; the batch item read (`JOIN evidence_reviews r ON …`) does not match. */
  const HEAD_STATEMENT = /FROM evidence_reviews WHERE /

  it('the delete-confirm COUNT is served by idx_evidence_reviews_conversation', async () => {
    const db = freshWorkspaceDb('evbatch').db // fresh: prepareCached prepares once per Db
    const sql = await capturePrepares(db, HEAD_STATEMENT, () => countEvidenceReviewsForConversation(db, 'c1'))
    expect(sql).toHaveLength(1)
    const p = plan(db, sql[0]!, 'c1')
    expect(p).toContain('idx_evidence_reviews_conversation')
    // The COUNT needs only the indexed column, so even a filter the index cannot serve
    // (`lower(conversation_id) = …`) SCANs the covering index and names it: the name alone
    // cannot tell the two apart here.
    expect(p).toContain('SEARCH evidence_reviews')
  })

  it('the chip-state batch head read is served by the same index', async () => {
    const db = freshWorkspaceDb('evbatch').db
    const sql = await capturePrepares(db, HEAD_STATEMENT, () => listEvidenceReviewSummariesForConversation(db, 'c1'))
    expect(sql).toHaveLength(1)
    expect(plan(db, sql[0]!, 'c1')).toContain('idx_evidence_reviews_conversation')
  })

  it('TEETH: without the index both queries fall back to a full table SCAN', async () => {
    const db = freshWorkspaceDb('evbatch').db
    db.exec('DROP INDEX idx_evidence_reviews_conversation')
    const sql = await capturePrepares(db, HEAD_STATEMENT, () => {
      countEvidenceReviewsForConversation(db, 'c1')
      listEvidenceReviewSummariesForConversation(db, 'c1')
    })
    expect(sql).toHaveLength(2)
    for (const s of sql) {
      const p = plan(db, s, 'c1')
      expect(p).not.toContain('idx_evidence_reviews_conversation')
      expect(p).toContain('SCAN evidence_reviews')
    }
  })

  it('the index reaches an EXISTING workspace too (additive ensure-on-open)', () => {
    const { db: first, root } = freshWorkspaceDb('evbatch-mig')
    first.exec('DROP INDEX IF EXISTS idx_evidence_reviews_conversation')
    expect(plan(first, COUNT_SQL, 'c1')).not.toContain('idx_evidence_reviews_conversation')
    first.close()
    // Re-opening the SAME file re-applies the schema, index included.
    const reopened = openDatabase(join(root, 'test.sqlite'))
    expect(plan(reopened, COUNT_SQL, 'c1')).toContain('idx_evidence_reviews_conversation')
  })
})
