import { useCallback, useEffect, useRef, useState } from 'react'
import type { KnowledgePack } from '@shared/types'
import { Badge, Button, ConfirmDialog, EmptyState, ErrorBanner, Spinner, useToast } from '../../components'
import { friendlyIpcError } from '../../lib/errors'
import { useT } from '../../i18n'

// Knowledge packs management (ZIM wave) — the Documents screen's "Knowledge packs"
// rail section. Lists registered ZIM archives (title, language, article count, size,
// availability), adds new ones via the MAIN-side dialog (`packs:add` — no path ever
// crosses the bridge), toggles per-pack enablement, removes registrations (the archive
// file is never touched — the confirm says so). Modeled on SkillsTab: mountedRef'd
// loader, ErrorBanner for failures, toast for successes, badges icon+word (§9).

function formatSize(tCount: ReturnType<typeof useT>['tCount'], bytes: number | null): string | null {
  if (bytes == null || bytes <= 0) return null
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 0.95) return `${gb.toFixed(1)} GB`
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`
}

export function PacksPanel(): JSX.Element {
  const { t, tCount } = useT()
  const showToast = useToast()
  const [packs, setPacks] = useState<KnowledgePack[] | null>(null)
  const [toolsInstalled, setToolsInstalled] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'add' | string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<KnowledgePack | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [status, list] = await Promise.all([
        window.api.getKnowledgePackStatus(),
        window.api.listKnowledgePacks()
      ])
      if (!mountedRef.current) return
      setToolsInstalled(status.toolsInstalled)
      setPacks(list)
    } catch (e) {
      if (!mountedRef.current) return
      setPacks([])
      setError(friendlyIpcError(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function onAdd(): Promise<void> {
    setBusy('add')
    setError(null)
    try {
      const added = await window.api.addKnowledgePacks()
      if (!mountedRef.current) return
      if (added && added.length > 0) {
        showToast(tCount('packs.addedToast', added.length))
        await refresh()
      }
    } catch (e) {
      if (mountedRef.current) setError(friendlyIpcError(e))
    } finally {
      if (mountedRef.current) setBusy(null)
    }
  }

  async function onToggle(pack: KnowledgePack): Promise<void> {
    setBusy(pack.id)
    setError(null)
    try {
      await window.api.setKnowledgePackEnabled(pack.id, !pack.enabled)
      await refresh()
    } catch (e) {
      if (mountedRef.current) setError(friendlyIpcError(e))
    } finally {
      if (mountedRef.current) setBusy(null)
    }
  }

  async function onRemove(pack: KnowledgePack): Promise<void> {
    setConfirmRemove(null)
    setBusy(pack.id)
    setError(null)
    try {
      await window.api.removeKnowledgePack(pack.id)
      if (mountedRef.current) showToast(t('packs.removedToast'))
      await refresh()
    } catch (e) {
      if (mountedRef.current) setError(friendlyIpcError(e))
    } finally {
      if (mountedRef.current) setBusy(null)
    }
  }

  const metaLine = (p: KnowledgePack): string => {
    const parts: string[] = []
    if (p.language) parts.push(p.language)
    if (p.articleCount != null) parts.push(tCount('packs.articleCount', p.articleCount))
    const size = formatSize(tCount, p.sizeBytes)
    if (size) parts.push(size)
    if (p.zimDate) parts.push(p.zimDate)
    return parts.join(' · ')
  }

  return (
    <div className="packs-panel">
      {/* Always-mounted alert region (M-U1 idiom). */}
      <ErrorBanner message={error} t={t} />

      {!toolsInstalled && (
        <p className="hint packs-tools-hint">
          <span aria-hidden="true">○</span> {t('packs.toolsMissing')}
        </p>
      )}

      <div className="actions">
        <Button variant="primary" disabled={busy !== null || !toolsInstalled} onClick={() => void onAdd()}>
          {busy === 'add' ? t('packs.addBusy') : t('packs.add')}
        </Button>
      </div>
      <p className="hint">{t('packs.lead')}</p>

      {packs == null && (
        <p className="hint" role="status">
          <Spinner /> {t('packs.loading')}
        </p>
      )}

      {packs != null && packs.length === 0 && (
        <EmptyState title={t('packs.emptyTitle')} line={t('packs.emptyLine')} />
      )}

      {packs != null && packs.length > 0 && (
        <div className="packs-list">
          {packs.map((p) => (
            <div key={p.id} className={`card packs-card ${p.available ? '' : 'packs-card-missing'}`}>
              <div className="packs-card-head">
                <span className="packs-card-title">{p.title}</span>
                {p.available ? (
                  p.enabled ? (
                    <Badge tone="success" icon="✓">
                      {t('packs.state.enabled')}
                    </Badge>
                  ) : (
                    <Badge tone="neutral" icon="○">
                      {t('packs.state.disabled')}
                    </Badge>
                  )
                ) : (
                  <Badge tone="warning" icon="⚠" title={t('packs.state.missingTitle')}>
                    {t('packs.state.missing')}
                  </Badge>
                )}
              </div>
              {p.description && <p className="packs-card-desc hint">{p.description}</p>}
              <p className="packs-card-meta hint">{metaLine(p)}</p>
              <div className="packs-card-actions">
                <Button size="sm" disabled={busy !== null || !p.available} onClick={() => void onToggle(p)}>
                  {busy === p.id ? (
                    <>
                      <Spinner /> {t('packs.working')}
                    </>
                  ) : p.enabled ? (
                    t('packs.disable')
                  ) : (
                    t('packs.enable')
                  )}
                </Button>
                <Button size="sm" className="danger" disabled={busy !== null} onClick={() => setConfirmRemove(p)}>
                  {t('packs.remove')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove != null}
        title={t('packs.removeTitle')}
        confirmLabel={t('packs.removeConfirm')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => void (confirmRemove && onRemove(confirmRemove))}
        onCancel={() => setConfirmRemove(null)}
        t={t}
      >
        {t('packs.removeBody')}
      </ConfirmDialog>
    </div>
  )
}
