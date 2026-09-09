import { useCallback, useEffect, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type {
  KnowledgePack,
  KnowledgePackAddFailureReason,
  KnowledgePacksChangedEvent
} from '@shared/types'
import type { KnowledgePackCollision } from '@shared/types'
import type { MessageKey } from '@shared/i18n'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Icon,
  KnowledgePackToolsDialog,
  Progress,
  Spinner,
  Switch,
  useToast
} from '../../components'
import { friendlyIpcError } from '../../lib/errors'
import { useKnowledgePackToolsInstall } from '../../lib/useKnowledgePackToolsInstall'
import { useT } from '../../i18n'

// Knowledge packs management (ZIM wave) — the Documents screen's "Knowledge packs" MODE
// (§11.16: the header's segmented switch; before that a rail section at the bottom of the
// document filters). Lists registered ZIM archives (title, language, article count, size,
// availability), adds new ones via the MAIN-side dialog (`packs:add` — no path ever crosses
// the bridge), toggles per-pack enablement with ONE Switch per row, offers "Ask this pack"
// (a chat answering from that pack alone), and removes registrations behind a "⋯" menu (the
// archive file is never touched — the confirm says so). Modeled on SkillsTab: mountedRef'd
// loader, ErrorBanner for failures, toast for successes, badges icon+word (§9).
//
// Live refresh (#301 P3b, finding L7, plan §9.17 (e)3): `packs:list` is DB-only — a file
// dropped into the drive's `zim/` folder or an external reconciliation is discovered by the
// session-start pass or by the "Refresh" button here, never by this panel polling. The panel
// reads its initial `refreshing` state from `packs:status` and then follows
// `onKnowledgePacksChanged`: `reconcile-start` shows the "Checking the drive…" line,
// `reconcile-end`/`mutation` refetch the list and clear it. An event whose `epoch` is below
// the last one seen (an old session's late announcement) is ignored — states just reset on
// the next mount because the App unmounts this screen on lock.

/** Where packs come from (docs/knowledge-packs.md §2). Copied to the clipboard on request — the
 *  app never opens a browser from an offline surface. */
const KIWIX_LIBRARY_URL = 'https://library.kiwix.org'

/** Reason code → the mapped banner key (#301 P5, finding L1, plan §9.19 (c)3) — never the raw
 *  reason text or manager detail; `null` (the DTO's cancelled shape carries no reason) falls
 *  back to the generic copy defensively. */
function addFailedKey(reason: KnowledgePackAddFailureReason | null): MessageKey {
  switch (reason) {
    case 'not-a-zim':
      return 'packs.addFailed.notAZim'
    case 'tools-missing':
      return 'packs.addFailed.toolsMissing'
    case 'manager':
      return 'packs.addFailed.manager'
    case 'path-unsupported':
      return 'packs.addFailed.pathUnsupported'
    default:
      return 'packs.addFailed.other'
  }
}

/**
 * An archive's ISO 639-3 language code as a name in the UI language (#340 nit): `deu` → "German"
 * / "Deutsch". The raw code stays when the platform cannot name it (`fallback: 'none'` answers
 * undefined for an unknown code; an environment without `Intl.DisplayNames` throws).
 */
function languageName(uiLang: string, code: string): string {
  try {
    const name = new Intl.DisplayNames([uiLang], { type: 'language', fallback: 'none' }).of(code)
    return name && name !== code ? name : code
  } catch {
    return code
  }
}

function formatSize(bytes: number | null): string | null {
  if (bytes == null || bytes <= 0) return null
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 0.95) return `${gb.toFixed(1)} GB`
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`
}

/** The tools-install job's download percentage, or null with no known total (indeterminate) —
 *  same shape as ModelsScreen's own engine-download progress. */
function toolsPct(job: { receivedBytes: number; totalBytes: number | null }): number | null {
  return job.totalBytes && job.totalBytes > 0
    ? Math.min(100, Math.round((job.receivedBytes / job.totalBytes) * 100))
    : null
}

interface Props {
  /**
   * "Ask this pack" (§11.16): open Chat in documents mode with this pack ticked and the document
   * corpus OFF — the bridge from the place packs are managed to the place they are used. Absent
   * ⇒ the action does not render (a standalone/preview mount).
   */
  onAskPack?: (packId: string) => void
}

export function PacksPanel({ onAskPack }: Props = {}): JSX.Element {
  const { t, tCount, lang } = useT()
  const showToast = useToast()
  const [packs, setPacks] = useState<KnowledgePack[] | null>(null)
  const [toolsInstalled, setToolsInstalled] = useState(true)
  // #340 (rag-design D-Z16): the served library's collision losers from `packs:status` — a
  // served-library fact, not a row field. Null until the session computed one (or an older main).
  const [excluded, setExcluded] = useState<KnowledgePackCollision[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'add' | 'refresh' | string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<KnowledgePack | null>(null)
  // #339 P8-2 (the owner's ruling): the "kiwix-tools not installed" notice's own install action.
  // The hook only fetches getEngineStatus/getPolicy while the tools are actually missing — a
  // workspace whose tools are already installed never makes these calls (KnowledgePacks.test.tsx
  // leg (d)). `refresh()` on `done` makes the notice disappear even before the packs:changed
  // broadcast's own refetch lands.
  const [toolsDialogOpen, setToolsDialogOpen] = useState(false)
  const toolsInstall = useKnowledgePackToolsInstall(!toolsInstalled, () => {
    showToast(t('packs.tools.doneToast'))
    void refresh()
  })
  const mountedRef = useRef(true)
  // Ignore an event whose epoch is below the last one seen — an old session's late
  // announcement (0 before anything has been observed; a real epoch starts at 1).
  const lastEpochRef = useRef(0)

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
      setRefreshing(status.refreshing)
      setExcluded(status.excluded ?? null)
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

  useEffect(() => {
    return window.api.onKnowledgePacksChanged?.((event: KnowledgePacksChangedEvent) => {
      if (event.epoch < lastEpochRef.current) return
      lastEpochRef.current = event.epoch
      if (event.reason === 'reconcile-start') {
        setRefreshing(true)
        return
      }
      // 'reconcile-end' / 'mutation': the pack set may have moved — refetch, and clear the
      // refreshing line even before the refetch settles (a coalesced rerun re-sets it via its
      // own reconcile-start event).
      setRefreshing(false)
      void refresh()
    })
  }, [refresh])

  async function onRefresh(): Promise<void> {
    setBusy('refresh')
    setError(null)
    try {
      await window.api.refreshKnowledgePacks()
    } catch (e) {
      if (mountedRef.current) setError(friendlyIpcError(e))
    } finally {
      if (mountedRef.current) setBusy(null)
    }
  }

  // The typed add-result DTO (#301 P5, finding L1, plan §9.19 (c)3): 'cancelled' does nothing;
  // 'success' toasts + refreshes; 'partial' refreshes AND banners the generic mixed-add copy
  // (the added packs are real — they just aren't the whole story); 'failure' banners the
  // reason-specific copy. ErrorBanner/showToast, same as every other outcome this panel handles.
  async function onAdd(): Promise<void> {
    setBusy('add')
    setError(null)
    try {
      const result = await window.api.addKnowledgePacks()
      if (!mountedRef.current) return
      switch (result.outcome) {
        case 'cancelled':
          break
        case 'success':
          showToast(tCount('packs.addedToast', result.added.length))
          await refresh()
          break
        case 'partial':
          showToast(tCount('packs.addedToast', result.added.length))
          setError(t('packs.addPartial', { failed: result.failed, total: result.added.length + result.failed }))
          await refresh()
          break
        case 'failure':
          setError(t(addFailedKey(result.failureReason)))
          break
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

  // The empty state's quiet second action (§11.16): the library address on the clipboard. The
  // app never opens a browser itself; a failed copy still names the address in the toast.
  async function onCopyLibrary(): Promise<void> {
    try {
      await navigator.clipboard.writeText(KIWIX_LIBRARY_URL)
      if (mountedRef.current) showToast(t('packs.copiedToast'))
    } catch {
      if (mountedRef.current) showToast(t('packs.copyFailed'))
    }
  }

  const metaLine = (p: KnowledgePack): string => {
    const parts: string[] = []
    if (p.language) parts.push(languageName(lang, p.language))
    if (p.articleCount != null) parts.push(tCount('packs.articleCount', p.articleCount))
    const size = formatSize(p.sizeBytes)
    if (size) parts.push(size)
    if (p.zimDate) parts.push(p.zimDate)
    return parts.join(' · ')
  }

  // The summary line (§11.16): "3 packs · 2 enabled · 9.7 GB on this drive". The size counts
  // only the archives that are actually present; with none known the part is left out.
  const summaryLine = (list: KnowledgePack[]): string => {
    const parts = [
      tCount('packs.summary.count', list.length),
      tCount('packs.summary.enabled', list.filter((p) => p.enabled).length)
    ]
    const bytes = list.reduce((sum, p) => sum + (p.available && p.sizeBytes ? p.sizeBytes : 0), 0)
    const size = formatSize(bytes)
    if (size) parts.push(t('packs.summary.size', { size }))
    return parts.join(' · ')
  }

  const loaded = packs != null
  const hasPacks = packs != null && packs.length > 0
  const addButton = (
    <Button variant="primary" disabled={busy !== null || !toolsInstalled} onClick={() => void onAdd()}>
      {busy === 'add' ? t('packs.addBusy') : t('packs.add')}
    </Button>
  )

  return (
    <div className="packs-panel">
      {/* Always-mounted alert region (M-U1 idiom). */}
      <ErrorBanner message={error} t={t} />

      {/* First run (§11.16): the tools-missing notice is a setup card — a title, the plain
          explanation, and the one primary action. The consent dialog itself is unchanged
          (`KnowledgePackToolsDialog`: size, license, source, the acknowledgement). */}
      {!toolsInstalled && (
        <div className="card packs-setup">
          <div className="packs-setup-title">{t('packs.setup.title')}</div>
          <p className="hint">{t('packs.toolsMissing')}</p>
          {toolsInstall.live && toolsInstall.job ? (
            <div className="download-progress">
              <Progress
                label={
                  toolsInstall.job.status === 'extracting'
                    ? t('packs.tools.extracting')
                    : toolsInstall.job.status === 'verifying'
                      ? t('packs.tools.verifying')
                      : toolsPct(toolsInstall.job) != null
                        ? t('packs.tools.progress', { pct: toolsPct(toolsInstall.job)! })
                        : t('packs.tools.downloadingNoTotal')
                }
                value={toolsPct(toolsInstall.job) != null ? toolsInstall.job.receivedBytes : undefined}
                max={toolsPct(toolsInstall.job) != null ? (toolsInstall.job.totalBytes ?? undefined) : undefined}
              />
              <Button size="sm" onClick={() => void toolsInstall.cancel()}>
                {t('models.download.cancel')}
              </Button>
            </div>
          ) : toolsInstall.job?.status === 'failed' ? (
            <div className="download-progress">
              <p className="hint">{t('packs.tools.failed')}</p>
              {toolsInstall.job.error && <p className="hint">{toolsInstall.job.error}</p>}
              <Button size="sm" variant="primary" onClick={() => setToolsDialogOpen(true)}>
                {t('models.engine.retry')}
              </Button>
            </div>
          ) : (
            <div className="actions">
              <Button variant="primary" onClick={() => setToolsDialogOpen(true)}>
                {t('packs.tools.install')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Head (§11.16): the summary line + the lead on the left; Refresh (quiet icon) and the
          primary "Add packs…" on the right. With an empty list the primary moves INTO the empty
          state (one primary per view), so only Refresh stays here. */}
      <div className="packs-head">
        <div className="packs-head-text">
          {hasPacks && <p className="packs-summary">{summaryLine(packs)}</p>}
          <p className="hint">{t('packs.lead')}</p>
        </div>
        <div className="packs-head-actions">
          <button
            type="button"
            className="icon-btn"
            disabled={refreshing || busy !== null || !toolsInstalled}
            aria-label={t('packs.refresh')}
            title={t('packs.refresh')}
            onClick={() => void onRefresh()}
          >
            <Icon name="refresh" size={18} />
          </button>
          {hasPacks && addButton}
        </div>
      </div>

      {refreshing && (
        <p className="hint" role="status">
          <Spinner /> {t('packs.refreshing')}
        </p>
      )}

      {!loaded && (
        <p className="hint" role="status">
          <Spinner /> {t('packs.loading')}
        </p>
      )}

      {loaded && !hasPacks && (
        <EmptyState
          title={t('packs.emptyTitle')}
          line={t('packs.emptyLine')}
          action={
            <>
              {addButton}
              <Button variant="ghost" onClick={() => void onCopyLibrary()}>
                {t('packs.copyLibrary')}
              </Button>
            </>
          }
        />
      )}

      {hasPacks && (
        <ul className="packs-list" aria-label={t('packs.listLabel')}>
          {packs.map((p) => {
            // #301 P6 (plan §9.23 (a) row 5/6, (c)5): a confirmed-`no` searchability verdict
            // is its OWN badge, shown BESIDE the switch — a pack can be enabled and still have
            // no full-text index. Undefined / 'unknown' / 'yes' show nothing.
            const notSearchable = p.available && p.searchable === 'no'
            // Reason text reachable without a mouse (guidelines §7): every reason that lives in
            // a Badge `title` tooltip is ALSO rendered as a visible line under the title row.
            const reasonText = !p.available
              ? p.unavailableReason === 'identity-mismatch'
                ? t('packs.state.identityMismatchTitle')
                : t('packs.state.missingTitle')
              : notSearchable
                ? t('packs.state.notSearchableTitle')
                : null
            // #340 (D-Z16): a collision loser is enabled and available yet NOT served — its own
            // badge beside the switch, and a visible line that names the winner when the list
            // knows it (the winner is another registered pack; a stale list may not).
            const collision = p.available && p.enabled ? (excluded?.find((e) => e.packId === p.id) ?? null) : null
            const winner = collision ? (packs.find((k) => k.id === collision.collidesWith) ?? null) : null
            const collisionText = collision
              ? winner
                ? t('packs.state.notServedTitle', { title: winner.title })
                : t('packs.state.notServedTitleUnknown')
              : null
            // "Ask this pack" is offered only for a pack an ask would actually search: present,
            // enabled, served, and not a confirmed no-index archive — the same eligibility the
            // scope picker applies to an unticked row.
            const askable = p.available && p.enabled && !notSearchable && collision == null
            const rowBusy = busy === p.id
            return (
              <li key={p.id} className={`card packs-card ${p.available ? '' : 'packs-card-missing'}`}>
                <div className="packs-card-head">
                  <span className="packs-card-title">{p.title}</span>
                  {!p.available &&
                    (p.unavailableReason === 'identity-mismatch' ? (
                      <Badge tone="warning" icon="⚠" title={t('packs.state.identityMismatchTitle')}>
                        {t('packs.state.identityMismatch')}
                      </Badge>
                    ) : (
                      <Badge tone="warning" icon="⚠" title={t('packs.state.missingTitle')}>
                        {t('packs.state.missing')}
                      </Badge>
                    ))}
                  {notSearchable && (
                    <Badge tone="neutral" icon="⊘" title={t('packs.state.notSearchableTitle')}>
                      {t('packs.state.notSearchable')}
                    </Badge>
                  )}
                  {collisionText && (
                    <Badge tone="warning" icon="⚠" title={collisionText}>
                      {t('packs.state.notServed')}
                    </Badge>
                  )}
                  {/* #340 nits: only THIS row's controls disable while it is busy (another row's
                      toggle or remove is an independent operation), and an unavailable pack can
                      be disabled too — the flag is the user's, whatever the file is doing. */}
                  <Switch
                    checked={p.enabled}
                    disabled={rowBusy}
                    ariaLabel={t('packs.switchLabel', { title: p.title })}
                    label={p.enabled ? t('packs.state.enabled') : t('packs.state.disabled')}
                    onChange={() => void onToggle(p)}
                  />
                </div>
                {reasonText && <p className="packs-card-reason hint">{reasonText}</p>}
                {collisionText && <p className="packs-card-reason hint">{collisionText}</p>}
                {p.description && <p className="packs-card-desc hint">{p.description}</p>}
                <p className="packs-card-meta hint">{metaLine(p)}</p>
                <div className="packs-card-actions">
                  {onAskPack && (
                    <Button
                      size="sm"
                      disabled={!askable || rowBusy}
                      title={t('packs.askTitle')}
                      onClick={() => onAskPack(p.id)}
                    >
                      {t('packs.ask')}
                    </Button>
                  )}
                  {/* Remove lives behind the row's "⋯" (guidelines §3: destructive actions in a
                      menu, never a permanent button); the ConfirmDialog stays. */}
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className="doc-row-menu-btn packs-card-menu"
                        disabled={rowBusy}
                        aria-label={t('packs.rowMenu', { title: p.title })}
                      >
                        ⋯
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
                        <DropdownMenu.Item className="menu-item danger" onSelect={() => setConfirmRemove(p)}>
                          {t('packs.remove')}
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
              </li>
            )
          })}
        </ul>
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

      {toolsInstall.family && (
        <KnowledgePackToolsDialog
          open={toolsDialogOpen}
          family={toolsInstall.family}
          downloadsEnabled={toolsInstall.downloadsEnabled}
          blockedReason={toolsInstall.blockedReason}
          onConfirm={() => {
            setToolsDialogOpen(false)
            void toolsInstall.start()
          }}
          onCancel={() => setToolsDialogOpen(false)}
          t={t}
        />
      )}
    </div>
  )
}
