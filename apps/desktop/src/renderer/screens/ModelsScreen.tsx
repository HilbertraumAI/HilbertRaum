import { useEffect, useRef, useState } from 'react'
import { Badge, Banner, Button, ConfirmDialog, EmptyState, Progress, type BadgeTone } from '../components'
import type { AppSettings, DownloadJob, ModelInfo, ModelState, PolicyStatus } from '@shared/types'

const UNKNOWN_RAM = null

// Status pills: icon + word, never color-only (guidelines §6).
const STATE_BADGE: Record<ModelState, { label: string; tone: BadgeTone; icon: string }> = {
  installed: { label: 'Installed', tone: 'success', icon: '✓' },
  missing: { label: 'Not downloaded', tone: 'neutral', icon: '○' },
  checksum_failed: { label: 'Checksum failed', tone: 'error', icon: '⚠' },
  unsupported: { label: 'Unsupported', tone: 'error', icon: '⚠' },
  not_recommended: { label: 'Not recommended', tone: 'warning', icon: '⚠' },
  ready: { label: 'Ready', tone: 'success', icon: '✓' },
  running: { label: 'Running', tone: 'accent', icon: '▶' }
}

/** Bytes → a friendly GB string for the confirmation dialog. */
function fmtGb(bytes: number | null, fallbackGb: number): string {
  const gb = bytes != null ? bytes / 1024 ** 3 : fallbackGb
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`
}

// The in-flight download survives leaving + re-entering the screen (the job itself
// lives in the main process; this only remembers which one to keep polling).
let rememberedJob: DownloadJob | null = null

const JOB_LIVE: ReadonlySet<DownloadJob['status']> = new Set(['queued', 'downloading', 'verifying'])

export function ModelsScreen(): JSX.Element {
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [policy, setPolicy] = useState<PolicyStatus | null>(null)
  const [machineRam, setMachineRam] = useState<number | null>(UNKNOWN_RAM)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Phase 18: the per-download confirmation dialog + the polled download job.
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
    refresh().catch((e) => setError(String(e)))
  }, [])

  // Poll the live download job (async-with-polling — the import-progress precedent).
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
      setError(String(e))
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
      setError(String(e))
    } finally {
      setLicenseAck(false)
    }
  }

  if (error && !models) {
    return (
      <div className="screen">
        <h1>Models</h1>
        <p className="hint">Could not load models: {error}</p>
      </div>
    )
  }

  if (!models || !settings) {
    return (
      <div className="screen">
        <h1>Models</h1>
        <p className="hint">
          <span className="spinner" /> Checking model files… The first check after adding or
          updating a model verifies its checksum and can take a few minutes for large files;
          after that the result is cached and this is instant.
        </p>
      </div>
    )
  }

  const chat = models.filter((m) => m.role === 'chat')
  const embeddings = models.filter((m) => m.role === 'embeddings')
  const others = models.filter((m) => m.role !== 'chat' && m.role !== 'embeddings')

  // Phase 18 gates (plan §6.1): the drive policy is the ceiling, the Settings toggle the
  // switch. The copy distinguishes the two — "disabled by policy" vs. "turn it on in
  // Settings" — reusing the PolicyStatus distinction the Privacy screen makes.
  const downloadsAllowedByPolicy = policy?.policy.network.allowModelDownloads ?? false
  const downloadsEnabled = downloadsAllowedByPolicy && (policy?.allowNetworkSetting ?? false)
  const downloadsBlockedReason = !downloadsAllowedByPolicy
    ? 'Downloads are disabled by this drive’s policy.'
    : !(policy?.allowNetworkSetting ?? false)
      ? 'To download models, turn on “Allow internet access for model downloads and updates” in Settings.'
      : null
  const anyDownloadable = models.some(
    (m) => m.download && (m.state === 'missing' || m.state === 'checksum_failed')
  )

  const isActive = (m: ModelInfo): boolean =>
    m.role === 'embeddings'
      ? settings.activeEmbeddingModelId === m.id
      : settings.activeModelId === m.id

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
                ? 'Verifying the downloaded file…'
                : pct != null
                  ? `Downloading… ${pct} % (${fmtGb(mine.receivedBytes, 0)} of ${fmtGb(mine.totalBytes, m.sizeOnDiskGb)})`
                  : `Downloading… ${fmtGb(mine.receivedBytes, 0)} so far`
            }
            value={pct != null ? mine.receivedBytes : undefined}
            max={pct != null ? (mine.totalBytes ?? undefined) : undefined}
          />
          <Button
            size="sm"
            disabled={mine.status === 'verifying'}
            onClick={() => window.api.cancelDownload(mine.jobId).then(setJob)}
          >
            Cancel download
          </Button>
        </div>
      )
    }
    return (
      <div className="download-progress">
        {mine?.status === 'failed' && <Banner tone="error">{mine.error}</Banner>}
        {mine?.status === 'cancelled' && (
          <p className="hint">Download cancelled — starting it again resumes where it stopped.</p>
        )}
        {mine?.status === 'done' && mine.unverified && (
          <Banner tone="warning">
            Downloaded, but this model’s manifest has no real checksum yet so the file stays
            unverified. Capture one with <code>verify-models --generate</code>.
          </Banner>
        )}
        <Button
          size="sm"
          variant="primary"
          disabled={!downloadsEnabled || (job != null && JOB_LIVE.has(job.status))}
          title={
            downloadsBlockedReason ??
            (job != null && JOB_LIVE.has(job.status)
              ? 'Another download is running — one model downloads at a time'
              : `Download ${m.displayName} (${fmtGb(m.download.sizeBytes, m.sizeOnDiskGb)})`)
          }
          onClick={() => {
            setLicenseAck(false)
            setConfirming(m)
          }}
        >
          {mine?.status === 'cancelled' || mine?.status === 'failed'
            ? 'Resume download'
            : 'Download'}
        </Button>
      </div>
    )
  }

  function card(m: ModelInfo): JSX.Element {
    const active = isActive(m)
    const installed = m.state === 'installed' || m.state === 'running' || m.state === 'ready'
    // Zero-weights first run: the MAIN process computes whether this (missing, chat)
    // model may start the built-in mock (developer + policy gates, H6/M10).
    const canMockStart = Boolean(m.startableAsMock)
    // RAM gate: this machine has less memory than the model's minimum. Select/Start are
    // disabled (the main process refuses installed weights too); copy stays friendly.
    const ramTooLow = m.insufficientRam === true
    const ramHint = ramTooLow
      ? `Needs at least ${m.recommendedMinRamGb} GB RAM` +
        (machineRam != null ? ` — this computer has about ${machineRam} GB` : '') +
        '. Pick a smaller model — quality stays great.'
      : undefined
    return (
      <div className="card model-card" key={m.id}>
        <div className="model-head">
          <div>
            <div className="model-title">{m.displayName}</div>
            <div className="model-sub">
              {m.family} · {m.format} · {m.runtime} · {m.license}
            </div>
          </div>
          <div className="badges">
            {active && (
              <Badge tone="success" icon="●">
                Active
              </Badge>
            )}
            {m.recommended && (
              <Badge tone="accent" icon="★">
                Recommended
              </Badge>
            )}
            {ramTooLow && (
              <Badge tone="warning" icon="⚠" title={ramHint}>
                Needs ≥{m.recommendedMinRamGb} GB RAM
              </Badge>
            )}
            <Badge tone={STATE_BADGE[m.state].tone} icon={STATE_BADGE[m.state].icon}>
              {STATE_BADGE[m.state].label}
            </Badge>
          </div>
        </div>

        <div className="model-meta">
          <span>
            Size <b>{m.sizeOnDiskGb} GB</b>
          </span>
          <span>
            Min RAM <b>{m.recommendedMinRamGb} GB</b>
          </span>
          <span>
            Rec. RAM <b>{m.recommendedRamGb} GB</b>
          </span>
          <span>
            Context <b>{m.recommendedContextTokens}</b>
          </span>
        </div>
        <div className="model-sub">
          <code>{m.localPath}</code>
        </div>

        {ramTooLow && <Banner tone="warning">{ramHint}</Banner>}

        <div className="model-actions">
          <Button
            size="sm"
            variant="primary"
            disabled={!installed || active || ramTooLow || busy !== null}
            title={ramHint}
            onClick={() => run(`select-${m.id}`, () => window.api.selectModel(m.id))}
          >
            {active ? 'Selected' : 'Select'}
          </Button>
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => run(`verify-${m.id}`, () => window.api.verifyModel(m.id))}
            title="Re-hash the file on disk and check it against its SHA-256 (bypasses the cache)"
          >
            {busy === `verify-${m.id}` ? (
              <>
                <span className="spinner" /> Verifying…
              </>
            ) : (
              'Verify checksum'
            )}
          </Button>
          {m.state === 'running' ? (
            <Button size="sm" disabled={busy !== null} onClick={() => run('stop', () => window.api.stopRuntime())}>
              Stop runtime
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
                    ? 'Start the local runtime for this model'
                    : canMockStart
                      ? 'No weights present — starts the built-in mock runtime so you can try the app'
                      : 'Model file not present'
              }
            >
              {installed ? 'Start runtime' : canMockStart ? 'Start mock runtime' : 'Start runtime'}
            </Button>
          )}
        </div>

        {downloadSection(m)}
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
        title={`Download ${m.displayName}?`}
        confirmLabel="Start download"
        confirmDisabled={needsAck && !licenseAck}
        onConfirm={() => void startDownload(m)}
        onCancel={close}
      >
        <dl className="kv">
          <dt>Size</dt>
          <dd>{fmtGb(m.download.sizeBytes, m.sizeOnDiskGb)}</dd>
          <dt>License</dt>
          <dd>
            {m.license}
            {m.download.licenseUrl && (
              <>
                {' — '}
                <a href={m.download.licenseUrl} target="_blank" rel="noreferrer">
                  read the license
                </a>
              </>
            )}
          </dd>
          <dt>From</dt>
          <dd>
            <code>{m.download.url}</code>
          </dd>
        </dl>
        <p className="hint">
          The file is checked against its expected checksum before it is used. This is the
          only network request the app makes — nothing about you or your documents is sent.
        </p>
        {needsAck && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={licenseAck}
              onChange={(e) => setLicenseAck(e.target.checked)}
            />
            <span>I have read and accept this model’s license terms</span>
          </label>
        )}
      </ConfirmDialog>
    )
  }

  return (
    <div className="screen">
      <h1>Models</h1>
      <p className="lead">
        Models are described by local manifests. Weights live under <code>models/</code> on the
        drive and are verified by SHA-256 before use. Nothing is downloaded without your
        explicit confirmation.
      </p>

      {anyDownloadable && downloadsBlockedReason && <Banner tone="info">{downloadsBlockedReason}</Banner>}

      {models.length === 0 && (
        <EmptyState
          title="No model manifests found"
          line={
            <>
              Add YAML manifests under <code>model-manifests/</code> on the drive.
            </>
          }
        />
      )}

      {chat.length > 0 && <div className="section-title">Chat</div>}
      {chat.map(card)}

      {embeddings.length > 0 && <div className="section-title">Embeddings</div>}
      {embeddings.map(card)}

      {others.length > 0 && <div className="section-title">Other</div>}
      {others.map(card)}

      {error && <Banner tone="error">{error}</Banner>}

      {confirming && confirmDialog(confirming)}
    </div>
  )
}
