import { useEffect, useState } from 'react'
import type { AppSettings, ModelInfo, ModelState } from '@shared/types'

const UNKNOWN_RAM = null

const STATE_LABEL: Record<ModelState, string> = {
  installed: 'Installed',
  missing: 'Not downloaded',
  checksum_failed: 'Checksum failed',
  unsupported: 'Unsupported',
  not_recommended: 'Not recommended',
  ready: 'Ready',
  running: 'Running'
}

export function ModelsScreen(): JSX.Element {
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [machineRam, setMachineRam] = useState<number | null>(UNKNOWN_RAM)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    const [m, s] = await Promise.all([window.api.listModels(), window.api.getSettings()])
    setModels(m)
    setSettings(s)
    // Machine RAM feeds the "needs more memory" flag copy; best-effort.
    window.api
      .getAppStatus()
      .then((st) => setMachineRam(st.machineRamGb))
      .catch(() => setMachineRam(UNKNOWN_RAM))
  }

  useEffect(() => {
    refresh().catch((e) => setError(String(e)))
  }, [])

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

  const isActive = (m: ModelInfo): boolean =>
    m.role === 'embeddings'
      ? settings.activeEmbeddingModelId === m.id
      : settings.activeModelId === m.id

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
            {active && <span className="badge active">● Active</span>}
            {m.recommended && <span className="badge recommended">Recommended</span>}
            {ramTooLow && (
              <span className="badge ram-low" title={ramHint}>
                Needs ≥{m.recommendedMinRamGb} GB RAM
              </span>
            )}
            <span className={`badge ${m.state}`}>{STATE_LABEL[m.state]}</span>
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

        {ramTooLow && <p className="hint warn">{ramHint}</p>}

        <div className="model-actions">
          <button
            className="btn sm primary"
            disabled={!installed || active || ramTooLow || busy !== null}
            title={ramHint}
            onClick={() => run(`select-${m.id}`, () => window.api.selectModel(m.id))}
          >
            {active ? 'Selected' : 'Select'}
          </button>
          <button
            className="btn sm"
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
          </button>
          {m.state === 'running' ? (
            <button
              className="btn sm"
              disabled={busy !== null}
              onClick={() => run('stop', () => window.api.stopRuntime())}
            >
              Stop runtime
            </button>
          ) : (
            <button
              className="btn sm"
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
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="screen">
      <h1>Models</h1>
      <p className="lead">
        Models are described by local manifests. Weights live under <code>models/</code> on the
        drive and are verified by SHA-256 before use. Nothing is downloaded automatically.
      </p>

      {models.length === 0 && (
        <p className="hint">
          No model manifests found. Add YAML manifests under <code>model-manifests/</code>.
        </p>
      )}

      {chat.length > 0 && <div className="section-title">Chat</div>}
      {chat.map(card)}

      {embeddings.length > 0 && <div className="section-title">Embeddings</div>}
      {embeddings.map(card)}

      {others.length > 0 && <div className="section-title">Other</div>}
      {others.map(card)}

      {error && <p className="hint">⚠ {error}</p>}
    </div>
  )
}
