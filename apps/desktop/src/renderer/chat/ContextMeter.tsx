import type { ContextUsage } from '@shared/types'
import { useT } from '../i18n'

// Context-window usage meter (context-compaction plan §5.1): a thin, quiet bar PLUS an always-visible
// percentage in the composer footer, showing how full the model's context window is for the active
// conversation — so the user can see at a glance how much room is left (and understands WHY a summary
// happens, trusting nothing is silently lost). The value is the over-counting word ESTIMATE (the
// exact tokens are in the tooltip, labelled approximate); the bar + number cap at 100%. During a turn
// the parent feeds a LIVE usage so both climb as the answer streams.
//
// Tone is visual only: calm < 75%, amber 75–90%, near-full ≥ 90%. At/above the amber threshold the
// tooltip adds the "older messages will be summarized" line (the actual compaction trigger is 0.85,
// but the heads-up rides the visible amber band — guidelines: warn before, not at, the cliff).

const AMBER_AT = 0.75
const NEAR_FULL_AT = 0.9

/** "8000" → "8k", "6400" → "6.4k", "512" → "512" — compact token counts for the tooltip. */
function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)))
  const k = n / 1000
  return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`
}

export function ContextMeter({ usage }: { usage: ContextUsage }): JSX.Element | null {
  const { t } = useT()
  const { usedTokens, window } = usage
  if (!(window > 0)) return null
  const ratio = usedTokens / window
  const pct = Math.min(100, Math.max(0, Math.round(ratio * 100)))
  const tone = ratio >= NEAR_FULL_AT ? 'near-full' : ratio >= AMBER_AT ? 'amber' : 'calm'

  // The tooltip is the meter's accessible name too (no extra i18n key): "Context: 6.4k / 8k tokens
  // (approximate)", plus the will-summarize heads-up once amber.
  let tooltip = t('chat.context.usageTooltip', {
    used: fmtTokens(usedTokens),
    window: fmtTokens(window)
  })
  if (ratio >= AMBER_AT) tooltip += ` ${t('chat.context.willSummarize')}`

  return (
    <span
      className={`context-meter context-meter-${tone}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={tooltip}
      aria-label={tooltip}
      title={tooltip}
    >
      <span className="context-meter-track" aria-hidden="true">
        <span className="context-meter-fill" style={{ width: `${pct}%` }} />
      </span>
      {/* Always-visible percentage (aria-hidden — the progressbar's aria-valuetext already carries
          the accessible "X / Yk tokens" reading). Tabular figures so it doesn't jitter as it climbs. */}
      <span className="context-meter-pct" aria-hidden="true">
        {pct}%
      </span>
    </span>
  )
}
