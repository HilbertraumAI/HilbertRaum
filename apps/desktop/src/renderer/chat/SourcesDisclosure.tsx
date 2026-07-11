import { useId, useState } from 'react'
import type { Citation, CoverageMode } from '@shared/types'
import { useT } from '../i18n'
import { formatCitationLabel } from '../lib/displayMap'

// "▸ Sources (N)" (guidelines §3): citations stay attached to the answer as an inline
// disclosure, collapsed by default, with `aria-controls` wiring the toggle to the expanded
// region (FE-D, full-audit-2026-06-29 follow-up Phase 5).
//
// Two honestly-different kinds of "citation", told apart by the answer's coverage mode
// (FE-B / F11 renderer half, same round):
//   - RELEVANCE (mode `relevance`, or a pre-migration NULL-coverage answer): the cards are the
//     1:1 inline-grounded excerpts the model was actually shown and cited ([Sn] each) → the
//     literal "Sources (N)" label and every card, unchanged.
//   - WHOLE-DOCUMENT (mode `tree`/`capped`/`extract`): the "citations" are LEAF PROVENANCE —
//     one entry per reachable document section (up to ~1000, uncapped server-side), NOT inline
//     grounding (the prompt carries no [Sn] markers; the model emits none). Presenting them as
//     "Sources (1000)" + 1000 cards reads as "the model cited 1000 passages" and janks. So a
//     provenance answer relabels to "Drawn from the document — N sections", drops the [Sn]
//     excerpt framing, marks the cards "Sections covered", and caps the render (~24 + an "and N
//     more sections" reveal). The CoverageMeter beside it owns the breadth claim (whole /
//     beginning / partial), so this label stays breadth-neutral and never restates it.

/** How many provenance cards to render before the "and N more sections" reveal. */
const PROVENANCE_CARD_CAP = 24

export function SourcesDisclosure({
  citations,
  mode
}: {
  citations: Citation[]
  /** The answer's coverage mode; any whole-document mode (≠ relevance) renders as provenance. */
  mode?: CoverageMode
}): JSX.Element {
  // tCount for the provenance labels (full-audit 2026-07-11 CODE-8): a one-section document
  // ("— 1 section") and a one-section reveal tail ("and 1 more section") are both reachable.
  const { t, tCount } = useT()
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const baseId = useId()
  const regionId = `${baseId}-region`
  // A whole-document answer's citations are leaf PROVENANCE, not 1:1 inline citations; only a
  // relevance answer (explicit, or undefined ⇒ pre-migration NULL coverage) keeps the literal
  // "Sources (N)" framing — so this path is byte-identical to before for every relevance turn.
  const isProvenance = mode != null && mode !== 'relevance'
  const overCap = isProvenance && !showAll && citations.length > PROVENANCE_CARD_CAP
  const shown = overCap ? citations.slice(0, PROVENANCE_CARD_CAP) : citations
  return (
    <div className="sources">
      <button
        type="button"
        className="sources-toggle"
        id={baseId}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>{' '}
        {isProvenance
          ? tCount('chat.sources.wholeDoc', citations.length)
          : t('chat.sources.toggle', { count: citations.length })}
      </button>
      {open && (
        <div
          className={isProvenance ? 'sources-cards provenance' : 'sources-cards'}
          id={regionId}
          role="region"
          aria-labelledby={baseId}
        >
          {isProvenance && (
            <div className="sources-caption hint">{t('chat.sources.wholeDocCaption')}</div>
          )}
          {shown.map((c) => (
            <div key={c.label} className="source-card">
              <div className="source-card-head">
                {/* A relevance card's [Sn] is an inline citation the model emitted; a provenance
                    card is a SECTION the answer drew on, so it shows no [Sn] (would misread as a
                    1:1 citation). The marker is display-localized (EN [S1] / DE [Q1], D68); the
                    stored `c.label` stays the machine-stable `S{n}`. */}
                {!isProvenance && (
                  <span className="cite-label">[{formatCitationLabel(t, c.label)}]</span>
                )}
                <span className="source-card-title">{c.sourceTitle}</span>
                {c.pageNumber != null ? (
                  <span className="source-card-where">
                    {t('chat.sources.page', { page: c.pageNumber })}
                  </span>
                ) : c.section ? (
                  <span className="source-card-where">{c.section}</span>
                ) : null}
              </div>
              {c.snippet && <div className="source-card-snippet">{c.snippet}</div>}
            </div>
          ))}
          {overCap && (
            <button type="button" className="sources-more" onClick={() => setShowAll(true)}>
              {tCount('chat.sources.more', citations.length - PROVENANCE_CARD_CAP)}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
