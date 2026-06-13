import { useEffect, useRef, useState } from 'react'
import { Badge, Banner, Button, ConfirmDialog, EmptyState, ErrorBanner, Progress, Spinner, type BadgeTone } from '../components'
import { friendlyIpcError } from '../lib/errors'
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
  if (m.sizeOnDiskGb <= 1.5) return 'models.hint.small'
  if (m.sizeOnDiskGb <= 6) return 'models.hint.balanced'
  return 'models.hint.large'
}

// The in-flight download survives leaving + re-entering the screen (the job itself
// lives in the main process; this only remembers which one to keep polling).
let rememberedJob: DownloadJob | null = null

const JOB_LIVE: ReadonlySet<DownloadJob['status']> = new Set(['queued', 'downloading', 'verifying'])

// The engine download (like the model download) outlives leaving the screen.
let rememberedEngineJob: EngineDownloadJob | null = null

const ENGINE_JOB_LIVE: ReadonlySet<EngineDownloadJob['status']> = new Set([
  'queued',
  'downloading',
  'verifying',
  'extracting'
])

export function ModelsScreen(): JSX.Element {
  const { t, lang } = useT()
  const [models, setModels] = useState<ModelInfo[] | null>(null)
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
  // The real AI engine (llama.cpp): without it, started models run in demo mode.
  const [engine, setEngine] = useState<EngineStatus | null>(null)
  const [engineJob, setEngineJob] = useState<EngineDownloadJob | null>(rememberedEngineJob)
  const engineJobRef = useRef<EngineDownloadJob | null>(rememberedEngineJob)

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
    setModels(m)
    setSettings(s)
    setPolicy(p)
    setEngine(e)
    setRuntime(rt)
    // Machine RAM feeds the "needs more memory" flag copy; best-effort.
    window.api
      .getAppStatus()
      .then((st) => setMachineRam(st.machineRamGb))
      .catch(() => setMachineRam(UNKNOWN_RAM))
  }

  useEffect(() => {
    refresh().catch((e) => setError(friendlyIpcError(e)))
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
  useEffect(() => {
    if (!runtime?.startingModelId) return
    const timer = setInterval(() => {
      void refresh().catch(() => undefined)
    }, RUNTIME_POLL_MS)
    return () => clearInterval(timer)
  }, [runtime?.startingModelId])

  // Poll the live download job (async-with-polling, like import progress).
  useEffect(() => {
    jobRef.current = job
    rememberedJob = job
    if (!job || !JOB_LIVE.has(job.status)) return
    const timer = setInterval(() => {
      window.api
        .getDownloadJob(job.jobId)
        .then((next) => {
          setJob(next)
          // A finished download changes install state — refresh the cards once.
          if (!JOB_LIVE.has(next.status) && JOB_LIVE.has(jobRef.current?.status ?? 'done')) {
            void refresh()
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
          setEngineJob(next)
          if (
            !ENGINE_JOB_LIVE.has(next.status) &&
            ENGINE_JOB_LIVE.has(engineJobRef.current?.status ?? 'done')
          ) {
            void refresh()
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

  async function startDownload(m: ModelInfo): Promise<void> {
    setConfirming(null)
    setError(null)
    try {
      const started = await window.api.downloadModel(m.id, { licenseAccepted: licenseAck })
      setJob(started)
    } catch (e) {
      setError(friendlyIpcError(e))
    } finally {
      setLicenseAck(false)
    }
  }

  if (error && !models) {
    return (
      <div className="screen">
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
      <div className="screen">
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
  const embeddings = models.filter((m) => m.role === 'embeddings')
  const others = models.filter((m) => m.role !== 'chat' && m.role !== 'embeddings')

  // The active chat model leads the screen (guidelines §2); the rest are the picker.
  const activeChat = chat.find(isActive) ?? null
  const otherChat = chat.filter((m) => m !== activeChat)

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
  const anyDownloadable = models.some(
    (m) => m.download && (m.state === 'missing' || m.state === 'checksum_failed')
  )

  function downloadSection(m: ModelInfo): JSX.Element | null {
    if (!m.download) return null
    if (m.state !== 'missing' && m.state !== 'checksum_failed') return null
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
            onClick={() => window.api.cancelDownload(mine.jobId).then(setJob)}
          >
            {t('models.download.cancel')}
          </Button>
        </div>
      )
    }
    return (
      <div className="download-progress">
        {mine?.status === 'failed' && <Banner tone="error">{mine.error}</Banner>}
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
    // Embeddings/reranker/transcriber are availability-driven (they work automatically once
    // installed — the embedder/reranker/transcriber pick their model by presence, not a UI
    // selection): there is nothing to select or start, so neither those actions NOR the
    // "Active" badge are shown (only the chat model has a user-chosen active slot). Starting
    // a non-chat model would claim the CHAT runtime slot and throw.
    const automatic = m.role === 'embeddings' || m.role === 'reranker' || m.role === 'transcriber'
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
      <div className="card model-card" key={m.id}>
        <div className="model-head">
          <div>
            <div className="model-title">{m.displayName}</div>
            <div className="model-sub">
              {t(plainHintKey(m))} {t('models.usesSpace', { size: fmtGb(null, m.sizeOnDiskGb, lang) })}
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

        {ramTooLow && <Banner tone="warning">{ramHint}</Banner>}

        {automatic ? (
          <p className="hint" style={{ margin: '4px 0 0' }}>
            {installed ? t('models.automatic.installed') : t('models.automatic.notInstalled')}
          </p>
        ) : (
          <div className="model-actions">
            <Button
              size="sm"
              variant="primary"
              disabled={!installed || active || ramTooLow || busy !== null}
              title={ramHint}
              onClick={() => run(`select-${m.id}`, () => window.api.selectModel(m.id))}
            >
              {active ? t('models.selected') : t('models.select')}
            </Button>
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
            ) : (
              <Button
                size="sm"
                disabled={
                  (!installed && !canMockStart) ||
                  (installed && ramTooLow) ||
                  busy !== null ||
                  anyStarting // a different model is coming up — the runtime is single-slot
                }
                onClick={() => run(`start-${m.id}`, () => window.api.startRuntime(m.id))}
                title={
                  installed && ramTooLow
                    ? ramHint
                    : installed
                      ? t('models.startTitle')
                      : canMockStart
                        ? t('models.startMockTitle')
                        : t('models.notPresentTitle')
                }
              >
                {installed
                  ? t('models.startRuntime')
                  : canMockStart
                    ? t('models.startMock')
                    : t('models.startRuntime')}
              </Button>
            )}
          </div>
        )}

        {downloadSection(m)}

        {/* Checksums / quantization ids / paths / runtime internals live here, closed
            by default (guidelines §2/§3 principle 3 — never in the everyday path). */}
        <details className="tech-details">
          <summary>{t('models.tech.summary')}</summary>
          <div className="tech-details-body">
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
              <dd>{t('models.tech.contextValue', { count: m.recommendedContextTokens })}</dd>
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

  function confirmDialog(m: ModelInfo): JSX.Element | null {
    if (!m.download) return null
    const needsAck = !m.download.licenseApproved
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
            {m.download.licenseUrl && (
              <>
                {' — '}
                <a href={m.download.licenseUrl} target="_blank" rel="noreferrer">
                  {t('models.confirm.readLicense')}
                </a>
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
          <p className="hint" style={{ margin: '4px 0 8px' }}>
            {t(opts.explainKey)}
          </p>
          {live && j ? (
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
          ) : (
            <>
              {j?.status === 'failed' && j.error && (
                <p className="hint" style={{ marginTop: 0 }}>
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
                <p className="hint" style={{ marginBottom: 0 }}>
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
    <div className="screen">
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

      {otherChat.length > 0 && (
        <div className="section-title">
          {activeChat ? t('models.section.otherModels') : t('models.section.choose')}
        </div>
      )}
      {otherChat.map(card)}

      {embeddings.length > 0 && <div className="section-title">{t('models.section.docSearch')}</div>}
      {embeddings.map(card)}

      {others.length > 0 && <div className="section-title">{t('models.section.other')}</div>}
      {others.map(card)}

      {/* Always-mounted alert region (audit M-U1) — announced on first appearance. */}
      <ErrorBanner message={error} t={t} />

      {confirming && confirmDialog(confirming)}
    </div>
  )
}
