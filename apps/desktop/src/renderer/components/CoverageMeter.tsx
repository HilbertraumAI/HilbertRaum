import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { CoverageInfo, CoverageTier } from '@shared/types'
import type { MessageKey } from '@shared/i18n'
import { useT } from '../i18n'
import { Badge, type BadgeTone } from './Badge'

// Coverage meter (whole-document-analysis plan §5.2, Phase 2). The honesty differentiator
// rendered with summary/answer results. It states BREADTH and DEPTH as two SEPARATE things —
// breadth ≠ fidelity [C1/L2]:
//   - breadth: "Covers the whole document" vs "the most relevant passages" — and "100%"/whole
//     is shown ONLY for a READY deep index; a building/stale/pending tree shows the partial
//     fraction, NEVER 100%.
//   - depth: the tier (a Tier-1 overview is abstractive/lossy even at 100% breadth).
// User-facing copy avoids the internal tree/node/chunk/embedding vocabulary (forbidden-UI-words):
// "deeply indexed", "sections", "passages" only.

/** Depth-tier labels (the DEPTH half of the meter / the tier selector). */
const TIER_LABEL: Record<CoverageTier, MessageKey> = {
  1: 'coverage.tier.1',
  2: 'coverage.tier.2',
  3: 'coverage.tier.3'
}
const TIER_HINT: Record<CoverageTier, MessageKey> = {
  1: 'coverage.tier.hint.1',
  2: 'coverage.tier.hint.2',
  3: 'coverage.tier.hint.3'
}

interface Breadth {
  tone: BadgeTone
  icon: string
  textKey: MessageKey
  params?: Record<string, string | number>
}

/** The breadth statement — what fraction of the document the result is based on. */
function breadthOf(coverage: CoverageInfo): Breadth {
  const { mode, treeStatus, chunksCovered, chunksTotal } = coverage
  if (mode === 'relevance') {
    return { tone: 'neutral', icon: '◐', textKey: 'coverage.relevance' }
  }
  if (mode === 'capped') {
    return coverage.truncated
      ? { tone: 'warning', icon: '◔', textKey: 'coverage.capped.beginning' }
      : { tone: 'neutral', icon: '○', textKey: 'coverage.capped.whole' }
  }
  // mode === 'tree'. The whole-document/100% claim is made ONLY for a READY deep index — any
  // other state shows the partial fraction or "not built yet", NEVER 100% (C1/L2).
  if (treeStatus === 'ready' && chunksTotal > 0 && chunksCovered >= chunksTotal) {
    return { tone: 'success', icon: '●', textKey: 'coverage.tree.whole' }
  }
  if (chunksCovered === 0) {
    return { tone: 'neutral', icon: '○', textKey: 'coverage.tree.pending' }
  }
  return {
    tone: 'accent',
    icon: '◔',
    textKey: 'coverage.tree.partial',
    params: { covered: chunksCovered, total: chunksTotal }
  }
}

export function CoverageMeter({ coverage }: { coverage: CoverageInfo }): JSX.Element {
  const { t } = useT()
  const breadth = breadthOf(coverage)
  // The DEPTH line only carries meaning when the result actually covers the whole document
  // at a chosen tier (a ready deep index). For capped/relevance there is no tier to show.
  const depthKey =
    coverage.mode === 'tree' && coverage.treeStatus === 'ready' && coverage.tier
      ? TIER_LABEL[coverage.tier]
      : null
  return (
    <div className="coverage-meter">
      <Badge tone={breadth.tone} icon={breadth.icon}>
        {t(breadth.textKey, breadth.params)}
      </Badge>
      {depthKey && <span className="coverage-depth hint">{t('coverage.depth', { label: t(depthKey) })}</span>}
    </div>
  )
}

/**
 * The coverage-tier selector (whole-document-analysis plan §5.2) — reuses the DepthMenu
 * dropdown pattern. Only shown when a deep index is ready (Tier 2/3 read precomputed
 * material; without a tree there is nothing deeper than the capped summary).
 */
export function TierMenu({
  value,
  onChange,
  disabled
}: {
  value: CoverageTier
  onChange: (tier: CoverageTier) => void
  disabled?: boolean
}): JSX.Element {
  const { t } = useT()
  const tiers: CoverageTier[] = [1, 2, 3]
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="footer-menu-btn" disabled={disabled}>
          {t('coverage.tierSelect.trigger', { label: t(TIER_LABEL[value]) })}{' '}
          <span aria-hidden="true">▾</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="start" sideOffset={6}>
          <DropdownMenu.RadioGroup
            value={String(value)}
            onValueChange={(next) => onChange(Number(next) as CoverageTier)}
          >
            {tiers.map((d) => (
              <DropdownMenu.RadioItem key={d} value={String(d)} className="menu-item menu-radio">
                <span className="menu-radio-mark" aria-hidden="true">
                  <DropdownMenu.ItemIndicator>●</DropdownMenu.ItemIndicator>
                </span>
                <span>
                  {t(TIER_LABEL[d])}
                  <span className="menu-item-hint">{t(TIER_HINT[d])}</span>
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
