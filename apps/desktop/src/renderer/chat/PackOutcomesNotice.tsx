import { useId, useState } from 'react'
import type { KnowledgePackOutcome } from '@shared/types'
import { useT } from '../i18n'

// Per-answer knowledge-pack outcomes (#301 P4, findings M6/M7; plan §9.21 (e)7).
//
// THE HONESTY PROBLEM this closes: before P4 a ticked pack that was disabled, unavailable,
// index-less, trimmed by the selection cap, or whose search failed contributed nothing and SAID
// nothing — the answer looked exactly like "your packs were searched and had nothing to add".
// Every pack the ask's scope selected now carries one recorded outcome, and this is where the
// user reads it.
//
// Placement (deliberately NOT inside `SourcesDisclosure`): the disclosure renders only when the
// answer cites something, and the turns that need this notice most are the ones with ZERO
// citation cards — the no-context answer whose packs all failed. So it hangs off the message
// block directly, under the answer.
//
// Copy is CODE → fixed string. The reason codes are the whole diagnostic (`KnowledgePackOutcome`
// carries no path, filename or stderr by contract), so an unknown code can only come from a
// newer build's data; `parsePackOutcomes` drops those main-side, and the render below falls back
// to the bare status word rather than printing a raw code.

/** The i18n key for one outcome's status/reason line. `searched` has no reason by contract. */
function outcomeCopy(
  t: ReturnType<typeof useT>['t'],
  outcome: KnowledgePackOutcome
): string {
  if (outcome.status === 'searched' || outcome.reason == null) return t('chat.packs.outcome.searched')
  // The key is `chat.packs.outcome.<code>`; every code in `KnowledgePackOutcomeReason` has one.
  return t(`chat.packs.outcome.${outcome.reason}` as 'chat.packs.outcome.searched')
}

export function PackOutcomesNotice({
  outcomes,
  hasArchiveCitation
}: {
  /** The answer's persisted outcomes, or undefined on a legacy row / a pack-less ask. */
  outcomes?: KnowledgePackOutcome[]
  /** True when the turn cites at least one ARCHIVE source. A legacy turn that did — persisted
   *  before this column existed — gets the explicit "outcome not recorded" line instead of a
   *  silent gap; a turn with neither outcomes nor archive citations renders nothing at all. */
  hasArchiveCitation?: boolean
}): JSX.Element | null {
  const { t, tCount } = useT()
  const [open, setOpen] = useState(false)
  const baseId = useId()
  const regionId = `${baseId}-region`

  if (!outcomes || outcomes.length === 0) {
    // LEGACY: an older answer that cited an archive but recorded no outcomes. Saying so beats
    // inventing one — and beats silence, which would read as "nothing to report".
    if (!hasArchiveCitation) return null
    return (
      <div className="pack-outcomes" role="note">
        <span className="pack-outcomes-summary">{t('chat.packs.outcome.unknown')}</span>
      </div>
    )
  }

  const searched = outcomes.filter((o) => o.status === 'searched').length
  const other = outcomes.length - searched
  return (
    <div className="pack-outcomes" role="note">
      {/* A <button aria-expanded> like SourcesDisclosure, not a native <details>: the same
          keyboard/AT behaviour as every other inline disclosure in the transcript. */}
      <button
        type="button"
        className="pack-outcomes-toggle"
        id={baseId}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>{' '}
        {t('chat.packs.outcome.summary', { searched, other })}
      </button>
      {open && (
        <ul className="pack-outcomes-rows" id={regionId} aria-labelledby={baseId}>
          {outcomes.map((o) => (
            <li key={o.packId} className="pack-outcome-row">
              {/* An id with no registration row at all has a null title (the pack was deleted
                  after the ask): name the state, never the raw UUID. */}
              <span className="pack-outcome-title">
                {o.title ?? t('chat.packs.outcome.removedPack')}
              </span>
              <span className="pack-outcome-state">{outcomeCopy(t, o)}</span>
              {o.status === 'searched' && (
                <span className="pack-outcome-count">
                  {tCount('chat.packs.outcome.passages', o.admitted)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
