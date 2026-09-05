import { useEffect, useRef, useState } from 'react'
import { Badge, Banner, Button, ConfirmDialog, EmptyState, ErrorBanner, Progress, SegmentedControl, Spinner, type BadgeTone } from '../components'
import {
  groupModelVariants,
  matchesModelSearch,
  modelTask,
  variantGroupOrder,
  type ModelTask
} from '../lib/modelLibrary'
import {
  isModelInstalled,
  isModelOnDrive,
  orderPickerModels
} from '../lib/modelAvailability'
import { friendlyIpcError, runAndSurface } from '../lib/errors'
import { useT } from '../i18n'
import type { MessageKey, UiLanguage } from '@shared/i18n'
import type {
  AppSettings,
  DownloadJob,
  EngineDownloadJob,
  EngineStatus,
  ModelInfo,
  ModelState,
  ModelVerifyProgress,
  PolicyStatus,
  RuntimeStatus
} from '@shared/types'
import { RUNTIME_POLL_MS } from '../lib/polling'

// "AI Model" screen (guidelines §2/§3 principle: singular mental model).
// The active model leads with a plain-language size/speed hint; the rest is a friendly
// picker. Checksums, quantization ids, paths, and runtime details sit behind a
// per-card "Technical details" disclosure (closed by default). The verify / download /
// RAM-gate / mock-start flows live in the main process; this screen only presents them.

const UNKNOWN_RAM = null
const TASKS: { value: ModelTask; label: MessageKey }[] = [
  { value: 'chat', label: 'models.library.chat' },
  { value: 'documents', label: 'models.section.docSearch' },
  { value: 'translation', label: 'models.library.translation' },
  { value: 'vision', label: 'models.library.images' },
  { value: 'transcriber', label: 'models.library.voice' }
]

// Status pills: icon + word, never color-only (guidelines §6). Label values are
// MessageKeys resolved at render (i18n record §5).
const STATE_BADGE: Record<ModelState, { labelKey: MessageKey; tone: BadgeTone; icon: string }> = {
  installed: { labelKey: 'models.state.installed', tone: 'success', icon: '✓' },
  missing: { labelKey: 'models.state.missing', tone: 'neutral', icon: '○' },
  checksum_failed: { labelKey: 'models.state.checksumFailed', tone: 'error', icon: '⚠' },
  unsupported: { labelKey: 'models.state.unsupported', tone: 'error', icon: '⚠' },
  not_recommended: { labelKey: 'models.state.notRecommended', tone: 'warning', icon: '⚠' },
  ready: { labelKey: 'models.state.ready', tone: 'success', icon: '✓' },
  running: { labelKey: 'models.state.running', tone: 'accent', icon: '▶' }
}

/** Bytes → a friendly GB string; the decimal separator follows the UI language. */
function fmtGb(bytes: number | null, fallbackGb: number, lang: UiLanguage): string {
  const gb = bytes != null ? bytes / 1024 ** 3 : fallbackGb
  const rounded = gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10
  return `${rounded.toLocaleString(lang, { useGrouping: false })} GB`
}

/**
 * A GB number that is ALREADY a GB value (manifest fields, not bytes) → locale string
 * (M-U5). Unlike `fmtGb` this does not round the manifest figure away; it only routes
 * the decimal separator + grouping through the UI language (German "4,5 GB").
 */
/**
 * The licence link as rendered — its href and the host shown beside it — or null when it must
 * not render as a link (#236): the manifest validator already refuses a non-https `license_url`,
 * but a stale cached manifest or a hostile one that slipped past an older build must not become
 * a clickable `javascript:` or `http:` anchor behind the fixed "read the license" label.
 * Stricter than the chat-link gate, which also allows `http:`. Returning both from one parse
 * keeps the anchor and the validated host from ever diverging.
 */
function licenseLink(url: string | null | undefined): { href: string; host: string } | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' ? { href: parsed.href, host: parsed.host } : null
  } catch {
    return null
  }
}

function fmtGbNum(gb: number, lang: UiLanguage): string {
  return `${gb.toLocaleString(lang)} GB`
}

/**
 * Plain-language size/speed hint (guidelines §7 spirit: "Balanced — works well on most
 * laptops" instead of quantization labels). Derived from what the manifest already
 * carries; the technical numbers live in the disclosure.
 */
function plainHintKey(m: ModelInfo): MessageKey {
  if (m.role === 'embeddings') return 'models.hint.embeddings'
  if (m.role === 'reranker') return 'models.hint.reranker'
  if (m.role === 'transcriber') return 'models.hint.transcriber'
  if (m.role === 'translation') return 'models.hint.translation'
  if (m.sizeOnDiskGb <= 1.5) return 'models.hint.small'
  if (m.sizeOnDiskGb <= 6) return 'models.hint.balanced'
  return 'models.hint.large'
}

/**
 * Context-size picker presets (the "Kontextgröße" card). "Auto" (null override) launches with
 * the model's recommended window; a fixed pick becomes llama-server's `--ctx-size` at the next
 * model start. Bounded set matching the main-process clamp [2048, 131072]. The 32k ceiling was
 * a dead end (issue #43): long-document workflows — the deep index above all — need >32k, and
 * modern local models support it natively. Big rungs stay honest via the memory warning below
 * (KV cache grows linearly with the window) instead of a silent cap.
 */
const CONTEXT_SIZE_PRESETS = [4096, 8192, 16384, 32768, 65536, 131072] as const

/** Picks at or above this show the "large windows cost memory" hint (issue #43). */
const CONTEXT_SIZE_WARNING_MIN = 65_536

/**
 * The pure availability predicates + picker order now live in `lib/modelAvailability.ts` so
 * `lib/modelLibrary` can share them without importing this screen back (that would be a cycle).
 * Re-exported here unchanged: every existing importer of these three keeps working.
 */
export { isModelInstalled, isModelRunnableHere, orderPickerModels } from '../lib/modelAvailability'

// The in-flight download survives leaving + re-entering the screen (the job itself
// lives in the main process; this only remembers which one to keep polling).
let rememberedJob: DownloadJob | null = null

/**
 * The display name of the remembered job's model (F2/B1). A refresh at the terminal transition
 * can stop listing the model, or list it as `installed` — the RESULT must still be named, so the
 * last known name is remembered alongside the job id it belongs to. Falls back to the model id.
 */
let rememberedJobName: { jobId: string; name: string } | null = null

/**
 * A terminal result the user dismissed, by job id (F2/B1): it must not come back on a refresh,
 * a re-render, or a remount within this renderer session. Module-scoped for the same reason
 * `rememberedJob` is — leaving and re-entering the screen remounts the component. Recovery after
 * a renderer RELOAD (which recreates this module) is a separate lifecycle, issue I5.
 */
let dismissedJobId: string | null = null

const JOB_LIVE: ReadonlySet<DownloadJob['status']> = new Set(['queued', 'downloading', 'verifying'])

/**
 * A finished download the user still has to act on: it failed, or it completed but could not be
 * verified. These keep the independent download panel (named, with Retry / Dismiss) so a search,
 * a task/family/view filter or a collapsed group cannot swallow the outcome. A VERIFIED `done`
 * and a `cancelled` job need no panel — the row itself carries their state (existing behaviour).
 */
function isUnresolvedResult(j: DownloadJob | null): boolean {
  return j != null && (j.status === 'failed' || (j.status === 'done' && j.unverified === true))
}

// The engine download (like the model download) outlives leaving the screen.
let rememberedEngineJob: EngineDownloadJob | null = null

const ENGINE_JOB_LIVE: ReadonlySet<EngineDownloadJob['status']> = new Set([
  'queued',
  'downloading',
  'verifying',
  'extracting'
])

/**
 * Test/preview-only reset (optionally: seed) of this module's download memory. Module state is
 * deliberately outside React so it survives a remount, which also means a jsdom test or a preview
 * case has no other way to start from a known state. Production code never calls this.
 */
export function __resetModelsScreenMemoryForTests(seed?: {
  job?: DownloadJob | null
  jobName?: string | null
}): void {
  rememberedJob = seed?.job ?? null
  rememberedJobName =
    seed?.job && seed.jobName ? { jobId: seed.job.jobId, name: seed.jobName } : null
  dismissedJobId = null
  rememberedEngineJob = null
}

export function ModelsScreen(): JSX.Element {
  const { t, tCount, lang } = useT()
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [libraryView, setLibraryView] = useState<'installed' | 'browse' | null>(null)
  const [query, setQuery] = useState('')
  const [task, setTask] = useState<ModelTask | 'all'>('all')
  const [family, setFamily] = useState('all')
  // F3/C1: group expansion is DERIVED by default — a group holding a damaged (`checksum_failed`)
  // variant starts expanded, so the repair row is reachable without first guessing that it hides
  // behind "Show all variants". This map records only the user's EXPLICIT toggles, by stable
  // group key, and those always win — across a refresh that introduces or clears damage, and
  // across filter/view changes (the key outlives both).
  const [userToggledGroups, setUserToggledGroups] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [policy, setPolicy] = useState<PolicyStatus | null>(null)
  const [machineRam, setMachineRam] = useState<number | null>(UNKNOWN_RAM)
  // First cold visit hashes the (multi-GB) weights; this drives a determinate bar in the
  // loading state instead of an opaque spinner. Null once nothing is hashing.
  const [verifyProgress, setVerifyProgress] = useState<ModelVerifyProgress | null>(null)
  // Runtime status — so a model that is loading in the background shows a disabled
  // "Starting…" button (the `startingModelId` is server truth that survives a revisit,
  // unlike the per-click `busy` flag). Without this, the still-enabled Start button let a
  // revisit kick off a disruptive restart.
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The per-download confirmation dialog + the polled download job.
  const [confirming, setConfirming] = useState<ModelInfo | null>(null)
  const [licenseAck, setLicenseAck] = useState(false)
  const [job, setJob] = useState<DownloadJob | null>(rememberedJob)
  const jobRef = useRef<DownloadJob | null>(rememberedJob)
  // F2/B1: the last known display name of the job's model, and the terminal result the user
  // dismissed. Both mirror module state so they survive leaving + re-entering the screen.
  const [jobName, setJobName] = useState<{ jobId: string; name: string } | null>(rememberedJobName)
  const [dismissedJob, setDismissedJob] = useState<string | null>(dismissedJobId)
  // The real AI engine (llama.cpp): without it, started models run in demo mode.
  const [engine, setEngine] = useState<EngineStatus | null>(null)
  const [engineJob, setEngineJob] = useState<EngineDownloadJob | null>(rememberedEngineJob)
  const engineJobRef = useRef<EngineDownloadJob | null>(rememberedEngineJob)
  // Mounted flag (audit FE-4): refresh() and the download/engine polls below resolve async; a
  // parked tick can land AFTER unmount (clearing the interval doesn't abort the in-flight
  // promise). Guard every setState behind this so ModelsScreen joins the uniform FE-4 discipline.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function refresh(): Promise<void> {
    const [m, s, p, e, rt] = await Promise.all([
      window.api.listModels(),
      window.api.getSettings(),
      window.api.getPolicy().catch(() => null),
      // Wrapped in Promise.resolve so a partial bridge (older preload, or a test stub that
      // returns nothing) degrades to null instead of throwing; the real preload resolves it.
      Promise.resolve(window.api.getEngineStatus?.()).then((r) => r ?? null, () => null),
      Promise.resolve(window.api.getRuntimeStatus?.()).then((r) => r ?? null, () => null)
    ])
    if (!mountedRef.current) return // unmounted while the batch was loading (FE-4)
    setModels(m)
    // Initialize once: finishing a download must not unexpectedly change views.
    setLibraryView((current) => current ?? (m.some(isModelInstalled) ? 'installed' : 'browse'))
    setSettings(s)
    setPolicy(p)
    setEngine(e)
    setRuntime(rt)
    // Machine RAM feeds the "needs more memory" flag copy; best-effort.
    window.api
      .getAppStatus()
      .then((st) => mountedRef.current && setMachineRam(st.machineRamGb))
      .catch(() => mountedRef.current && setMachineRam(UNKNOWN_RAM))
  }

  useEffect(() => {
    // RD-5: the reject can land after unmount too — same FE-4 guard as every other setState here.
    refresh().catch((e) => mountedRef.current && setError(friendlyIpcError(e)))
  }, [])

  // Stream first-run verification progress (the cold-hash bar). The terminal `done` event
  // clears it so the bar never lingers after hashing finishes. `?.` tolerates older
  // preloads / test stubs (they simply never drive the bar).
  useEffect(() => {
    return window.api.onModelVerifyProgress?.((p) =>
      // Lock onto one pass: `listModels` can run as overlapping passes (a remount, the
      // download poll), each with its own `modelCount` as the cache warms — without this
      // the bar flips between "1 of 1" and "2 of 2". Ignore events from a different pass
      // until the tracked one's terminal `done`.
      setVerifyProgress((prev) => {
        if (prev && prev.runId !== p.runId) return prev
        return p.done ? null : p
      })
    )
  }, [])

  // While a model is starting in the background, poll runtime status so the "Starting…"
  // button flips to "Stop" on its own once the GGUF finishes loading (a full `refresh`
  // also picks up the new `running` model state).
  // SH-9 (#149): while a model starts, poll ONLY the small getRuntimeStatus — the previous
  // full 6-IPC refresh() (listModels full-verify, settings, policy, engine, runtime, app
  // status) rebuilt every card ~2.5 s for minutes on a 20 GB GGUF. One full refresh runs on
  // the starting→settled transition, which also re-fires this effect and clears the timer.
  useEffect(() => {
    if (!runtime?.startingModelId) return
    const timer = setInterval(() => {
      void Promise.resolve(window.api.getRuntimeStatus?.())
        .then((rt) => {
          if (!mountedRef.current || !rt) return
          setRuntime(rt)
          if (!rt.startingModelId) {
            // Settled (running or stopped): the cards' install/active state may have changed.
            void runAndSurface(refresh, (m) => mountedRef.current && setError(m))
          }
        })
        .catch(() => undefined)
    }, RUNTIME_POLL_MS)
    return () => clearInterval(timer)
  }, [runtime?.startingModelId])

  // F2/B1: remember the downloading model's NAME while the catalog still lists it, so a terminal
  // result stays named after a refresh that drops the entry or flips it to `installed`.
  useEffect(() => {
    if (!job || !models) return
    const found = models.find((m) => m.id === job.modelId)
    if (!found) return
    if (rememberedJobName?.jobId === job.jobId && rememberedJobName.name === found.displayName) return
    rememberedJobName = { jobId: job.jobId, name: found.displayName }
    setJobName(rememberedJobName)
  }, [job, models])

  // Poll the live download job (async-with-polling, like import progress).
  useEffect(() => {
    jobRef.current = job
    rememberedJob = job
    if (!job || !JOB_LIVE.has(job.status)) return
    const timer = setInterval(() => {
      window.api
        .getDownloadJob(job.jobId)
        .then((next) => {
          if (!mountedRef.current) return // late tick after unmount (FE-4)
          // F2/B1: a response for a job that is no longer the current one (a new download was
          // accepted meanwhile) must never overwrite the newer job or resurrect an old result.
          if (jobRef.current?.jobId !== job.jobId || next.jobId !== job.jobId) return
          setJob(next)
          // A finished download changes install state — refresh the cards once. CODE-28
          // (full-audit 2026-07-11): surfaced, not fire-and-forget — a failing refresh at
          // exactly this transition left stale cards + an unhandled rejection.
          if (!JOB_LIVE.has(next.status) && JOB_LIVE.has(jobRef.current?.status ?? 'done')) {
            void runAndSurface(refresh, (m) => mountedRef.current && setError(m))
          }
        })
        .catch(() => undefined)
    }, 1000)
    return () => clearInterval(timer)
  }, [job?.jobId, job?.status])

  // Poll the engine download the same way; a finished install refreshes the cards once
  // (the engine status flips installed → the demo-mode banner disappears).
  useEffect(() => {
    engineJobRef.current = engineJob
    rememberedEngineJob = engineJob
    if (!engineJob || !ENGINE_JOB_LIVE.has(engineJob.status)) return
    const timer = setInterval(() => {
      window.api
        .getEngineJob(engineJob.jobId)
        .then((next) => {
          if (!mountedRef.current) return // late tick after unmount (FE-4)
          setEngineJob(next)
          if (
            !ENGINE_JOB_LIVE.has(next.status) &&
            ENGINE_JOB_LIVE.has(engineJobRef.current?.status ?? 'done')
          ) {
            // CODE-28: same surfaced completion-refresh as the model-download poll above.
            void runAndSurface(refresh, (m) => mountedRef.current && setError(m))
          }
        })
        .catch(() => undefined)
    }, 1000)
    return () => clearInterval(timer)
  }, [engineJob?.jobId, engineJob?.status])

  async function startEngineDownload(): Promise<void> {
    setError(null)
    try {
      setEngineJob(await window.api.downloadEngine())
    } catch (e) {
      setError(friendlyIpcError(e))
    }
  }

  async function run(key: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError(friendlyIpcError(e))
    } finally {
      setBusy(null)
    }
  }

  /** Persist the context-size pick ('auto' = null override = the model's recommended window).
   *  Applies at the next model start — the card's hint (+ restart note while one runs) says so. */
  async function onContextSizeChange(value: string): Promise<void> {
    setError(null)
    try {
      const s = await window.api.updateSettings({
        contextTokensOverride: value === 'auto' ? null : Number(value)
      })
      if (mountedRef.current) setSettings(s)
    } catch (e) {
      if (mountedRef.current) setError(friendlyIpcError(e))
    }
  }

  async function startDownload(m: ModelInfo): Promise<void> {
    setConfirming(null)
    setError(null)
    try {
      const started = await window.api.downloadModel(m.id, { licenseAccepted: licenseAck })
      // F2/B1: only an ACCEPTED job replaces a retained terminal result — a rejected start (and a
      // cancelled dialog) leaves the previous result on screen. The dismissal is cleared with it so
      // a backend that resumes under the same job id cannot start out hidden. FE-4 mounted guard.
      if (!mountedRef.current) return
      dismissedJobId = null
      setDismissedJob(null)
      setJob(started)
    } catch (e) {
      if (mountedRef.current) setError(friendlyIpcError(e))
    } finally {
      if (mountedRef.current) setLicenseAck(false)
    }
  }

  if (error && !models) {
    return (
      <div className="screen models-screen">
        <h1>{t('models.title')}</h1>
        <p className="hint">{t('models.loadError', { error })}</p>
      </div>
    )
  }

  if (!models || !settings) {
    const p = verifyProgress
    const pct =
      p && p.overallBytesTotal > 0
        ? Math.min(100, Math.round((p.overallBytesHashed / p.overallBytesTotal) * 100))
        : null
    return (
      <div className="screen models-screen">
        <h1>{t('models.title')}</h1>
        {p && pct != null ? (
          <Progress
            label={t('models.checkingProgress', {
              n: p.modelIndex,
              m: p.modelCount,
              name: p.displayName,
              pct
            })}
            value={p.overallBytesHashed}
            max={p.overallBytesTotal}
          />
        ) : (
          <p className="hint">
            <Spinner /> {t('models.checking')}
          </p>
        )}
      </div>
    )
  }

  const isActive = (m: ModelInfo): boolean =>
    m.role === 'embeddings'
      ? settings.activeEmbeddingModelId === m.id
      : settings.activeModelId === m.id

  const chat = models.filter((m) => m.role === 'chat')

  // The active chat model remains pinned outside the filters. The library contains
  // alternatives, ordered by availability/recommendation before grouping variants.
  const activeChat = chat.find(isActive) ?? null
  const visibleModels = orderPickerModels(models.filter((m) =>
    m !== activeChat &&
    // F3/C1: the drive view lists known damaged entries too — the repair action is on the row.
    (libraryView !== 'installed' || isModelOnDrive(m)) &&
    (task === 'all' || modelTask(m) === task) &&
    (family === 'all' || m.family === family) &&
    matchesModelSearch(m, query)
  ))
  const families = [...new Set(models.map((m) => m.family))].sort()
  const hasFilters = query !== '' || task !== 'all' || family !== 'all'
  // F2/B1 — what the independent "Current model download" panel owns: the live job (as before)
  // AND an unresolved terminal result, until the user dismisses it, a new job is accepted, or the
  // download ends verified/cancelled. Derived from `job` alone; no separate copy of the job.
  const panelJob =
    job && job.jobId !== dismissedJob && (JOB_LIVE.has(job.status) || isUnresolvedResult(job))
      ? job
      : null
  const panelLive = panelJob != null && JOB_LIVE.has(panelJob.status)
  const panelModel = panelJob ? models.find((m) => m.id === panelJob.modelId) ?? null : null
  // Name the result even when the refresh at the transition no longer lists the model.
  const panelName = panelJob
    ? panelModel?.displayName ??
      (jobName?.jobId === panelJob.jobId ? jobName.name : null) ??
      panelJob.modelId
    : ''

  // Download gates: the drive policy is the ceiling, the Settings toggle the
  // switch. The copy distinguishes the two — "disabled by policy" vs. "turn it on in
  // Settings" — reusing the PolicyStatus distinction the Privacy & data tab makes.
  const downloadsAllowedByPolicy = policy?.policy.network.allowModelDownloads ?? false
  const downloadsEnabled = downloadsAllowedByPolicy && (policy?.allowNetworkSetting ?? false)
  const downloadsBlockedReason = !downloadsAllowedByPolicy
    ? t('models.downloads.blockedByPolicy')
    : !(policy?.allowNetworkSetting ?? false)
      ? t('models.downloads.enableInSettings')
      : null
  // A withdrawn source (#196) is NOT downloadable — the network-gate banner above the list
  // must not appear for a screen whose only "missing" models can never be fetched anyway.
  const anyDownloadable = models.some(
    (m) => m.download && !m.download.withdrawn && (m.state === 'missing' || m.state === 'checksum_failed')
  )

  // Retry (panel, terminal result only): resolve the EXACT model id from the current list and run
  // it through the same confirmation as every other download — the same gates, the same license
  // link, a fresh acknowledgement. A model that left the catalog, lost its download block or was
  // withdrawn (#196) keeps a visible, explained result instead of a button that can only fail.
  const retryTarget =
    panelJob && !panelLive ? models.find((m) => m.id === panelJob.modelId) ?? null : null
  const retryWithdrawn = retryTarget?.download?.withdrawn ?? null
  const retryUnavailable = retryTarget == null || retryTarget.download == null
  const retryBlockedReason =
    downloadsBlockedReason ??
    (retryWithdrawn != null ? t('models.download.withdrawn', { reason: retryWithdrawn }) : null) ??
    (retryUnavailable ? t('models.download.retryUnavailable') : null) ??
    // The same one-at-a-time gate the rows use; a retained result never widens it (see below).
    (job != null && JOB_LIVE.has(job.status) ? t('models.download.otherRunning') : null)

  function downloadSection(m: ModelInfo): JSX.Element | null {
    if (!m.download) return null
    if (m.state !== 'missing' && m.state !== 'checksum_failed') return null
    // #196: the publisher removed the pinned file. Explain instead of offering a button that
    // can only end in an HTTP 404 — the main process refuses the start regardless.
    if (m.download.withdrawn) {
      return (
        <div className="download-progress">
          <Banner tone="info">
            {t('models.download.withdrawn', { reason: m.download.withdrawn })}
          </Banner>
        </div>
      )
    }
    const mine = job && job.modelId === m.id ? job : null
    if (mine && JOB_LIVE.has(mine.status)) {
      const pct =
        mine.totalBytes && mine.totalBytes > 0
          ? Math.min(100, Math.round((mine.receivedBytes / mine.totalBytes) * 100))
          : null
      return (
        <div className="download-progress">
          <Progress
            label={
              mine.status === 'verifying'
                ? t('models.download.verifying')
                : pct != null
                  ? t('models.download.progress', {
                      pct,
                      received: fmtGb(mine.receivedBytes, 0, lang),
                      total: fmtGb(mine.totalBytes, m.sizeOnDiskGb, lang)
                    })
                  : t('models.download.progressNoTotal', {
                      received: fmtGb(mine.receivedBytes, 0, lang)
                    })
            }
            value={pct != null ? mine.receivedBytes : undefined}
            max={pct != null ? (mine.totalBytes ?? undefined) : undefined}
          />
          <Button
            size="sm"
            disabled={mine.status === 'verifying'}
            // Surface a cancel rejection as a friendly error instead of an unhandled
            // promise rejection (audit FE-2). SH-6 (#149): the resolved state writes the
            // module-scoped rememberedJob DIRECTLY (the state effect can't run after an
            // unmount, so a remount used to briefly resume polling a cancelled job) and
            // both setters take the FE-4 mounted guard.
            onClick={() =>
              window.api
                .cancelDownload(mine.jobId)
                .then((next) => {
                  rememberedJob = next
                  if (mountedRef.current) setJob(next)
                })
                .catch((e) => mountedRef.current && setError(friendlyIpcError(e)))
            }
          >
            {t('models.download.cancel')}
          </Button>
        </div>
      )
    }
    return (
      <div className="download-progress">
        {/* SH-2 (#145): always-mounted so the FIRST download failure is announced. */}
        <ErrorBanner message={mine?.status === 'failed' ? mine.error : null} t={t} />
        {mine?.status === 'cancelled' && (
          <p className="hint">{t('models.download.cancelled')}</p>
        )}
        {mine?.status === 'done' && mine.unverified && (
          <Banner tone="warning">
            {t('models.download.unverifiedBefore')}
            <code>verify-models --generate</code>
            {t('models.download.unverifiedAfter')}
          </Banner>
        )}
        <Button
          size="sm"
          variant="primary"
          disabled={!downloadsEnabled || (job != null && JOB_LIVE.has(job.status))}
          title={
            downloadsBlockedReason ??
            (job != null && JOB_LIVE.has(job.status)
              ? t('models.download.otherRunning')
              : t('models.download.titled', {
                  name: m.displayName,
                  size: fmtGb(m.download.sizeBytes, m.sizeOnDiskGb, lang)
                }))
          }
          onClick={() => {
            setLicenseAck(false)
            setConfirming(m)
          }}
        >
          {mine?.status === 'cancelled' || mine?.status === 'failed'
            ? t('models.download.resume')
            : t('models.download.start')}
        </Button>
      </div>
    )
  }

  function card(m: ModelInfo): JSX.Element {
    const installed = m.state === 'installed' || m.state === 'running' || m.state === 'ready'
    // Embeddings/reranker/transcriber/vision are availability-driven (they work once installed
    // by PRESENCE, not a UI selection — the embedder/reranker/transcriber pick by presence; a
    // vision model is used on demand by the Images screen). There is nothing to select or start,
    // so neither those actions NOR the "Active" badge are shown (only the chat model has a
    // user-chosen active slot). Starting a non-chat model claims the CHAT runtime slot and throws
    // (`registerModelIpc` rejects a non-`chat` role), so these roles must never reach Select/Start.
    const automatic =
      m.role === 'embeddings' ||
      m.role === 'reranker' ||
      m.role === 'transcriber' ||
      m.role === 'vision' ||
      m.role === 'translation'
    const active = !automatic && isActive(m)
    // Zero-weights first run: the MAIN process computes whether this (missing, chat)
    // model may start the built-in mock (developer + policy gates).
    const canMockStart = Boolean(m.startableAsMock)
    // RAM gate: this machine has less memory than the model's minimum. Select/Start are
    // disabled (the main process refuses installed weights too); copy stays friendly.
    const ramTooLow = m.insufficientRam === true
    const ramHint = ramTooLow
      ? t('models.ram.needs', { min: m.recommendedMinRamGb }) +
        (machineRam != null ? t('models.ram.machine', { ram: machineRam }) : '') +
        t('models.ram.advice')
      : undefined
    // A start in flight (server truth, survives a revisit): this model's own, or any.
    const thisStarting = runtime?.startingModelId === m.id
    const anyStarting = runtime?.startingModelId != null
    return (
      // #35: not-yet-downloaded cards render visually quieter (`.model-card-missing`) so
      // the models that are usable right now stand out when scanning the list.
      <div className={`card model-card${installed ? '' : ' model-card-missing'}`} key={m.id}>
        <div className="model-head">
          <div>
            <div className="model-title">{m.displayName}</div>
            <div className="model-sub">
              {t(TASKS.find((entry) => entry.value === modelTask(m))!.label)}
              {' · '}{t('models.usesSpace', { size: fmtGb(null, m.sizeOnDiskGb, lang) })}
              {' · '}{t('models.library.memory', { size: fmtGbNum(m.recommendedMinRamGb, lang) })}
            </div>
          </div>
          <div className="badges">
            {active && (
              <Badge tone="success" icon="●">
                {t('models.badge.active')}
              </Badge>
            )}
            {m.recommended && (
              <Badge tone="accent" icon="★">
                {t('models.badge.recommended')}
              </Badge>
            )}
            {ramTooLow && (
              <Badge tone="warning" icon="⚠" title={ramHint}>
                {t('models.badge.ramNeeded', { min: m.recommendedMinRamGb })}
              </Badge>
            )}
            <Badge tone={STATE_BADGE[m.state].tone} icon={STATE_BADGE[m.state].icon}>
              {t(STATE_BADGE[m.state].labelKey)}
            </Badge>
          </div>
        </div>

        <div className="model-row-actions">
        {!automatic && (
          // A "Not downloaded" card shows ONE clear action — Download (rendered below) —
          // plus, in demo-capable developer mode, "Try in demo mode". The disabled
          // "Select" / "Start runtime" buttons are noise before the weights exist, so they
          // are hidden until the model is downloaded (§3/§7 hide the machinery). Once
          // installed, ONE primary "Use this model" action selects it and starts its runtime
          // (beta #27, D70) — a first-time user no longer has to guess whether Select or Start
          // leads to chatting. Stop / Starting… / the Active badge carry the runtime state.
          (installed || canMockStart || thisStarting || m.state === 'running') && (
            <div className="model-actions">
              {m.state === 'running' ? (
                <Button size="sm" disabled={busy !== null} onClick={() => run('stop', () => window.api.stopRuntime())}>
                  {t('models.stopRuntime')}
                </Button>
              ) : thisStarting ? (
                // Server-truth "Starting…": disabled, and it survives leaving + revisiting
                // the screen (the cause of the accidental restart).
                <Button size="sm" disabled title={t('models.startingTitle')}>
                  <Spinner /> {t('models.starting')}
                </Button>
              ) : installed ? (
                // The merged action (select + start, MAIN-side via useModel). NOT disabled on
                // `active`: an already-active model that isn't running still needs this to start
                // (select is idempotent, the start actually loads it). Disabled only by the RAM
                // gate / another button busy / another model starting.
                <Button
                  size="sm"
                  variant="primary"
                  disabled={ramTooLow || busy !== null || anyStarting}
                  onClick={() => run(`use-${m.id}`, () => window.api.useModel(m.id))}
                  title={ramTooLow ? ramHint : t('models.useTitle')}
                >
                  {t('models.use')}
                </Button>
              ) : (
                // Not installed but demo-capable (developer + policy gated in MAIN via
                // `startableAsMock`): "Try in demo mode" lets the dev try the app with no
                // weights. End users never reach this branch (the gate is off for them).
                <Button
                  size="sm"
                  disabled={busy !== null || anyStarting}
                  onClick={() => run(`start-${m.id}`, () => window.api.startRuntime(m.id))}
                  title={t('models.startMockTitle')}
                >
                  {t('models.startMock')}
                </Button>
              )}
            </div>
          )
        )}

        {/* While the panel above owns this model's job — live progress OR a retained terminal
            result — the row must not repeat it. After Dismiss the row's own status/recovery UI
            (Resume, the unverified note) comes back exactly as before. */}
        {panelJob?.modelId !== m.id && downloadSection(m)}
        </div>

        {/* Checksums / quantization ids / paths / runtime internals live here, closed
            by default (guidelines §2/§3 principle 3 — never in the everyday path). */}
        <details className="tech-details">
          <summary>{t('models.tech.summary')}</summary>
          <div className="tech-details-body">
            <p className="hint">{t(plainHintKey(m))}</p>
            {ramTooLow && <Banner tone="warning">{ramHint}</Banner>}
            {automatic && (
              <p className="hint hint-tight">
                {m.role === 'vision'
                  ? installed ? t('models.vision.installed') : t('models.vision.notInstalled')
                  : m.role === 'translation'
                    ? installed ? t('models.translation.installed') : t('models.translation.notInstalled')
                    : installed ? t('models.automatic.installed') : t('models.automatic.notInstalled')}
              </p>
            )}
            <dl className="kv">
              <dt>{t('models.tech.id')}</dt>
              <dd>
                <code>{m.id}</code>
              </dd>
              <dt>{t('models.tech.family')}</dt>
              <dd>{m.family}</dd>
              <dt>{t('models.tech.format')}</dt>
              <dd>{m.format}</dd>
              <dt>{t('models.tech.runtime')}</dt>
              <dd>{m.runtime}</dd>
              <dt>{t('models.tech.license')}</dt>
              <dd>{m.license}</dd>
              <dt>{t('models.tech.sizeOnDisk')}</dt>
              <dd>{fmtGbNum(m.sizeOnDiskGb, lang)}</dd>
              <dt>{t('models.tech.minRam')}</dt>
              <dd>{fmtGbNum(m.recommendedMinRamGb, lang)}</dd>
              <dt>{t('models.tech.recRam')}</dt>
              <dd>{fmtGbNum(m.recommendedRamGb, lang)}</dd>
              <dt>{t('models.tech.context')}</dt>
              {/* RD-3: locale-formatted like every other figure in this block (fmtGbNum / the
                  context-size picker below) — a German UI reads "32.768", not raw "32768". */}
              <dd>{t('models.tech.contextValue', { count: m.recommendedContextTokens.toLocaleString(lang) })}</dd>
              <dt>{t('models.tech.file')}</dt>
              <dd>
                <code>{m.localPath}</code>
              </dd>
            </dl>
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => run(`verify-${m.id}`, () => window.api.verifyModel(m.id))}
              title={t('models.verifyTitle')}
            >
              {busy === `verify-${m.id}` ? (
                <>
                  <Spinner /> {t('models.verifying')}
                </>
              ) : (
                t('models.verify')
              )}
            </Button>
          </div>
        </details>
      </div>
    )
  }

  function libraryRows(list: ModelInfo[]): JSX.Element[] {
    return groupModelVariants(list).map((group) => {
      if (group.models.length === 1) return card(group.models[0])
      // C1: a damaged variant must not hide inside a collapsed group — the whole recovery action
      // sits on its row. An explicit user toggle still wins (both directions).
      const hasRepair = group.models.some((m) => m.state === 'checksum_failed')
      const expanded = userToggledGroups.get(group.key) ?? hasRepair
      // F5: the collapsed card is the group FACE (an obtainable member of the leader's priority
      // cohort), then every other variant once, in the order the sort produced.
      const ordered = variantGroupOrder(group)
      return (
        // Heading outline (O5): screen <h2> → task section <h3> → this group <h4>.
        <section className="model-variant-group" key={group.key} aria-label={group.name}>
          <div className="model-variant-heading">
            <h4>{group.name}</h4>
            <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => {
              setUserToggledGroups((previous) => new Map(previous).set(group.key, !expanded))
            }}>
              {t(expanded ? 'models.library.hideVariants' : 'models.library.showVariants', { count: group.models.length })}
            </Button>
          </div>
          {card(ordered[0])}
          {expanded && ordered.slice(1).map(card)}
        </section>
      )
    })
  }

  function confirmDialog(m: ModelInfo): JSX.Element | null {
    if (!m.download) return null
    const needsAck = !m.download.licenseApproved
    const license = licenseLink(m.download.licenseUrl)
    const close = (): void => {
      setConfirming(null)
      setLicenseAck(false)
    }
    return (
      <ConfirmDialog
        open
        title={t('models.confirm.title', { name: m.displayName })}
        confirmLabel={t('models.confirm.start')}
        t={t}
        confirmDisabled={needsAck && !licenseAck}
        onConfirm={() => void startDownload(m)}
        onCancel={close}
      >
        <dl className="kv">
          <dt>{t('models.confirm.size')}</dt>
          <dd>{fmtGb(m.download.sizeBytes, m.sizeOnDiskGb, lang)}</dd>
          <dt>{t('models.confirm.license')}</dt>
          <dd>
            {m.license}
            {license && (
              <>
                {' — '}
                <a href={license.href} target="_blank" rel="noreferrer">
                  {t('models.confirm.readLicense')}
                </a>
                {/* #236: the destination host is shown, like the download address below it. */}
                {' ('}
                <code>{license.host}</code>
                {')'}
              </>
            )}
          </dd>
          <dt>{t('models.confirm.from')}</dt>
          <dd>
            <code>{m.download.url}</code>
          </dd>
        </dl>
        <p className="hint">{t('models.confirm.hint')}</p>
        {needsAck && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={licenseAck}
              onChange={(e) => setLicenseAck(e.target.checked)}
            />
            <span>{t('models.confirm.licenseAck')}</span>
          </label>
        )}
      </ConfirmDialog>
    )
  }

  // The engine banner: the SAME progress/cancel/error shape serves two distinct cases —
  // the chat engine (llama.cpp) missing is a strong warning (started models would fall
  // back to the demo runtime), while only the voice engine (whisper.cpp) missing is a
  // quiet, accurate note (chat already works — voice dictation is the only thing waiting).
  // The caller picks the tone + copy so the two never get conflated (an installed chat
  // engine must NOT show a "models run in demo mode" alarm).
  function engineBanner(opts: {
    tone: 'warning' | 'info'
    titleKey: MessageKey
    explainKey: MessageKey
    installKey: MessageKey
  }): JSX.Element {
    const j = engineJob
    const live = j != null && ENGINE_JOB_LIVE.has(j.status)
    const pct =
      j && j.totalBytes && j.totalBytes > 0
        ? Math.min(100, Math.round((j.receivedBytes / j.totalBytes) * 100))
        : null
    return (
      <Banner tone={opts.tone}>
        <div className="engine-install">
          <strong>{t(opts.titleKey)}</strong>
          <p className="hint hint-lede">
            {t(opts.explainKey)}
          </p>
          {live && j ? (
            <>
              <Progress
                label={
                  j.status === 'extracting'
                    ? t('models.engine.extracting')
                    : j.status === 'verifying'
                      ? t('models.engine.verifying')
                      : pct != null
                        ? t('models.engine.progress', { pct })
                        : t('models.engine.downloadingNoTotal')
                }
                value={pct != null && j.status === 'downloading' ? j.receivedBytes : undefined}
                max={pct != null && j.status === 'downloading' ? (j.totalBytes ?? undefined) : undefined}
              />
              {/* SH-1 (#144): the multi-hundred-MB engine fetch was the one long-running
                  network action with no Cancel (cancelEngineDownload had zero callers).
                  Mirrors the model-download cancel incl. its error surfacing; main treats
                  verifying/extracting as cancellable states (F-33), so no disable here. */}
              <Button
                size="sm"
                onClick={() =>
                  window.api
                    .cancelEngineDownload(j.jobId)
                    .then((next) => {
                      rememberedEngineJob = next
                      if (mountedRef.current) setEngineJob(next)
                    })
                    .catch((e) => mountedRef.current && setError(friendlyIpcError(e)))
                }
              >
                {t('models.download.cancel')}
              </Button>
            </>
          ) : (
            <>
              {j?.status === 'failed' && j.error && (
                <p className="hint mt-0">
                  {j.error}
                </p>
              )}
              <Button
                size="sm"
                variant="primary"
                disabled={!downloadsEnabled}
                title={downloadsBlockedReason ?? undefined}
                onClick={() => void startEngineDownload()}
              >
                {j?.status === 'failed' ? t('models.engine.retry') : t(opts.installKey)}
              </Button>
              {downloadsBlockedReason && (
                <p className="hint mb-0">
                  {downloadsBlockedReason}
                </p>
              )}
            </>
          )}
        </div>
      </Banner>
    )
  }

  return (
    <div className="screen models-screen">
      <h1>{t('models.title')}</h1>
      <p className="lead">{t('models.lead')}</p>

      {anyDownloadable && downloadsBlockedReason && <Banner tone="info">{downloadsBlockedReason}</Banner>}

      {/* Chat engine (llama.cpp) missing → real "demo mode" warning. Voice engine
          (whisper.cpp) missing on its own → a quiet note: chat already works, only
          dictation waits. An installed chat engine never shows the alarming banner. */}
      {engine && engine.available && engine.missingFamilies.includes('llama_cpp') &&
        engineBanner({
          tone: 'warning',
          titleKey: 'models.engine.title',
          explainKey: 'models.engine.explain',
          installKey: 'models.engine.install'
        })}
      {engine &&
        engine.available &&
        !engine.missingFamilies.includes('llama_cpp') &&
        engine.missingFamilies.includes('whisper_cpp') &&
        engineBanner({
          tone: 'info',
          titleKey: 'models.voiceEngine.title',
          explainKey: 'models.voiceEngine.explain',
          installKey: 'models.voiceEngine.install'
        })}

      {models.length === 0 && (
        <EmptyState
          title={t('models.empty.title')}
          line={
            <>
              {t('models.empty.lineBefore')}
              <code>model-manifests/</code>
              {t('models.empty.lineAfter')}
            </>
          }
        />
      )}

      {activeChat && (
        <>
          <div className="section-title">{t('models.section.yourModel')}</div>
          {card(activeChat)}
        </>
      )}

      {/* Context-size picker (2026-07-04 user report): the truncation notice already pointed
          users here to "raise the context size", and the setting existed but was never applied
          for catalog models (the manifest recommendation always won). "Auto" keeps the model's
          recommended window; a fixed pick becomes the launched --ctx-size at the next start. */}
      {settings && chat.length > 0 && (
        <div className="card">
          <h2>{t('models.context.title')}</h2>
          <label className="hint hint-block">
            {t('models.context.label')}{' '}
            <select
              className="select"
              value={settings.contextTokensOverride != null ? String(settings.contextTokensOverride) : 'auto'}
              onChange={(e) => void onContextSizeChange(e.target.value)}
            >
              {/* Issue #43: name the number "Auto" resolves to for the active model — it is
                  often the LARGEST choice in this list, and an unlabeled "Auto" read as
                  "small default", sending users into a fixed pick that capped the window. */}
              <option value="auto">
                {activeChat
                  ? t('models.context.autoResolved', {
                      count: (activeChat.recommendedContextTokens || settings.contextTokens).toLocaleString(lang)
                    })
                  : t('models.context.auto')}
              </option>
              {CONTEXT_SIZE_PRESETS.map((n) => (
                <option key={n} value={String(n)}>
                  {t('models.tech.contextValue', { count: n.toLocaleString(lang) })}
                </option>
              ))}
              {/* RD-4: an override outside the preset rungs (an older release's preset, a hand-
                  edited settings file) must still render as the selected value — a <select> whose
                  value matches no option silently renders BLANK. Same label style as the rungs. */}
              {settings.contextTokensOverride != null &&
                !(CONTEXT_SIZE_PRESETS as readonly number[]).includes(settings.contextTokensOverride) && (
                  <option value={String(settings.contextTokensOverride)}>
                    {t('models.tech.contextValue', {
                      count: settings.contextTokensOverride.toLocaleString(lang)
                    })}
                  </option>
                )}
            </select>
          </label>
          <p className="hint">{t('models.context.hint')}</p>
          {settings.contextTokensOverride != null &&
            settings.contextTokensOverride >= CONTEXT_SIZE_WARNING_MIN && (
              <p className="hint context-size-warning">{t('models.context.bigWarning')}</p>
            )}
          {runtime?.running && <p className="hint">{t('models.context.restartHint')}</p>}
        </div>
      )}

      <section className="model-library" aria-label={t('models.library.title')}>
        <h2>{t('models.library.title')}</h2>
        <SegmentedControl
          ariaLabel={t('models.library.view')}
          value={libraryView ?? 'browse'}
          options={[
            { value: 'installed', label: t('models.library.onDrive') },
            { value: 'browse', label: t('models.library.browse') }
          ]}
          onChange={setLibraryView}
        />
        <div className="model-library-filters">
          <label className="model-library-search">
            {t('models.library.search')}
            <input className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder={t('models.library.searchPlaceholder')} />
          </label>
          <label>
            {t('models.library.task')}
            <select className="select" value={task} onChange={(e) => setTask(e.target.value as ModelTask | 'all')}>
              <option value="all">{t('models.library.allTasks')}</option>
              {TASKS.map((entry) => <option key={entry.value} value={entry.value}>{t(entry.label)}</option>)}
            </select>
          </label>
          <label>
            {t('models.library.family')}
            <select className="select" value={family} onChange={(e) => setFamily(e.target.value)}>
              <option value="all">{t('models.library.allFamilies')}</option>
              {families.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          {hasFilters && <Button size="sm" onClick={() => { setQuery(''); setTask('all'); setFamily('all') }}>
            {t('models.library.clear')}
          </Button>}
        </div>
        {/* Progress/cancel remains reachable even when filters or a collapsed group hide its row —
            and a FAILED or unverified result stays here, named, with Retry / Dismiss, until the
            user acts, a new download is accepted, or the download ends verified/cancelled
            (design-guidelines §15 "Terminal download results"). */}
        {panelJob && <div className="model-library-download" role="region" aria-label={t('models.library.download')}>
          <strong>{panelName}</strong>
          {/* ONE always-mounted alert node for the whole panel lifetime: empty while the download
              runs, filled on the terminal transition. Same wrapper shape as ErrorBanner (audit
              M-U1) — a live region that only appears at failure is not reliably announced. */}
          <div className="error-banner-region" role="alert" aria-live="assertive">
            {panelJob.status === 'failed' && (
              <Banner tone="error" role="status">
                <p>{t('models.download.failed', { name: panelName })}</p>
                {panelJob.error && <p>{panelJob.error}</p>}
              </Banner>
            )}
            {panelJob.status === 'done' && panelJob.unverified && (
              <Banner tone="warning" role="status">
                {t('models.download.unverifiedBefore')}
                <code>verify-models --generate</code>
                {t('models.download.unverifiedAfter')}
              </Banner>
            )}
          </div>
          {panelLive ? (
            panelModel && downloadSection(panelModel)
          ) : (
            <>
              <div className="model-library-download-actions">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={retryBlockedReason != null}
                  title={
                    retryBlockedReason ??
                    t('models.download.titled', {
                      name: panelName,
                      size: fmtGb(
                        retryTarget?.download?.sizeBytes ?? null,
                        retryTarget?.sizeOnDiskGb ?? 0,
                        lang
                      )
                    })
                  }
                  // The EXISTING confirmation, with this variant's license link and a reset
                  // acknowledgement — a retry never silently accepts a pending license.
                  onClick={() => {
                    if (!retryTarget) return
                    setLicenseAck(false)
                    setConfirming(retryTarget)
                  }}
                >
                  {t('models.download.retry')}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    dismissedJobId = panelJob.jobId
                    setDismissedJob(panelJob.jobId)
                  }}
                >
                  {t('models.download.dismiss')}
                </Button>
              </div>
              {retryBlockedReason && <p className="hint mb-0">{retryBlockedReason}</p>}
            </>
          )}
        </div>}
        <p className="hint" role="status">{tCount('models.library.results', visibleModels.length)}</p>
        {visibleModels.length === 0 ? (
          <div className="model-library-empty">
            <p>{t(hasFilters ? 'models.library.noMatches' : libraryView === 'installed'
              ? activeChat && isModelInstalled(activeChat) ? 'models.library.onlyActive' : 'models.library.noneInstalled'
              : 'models.library.noAlternatives')}</p>
            {libraryView === 'installed' && <Button onClick={() => setLibraryView('browse')}>
              {t('models.library.browse')}
            </Button>}
          </div>
        ) : TASKS.map((entry) => {
          const list = visibleModels.filter((m) => modelTask(m) === entry.value)
          return list.length > 0 && <section key={entry.value} aria-label={t(entry.label)}>
            <h3 className="model-task-heading">{t(entry.label)}</h3>
            {libraryRows(list)}
          </section>
        })}
      </section>

      {/* Always-mounted alert region (audit M-U1) — announced on first appearance. */}
      <ErrorBanner message={error} t={t} />

      {confirming && confirmDialog(confirming)}
    </div>
  )
}
