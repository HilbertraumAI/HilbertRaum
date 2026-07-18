import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type {
  EvidenceExportRecord,
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
  EvidenceSourceContext,
  ReviewDecision
} from '../../shared/types'
import { tMain } from '../services/i18n'
import { findManifestById } from '../services/models'
import { createEvidenceReviewFromMessage } from '../services/evidence-pack/snapshot'
import {
  acknowledgeEvidenceReviewFreshness,
  computeEvidenceReviewFreshness
} from '../services/evidence-pack/freshness'
import { getEvidenceSourceContext } from '../services/evidence-pack/source-context'
import {
  exportEvidencePackToFile,
  EvidencePackOutdatedError,
  EvidencePackRecordError,
  EvidencePackUnrecordedFileError
} from '../services/evidence-pack/export'
import { printEvidencePackHtmlToPdf } from '../services/evidence-pack/print-pdf'
import {
  countEvidenceReviewsForConversation,
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

  // P4 read overlay (spec §18.4): the service reads report the honest constant-false
  // "not known to be outdated"; the IPC boundary is where the DERIVED overlay is applied —
  // detail + entry-point summary carry the REAL computed flag (stored-fact comparison,
  // trivially cheap), so the chat chip and a freshly opened screen are truthful without a
  // second round trip. Write-path returns (update/markReady/reopen/create) keep the
  // constant-false overlay — the renderer's freshness UI reads the refresh result, never
  // a write-return's flag.
  const outdatedOverlay = (reviewId: string): boolean =>
    computeEvidenceReviewFreshness(ctx.db, reviewId)?.outdated === true

  ipcMain.handle(IPC.getEvidenceReview, (_e, reviewId: unknown): EvidenceReviewDetail | null => {
    requireUnlocked()
    const id = safeId(reviewId)
    const detail = id ? getEvidenceReview(ctx.db, id) : null
    return detail ? { ...detail, outdated: outdatedOverlay(detail.id) } : null
  })

  ipcMain.handle(
    IPC.getEvidenceReviewForMessage,
    (_e, messageId: unknown): EvidenceReviewSummary | null => {
      requireUnlocked()
      const id = safeId(messageId)
      const summary = id ? getEvidenceReviewForMessage(ctx.db, id) : null
      return summary ? { ...summary, outdated: outdatedOverlay(summary.id) } : null
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
      if (!result) return null
      // Audit only a REAL transition (FIX-5): an already-ready review is a service-side
      // no-op — no re-stamp, no second event.
      if (result.becameReady) {
        ctx.audit?.('evidence_review_ready', 'Evidence review marked ready', {
          reviewId: result.review.id,
          requiredTotal: result.gate.requiredTotal,
          decidedTotal: result.gate.decidedTotal
        })
      }
      return { review: result.review, gate: result.gate }
    }
  )

  ipcMain.handle(IPC.reopenEvidenceReview, (_e, reviewId: unknown): EvidenceReview | null => {
    requireUnlocked()
    const id = safeId(reviewId)
    return id ? reopenEvidenceReview(ctx.db, id) : null
  })

  // The REAL freshness engine (Phase 4, spec §21.2): snapshot vs workspace from STORED
  // facts only — never re-hashes, never reads source files, never touches the model
  // runtime or network. Unresolved-identity sources stay 'unverifiable' (never 'changed').
  ipcMain.handle(
    IPC.refreshEvidenceReviewState,
    (_e, reviewId: unknown): EvidenceReviewFreshness | null => {
      requireUnlocked()
      const id = safeId(reviewId)
      return id ? computeEvidenceReviewFreshness(ctx.db, id) : null
    }
  )

  // Acknowledge the CURRENT drift (spec §15.5/§21.3/§28.6): records the drift fingerprint
  // + stamp so a LATER change re-demands acknowledgment; unlocks export while the drift is
  // unchanged. Never rewrites status/completed_at/updated_at (§18.4) — deliberately NOT
  // subject to the ready-state write-guard (it is lifecycle metadata, not a decision
  // edit). No audit event: reads/acknowledge carry no spec §22 audit type.
  ipcMain.handle(
    IPC.acknowledgeEvidenceReviewFreshness,
    (_e, reviewId: unknown): EvidenceReviewFreshness | null => {
      requireUnlocked()
      const id = safeId(reviewId)
      return id ? acknowledgeEvidenceReviewFreshness(ctx.db, id) : null
    }
  )

  // Source-in-context (D-5, spec §10.2.4/§22.10): the renderer names the review + source
  // KEY; main resolves the SNAPSHOTTED documentId through the review's own snapshot and
  // reads the STORED extraction (chunks table) around the persisted excerpt — no
  // renderer-supplied document ids, no paths, no source-file reads. Unknown review/key and
  // unresolved-identity sources read as null.
  ipcMain.handle(
    IPC.getEvidenceSourceContext,
    (_e, reviewId: unknown, sourceKey: unknown): EvidenceSourceContext | null => {
      requireUnlocked()
      const id = safeId(reviewId)
      const key = safeId(sourceKey)
      return id && key ? getEvidenceSourceContext(ctx.db, id, key) : null
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

  // D-2 (spec §25.4, plan §7.6): the conversation-delete confirm names how many reviews the
  // cascade will remove. A pure COUNT — no titles, notes, or content ever cross this channel;
  // a malformed id reads as "no reviews" (0), matching the other unknown-id results.
  ipcMain.handle(
    IPC.countEvidenceReviewsForConversation,
    (_e, conversationId: unknown): number => {
      requireUnlocked()
      const id = safeId(conversationId)
      return id ? countEvidenceReviewsForConversation(ctx.db, id) : 0
    }
  )

  // Evidence-pack export (plan §8.3 — the 15th channel, deliberately registered in Phase 3
  // alongside its implementation; P6 adds PDF over the SAME channel): deterministic HTML
  // render (+ hidden-window print for PDF, plan §11/D-1) + ATOMIC write; null on an
  // unknown id or user cancel, and a failure up to the rename leaves NO file and NO row
  // (spec §28.9). A POST-rename record failure unlinks the just-written file and rejects
  // with honest localized copy (never reported as a cancel); if even the unlink fails, a
  // DISTINCT message says the file exists but is not in the export history. Works on draft
  // AND ready reviews — the ready-state write-guard covers item/link mutations only. The
  // dialog + fs run in MAIN (the renderer has no fs/dialog access), and the options
  // payload is resolved through the tolerant boundary resolvers — unknown keys drop, an
  // unknown format reads 'html'. The save dialog OFFERS both formats (requested first);
  // the chosen extension decides the effective one (`packFormatForDestination`). Audit
  // is {reviewId, format} ONLY: the chosen path and the review TITLE (which seeds the
  // suggested file name) are content and never recorded (sentinel-tested).
  ipcMain.handle(
    IPC.exportEvidencePack,
    async (_e, reviewId: unknown, options: unknown): Promise<EvidenceExportRecord | null> => {
      requireUnlocked()
      const id = safeId(reviewId)
      if (!id) return null
      let record: EvidenceExportRecord | null
      try {
        record = await exportEvidencePackToFile(ctx.db, id, options, {
          chooseDestination: async (suggestedFileName, format) => {
            const win = BrowserWindow.getFocusedWindow()
            const htmlFilter = { name: 'HTML', extensions: ['html'] }
            const pdfFilter = { name: 'PDF', extensions: ['pdf'] }
            const dialogOptions: Electron.SaveDialogOptions = {
              title: tMain('main.dialog.exportEvidencePack'),
              defaultPath: suggestedFileName,
              // Both formats on offer (plan §11), the requested one first — the first
              // filter is the dialog's preselected "Save as type".
              filters: format === 'pdf' ? [pdfFilter, htmlFilter] : [htmlFilter, pdfFilter],
              // §24.3 encryption-boundary warning: the renderer's export panel shows it on
              // every platform; `message` additionally surfaces it inside the macOS sheet.
              message: tMain('review.export.encryptionWarning')
            }
            const result = win
              ? await dialog.showSaveDialog(win, dialogOptions)
              : await dialog.showSaveDialog(dialogOptions)
            return result.canceled || !result.filePath ? null : result.filePath
          },
          // The P6 hidden-window print harness — sandboxed, preload-free, torn down in
          // `finally` and on app quit; fed the rendered pack HTML verbatim.
          renderPdf: printEvidencePackHtmlToPdf
        })
      } catch (err) {
        // Localize the named outcomes (service messages are ids-only English);
        // everything else propagates as-is.
        if (err instanceof EvidencePackOutdatedError) {
          throw new Error(tMain('main.evidenceReviews.exportOutdated'))
        }
        if (err instanceof EvidencePackUnrecordedFileError) {
          throw new Error(tMain('main.evidenceReviews.exportFileNotRecorded'))
        }
        if (err instanceof EvidencePackRecordError) {
          throw new Error(tMain('main.evidenceReviews.exportNotRecorded'))
        }
        throw err
      }
      if (record) {
        ctx.audit?.('evidence_pack_exported', 'Evidence pack exported', {
          reviewId: id,
          format: record.format
        })
      }
      return record
    }
  )
}
