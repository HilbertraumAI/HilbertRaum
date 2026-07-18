import { useId, useState } from 'react'
import type {
  CoverageInfo,
  EvidenceReviewItem,
  EvidenceSourceSnapshot
} from '@shared/types'
import { formatCitationLabel } from '../lib/displayMap'
import { PROVENANCE_CARD_CAP } from '../chat/SourcesDisclosure'
import type { I18n } from '../i18n'

// The review workspace's evidence pane (EP-1 plan §7.3, spec §11.4): the answer's FROZEN
// source snapshots as cards reusing the SourcesDisclosure card idiom, headed by the
// per-mode honesty caption (spec §24.3). The whole-document caption is the load-bearing
// "provenance, not citations" claim — a provenance card NEVER shows an [Sn] marker (it
// would misread as a 1:1 inline citation), exactly like SourcesDisclosure.
//
// Linking (spec §13): with a review item selected, each card offers "Link to item" /
// "Remove link". Renderer-made links are ALWAYS "Reviewer linked" (main forces
// `origin: 'reviewer'`); the relation flag (spec §14.3 — supports/qualifies/contradicts/
// context) is offered on reviewer links only. An `answer_marker` link shows the "Cited by
// the answer" label read-only: re-writing it through `setEvidenceLink` would overwrite the
// origin to 'reviewer' and silently destroy the citation claim — deliberately not offered.

export type EvidencePaneMode = 'relevance' | 'whole_doc' | 'structured'

/** Map the snapshotted coverage mode to the pane's honesty caption class (the Phase-1
 *  snapshot-builder mapping: relevance/absent → relevance; extract → structured;
 *  tree/capped/unknown → whole-document — degrade toward the weaker claim). */
export function evidencePaneMode(coverage: CoverageInfo | null): EvidencePaneMode {
  const mode = coverage?.mode
  if (mode == null || mode === 'relevance') return 'relevance'
  if (mode === 'extract') return 'structured'
  return 'whole_doc'
}

const CAPTION_KEY = {
  relevance: 'review.evidence.captionRelevance',
  whole_doc: 'review.evidence.captionWholeDoc',
  structured: 'review.evidence.captionStructured'
} as const

const RELATIONS = ['supports', 'qualifies', 'contradicts', 'context'] as const
type Relation = (typeof RELATIONS)[number]

export function EvidencePane({
  sources,
  coverage,
  selectedItem,
  onLink,
  onUnlink,
  onSetRelation,
  t,
  tCount
}: {
  sources: EvidenceSourceSnapshot[]
  coverage: CoverageInfo | null
  /** The review item link/unlink actions operate on; null = none selected (actions hint). */
  selectedItem: EvidenceReviewItem | null
  onLink: (itemId: string, evidenceKey: string) => void
  onUnlink: (itemId: string, evidenceKey: string) => void
  onSetRelation: (itemId: string, evidenceKey: string, relation: Relation | null) => void
  t: I18n['t']
  tCount: I18n['tCount']
}): JSX.Element {
  // Same cap + reveal as SourcesDisclosure (spec §25.6): the full persisted set stays
  // available; the initial render is capped for large provenance sets.
  const [showAll, setShowAll] = useState(false)
  const overCap = !showAll && sources.length > PROVENANCE_CARD_CAP
  const shown = overCap ? sources.slice(0, PROVENANCE_CARD_CAP) : sources
  const paneMode = evidencePaneMode(coverage)
  const headId = useId()
  return (
    <div className="review-evidence" role="region" aria-labelledby={headId}>
      <h2 id={headId} className="review-evidence-title">
        {t('review.evidence.title')}
      </h2>
      <p className="hint review-evidence-caption">{t(CAPTION_KEY[paneMode])}</p>
      {/* The spec §24.3 review disclaimer — ambient, next to the evidence it qualifies. */}
      <p className="hint review-disclaimer">{t('review.disclaimer')}</p>
      {sources.length === 0 && <p className="hint">{t('review.evidence.none')}</p>}
      {sources.length > 0 && selectedItem == null && (
        <p className="hint review-link-hint">{t('review.link.selectHint')}</p>
      )}
      {shown.map((s) => (
        <EvidenceCard
          key={s.key}
          source={s}
          selectedItem={selectedItem}
          onLink={onLink}
          onUnlink={onUnlink}
          onSetRelation={onSetRelation}
          t={t}
        />
      ))}
      {overCap && (
        <button type="button" className="sources-more" onClick={() => setShowAll(true)}>
          {tCount('chat.sources.more', sources.length - PROVENANCE_CARD_CAP)}
        </button>
      )}
    </div>
  )
}

function EvidenceCard({
  source,
  selectedItem,
  onLink,
  onUnlink,
  onSetRelation,
  t
}: {
  source: EvidenceSourceSnapshot
  selectedItem: EvidenceReviewItem | null
  onLink: (itemId: string, evidenceKey: string) => void
  onUnlink: (itemId: string, evidenceKey: string) => void
  onSetRelation: (itemId: string, evidenceKey: string, relation: Relation | null) => void
  t: I18n['t']
}): JSX.Element {
  const relationId = useId()
  const link = selectedItem?.links.find((l) => l.evidenceKey === source.key) ?? null
  // Only a DIRECT EXCERPT carries the localized [Sn] marker (EN [S1] / DE [Q1]) — a
  // provenance/structured source shows none (SourcesDisclosure precedent, spec §13.3).
  const showMarker = source.kind === 'direct_excerpt' && source.machineLabel
  return (
    <div className="source-card review-source-card">
      <div className="source-card-head">
        {showMarker && (
          <span className="cite-label">[{formatCitationLabel(t, source.machineLabel!)}]</span>
        )}
        <span className="source-card-title">{source.documentTitle}</span>
        {source.pageNumber != null ? (
          <span className="source-card-where">
            {t('chat.sources.page', { page: source.pageNumber })}
          </span>
        ) : source.sectionLabel ? (
          <span className="source-card-where">{source.sectionLabel}</span>
        ) : null}
      </div>
      {source.snippet && <div className="source-card-snippet">{source.snippet}</div>}
      <div className="review-source-meta">
        <span className="review-source-kind">{t(`review.source.kind.${source.kind}`)}</span>
        {/* Honest identity/availability states (spec §13.5/§25.2; Phase-4 freshness adds
            live states — these are the CREATION-TIME facts the snapshot recorded). */}
        {source.identity === 'unresolved' && (
          <span className="review-source-state">
            <span aria-hidden="true">?</span> {t('review.source.unresolved')}
          </span>
        )}
        {source.availabilityAtCreation === 'missing' && (
          <span className="review-source-state">
            <span aria-hidden="true">⚠</span> {t('review.source.missingAtCreation')}
          </span>
        )}
      </div>
      {selectedItem != null && (
        <div className="review-source-actions">
          {link == null && (
            <button
              type="button"
              className="msg-action"
              onClick={() => onLink(selectedItem.id, source.key)}
            >
              {t('review.link.add')}
            </button>
          )}
          {link != null && (
            <>
              <span className="review-link-origin">
                {t(link.origin === 'answer_marker' ? 'review.link.cited' : 'review.link.reviewer')}
              </span>
              {link.origin === 'reviewer' && (
                <span className="review-relation">
                  <label htmlFor={relationId}>{t('review.relation.label')}</label>{' '}
                  <select
                    id={relationId}
                    value={link.relation ?? ''}
                    onChange={(e) =>
                      onSetRelation(
                        selectedItem.id,
                        source.key,
                        e.target.value === '' ? null : (e.target.value as Relation)
                      )
                    }
                  >
                    <option value="">{t('review.relation.none')}</option>
                    {RELATIONS.map((r) => (
                      <option key={r} value={r}>
                        {t(`review.relation.${r}`)}
                      </option>
                    ))}
                  </select>
                </span>
              )}
              <button
                type="button"
                className="msg-action"
                onClick={() => onUnlink(selectedItem.id, source.key)}
              >
                {t('review.link.remove')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
