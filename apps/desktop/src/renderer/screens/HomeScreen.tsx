import { useEffect, useState } from 'react'
import { Badge, Banner, Button, Icon, type IconName } from '../components'
import { RUNTIME_POLL_MS } from '../lib/polling'
import { localizeServerCopy } from '../lib/displayMap'
import { useT } from '../i18n'
import type {
  AppStatus,
  DocumentInfo,
  KnowledgePack,
  MovedDriveNotice,
  PreflightResult,
  RuntimeStatus
} from '@shared/types'

interface Props {
  onNavigate: (screen: string) => void
}

// Home as a readiness hub (guidelines §2): answers "is everything ready?"
// at a glance — workspace state, model running?, document count — with ONE primary
// action ("Start chatting") and quiet preflight warnings. Reuses existing IPC only
// (getAppStatus / getRuntimeStatus / listDocuments / runPreflight).

/**
 * PF-7a (full-audit 2026-07-10): the runtime fields this screen actually consumes — an
 * unchanged poll keeps the PREVIOUS state object so React bails out of the re-render
 * instead of re-rendering the whole screen every 2.5 s on a fresh-but-identical object.
 */
function sameRuntime(a: RuntimeStatus | null, b: RuntimeStatus | null): boolean {
  return a != null && b != null && a.running === b.running && a.modelId === b.modelId
}

/** Test probe (the `__docRowRenderCounts` pattern, DEV-only): HomeScreen render count. */
export const __homeScreenRenderCount = { value: 0 }

export function HomeScreen({ onNavigate }: Props): JSX.Element {
  if (import.meta.env.DEV) __homeScreenRenderCount.value += 1
  const { t, tCount, lang } = useT()
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [docs, setDocs] = useState<DocumentInfo[] | null>(null)
  // §11.16: the knowledge packs for the fourth readiness row. Null = not known (still loading,
  // an older bridge without the channel, or a failed read) — the row simply does not render.
  const [packs, setPacks] = useState<KnowledgePack[] | null>(null)
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  /** §5 item 22 (a): what the moved-drive check did this session, or null when nothing to say. */
  const [moved, setMoved] = useState<MovedDriveNotice | null>(null)

  useEffect(() => {
    let active = true
    window.api
      ?.getAppStatus()
      .then((s) => active && setStatus(s))
      .catch(() => active && setStatus(null))
    window.api
      ?.listDocuments()
      .then((d) => active && setDocs(d ?? []))
      .catch(() => active && setDocs([]))
    // §11.16: best-effort like the reads above — `Promise.resolve(...)` because an older preload
    // (or a test harness that does not stub the channel) hands back `undefined`, and "could not
    // ask" reads the same as "nothing to say": no row.
    Promise.resolve(window.api?.listKnowledgePacks?.())
      .then((p) => active && setPacks(Array.isArray(p) ? p : null))
      .catch(() => active && setPacks(null))
    // Friendly, non-blocking launch preflight (drive writable / space / speed).
    window.api
      ?.runPreflight?.()
      .then((p) => active && setPreflight(p))
      .catch(() => active && setPreflight(null))
    return () => {
      active = false
    }
  }, [])

  // The moved-drive notice (§5 item 22 (a), owner decision 2026-09-08). One-shot on mount like
  // the reads above — and then re-read on `performance:changed`, the SAME push the Performance
  // screen listens to, because the state this reports genuinely changes under an open Home: the
  // background measurement it announces finishes (or is skipped), and the check the notice points
  // at clears it. A read failure leaves the notice absent, never a half-message.
  useEffect(() => {
    let active = true
    // `Promise.resolve(...)` rather than a bare `.then`: an older preload (or a test harness
    // that does not stub this one) hands back `undefined`, and the honest reading of "I could
    // not ask" is the same as the honest reading of "nothing to report" — no notice.
    const read = (): void => {
      Promise.resolve(window.api?.getMovedDriveNotice?.())
        .then((n) => active && setMoved(n ?? null))
        .catch(() => active && setMoved(null))
    }
    read()
    const off = window.api?.onPerformanceChanged?.(read)
    return () => {
      active = false
      off?.()
    }
  }, [])

  // The selected model auto-starts in the background at launch — poll so the model
  // row flips to "running" without a manual refresh (same cadence as ChatScreen).
  // PF-7a (full-audit 2026-07-10): the poll used to run forever and set a fresh object per
  // tick. Now (1) an unchanged tick keeps the previous object (`sameRuntime`) so nothing
  // re-renders, and (2) once the model is running the interval stops — the ChatScreen
  // pattern (it polls only while NOT running) — with a window-focus re-check so a model
  // stopped/crashed while the user was away still flips the row.
  const running = runtime?.running === true
  useEffect(() => {
    let active = true
    const check = (): void => {
      window.api
        ?.getRuntimeStatus()
        .then((r) => active && setRuntime((prev) => (sameRuntime(prev, r) ? prev : r)))
        .catch(() => active && setRuntime(null))
    }
    check()
    const onFocus = (): void => check()
    window.addEventListener('focus', onFocus)
    const timer = running ? null : setInterval(check, RUNTIME_POLL_MS)
    return () => {
      active = false
      window.removeEventListener('focus', onFocus)
      if (timer) clearInterval(timer)
    }
  }, [running])

  const preflightNotes = preflight
    ? [...preflight.problems, ...(preflight.slowDriveWarning ? [preflight.slowDriveWarning] : [])]
    : []

  // §5 item 22 (a). The three states say three DIFFERENT things, and the difference between the
  // first two is the point of the notice: a restore re-measured NOTHING (the figures are dated),
  // while a new computer has a measurement already under way. Only the two that need one get the
  // action — offering "Check this computer" while a check is running would ask for a second.
  // The action NAVIGATES to Performance, where the check lives: every Home button navigates
  // ("Choose a model" opens AI Model rather than choosing one), and since item 22 (b) Performance
  // is the one place the check is started from.
  const movedNote = ((): { text: string; action: boolean } | null => {
    if (!moved) return null
    if (moved.kind === 'restored') {
      const d = new Date(moved.ranAt)
      return {
        text: Number.isNaN(d.getTime())
          ? t('home.moved.restoredUndated')
          : t('home.moved.restored', { when: d.toLocaleDateString(lang) }),
        action: true
      }
    }
    return moved.kind === 'measuring'
      ? { text: t('home.moved.measuring'), action: false }
      : { text: t('home.moved.owed'), action: true }
  })()

  const modelRunning = running
  const indexedCount = docs?.filter((d) => d.status === 'indexed').length ?? null

  // The hero CTA is adaptive (D-UI3): it leads with the action that unblocks the user.
  // `needsModel` is the SAME signal the model row's warning badge renders from (no model
  // running AND none selected) — so the loud primary becomes "Choose a model" instead of
  // a "Start chatting" that dead-ends at the no-model empty state. Guarded on a loaded
  // status so we don't flash "Choose a model" before we know there isn't one.
  const needsModel = status != null && !modelRunning && !status.activeModelId

  const headline = modelRunning
    ? t('home.headline.ready')
    : status?.activeModelId
      ? t('home.headline.starting')
      : t('home.headline.almost')

  // ---- Readiness rows ----------------------------------------------------------

  const workspaceRow: ReadinessRowProps = {
    icon: 'lock',
    label: t('home.workspace.label'),
    value:
      status == null
        ? t('home.checking')
        : status.workspaceMode === 'encrypted'
          ? t('home.workspace.encrypted')
          : t('home.workspace.plaintext'),
    badge:
      status == null ? null : status.workspaceMode === 'encrypted' ? (
        <Badge tone="success" icon="✓">
          {t('home.workspace.badgeProtected')}
        </Badge>
      ) : (
        <Badge tone="neutral" icon="○">
          {t('home.workspace.badgeDeveloper')}
        </Badge>
      )
  }

  const modelRow: ReadinessRowProps = modelRunning
    ? {
        icon: 'brain',
        label: t('home.model.label'),
        value: t('home.model.running', {
          model: runtime?.modelId ?? t('home.model.fallbackName')
        }),
        badge: (
          <Badge tone="success" icon="▶">
            {t('home.model.badgeRunning')}
          </Badge>
        )
      }
    : status?.activeModelId
      ? {
          icon: 'brain',
          label: t('home.model.label'),
          value: t('home.model.selected', { model: status.activeModelId }),
          badge: (
            <Badge tone="neutral" icon="○">
              {t('home.model.badgeStarting')}
            </Badge>
          ),
          action: (
            <Button size="sm" onClick={() => onNavigate('models')}>
              {t('home.model.open')}
            </Button>
          )
        }
      : {
          icon: 'brain',
          label: t('home.model.label'),
          value: t('home.model.none'),
          badge: (
            <Badge tone="warning" icon="⚠">
              {t('home.model.badgeNeedsModel')}
            </Badge>
          ),
          action: (
            <Button size="sm" onClick={() => onNavigate('models')}>
              {t('home.model.choose')}
            </Button>
          )
        }

  const docsRow: ReadinessRowProps = {
    icon: 'file',
    label: t('home.docs.label'),
    value:
      indexedCount == null
        ? t('home.checking')
        : indexedCount === 0
          ? t('home.docs.none')
          : tCount('home.docsReady', indexedCount),
    badge:
      indexedCount == null ? null : indexedCount > 0 ? (
        <Badge tone="success" icon="✓">
          {t('home.docs.badgeReady')}
        </Badge>
      ) : (
        <Badge tone="neutral" icon="○">
          {t('home.docs.badgeNone')}
        </Badge>
      ),
    action:
      indexedCount === 0 ? (
        <Button size="sm" onClick={() => onNavigate('documents')}>
          {t('home.docs.add')}
        </Button>
      ) : undefined
  }

  // §11.16: the knowledge packs as a fourth readiness row — the offline Wikipedia is a source
  // like the documents, so Home says whether one is ready and offers the way in when none is.
  // Three states: no pack registered (add), packs registered but none usable (open the panel),
  // at least one present AND enabled (ready). Hidden entirely while the packs are unknown.
  const packsRow: ReadinessRowProps | null = (() => {
    if (packs == null) return null
    const ready = packs.filter((p) => p.available && p.enabled).length
    if (packs.length === 0) {
      return {
        icon: 'book',
        label: t('home.packs.label'),
        value: t('home.packs.none'),
        badge: (
          <Badge tone="neutral" icon="○">
            {t('home.docs.badgeNone')}
          </Badge>
        ),
        action: (
          <Button size="sm" onClick={() => onNavigate('documents:packs')}>
            {t('home.packs.add')}
          </Button>
        )
      }
    }
    if (ready === 0) {
      return {
        icon: 'book',
        label: t('home.packs.label'),
        value: t('home.packs.noneEnabled'),
        badge: (
          <Badge tone="neutral" icon="○">
            {t('home.packs.badgeNoneEnabled')}
          </Badge>
        ),
        action: (
          <Button size="sm" onClick={() => onNavigate('documents:packs')}>
            {t('home.packs.open')}
          </Button>
        )
      }
    }
    return {
      icon: 'book',
      label: t('home.packs.label'),
      value: tCount('home.packsReady', ready),
      badge: (
        <Badge tone="success" icon="✓">
          {t('home.docs.badgeReady')}
        </Badge>
      )
    }
  })()

  return (
    <div className="screen">
      <h1>{headline}</h1>
      <p className="lead">{t('home.lead')}</p>

      {preflightNotes.length > 0 && (
        <Banner tone="warning">
          {/* Preflight problems arrive already localized (tMain); the slow-drive note
              is canonical English shared with persisted benchmark warnings, so it is
              display-mapped here (D-L4 — identity for localized/unknown strings). */}
          {preflightNotes.map((note, i) => (
            <p key={i}>{localizeServerCopy(t, note)}</p>
          ))}
          {/* The "docs" folder name is a literal embedded in the localized sentence via a
              {folder} placeholder (audit L9) — splitting on it lets us bold the name without
              hardcoding English word order around a raw <strong>docs</strong>. */}
          <p>
            {(() => {
              const [before, after = ''] = t('home.preflight.continue').split('{folder}')
              return (
                <>
                  {before}
                  <strong>docs</strong>
                  {after}
                </>
              )
            })()}
          </p>
        </Banner>
      )}

      {/* The moved-drive notice (§5 item 22 (a)). Informational, not a warning: nothing is
          wrong — the drive simply changed computers, and the user is told which of the two
          things the silent check did. `runPreflight`'s banner above is the precedent for a
          friendly, non-blocking note on Home. */}
      {movedNote && (
        <Banner
          tone="info"
          action={
            movedNote.action ? (
              <Button size="sm" onClick={() => onNavigate('performance')}>
                {t('perf.check')}
              </Button>
            ) : undefined
          }
        >
          <p>{movedNote.text}</p>
        </Banner>
      )}

      <div className="card readiness-card">
        <ReadinessRow {...workspaceRow} />
        <ReadinessRow {...modelRow} />
        <ReadinessRow {...docsRow} />
        {packsRow && <ReadinessRow {...packsRow} />}
      </div>

      {/* One loud primary at a time (§6). When a model is needed, the unblocking action
          ("Choose a model") leads and chatting demotes to secondary (still clickable —
          the mock/demo runtime may allow it; never hard-disabled). Otherwise "Start
          chatting" leads, as before. The model row keeps its own inline "Choose a model"
          (a small Secondary), so the remediation isn't duplicated as a second loud button. */}
      <div className="actions">
        {needsModel ? (
          <>
            <Button variant="primary" onClick={() => onNavigate('models')}>
              {t('home.model.choose')}
            </Button>
            <Button onClick={() => onNavigate('chat')}>{t('home.actions.startChat')}</Button>
            {indexedCount !== 0 && (
              <Button onClick={() => onNavigate('ask-documents')}>
                {t('home.actions.askDocs')}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="primary" onClick={() => onNavigate('chat')}>
              {t('home.actions.startChat')}
            </Button>
            {indexedCount !== 0 && (
              <Button onClick={() => onNavigate('ask-documents')}>
                {t('home.actions.askDocs')}
              </Button>
            )}
            {indexedCount !== 0 && (
              <Button onClick={() => onNavigate('documents')}>{t('home.docs.add')}</Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

interface ReadinessRowProps {
  icon: IconName
  label: string
  value: string
  badge?: JSX.Element | null
  action?: JSX.Element
}

function ReadinessRow({ icon, label, value, badge, action }: ReadinessRowProps): JSX.Element {
  return (
    <div className="readiness-row">
      <Icon name={icon} className="readiness-icon" />
      <div className="readiness-text">
        <div className="readiness-label">{label}</div>
        <div className="readiness-value">{value}</div>
      </div>
      {badge}
      {action != null && <div className="readiness-action">{action}</div>}
    </div>
  )
}
