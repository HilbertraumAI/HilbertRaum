import { useCallback, useEffect, useRef, useState } from 'react'
import { Banner, Button, ErrorBanner, useToast } from '../../components'
import { useT, type I18n } from '../../i18n'
import { localizeServerCopy } from '../../lib/displayMap'
import { friendlyIpcError, runAndSurface } from '../../lib/errors'
import { fmt1 } from '../../lib/format'
import { formatSize } from '../documents/format'
import type { MessageKey, UiLanguage } from '@shared/i18n'
import type {
  AppSettings,
  AppStatus,
  AuditEvent,
  AuditEventType,
  BenchmarkResult,
  DriveStatus,
  LocalApiStatus,
  PerformanceSnapshot,
  RuntimeInstallInfo,
  RuntimeStatus
} from '@shared/types'

// "Diagnostics (advanced)" tab of the Settings screen. The home of every technical
// detail: the Activity panel, the log tail, the Acceleration line + "Try GPU again",
// and the hardware benchmark. Visually quieter than a destination screen — it is a
// support surface, not an everyday one (guidelines §2).

/** How many activity entries each page load fetches. */
const ACTIVITY_PAGE_SIZE = 50

/** Friendly labels for the Activity panel's entries + type filter (spec §11.4 tone).
 *  Label values are MessageKeys resolved at render (i18n record §5). */
const AUDIT_TYPE_LABELS: Record<AuditEventType, MessageKey> = {
  runtime_started: 'diag.audit.runtime_started',
  runtime_stopped: 'diag.audit.runtime_stopped',
  runtime_crashed: 'diag.audit.runtime_crashed',
  runtime_fallback: 'diag.audit.runtime_fallback',
  model_selected: 'diag.audit.model_selected',
  model_verified: 'diag.audit.model_verified',
  model_download_started: 'diag.audit.model_download_started',
  model_download_verified: 'diag.audit.model_download_verified',
  model_download_failed: 'diag.audit.model_download_failed',
  document_imported: 'diag.audit.document_imported',
  document_reindexed: 'diag.audit.document_reindexed',
  document_deleted: 'diag.audit.document_deleted',
  document_task_completed: 'diag.audit.document_task_completed',
  document_task_failed: 'diag.audit.document_task_failed',
  document_exported: 'diag.audit.document_exported',
  summary_exported: 'diag.audit.summary_exported',
  conversation_deleted: 'diag.audit.conversation_deleted',
  conversation_exported: 'diag.audit.conversation_exported',
  message_table_exported: 'diag.audit.message_table_exported',
  workspace_created: 'diag.audit.workspace_created',
  workspace_unlocked: 'diag.audit.workspace_unlocked',
  workspace_locked: 'diag.audit.workspace_locked',
  workspace_unlock_failed: 'diag.audit.workspace_unlock_failed',
  workspace_lock_failed: 'diag.audit.workspace_lock_failed',
  workspace_password_changed: 'diag.audit.workspace_password_changed',
  settings_changed: 'diag.audit.settings_changed',
  local_api_toggled: 'diag.audit.local_api_toggled',
  policy_warning: 'diag.audit.policy_warning',
  offline_guard_violation: 'diag.audit.offline_guard_violation',
  collection_created: 'diag.audit.collection_created',
  collection_renamed: 'diag.audit.collection_renamed',
  collection_archived: 'diag.audit.collection_archived',
  collection_deleted: 'diag.audit.collection_deleted',
  documents_added_to_collection: 'diag.audit.documents_added_to_collection',
  documents_removed_from_collection: 'diag.audit.documents_removed_from_collection',
  document_lifecycle_changed: 'diag.audit.document_lifecycle_changed',
  skill_imported: 'diag.audit.skill_imported',
  skill_deleted: 'diag.audit.skill_deleted',
  skill_enabled: 'diag.audit.skill_enabled',
  skill_disabled: 'diag.audit.skill_disabled',
  skill_run_started: 'diag.audit.skill_run_started',
  skill_run_done: 'diag.audit.skill_run_done',
  skill_run_failed: 'diag.audit.skill_run_failed',
  // Evidence Pack / Review Mode (EP-1 Phase 0): labels land with the type literals because
  // this record is exhaustive; no event of these types exists until the Phase-1 IPC emits one.
  evidence_review_created: 'diag.audit.evidence_review_created',
  evidence_review_ready: 'diag.audit.evidence_review_ready',
  evidence_review_deleted: 'diag.audit.evidence_review_deleted',
  evidence_pack_exported: 'diag.audit.evidence_pack_exported',
  knowledge_pack_added: 'diag.audit.knowledge_pack_added',
  knowledge_pack_removed: 'diag.audit.knowledge_pack_removed',
  knowledge_pack_article_saved: 'diag.audit.knowledge_pack_article_saved'
}

function auditLabel(type: AuditEventType, t: I18n['t']): string {
  const key = AUDIT_TYPE_LABELS[type]
  return key != null ? t(key) : type
}

/**
 * The "Acceleration" line (architecture.md GPU record §8): the live backend when a
 * model is running, else what this machine's ELIGIBLE probe says it offers. Friendly
 * tone — CPU is presented as normal, never degraded.
 *
 * ONE ELIGIBLE GPU SOURCE (issue #327). The device comes from the snapshot's `currentGpu`
 * (`performance:get`), which main computes as `displayDevice(eligibleGpuProbe(probe, hereKey))`
 * — the same device the ladder labels a GPU start with and the Performance screen shows: on a
 * hybrid [iGPU, dGPU] box the dGPU, where `devices[0]` named the iGPU (PR #303 audit M8.2 / P5
 * residual). It used to read `settings.gpuProbe.devices` RAW, which skipped the machine-stamp
 * check: a probe recorded on ANOTHER computer (the drive moved, settings restored) had this
 * line announcing "graphics acceleration available: <card>" while the Performance screen
 * correctly said the machine has none. The renderer has no `hereKey` of its own, so the
 * eligible device is taken main-side rather than re-derived here.
 *
 * Null `currentGpu` — no eligible probe, no device in it, or the read failed — is the CPU
 * wording: naming no card is the honest answer, and it is what the machine will actually do.
 * It is a LABEL either way: nothing about which devices the runtime may use changes, and the
 * probe's full device list is still unfiltered everywhere it is enumerated.
 */
function accelerationLabel(
  runtime: RuntimeStatus | null,
  currentGpu: PerformanceSnapshot['currentGpu'],
  t: I18n['t']
): string {
  if (runtime?.running && runtime.backend) {
    if (runtime.backend === 'gpu')
      return t('diag.accel.gpu', { name: runtime.gpuName ?? t('diag.accel.gpuFallbackName') })
    if (runtime.backend === 'mock') return t('diag.accel.mock')
    return t('diag.accel.cpu')
  }
  if (currentGpu) return t('diag.accel.gpuAvailable', { name: currentGpu.name })
  return t('diag.accel.cpu')
}

// fmt1 (one-decimal locale number) is shared with the Chat starting panel — lib/format.

/** Locale-aware plain number (throughput: MB/s, tokens/s) — keeps the measured value
 *  as-is but routes the decimal separator + grouping through the UI language (M-U5,
 *  German "1.234,5"). */
function fmtNum(n: number, lang: UiLanguage): string {
  return n.toLocaleString(lang)
}

/** The one-line runtime status, shared by the card row and the copy report so they can
 *  never drift. */
function runtimeStatusLine(runtime: RuntimeStatus | null, t: I18n['t']): string {
  if (!runtime) return t('diag.app.unknown')
  if (!runtime.running) return t('diag.app.stopped')
  return t('diag.app.runtimeRunning', {
    model: runtime.modelId ?? t('diag.app.unknownModel'),
    onPort: runtime.port != null ? t('diag.app.onPort', { port: runtime.port }) : '',
    health: runtime.healthy ? t('diag.app.healthy') : t('diag.app.unhealthy')
  })
}

/** The one-line local-API status, shared by the card row and the copy report. Counts
 *  only — the endpoint records nothing about who called or what was asked (D1). */
function localApiStatusLine(api: LocalApiStatus | null | undefined, t: I18n['t']): string {
  if (api == null) return t('diag.localApi.off')
  if (api.lastError === 'port_in_use') return t('diag.localApi.portInUse')
  if (api.lastError === 'start_failed') return t('diag.localApi.startFailed')
  if (!api.running) return t('diag.localApi.off')
  return t('diag.localApi.running', {
    port: String(api.port ?? '?'),
    served: String(api.requestsServed),
    rejected: String(api.rejectedCount)
  })
}

/** Plain-text rendering of the "App & runtime" card for the Copy button — the same labels
 *  + values shown on screen, so a user can paste the lot into a support message. */
function buildAppRuntimeReport(
  app: AppStatus | null,
  runtime: RuntimeStatus | null,
  currentGpu: PerformanceSnapshot['currentGpu'],
  install: RuntimeInstallInfo | null,
  t: I18n['t']
): string {
  return [
    t('diag.app.title'),
    `${t('diag.app.version')}: ${app ? `${app.appName} ${app.appVersion}` : t('diag.app.unknown')}`,
    `${t('diag.app.selectedModel')}: ${app?.activeModelId ?? t('diag.app.noneSelected')}`,
    `${t('diag.app.profile')}: ${app?.hardwareProfile ?? t('diag.app.unknown')}`,
    `${t('diag.app.runtime')}: ${runtimeStatusLine(runtime, t)}`,
    `${t('diag.app.acceleration')}: ${accelerationLabel(runtime, currentGpu, t)}`,
    `${t('diag.localApi.label')}: ${localApiStatusLine(app?.localApi, t)}`,
    `${t('diag.app.runtimeBuild')}: ${
      install ? `llama.cpp ${install.version} (${install.backend})` : t('diag.app.noInstallMarker')
    }`
  ].join('\n')
}

/**
 * The "Decode speed" value, naming the model the probe actually streamed through (issue #52:
 * the number is measured on the CURRENTLY LOADED model, not the recommended one the card lists
 * above — without the name, the layout invites the wrong reading). Shared by the card row and
 * the Copy text so the two can never disagree. Results persisted before the field existed
 * have no measuredModelId and render without the model name, exactly as before.
 *
 * #291: a figure from the runtime's own decode timings shows the token count it covers; the
 * chunk-count fallback — and every result persisted before `speedBasis` existed, which were all
 * chunk-based — is marked approximate (it counts SSE chunks over wall time including prefill).
 */
function tokensPerSecondValue(bench: BenchmarkResult, t: I18n['t'], lang: UiLanguage): string {
  if (bench.tokensPerSecond == null) return t('diag.bench.tokensNotMeasured')
  const basis = bench.speedBasis
  const exact = basis?.basis === 'timings'
  const value = exact ? fmtNum(bench.tokensPerSecond, lang) : `≈ ${fmtNum(bench.tokensPerSecond, lang)}`
  const notes: string[] = []
  if (exact) notes.push(t('diag.bench.tokensOver', { tokens: fmtNum(basis.tokens, lang) }))
  else notes.push(t('diag.bench.tokensApprox'))
  if (bench.measuredModelId) notes.push(t('diag.bench.tokensModel', { model: bench.measuredModelId }))
  return `${value} (${notes.join('; ')})`
}

/**
 * The honest "Measured read speed" value (issue #108): the latest real multi-GB
 * sequential read observed during normal use — a model load, or a full file check.
 * Replaces the retired page-cache "(cached)" read figure (F-35), which was ~100×
 * inflated on slow media and carried no information. Shared by the card row and the
 * Copy text so the two can never disagree. Results persisted before the field existed
 * (and fresh installs with no load window yet) render the "not measured" state.
 */
function effectiveReadValue(bench: BenchmarkResult, t: I18n['t'], lang: UiLanguage): string {
  const sample = bench.effectiveRead
  if (!sample) return t('diag.bench.effectiveReadNone')
  const value = `${fmtNum(sample.mbps, lang)} MB/s`
  const gb = fmt1(sample.bytes / 1e9, lang)
  // The sample's own date, not the card's "Last run": `effectiveRead` is updated in
  // place between benchmark runs, so the row must carry its own freshness.
  const when = new Date(sample.at).toLocaleDateString(lang)
  return sample.source === 'model_load'
    ? `${value} (${t('diag.bench.effectiveReadLoad', { gb, when })})`
    : `${value} (${t('diag.bench.effectiveReadHash', { gb, when })})`
}

/**
 * The "Last run" stamp. A record whose own date is unknown carries `ranAt: ''` (the
 * `UNKNOWN_RAN_AT` sentinel the PR #303 audit H1 validators use rather than inventing a "now"
 * for a legacy profile-only blob), and `new Date('')` prints "Invalid Date" — say "unknown".
 */
function lastRunValue(bench: BenchmarkResult, t: I18n['t'], lang: UiLanguage): string {
  const ran = new Date(bench.ranAt)
  return Number.isNaN(ran.getTime()) ? t('diag.app.unknown') : ran.toLocaleString(lang)
}

/** Plain-text rendering of the "Hardware benchmark" card for the Copy button. */
function buildBenchmarkReport(bench: BenchmarkResult, t: I18n['t'], lang: UiLanguage): string {
  const lines = [
    t('diag.bench.title'),
    `${t('diag.bench.profile')}: ${bench.profile}`,
    `${t('diag.bench.recommended')}: ${bench.recommendedModelId ?? t('diag.bench.noMatch')}`,
    `${t('diag.bench.ram')}: ${bench.ramGb > 0 ? `${fmt1(bench.ramGb, lang)} GB` : t('diag.app.unknown')}`,
    `${t('diag.bench.cpu')}: ${(bench.cpuModel || t('diag.app.unknown')) + (bench.cpuCores > 0 ? t('diag.bench.cores', { count: bench.cpuCores }) : '')}`,
    `${t('diag.bench.osArch')}: ${bench.os || t('diag.app.unknown')} (${bench.arch || t('diag.app.unknown')})`,
    `${t('diag.bench.gpu')}: ${bench.gpu ?? t('diag.bench.notDetected')}`,
    `${t('diag.bench.effectiveRead')}: ${effectiveReadValue(bench, t, lang)}`,
    `${t('diag.bench.driveWrite')}: ${bench.driveWriteMbps != null ? `${fmtNum(bench.driveWriteMbps, lang)} MB/s` : t('diag.bench.notMeasured')}`,
    `${t('diag.bench.tokens')}: ${tokensPerSecondValue(bench, t, lang)}`,
    `${t('diag.bench.lastRun')}: ${lastRunValue(bench, t, lang)}`
  ]
  // Warnings are persisted canonical English — localize the known set at render (D-L4).
  for (const w of bench.warnings) lines.push(`- ${localizeServerCopy(t, w)}`)
  return lines.join('\n')
}

export function DiagnosticsTab(): JSX.Element {
  const { t, lang } = useT()
  const [drive, setDrive] = useState<DriveStatus | null>(null)
  const [bench, setBench] = useState<BenchmarkResult | null>(null)
  const [app, setApp] = useState<AppStatus | null>(null)
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  /** The Acceleration line's device: the snapshot's machine-ELIGIBLE one, never the raw
   *  `settings.gpuProbe` (#327 — see `accelerationLabel`). Null until the read lands, and null
   *  again if it fails, which reads as the CPU wording. */
  const [currentGpu, setCurrentGpu] = useState<PerformanceSnapshot['currentGpu']>(null)
  const [install, setInstall] = useState<RuntimeInstallInfo | null>(null)
  const [logTail, setLogTail] = useState<string[] | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // full-audit 2026-07-11 CODE-27: "Try GPU again" was the one handler in this file without
  // a try/catch + mounted guard — a rejected re-probe was an unhandled rejection with zero
  // feedback. Its failure gets its own banner next to the button (the benchmark's `error`
  // slot carries benchmark-specific copy).
  const [gpuRetryError, setGpuRetryError] = useState<string | null>(null)
  // Activity panel: loaded on demand, paged via the beforeId cursor.
  const [showActivity, setShowActivity] = useState(false)
  const [events, setEvents] = useState<AuditEvent[] | null>(null)
  const [moreAvailable, setMoreAvailable] = useState(false)
  const [typeFilter, setTypeFilter] = useState<string>('all')
  // "Saved" confirmations are transient toasts (guidelines §6).
  const toast = useToast()
  // The refreshers below run on mount AND from buttons, so a single component-level mounted
  // flag (checked before each setState) is cleaner than per-effect `active` guards here and
  // prevents a setState after unmount when a late IPC reply resolves (audit FE-4).
  const mountedRef = useRef(true)
  // SH-7 (#149): "Show earlier" in-flight guard (see loadMoreActivity).
  const loadingMoreRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refreshStatus = useCallback(async (): Promise<void> => {
    window.api?.getAppStatus().then((s) => mountedRef.current && setApp(s)).catch(() => mountedRef.current && setApp(null))
    window.api?.getRuntimeStatus().then((s) => mountedRef.current && setRuntime(s)).catch(() => mountedRef.current && setRuntime(null))
    window.api?.getSettings().then((s) => mountedRef.current && setSettings(s)).catch(() => mountedRef.current && setSettings(null))
    // #327: the Acceleration line's device comes from the snapshot's ELIGIBLE probe, computed
    // main-side against THIS machine's key — the raw `settings.gpuProbe` read above is for the
    // compatibility-mode notice and the toggle only. BEST-EFFORT: a rejected read (or a bridge
    // that has no such method) leaves `currentGpu` null and the line on the CPU wording rather
    // than failing the card, so the await is wrapped instead of chained off a bare promise.
    void (async () => {
      try {
        const perf = await window.api?.getPerformance()
        if (mountedRef.current) setCurrentGpu(perf?.currentGpu ?? null)
      } catch {
        if (mountedRef.current) setCurrentGpu(null)
      }
    })()
  }, [])

  const refreshLogs = useCallback(async (): Promise<void> => {
    window.api?.getLogTail().then((l) => mountedRef.current && setLogTail(l)).catch(() => mountedRef.current && setLogTail([]))
  }, [])

  const loadActivity = useCallback(async (): Promise<void> => {
    try {
      const page = (await window.api?.getAuditEvents(ACTIVITY_PAGE_SIZE)) ?? []
      if (!mountedRef.current) return // late reply after unmount (FE-4)
      setEvents(page)
      setMoreAvailable(page.length === ACTIVITY_PAGE_SIZE)
    } catch {
      if (!mountedRef.current) return
      setEvents([])
      setMoreAvailable(false)
    }
  }, [])

  const loadMoreActivity = useCallback(async (): Promise<void> => {
    const last = events?.[events.length - 1]
    if (!last) return
    // SH-7 (#149): in-flight guard — a double-click reused the same cursor and appended the
    // same 50 rows twice (duplicate key={ev.id} warnings + a visually doubled page).
    if (loadingMoreRef.current) return
    loadingMoreRef.current = true
    try {
      const page = (await window.api?.getAuditEvents(ACTIVITY_PAGE_SIZE, last.id)) ?? []
      if (!mountedRef.current) return // late reply after unmount (FE-4)
      setEvents((prev) => [...(prev ?? []), ...page])
      setMoreAvailable(page.length === ACTIVITY_PAGE_SIZE)
    } catch {
      if (!mountedRef.current) return
      setMoreAvailable(false)
    } finally {
      loadingMoreRef.current = false
    }
  }, [events])

  async function exportActivity(): Promise<void> {
    try {
      const path = await window.api.exportAuditLog()
      if (path) toast(t('diag.activity.savedTo', { path }))
    } catch {
      // Export is cancellable from the OS dialog; a failure simply shows no toast.
    }
  }

  /** Copy a plain-text report to the clipboard, confirming with a transient toast — so a
   *  user can hand technical details to support without retyping (guidelines §6). Uses
   *  Electron's native clipboard (window.api.copyToClipboard), not navigator.clipboard,
   *  which is unreliable in the file://-loaded renderer. */
  const copyReport = useCallback(
    (text: string): void => {
      void window.api
        ?.copyToClipboard(text)
        .then((ok) => toast(ok ? t('diag.copied') : t('diag.copyFailed')))
        .catch(() => toast(t('diag.copyFailed')))
    },
    [toast, t]
  )

  // Copy the logs from a FRESH tail read (the panel may be collapsed / stale), not just
  // whatever is currently rendered.
  async function copyLogs(): Promise<void> {
    try {
      const lines = (await window.api?.getLogTail()) ?? []
      setLogTail(lines)
      const ok = await window.api?.copyToClipboard(lines.join('\n'))
      toast(ok ? t('diag.copied') : t('diag.copyFailed'))
    } catch {
      toast(t('diag.copyFailed'))
    }
  }

  // Save the WHOLE log to a user-chosen file (plaintext, via the main-process dialog) so it
  // can be shared with support. The on-disk log stays encrypted; this is a deliberate copy.
  async function saveLogs(): Promise<void> {
    try {
      const path = await window.api.exportLog()
      if (path) toast(t('diag.logs.savedTo', { path }))
    } catch {
      // Cancellable from the OS dialog; a failure simply shows no toast.
    }
  }

  useEffect(() => {
    // Late IPC replies are dropped after unmount via the shared mountedRef (audit FE-4).
    window.api?.getDriveStatus().then((d) => mountedRef.current && setDrive(d)).catch(() => mountedRef.current && setDrive(null))
    window.api?.getRuntimeInstall().then((i) => mountedRef.current && setInstall(i)).catch(() => mountedRef.current && setInstall(null))
    // Show the last benchmark, if one has been run before, so the profile persists across launches.
    window.api
      ?.getSettings()
      .then((s) => mountedRef.current && setBench(s.lastBenchmark))
      .catch(() => mountedRef.current && setBench(null))
    void refreshStatus()
  }, [refreshStatus])

  // "Try GPU again" (architecture.md GPU record §8): clears the automatic compatibility-mode flag
  // (e.g. after a graphics-driver update) WITHOUT touching the Settings toggle. The
  // dedicated IPC also invalidates the session probe cache + re-probes — a plain
  // settings write would keep a stale "no GPU" probe for the whole session.
  // CODE-27: awaited + surfaced (the shared runAndSurface class fix) and mountedRef-guarded
  // like every sibling handler (audit FE-4) — a late reply/rejection after leaving the tab
  // must neither setState nor vanish silently.
  async function tryGpuAgain(): Promise<void> {
    setGpuRetryError(null)
    await runAndSurface(
      async () => {
        const next = await window.api.tryGpuAgain()
        if (mountedRef.current) setSettings(next)
        // #327 follow-through (P10 re-review): the Acceleration line reads the snapshot's
        // eligible device, not the returned settings, so re-read it — a successful retry that
        // finds a card must name it at once, not after the next Refresh or remount.
        void refreshStatus()
      },
      (message) => {
        if (mountedRef.current) setGpuRetryError(message)
      }
    )
  }

  async function runBenchmark(): Promise<void> {
    setRunning(true)
    setError(null)
    try {
      const result = await window.api.runBenchmark()
      setBench(result)
      // The benchmark re-probes + persists the GPU info — refresh so the
      // Acceleration line reflects it without a manual "Refresh".
      void refreshStatus()
    } catch (err) {
      // friendlyIpcError strips the Electron transport prefix + Error-class name so the
      // localized diag.bench.failed copy interpolates a clean message, not raw English
      // boilerplate (audit FE-8).
      setError(friendlyIpcError(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <p className="hint">{t('diag.localOnly')}</p>

      <div className="card">
        <h2>{t('diag.app.title')}</h2>
        <dl className="kv">
          <dt>{t('diag.app.version')}</dt>
          <dd>{app ? `${app.appName} ${app.appVersion}` : t('diag.app.unknown')}</dd>
          <dt>{t('diag.app.selectedModel')}</dt>
          <dd>{app?.activeModelId ?? t('diag.app.noneSelected')}</dd>
          <dt>{t('diag.app.profile')}</dt>
          <dd>{app?.hardwareProfile ?? t('diag.app.unknown')}</dd>
          <dt>{t('diag.app.runtime')}</dt>
          <dd>{runtimeStatusLine(runtime, t)}</dd>
          <dt>{t('diag.app.acceleration')}</dt>
          <dd>{accelerationLabel(runtime, currentGpu, t)}</dd>
          <dt>{t('diag.localApi.label')}</dt>
          <dd>{localApiStatusLine(app?.localApi, t)}</dd>
          <dt>{t('diag.app.runtimeBuild')}</dt>
          <dd>
            {install
              ? `llama.cpp ${install.version} (${install.backend})`
              : t('diag.app.noInstallMarker')}
          </dd>
        </dl>
        {settings?.gpuAutoDisabled && (
          <Banner
            tone="info"
            action={
              settings.gpuMode === 'auto' ? (
                <Button size="sm" onClick={() => void tryGpuAgain()}>
                  {t('diag.gpu.tryAgain')}
                </Button>
              ) : undefined
            }
          >
            {t('diag.gpu.compat')}{' '}
            {settings.gpuMode === 'auto' ? t('diag.gpu.tryHint') : t('diag.gpu.offHint')}
          </Banner>
        )}
        {/* CODE-27: the re-probe's failure, in context under the button that triggered it.
            SH-2 (#145): always-mounted so the FIRST failure is announced. */}
        <ErrorBanner
          message={gpuRetryError ? t('diag.gpu.tryFailed', { error: gpuRetryError }) : null}
          t={t}
        />
        <div className="actions">
          <Button size="sm" onClick={() => void refreshStatus()}>
            {t('diag.refresh')}
          </Button>
          <Button
            size="sm"
            title={t('diag.copyTitle')}
            onClick={() => copyReport(buildAppRuntimeReport(app, runtime, currentGpu, install, t))}
          >
            {t('diag.copy')}
          </Button>
        </div>
      </div>

      <div className="card">
        <h2>{t('diag.bench.title')}</h2>
        <p className="hint">{t('diag.bench.hint')}</p>
        <div className="actions">
          <Button size="sm" onClick={() => void runBenchmark()} disabled={running}>
            {running ? t('diag.bench.running') : bench ? t('diag.bench.rerun') : t('diag.bench.run')}
          </Button>
          {bench && (
            <Button
              size="sm"
              title={t('diag.copyTitle')}
              onClick={() => copyReport(buildBenchmarkReport(bench, t, lang))}
            >
              {t('diag.copy')}
            </Button>
          )}
        </div>
        {/* SH-2 (#145): always-mounted so the FIRST failure is announced. */}
        <ErrorBanner message={error ? t('diag.bench.failed', { error }) : null} t={t} />

        {bench && (
          <>
            {/* Match the 8px gap the .actions row has above it, so the results don't
                crowd the buttons. */}
            <dl className="kv mt-2">
              <dt>{t('diag.bench.profile')}</dt>
              <dd>
                <strong>{bench.profile}</strong>
              </dd>
              <dt>{t('diag.bench.recommended')}</dt>
              <dd>{bench.recommendedModelId ?? t('diag.bench.noMatch')}</dd>
              <dt>{t('diag.bench.ram')}</dt>
              <dd>{bench.ramGb > 0 ? `${fmt1(bench.ramGb, lang)} GB` : t('diag.app.unknown')}</dd>
              <dt>{t('diag.bench.cpu')}</dt>
              <dd>
                {bench.cpuModel || t('diag.app.unknown')}
                {bench.cpuCores > 0 ? t('diag.bench.cores', { count: bench.cpuCores }) : ''}
              </dd>
              <dt>{t('diag.bench.osArch')}</dt>
              <dd>
                {bench.os || t('diag.app.unknown')} ({bench.arch || t('diag.app.unknown')})
              </dd>
              <dt>{t('diag.bench.gpu')}</dt>
              <dd>{bench.gpu ?? t('diag.bench.notDetected')}</dd>
              <dt>{t('diag.bench.effectiveRead')}</dt>
              <dd>{effectiveReadValue(bench, t, lang)}</dd>
              <dt>{t('diag.bench.driveWrite')}</dt>
              <dd>
                {bench.driveWriteMbps != null
                  ? `${fmtNum(bench.driveWriteMbps, lang)} MB/s`
                  : t('diag.bench.notMeasured')}
              </dd>
              <dt>{t('diag.bench.tokens')}</dt>
              <dd>{tokensPerSecondValue(bench, t, lang)}</dd>
              <dt>{t('diag.bench.lastRun')}</dt>
              <dd>{lastRunValue(bench, t, lang)}</dd>
            </dl>

            {bench.warnings.length > 0 && (
              <ul className="benchmark-warnings">
                {/* Warnings are persisted canonical English inside lastBenchmark —
                    the D-L4 display map translates the known set at render. */}
                {bench.warnings.map((w, i) => (
                  <li key={i} className="hint">
                    {localizeServerCopy(t, w)}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>{t('diag.system.title')}</h2>
        {drive ? (
          <dl className="kv">
            <dt>{t('diag.system.osPlatform')}</dt>
            <dd>{drive.platform} ({drive.arch})</dd>
            <dt>{t('diag.system.freeSpace')}</dt>
            <dd>
              {drive.freeBytes != null
                ? `${fmt1(drive.freeBytes / 1e9, lang)} GB`
                : t('diag.app.unknown')}
            </dd>
            {/* #122: the images/ history footprint — runaway growth here threatens the lock
                path's re-encrypt free-space need, so it must be visible where storage is. */}
            <dt>{t('diag.system.imagesSize')}</dt>
            <dd>
              {drive.imagesBytes != null ? formatSize(drive.imagesBytes, lang) : t('diag.app.unknown')}
            </dd>
          </dl>
        ) : (
          <p className="hint">{t('diag.system.loadFailed')}</p>
        )}
      </div>

      <div className="card">
        <h2>{t('diag.paths.title')}</h2>
        {drive ? (
          <dl className="kv">
            <dt>{t('privacy.data.driveRoot')}</dt>
            <dd>{drive.rootPath}</dd>
            <dt>{t('privacy.data.workspace')}</dt>
            <dd>{drive.workspacePath}</dd>
            <dt>{t('privacy.data.models')}</dt>
            <dd>{drive.modelsPath}</dd>
            <dt>{t('privacy.data.logs')}</dt>
            <dd>{drive.logsPath}</dd>
            <dt>{t('diag.paths.prepared')}</dt>
            <dd>{drive.isPreparedDrive ? t('diag.paths.yes') : t('diag.paths.noFallback')}</dd>
            <dt>{t('diag.paths.writable')}</dt>
            <dd>{drive.writable ? t('diag.paths.yes') : t('diag.paths.no')}</dd>
          </dl>
        ) : (
          <p className="hint">{t('diag.paths.loadFailed')}</p>
        )}
      </div>

      <div className="card">
        <h2>{t('diag.activity.title')}</h2>
        <p className="hint">{t('diag.activity.hint')}</p>
        <div className="actions">
          <Button
            size="sm"
            onClick={() => {
              setShowActivity((v) => !v)
              if (!showActivity) void loadActivity()
            }}
          >
            {showActivity ? t('diag.activity.hide') : t('diag.activity.show')}
          </Button>
          {showActivity && (
            <>
              <Button size="sm" onClick={() => void loadActivity()}>
                {t('diag.refresh')}
              </Button>
              <Button size="sm" onClick={() => void exportActivity()}>
                {t('diag.activity.export')}
              </Button>
            </>
          )}
        </div>
        {showActivity && (
          <>
            {events != null && events.length > 0 && (
              <label className="hint hint-block mt-2">
                {t('diag.activity.filterShow')}{' '}
                <select
                  className="select"
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                >
                  <option value="all">{t('diag.activity.filterAll')}</option>
                  {[...new Set(events.map((ev) => ev.type))].map((type) => (
                    <option key={type} value={type}>
                      {auditLabel(type, t)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {events == null ? (
              <p className="hint">{t('diag.activity.loading')}</p>
            ) : events.length === 0 ? (
              <p className="hint">{t('diag.activity.empty')}</p>
            ) : (
              <ul className="activity-list">
                {events
                  .filter((ev) => typeFilter === 'all' || ev.type === typeFilter)
                  .map((ev) => (
                    <li key={ev.id} className="hint">
                      <span className="activity-time">
                        {new Date(ev.createdAt).toLocaleString(lang)}
                      </span>{' '}
                      — <strong>{auditLabel(ev.type, t)}</strong>: {ev.message}
                    </li>
                  ))}
              </ul>
            )}
            {moreAvailable && (
              <Button size="sm" onClick={() => void loadMoreActivity()}>
                {t('diag.activity.earlier')}
              </Button>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>{t('diag.logs.title')}</h2>
        <p className="hint">
          {t('diag.logs.hintBefore')}
          <code>logs/app.log</code>
          {t('diag.logs.hintAfter')}
        </p>
        <div className="actions">
          <Button
            size="sm"
            onClick={() => {
              setShowLogs((v) => !v)
              if (!showLogs) void refreshLogs()
            }}
          >
            {showLogs ? t('diag.logs.hide') : t('diag.logs.show')}
          </Button>
          {showLogs && (
            <Button size="sm" onClick={() => void refreshLogs()}>
              {t('diag.refresh')}
            </Button>
          )}
          <Button size="sm" title={t('diag.copyTitle')} onClick={() => void copyLogs()}>
            {t('diag.copy')}
          </Button>
          <Button size="sm" onClick={() => void saveLogs()}>
            {t('diag.logs.save')}
          </Button>
        </div>
        {showLogs && (
          <pre className="log-tail">
            {logTail == null
              ? t('diag.activity.loading')
              : logTail.length === 0
                ? t('diag.logs.empty')
                : logTail.join('\n')}
          </pre>
        )}
      </div>
    </>
  )
}
