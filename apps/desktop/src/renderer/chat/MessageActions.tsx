// Per-message action row (guidelines §3): shown under assistant answers,
// revealed on hover or keyboard focus (CSS — the buttons stay focusable while hidden).
// "Try again" regenerates (last answer, plain chat only), "Copy" copies the answer text,
// "Save" saves the whole conversation, "Export CSV" (result-tables §4 — only on answers
// carrying a result table) saves the answer's structured table to a user-chosen file.
// "Review evidence" / "Continue review" (EP-1 plan §7.2, spec §9.1/§9.4 — only on
// review-eligible document-grounded answers) opens the review workspace; an existing
// review shows a small Draft/Ready status chip (Outdated arrives in Phase 4).
// Feedback ("Copied"/"Saved") goes through the toast host — the buttons never mutate their own labels.

import type { EvidenceReviewStatus } from '@shared/types'
import { useT } from '../i18n'

interface Props {
  /** Omit to hide (only the last assistant answer in a plain chat can regenerate). */
  onTryAgain?: () => void
  onCopy: () => void
  onSave: () => void
  /** Omit to hide (only answers with `hasResultTable` carry an exportable table). */
  onExportTable?: () => void
  /** Omit to hide (only `isReviewEligible` answers offer a review — spec §9.1). */
  onReview?: () => void
  /** The message's existing review status, or null/absent when none exists yet. */
  reviewStatus?: EvidenceReviewStatus | null
  disabled?: boolean
}

export function MessageActions({
  onTryAgain,
  onCopy,
  onSave,
  onExportTable,
  onReview,
  reviewStatus,
  disabled
}: Props): JSX.Element {
  const { t } = useT()
  return (
    <div className="msg-actions">
      {onTryAgain && (
        <button type="button" className="msg-action" disabled={disabled} onClick={onTryAgain}>
          ↺ {t('chat.actions.tryAgain')}
        </button>
      )}
      {onExportTable && (
        <button
          type="button"
          className="msg-action"
          disabled={disabled}
          title={t('chat.actions.exportCsvTitle')}
          onClick={onExportTable}
        >
          {t('chat.actions.exportCsv')}
        </button>
      )}
      <button type="button" className="msg-action" disabled={disabled} onClick={onCopy}>
        {t('chat.actions.copy')}
      </button>
      <button
        type="button"
        className="msg-action"
        disabled={disabled}
        title={t('chat.actions.saveTitle')}
        onClick={onSave}
      >
        {t('chat.actions.save')}
      </button>
      {/* Spec §9.1 order: Review evidence sits last. The label flips to "Continue review"
          once a review exists (§9.4); the quiet status chip is text+glyph, never color-only
          (guidelines §9). Streaming: the shared `disabled` covers the whole row. */}
      {onReview && (
        <>
          <button type="button" className="msg-action" disabled={disabled} onClick={onReview}>
            {reviewStatus ? t('review.action.continue') : t('review.action.start')}
          </button>
          {reviewStatus && (
            <span className="msg-review-chip">
              <span aria-hidden="true">{reviewStatus === 'ready' ? '✓' : '○'}</span>{' '}
              {t(reviewStatus === 'ready' ? 'review.status.ready' : 'review.status.draft')}
            </span>
          )}
        </>
      )}
    </div>
  )
}
