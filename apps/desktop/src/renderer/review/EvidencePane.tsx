import { useId, useState } from 'react'
import type {
  CoverageInfo,
  EvidenceReviewFreshness,
  EvidenceReviewItem,
  EvidenceSourceFreshnessState,
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

// The honesty-mode mapping MOVED to shared/evidence-review.ts in Phase 3 (plan §8.1) so the
// main-side pack model reuses the exact same function; imported + re-exported here so
// Phase-2 imports (ReviewScreen + tests) stay valid. Semantics unchanged: relevance/absent
// → relevance; extract → structured; tree/capped/unknown → whole-document (weaker claim).
import { evidencePaneMode } from '@shared/evidence-review'
export { evidencePaneMode, type EvidencePaneMode } from '@shared/evidence-review'

const CAPTION_KEY = {
  relevance: 'review.evidence.captionRelevance',
  whole_doc: 'review.evidence.captionWholeDoc',
  structured: 'review.evidence.captionStructured'
} as const

const RELATIONS = ['supports', 'qualifies', 'contradicts', 'context'] as const
type Relation = (typeof RELATIONS)[number]

/** True when `source` matches the filter query (already lowercased). Matches the VISIBLE
 *  card facts: title, snippet, section label, the marker as DISPLAYED (review FIX-2 —
 *  `formatCitationLabel`, so a German reviewer typing the "Q3" the card shows matches;
 *  the raw machine "S3" keeps matching too), and the page number. */
function matchesSourceFilter(source: EvidenceSourceSnapshot, q: string, t: I18n['t']): boolean {
  return (
    source.documentTitle.toLowerCase().includes(q) ||
    (source.snippet ?? '').toLowerCase().includes(q) ||
    (source.sectionLabel ?? '').toLowerCase().includes(q) ||
    (source.machineLabel ?? '').toLowerCase().includes(q) ||
    (source.machineLabel != null &&
      formatCitationLabel(t, source.machineLabel).toLowerCase().includes(q)) ||
    (source.pageNumber != null && String(source.pageNumber).includes(q))
  )
}

export function EvidencePane({
  sources,
  coverage,
  selectedItem,
  selectedItemNumber,
  readOnly,
  freshness,
  onLink,
  onUnlink,
  onSetRelation,
  onOpenContext,
  t,
  tCount
}: {
  sources: EvidenceSourceSnapshot[]
  coverage: CoverageInfo | null
  /** The review item link/unlink actions operate on; null = none selected (actions hint). */
  selectedItem: EvidenceReviewItem | null
  /** P5 (spec §23): the selected item's 1-based display number — renders the visible
   *  "Linking evidence for review item N" line that ties the pane to the answer pane. */
  selectedItemNumber?: number | null
  /** Ready review (FIX-1): link/unlink/relation controls disable until reopened. */
  readOnly?: boolean
  /** P4: the at-open freshness verdict; null = none landed yet (cards show creation facts only). */
  freshness?: EvidenceReviewFreshness | null
  onLink: (itemId: string, evidenceKey: string) => void
  onUnlink: (itemId: string, evidenceKey: string) => void
  onSetRelation: (itemId: string, evidenceKey: string, relation: Relation | null) => void
  /** P4 (D-5): open the source-in-context modal for one snapshot key. */
  onOpenContext?: (evidenceKey: string) => void
  t: I18n['t']
  tCount: I18n['tCount']
}): JSX.Element {
  // Cap + STEPPED reveal (spec §25.6/§26, P5): the full persisted set stays available; the
  // initial render is capped at PROVENANCE_CARD_CAP cards and each reveal adds one more
  // cap-sized batch. This bounds the mounted DOM regardless of set size — measured against
  // the spec's 24-card norm, the cap+reveal keeps the pane fast WITHOUT virtualization
  // (no @tanstack/react-virtual; the initial DOM never exceeds the cap).
  const [revealed, setRevealed] = useState(PROVENANCE_CARD_CAP)
  // P5 filter (spec §25.6 "search/filter") — offered once the set exceeds the initial cap
  // (below it every card is already on screen). Filtering narrows BEFORE the cap.
  const [filter, setFilter] = useState('')
  const filterId = useId()
  const query = filter.trim().toLowerCase()
  const filtered =
    query === '' ? sources : sources.filter((s) => matchesSourceFilter(s, query, t))
  const shown = filtered.length > revealed ? filtered.slice(0, revealed) : filtered
  const remaining = filtered.length - shown.length
  const paneMode = evidencePaneMode(coverage)
  const headId = useId()
  const linkingId = useId()
  const showLinkingLine = sources.length > 0 && selectedItem != null && selectedItemNumber != null
  const stateByKey = new Map<string, EvidenceSourceFreshnessState>(
    (freshness?.sources ?? []).map((s) => [s.key, s.state])
  )
  return (
    <div
      className="review-evidence"
      role="region"
      aria-labelledby={headId}
      // Spec §23 (review FIX-3): the region's accessible DESCRIPTION carries the selected-
      // item context ("Linking evidence for review item N") — the NAME stays the stable
      // "Evidence" title. The SAME region (this component) mounts in the wide aside and in
      // the narrow drawer Modal, so both layouts carry the association.
      aria-describedby={showLinkingLine ? linkingId : undefined}
    >
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
      {showLinkingLine && (
        <p className="hint review-linking-item" id={linkingId}>
          {t('review.evidence.linkingItem', { n: selectedItemNumber })}
        </p>
      )}
      {sources.length > PROVENANCE_CARD_CAP && (
        <div className="review-evidence-filter">
          <label htmlFor={filterId} className="hint">
            {t('review.evidence.filterLabel')}
          </label>
          <input
            id={filterId}
            type="text"
            className="review-evidence-filter-input"
            placeholder={t('review.evidence.filterPlaceholder')}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value)
              // A new query restarts the reveal — predictable "first page of matches".
              setRevealed(PROVENANCE_CARD_CAP)
            }}
          />
          {query !== '' && (
            <button
              type="button"
              className="msg-action"
              onClick={() => {
                setFilter('')
                setRevealed(PROVENANCE_CARD_CAP)
              }}
            >
              {t('review.evidence.filterClear')}
            </button>
          )}
        </div>
      )}
      {/* Persistent live region (review FIX-5a): mounted EMPTY alongside the filter and
          filled on the no-match state — a region that first APPEARS with its content is
          missed by some screen readers; text changing inside an existing region is not. */}
      {sources.length > PROVENANCE_CARD_CAP && (
        <p className="hint review-evidence-filter-none" role="status">
          {query !== '' && filtered.length === 0 ? t('review.evidence.filterNone') : ''}
        </p>
      )}
      {shown.map((s) => (
        <EvidenceCard
          key={s.key}
          source={s}
          currentState={freshness ? (stateByKey.get(s.key) ?? null) : null}
          selectedItem={selectedItem}
          readOnly={readOnly === true}
          onLink={onLink}
          onUnlink={onUnlink}
          onSetRelation={onSetRelation}
          onOpenContext={onOpenContext}
          t={t}
        />
      ))}
      {remaining > 0 && (
        <>
          {/* Plain text, deliberately NOT a live region (review FIX-5a): it changes only
              in direct response to the user's own reveal click, right beside the button. */}
          <p className="hint review-evidence-shown">
            {t('review.evidence.shownCount', { shown: shown.length, total: filtered.length })}
          </p>
          {/* AUD-11: the cards this uncovers are SOURCE cards, and the line right above
              says "{shown} of {total} sources shown" — so the control has its own copy
              instead of borrowing the chat's whole-document "…more sections" wording, which
              contradicted its own neighbour in EN and DE alike. */}
          <button
            type="button"
            className="sources-more"
            onClick={() => setRevealed((r) => r + PROVENANCE_CARD_CAP)}
          >
            {tCount('review.evidence.more', Math.min(remaining, PROVENANCE_CARD_CAP))}
          </button>
        </>
      )}
    </div>
  )
}

function EvidenceCard({
  source,
  currentState,
  selectedItem,
  readOnly,
  onLink,
  onUnlink,
  onSetRelation,
  onOpenContext,
  t
}: {
  source: EvidenceSourceSnapshot
  /** P4: the source's at-open freshness state; null = no verdict landed. */
  currentState: EvidenceSourceFreshnessState | null
  selectedItem: EvidenceReviewItem | null
  readOnly: boolean
  onLink: (itemId: string, evidenceKey: string) => void
  onUnlink: (itemId: string, evidenceKey: string) => void
  onSetRelation: (itemId: string, evidenceKey: string, relation: Relation | null) => void
  onOpenContext?: (evidenceKey: string) => void
  t: I18n['t']
}): JSX.Element {
  const relationId = useId()
  const link = selectedItem?.links.find((l) => l.evidenceKey === source.key) ?? null
  // Only a DIRECT EXCERPT carries the localized [Sn] marker (EN [S1] / DE [Q1]) — a
  // provenance/structured source shows none (SourcesDisclosure precedent, spec §13.3).
  const showMarker = source.kind === 'direct_excerpt' && source.machineLabel
  // P4 freshness badges (spec §15.4/§15.5), ADDITIONAL to the creation-time facts below:
  //  - 'changed'  → §15.5 copy (resolved sources only by construction);
  //  - 'missing'  → §15.4 copy, ONLY when the deletion is NEW (a creation-missing source
  //    already carries its own badge — no duplicate);
  //  - 'unverifiable' on a RESOLVED source (hash absent) → honest cannot-verify;
  //    UNRESOLVED sources keep only their existing "identity" badge — their state can
  //    never be presented as changed (binding P3 watch-out).
  const freshnessBadge =
    currentState === 'changed'
      ? ({ icon: '⚠', key: 'review.source.changed' } as const)
      : currentState === 'missing' && source.availabilityAtCreation !== 'missing'
        ? ({ icon: '⚠', key: 'review.source.missingNow' } as const)
        : currentState === 'unverifiable' && source.identity === 'resolved'
          ? ({ icon: '?', key: 'review.source.cannotVerify' } as const)
          : null
  // D-5: context resolves through the snapshotted documentId — only resolved sources can
  // offer it (an unresolved identity has no document to read; main refuses it too).
  const canOpenContext = onOpenContext != null && source.identity === 'resolved' && !!source.documentId
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
        {/* Honest identity/availability states (spec §13.5/§25.2): the CREATION-TIME facts
            the snapshot recorded; the P4 freshness badge below adds the CURRENT state. */}
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
        {freshnessBadge && (
          <span className="review-source-state review-source-freshness">
            <span aria-hidden="true">{freshnessBadge.icon}</span> {t(freshnessBadge.key)}
          </span>
        )}
      </div>
      {canOpenContext && (
        <div className="review-source-context-action">
          <button type="button" className="msg-action" onClick={() => onOpenContext(source.key)}>
            {t('review.sourceContext.open')}
          </button>
        </div>
      )}
      {selectedItem != null && (
        <div className="review-source-actions">
          {link == null && (
            <button
              type="button"
              className="msg-action"
              disabled={readOnly}
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
                    disabled={readOnly}
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
                disabled={readOnly}
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
