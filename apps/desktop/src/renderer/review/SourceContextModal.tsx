import { useEffect, useState } from 'react'
import type { EvidenceSourceContext } from '@shared/types'
import { Modal } from '../components'
import type { I18n } from '../i18n'

// Source-in-context modal (EP-1 plan §9.3, D-5, spec §10.2.4): the STORED extracted text
// around one source's persisted excerpt, with the excerpt highlighted and a hash-state
// line. All resolution is MAIN-SIDE (`evidence:sourceContext` — review id + source KEY
// only; the renderer never names documents or paths), and the text comes from the stored
// extraction, never from re-reading the source file (the modal says so).
//
// States (all text + icon, never color-only):
//  - located: dim before-text, <mark> excerpt, dim after-text;
//  - available but not located: honest "could not locate" + the persisted excerpt;
//  - missing document: the spec §15.4 copy + the persisted excerpt;
//  - load failure / null (stale key): honest failure copy.
// The hash-state line always renders: match / mismatch (§15.5 copy) / cannot-verify.

export function SourceContextModal({
  open,
  reviewId,
  sourceKey,
  onClose,
  t
}: {
  open: boolean
  reviewId: string
  /** The snapshot key of the source to resolve; null = nothing to show. */
  sourceKey: string | null
  onClose: () => void
  t: I18n['t']
}): JSX.Element {
  const [context, setContext] = useState<EvidenceSourceContext | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    if (!open || !sourceKey) return
    let cancelled = false
    setPhase('loading')
    setContext(null)
    void (async () => {
      try {
        const result = await window.api.getEvidenceSourceContext(reviewId, sourceKey)
        if (cancelled) return
        setContext(result)
        setPhase(result ? 'ready' : 'failed')
      } catch {
        if (!cancelled) setPhase('failed')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, reviewId, sourceKey])

  const hashKey =
    context?.hashState === 'match'
      ? 'review.sourceContext.hashMatch'
      : context?.hashState === 'mismatch'
        ? 'review.sourceContext.hashMismatch'
        : 'review.sourceContext.hashUnknown'

  return (
    <Modal open={open} onClose={onClose} title={t('review.sourceContext.title')} width="wide" t={t}>
      <div className="review-source-context">
        {phase === 'loading' && <p className="hint">{t('review.sourceContext.loading')}</p>}
        {phase === 'failed' && <p className="hint">{t('review.sourceContext.failed')}</p>}
        {phase === 'ready' && context && (
          <>
            <p className="review-context-doc">
              <strong>{context.documentTitle}</strong>
              {context.pageNumber != null && (
                <span className="hint"> · {t('chat.sources.page', { page: context.pageNumber })}</span>
              )}
              {context.pageNumber == null && context.sectionLabel && (
                <span className="hint"> · {context.sectionLabel}</span>
              )}
            </p>
            {/* The hash-state line (D-5): the same stored-hash comparison freshness uses. */}
            <p className="hint review-context-hash">
              <span aria-hidden="true">{context.hashState === 'match' ? '✓' : '⚠'}</span>{' '}
              {t(hashKey)}
            </p>
            {context.availability === 'missing' && (
              <p className="hint review-context-missing">
                <span aria-hidden="true">⚠</span> {t('review.sourceContext.missing')}
              </p>
            )}
            {context.located ? (
              <>
                <div className="review-context-text">
                  {context.before && <span className="review-context-dim">{context.before}</span>}
                  <mark className="review-context-match">{context.match}</mark>
                  {context.after && <span className="review-context-dim">{context.after}</span>}
                </div>
                <p className="hint">{t('review.sourceContext.storedNote')}</p>
              </>
            ) : (
              <>
                {context.availability === 'available' && (
                  <p className="hint">{t('review.sourceContext.notLocated')}</p>
                )}
                {context.snippet && (
                  <>
                    <h3 className="review-context-excerpt-head">
                      {t('review.sourceContext.excerptHeading')}
                    </h3>
                    <blockquote className="review-context-snippet">{context.snippet}</blockquote>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
