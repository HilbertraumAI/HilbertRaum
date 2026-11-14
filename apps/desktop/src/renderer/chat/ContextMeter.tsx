import type { ContextUsage } from '@shared/types'
import type { UiLanguage } from '@shared/i18n'
import { useT } from '../i18n'

// Conversation-memory meter (context-compaction plan §5.1; beta-feedback #25 / D69): a short visible
// LABEL ("Memory") + a thin quiet bar + an always-visible percentage in the composer footer, showing
// how full THIS conversation's memory is — so the user can see at a glance how much room is left (and
// understands WHY a summary happens, trusting nothing is silently lost). The label is what kills the
// #25 misreading: a bare `%` with role="progressbar" read as task/answer PROGRESS. This is a gauge of
// a current level, so it is role="meter" with a visible name, not a progress bar.
//
// The value is the over-counting word ESTIMATE (the exact-ish tokens ride the tooltip, labelled
// approximate); the bar + number cap at 100%. During a turn the parent feeds a LIVE usage so both
// climb as the answer streams.
//
// Tone is visual only: calm < 75%, amber 75–89%, near-full ≥ 90%. At/above the amber threshold the
// tooltip adds the "older messages will be summarized" line (the actual compaction trigger is 0.85,
// but the heads-up rides the visible amber band — guidelines: warn before, not at, the cliff).
// #742: the bands read the percent the meter SHOWS, not the raw ratio — at 0.746 the label said "75%"
// in the calm tone with no heads-up, and at 0.896 "90%" stayed amber.

const AMBER_PCT = 75
const NEAR_FULL_PCT = 90

/** "8000" → "8k", "6400" → "6.4k" (DE "6,4k"), "512" → "512" — compact token counts for the
 *  tooltip. Locale-aware via `toLocaleString(lang)` like the sibling formatters (M-U5;
 *  DiagnosticsTab.fmt1 / documents/format.tsx `formatSize`) — the bare `toFixed` shipped a
 *  wrong decimal separator into the German tooltip (full-audit 2026-07-11 CODE-41). EN
 *  output stays byte-identical to the previous toFixed form. */
function fmtTokens(n: number, lang: UiLanguage): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)))
  const k = n / 1000
  const digits = k % 1 === 0 ? 0 : 1
  return `${k.toLocaleString(lang, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false
  })}k`
}

export function ContextMeter({ usage }: { usage: ContextUsage }): JSX.Element | null {
  const { t, lang } = useT()
  const { usedTokens, window } = usage
  if (!(window > 0)) return null
  const pct = Math.min(100, Math.max(0, Math.round((usedTokens / window) * 100)))
  const tone = pct >= NEAR_FULL_PCT ? 'near-full' : pct >= AMBER_PCT ? 'amber' : 'calm'

  // The short visible name ("Memory" / "Speicher") — also the meter's accessible name (aria-label).
  const label = t('chat.context.label')
  // The tooltip carries the human-readable value (aria-valuetext + title): "Memory for this
  // conversation: 45% full (about 6.4k of 8k tokens)", plus the will-summarize heads-up once amber.
  let tooltip = t('chat.context.usageTooltip', {
    pct: String(pct),
    used: fmtTokens(usedTokens, lang),
    window: fmtTokens(window, lang)
  })
  if (pct >= AMBER_PCT) tooltip += ` ${t('chat.context.willSummarize')}`

  return (
    <span
      className={`context-meter context-meter-${tone}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={tooltip}
      aria-label={label}
      title={tooltip}
    >
      {/* Visible short label — the fix for #25: names the gauge so it never reads as task progress. */}
      <span className="context-meter-label" aria-hidden="true">
        {label}
      </span>
      <span className="context-meter-track" aria-hidden="true">
        <span className="context-meter-fill" style={{ width: `${pct}%` }} />
      </span>
      {/* Always-visible percentage (aria-hidden — the meter's aria-valuetext already carries the
          accessible reading). Tabular figures so it doesn't jitter as it climbs. The language's own
          percent pattern (#804): Turkish puts the sign first, French and Spanish a no-break space
          before it, German a space, as the tooltip beside it does. */}
      <span className="context-meter-pct" aria-hidden="true">
        {t('common.percent', { pct })}
      </span>
    </span>
  )
}
