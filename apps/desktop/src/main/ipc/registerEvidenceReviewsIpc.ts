import { app, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type {
  EvidenceLinkInput,
  EvidenceReadyGate,
  EvidenceReview,
  EvidenceReviewDetail,
  EvidenceReviewFreshness,
  EvidenceReviewItem,
  EvidenceReviewItemPatch,
  EvidenceReviewPatch,
  EvidenceReviewSummary,
  EvidenceSelectionInput,
  ReviewDecision
} from '../../shared/types'
import { tMain } from '../services/i18n'
import { findManifestById } from '../services/models'
import { createEvidenceReviewFromMessage } from '../services/evidence-pack/snapshot'
import {
  createEvidenceSelection,
  deleteEvidenceReview,
  deleteEvidenceSelection,
  getEvidenceReview,
  getEvidenceReviewForMessage,
  markEvidenceReviewReady,
  removeEvidenceLink,
  reopenEvidenceReview,
  setEvidenceLink,
  updateEvidenceReview,
  updateEvidenceReviewItem
} from '../services/evidence-reviews'

// IPC for Evidence Pack / Review Mode (EP-1 plan §6.4, spec §19). Pure local SQLite reads/
// writes over persisted message data — NO model call, NO network, NO sidecar start anywhere
// on this surface (spec FR-2/FR-12; the no-model/no-network test assertions pin it).
//
// Boundary rules (spec §19 security):
//  - The renderer passes IDS and user-entered review text only. Snapshots, source
//    resolution, catalog lookups and derived state are main-side.
//  - Payload guards narrow every untrusted argument (the `safeIdArray` idiom): malformed
//    ids read as unknown (null/false results); malformed patch fields are DROPPED, never
//    normalized into a different stored value.
//  - `setEvidenceLink` FORCES `origin: 'reviewer'`: 'answer_marker' is the load-bearing
//    "cited by the answer" claim (spec §13.3) and its ONLY producer is the main-side
//    snapshot builder — a renderer payload can never mint it.
//  - Audit metadata is ids/counts ONLY — never titles, notes, reviewer labels, snippets, or
//    block text (enforced by the sentinel sweep in tests/integration/audit-ipc.test.ts).

/** Untrusted-boundary guard: a non-empty string id, else null (reads as unknown). */
function safeId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

const DECISION_VALUES: ReadonlySet<string> = new Set([
  'supported',
  'partly_supported',
  'not_supported',
  'follow_up',
  'not_reviewed',
  'not_applicable'
])

const RELATION_VALUES: ReadonlySet<string> = new Set([
  'supports',
  'qualifies',
  'contradicts',
  'context'
])

/** Keep only well-typed head-patch fields; anything malformed is dropped (never coerced). */
function sanitizeReviewPatch(value: unknown): EvidenceReviewPatch {
  const patch: EvidenceReviewPatch = {}
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (typeof v.title === 'string') patch.title = v.title
    if (typeof v.reviewerLabel === 'string' || v.reviewerLabel === null) {
      patch.reviewerLabel = v.reviewerLabel
    }
    if (typeof v.generalNote === 'string' || v.generalNote === null) {
      patch.generalNote = v.generalNote
    }
  }
  return patch
}

/** Keep only well-typed item-patch fields. An unknown decision literal is DROPPED (the
 *  stored decision stays untouched) — never normalized into a different judgment. */
function sanitizeItemPatch(value: unknown): EvidenceReviewItemPatch {
  const patch: EvidenceReviewItemPatch = {}
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (typeof v.decision === 'string' && DECISION_VALUES.has(v.decision)) {
      patch.decision = v.decision as ReviewDecision
    }
    if (typeof v.reviewerNote === 'string' || v.reviewerNote === null) {
      patch.reviewerNote = v.reviewerNote
    }
  }
  return patch
}

/** A structurally valid selection input, else null (the service re-validates offsets). */
function sanitizeSelectionInput(value: unknown): EvidenceSelectionInput | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.blockKey !== 'string' || v.blockKey.length === 0) return null
  if (typeof v.startOffset !== 'number' || typeof v.endOffset !== 'number') return null
  return { blockKey: v.blockKey, startOffset: v.startOffset, endOffset: v.endOffset }
}

/** Renderer link input → the stored shape: origin FORCED to 'reviewer' (see module header);
 *  relation kept only when it is one of the four literals. */
function sanitizeLinkInput(value: unknown): EvidenceLinkInput {
  let relation: EvidenceLinkInput['relation'] = null
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (typeof v.relation === 'string' && RELATION_VALUES.has(v.relation)) {
      relation = v.relation as Exclude<EvidenceLinkInput['relation'], null | undefined>
    }
  }
  return { origin: 'reviewer', relation }
}

export function registerEvidenceReviewsIpc(ctx: AppContext): void {
  // Every handler is DB-backed; refuse with the friendly localized copy while locked
  // (ipc-lock-coverage.test.ts drives every channel here against a locked ctx).
  const requireUnlocked = (): void => {
    if (!ctx.workspace.isUnlocked()) {
      throw new Error(tMain('main.evidenceReviews.locked'))
    }
  }

  ipcMain.handle(IPC.createEvidenceReview, (_e, messageId: unknown): EvidenceReviewDetail => {
    requireUnlocked()
    const id = safeId(messageId)
    if (!id) throw new Error(tMain('main.evidenceReviews.invalidRequest'))
    // Idempotent create (one active review per message, v1): an existing review is
    // returned as-is — a double-click or a stale "Review evidence" button never throws
    // and never duplicates. Audit fires only on a REAL creation.
    const existing = getEvidenceReviewForMessage(ctx.db, id)
    if (existing) {
      const detail = getEvidenceReview(ctx.db, existing.id)
      if (detail) return detail
    }
    const detail = createEvidenceReviewFromMessage(ctx.db, id, {
      appVersion: app.getVersion(),
      modelDisplayName: (modelId) =>
        findManifestById(ctx.manifestsDir, modelId)?.displayName ?? null
    })
    ctx.audit?.('evidence_review_created', 'Evidence review created', {
      reviewId: detail.id,
      messageId: detail.messageId,
      conversationId: detail.conversationId,
      itemCount: detail.items.length,
      sourceCount: detail.sources.length,
      autoLinkCount: detail.items.reduce(
        (n, item) => n + item.links.filter((l) => l.origin === 'answer_marker').length,
        0
      )
    })
    return detail
  })

  ipcMain.handle(IPC.getEvidenceReview, (_e, reviewId: unknown): EvidenceReviewDetail | null => {
    requireUnlocked()
    const id = safeId(reviewId)
    return id ? getEvidenceReview(ctx.db, id) : null
  })

  ipcMain.handle(
    IPC.getEvidenceReviewForMessage,
    (_e, messageId: unknown): EvidenceReviewSummary | null => {
      requireUnlocked()
      const id = safeId(messageId)
      return id ? getEvidenceReviewForMessage(ctx.db, id) : null
    }
  )

  ipcMain.handle(
    IPC.updateEvidenceReview,
    (_e, reviewId: unknown, patch: unknown): EvidenceReview | null => {
      requireUnlocked()
      const id = safeId(reviewId)
      return id ? updateEvidenceReview(ctx.db, id, sanitizeReviewPatch(patch)) : null
    }
  )

  ipcMain.handle(
    IPC.updateEvidenceReviewItem,
    (_e, itemId: unknown, patch: unknown): EvidenceReviewItem | null => {
      requireUnlocked()
      const id = safeId(itemId)
      return id ? updateEvidenceReviewItem(ctx.db, id, sanitizeItemPatch(patch)) : null
    }
  )

  ipcMain.handle(
    IPC.createEvidenceSelection,
    (_e, reviewId: unknown, input: unknown): EvidenceReviewItem | null => {
      requireUnlocked()
      const id = safeId(reviewId)
      const selection = sanitizeSelectionInput(input)
      return id && selection ? createEvidenceSelection(ctx.db, id, selection) : null
    }
  )

  ipcMain.handle(IPC.deleteEvidenceSelection, (_e, itemId: unknown): boolean => {
    requireUnlocked()
    const id = safeId(itemId)
    return id ? deleteEvidenceSelection(ctx.db, id) : false
  })

  ipcMain.handle(
    IPC.setEvidenceLink,
    (_e, itemId: unknown, evidenceKey: unknown, input: unknown): EvidenceReviewItem | null => {
      requireUnlocked()
      const id = safeId(itemId)
      const key = safeId(evidenceKey)
      return id && key ? setEvidenceLink(ctx.db, id, key, sanitizeLinkInput(input)) : null
    }
  )

  ipcMain.handle(
    IPC.removeEvidenceLink,
    (_e, itemId: unknown, evidenceKey: unknown): boolean => {
      requireUnlocked()
      const id = safeId(itemId)
      const key = safeId(evidenceKey)
      return id && key ? removeEvidenceLink(ctx.db, id, key) : false
    }
  )

  ipcMain.handle(
    IPC.markEvidenceReviewReady,
    (_e, reviewId: unknown): { review: EvidenceReview; gate: EvidenceReadyGate } | null => {
      requireUnlocked()
      const id = safeId(reviewId)
      if (!id) return null
      const result = markEvidenceReviewReady(ctx.db, id)
      if (result && result.gate.eligible && result.review.status === 'ready') {
        ctx.audit?.('evidence_review_ready', 'Evidence review marked ready', {
          reviewId: result.review.id,
          requiredTotal: result.gate.requiredTotal,
          decidedTotal: result.gate.decidedTotal
        })
      }
      return result
    }
  )

  ipcMain.handle(IPC.reopenEvidenceReview, (_e, reviewId: unknown): EvidenceReview | null => {
    requireUnlocked()
    const id = safeId(reviewId)
    return id ? reopenEvidenceReview(ctx.db, id) : null
  })

  // Phase-4 seam (spec §21), STUBBED per plan §6.4: a known review reports the same
  // "not known to be outdated" overlay every read already carries — never a verified
  // claim. The real snapshot-vs-workspace comparison replaces this body in Phase 4.
  ipcMain.handle(
    IPC.refreshEvidenceReviewState,
    (_e, reviewId: unknown): EvidenceReviewFreshness | null => {
      requireUnlocked()
      const id = safeId(reviewId)
      if (!id) return null
      return getEvidenceReview(ctx.db, id) ? { reviewId: id, outdated: false } : null
    }
  )

  ipcMain.handle(IPC.deleteEvidenceReview, (_e, reviewId: unknown): boolean => {
    requireUnlocked()
    const id = safeId(reviewId)
    if (!id) return false
    const deleted = deleteEvidenceReview(ctx.db, id)
    if (deleted) {
      ctx.audit?.('evidence_review_deleted', 'Evidence review deleted', { reviewId: id })
    }
    return deleted
  })
}
