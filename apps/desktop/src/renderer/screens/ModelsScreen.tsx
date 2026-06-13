import { useEffect, useRef, useState } from 'react'
import { Badge, Banner, Button, ConfirmDialog, EmptyState, ErrorBanner, Progress, Spinner, type BadgeTone } from '../components'
import { friendlyIpcError } from '../lib/errors'
import { useT } from '../i18n'
import type { MessageKey, UiLanguage } from '@shared/i18n'
import type { AppSettings, DownloadJob, ModelInfo, ModelState, PolicyStatus } from '@shared/types'

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

export function ModelsScreen(): JSX.Element {
  const { t, lang } = useT()
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [policy, setPolicy] = useState<PolicyStatus | null>(null)
  const [machineRam, setMachineRam] = useState<number | null>(UNKNOWN_RAM)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The per-download confirmation dialog + the polled download job.
  const [confirming, setConfirming] = useState<ModelInfo | null>(null)
  const [licenseAck, setLicenseAck] = useState(false)
  const [job, setJob] = useState<DownloadJob | null>(rememberedJob)
  const jobRef = useRef<DownloadJob | null>(rememberedJob)

  async function refresh(): Promise<void> {
    const [m, s, p] = await Promise.all([
      window.api.listModels(),
      window.api.getSettings(),
      window.api.getPolicy().catch(() => null)
    ])
    setModels(m)
    setSettings(s)
    setPolicy(p)
    // Machine RAM feeds the "needs more memory" flag copy; best-effort.
    window.api
      .getAppStatus()
      .then((st) => setMachineRam(st.machineRamGb))
      .catch(() => setMachineRam(UNKNOWN_RAM))
  }

  useEffect(() => {
    refresh().catch((e) => setError(friendlyIpcError(e)))
  }, [])

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
    return (
      <div className="screen">
        <h1>{t('models.title')}</h1>
        <p className="hint">
          <Spinner /> {t('models.checking')}
        </p>
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
    const active = isActive(m)
    const installed = m.state === 'installed' || m.state === 'running' || m.state === 'ready'
    // Reranker/transcriber are availability-driven (they work automatically once
    // installed): there is nothing to select or start, so those actions are
    // not offered — selecting one would claim the CHAT slot.
    const automatic = m.role === 'reranker' || m.role === 'transcriber'
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
            ) : (
              <Button
                size="sm"
                disabled={(!installed && !canMockStart) || (installed && ramTooLow) || busy !== null}
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

  return (
    <div className="screen">
      <h1>{t('models.title')}</h1>
      <p className="lead">{t('models.lead')}</p>

      {anyDownloadable && downloadsBlockedReason && <Banner tone="info">{downloadsBlockedReason}</Banner>}

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
