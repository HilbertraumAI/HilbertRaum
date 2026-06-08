import { useEffect, useState } from 'react'
import type { AppSettings, ModelInfo, ModelState } from '@shared/types'

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
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    const [m, s] = await Promise.all([window.api.listModels(), window.api.getSettings()])
    setModels(m)
    setSettings(s)
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
        <p className="hint">Loading models…</p>
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

        <div className="model-actions">
          <button
            className="btn sm primary"
            disabled={!installed || active || busy !== null}
            onClick={() => run(`select-${m.id}`, () => window.api.selectModel(m.id))}
          >
            {active ? 'Selected' : 'Select'}
          </button>
          <button
            className="btn sm"
            disabled={busy !== null}
            onClick={() => run(`verify-${m.id}`, () => window.api.listModels())}
            title="Re-check the file on disk against its SHA-256"
          >
            Verify checksum
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
              disabled={!installed || busy !== null}
              onClick={() => run(`start-${m.id}`, () => window.api.startRuntime(m.id))}
              title={installed ? 'Start the runtime (mock until Phase 10)' : 'Model file not present'}
            >
              Start runtime
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
