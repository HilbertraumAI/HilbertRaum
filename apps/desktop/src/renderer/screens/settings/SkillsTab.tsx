import { useCallback, useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  Icon,
  Modal,
  Switch,
  useToast
} from '../../components'
import { useT } from '../../i18n'
import { localizedSkillDescription, localizedSkillTitle } from '../../lib/skillI18n'
import { consumeSkillDetailRequest } from '../../lib/skillDetailRequest'
import { IMPORT_ERROR_KEY, importErrorKeyForMessage, localizeSkillNote } from '../../lib/skillImportI18n'
import type { MessageKey } from '@shared/i18n'
import type { SkillKind, SkillPermissions } from '@shared/skill-manifest'
import type { AppSettings, SkillInfo, SkillPreview, SkillReconcileStatus } from '@shared/types'

// Settings → Skills (skills plan §15 + §18.1). The one place to see and add skills.
// Everything destructive/file-touching is resolved MAIN-side (S4): the renderer hands a
// chosen path to previewSkillPackage/importSkill and otherwise reads SkillInfo. No fs,
// no dialog, no validation here. Copy is calm (guidelines §1), every status is icon+word
// (never colour-only, §9), and the warning for imported skills is reassuring, not alarming.
// The import-error/note localization tables live in lib/skillImportI18n.ts (SKA-33/SKA-35).

type ImportState = { path: string; preview: SkillPreview } | null

export function SkillsTab(): JSX.Element {
  const { t, tCount } = useT()
  const toast = useToast()
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [detail, setDetail] = useState<SkillInfo | null>(null)
  const [pending, setPending] = useState<ImportState>(null)
  const [confirmDelete, setConfirmDelete] = useState<SkillInfo | null>(null)
  // DS12: enabling a skill whose name is shared turns the other one off — confirm first.
  const [confirmReplace, setConfirmReplace] = useState<SkillInfo | null>(null)
  // S13c (D4): the global auto-fire opt-in. Loaded best-effort; the toggle hides until it resolves so
  // a failed read never shows a misleading "off". Mirrors the SettingsScreen patch pattern.
  const [settings, setSettings] = useState<AppSettings | null>(null)
  // SKA-32: the last reconcile's structural error summary (counts+codes only, never a folder
  // name). Non-zero → the calm "N skill folders could not be read" notice below the toolbar.
  const [reconcileStatus, setReconcileStatus] = useState<SkillReconcileStatus | null>(null)
  // Per-skill enable/disable in-flight set (audit FE-3): the Switch is disabled while a toggle is
  // pending and a second toggle for the same skill is ignored, so rapid clicks can't race (no
  // overlapping enable/disable whose last-resolved refresh wins). Disable-while-pending over
  // optimistic UI — simpler and robust; `refresh()` reconciles to the server state at the end.
  const [toggling, setToggling] = useState<ReadonlySet<string>>(() => new Set())

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await window.api.listSkills()
      setSkills(list)
      setLoadError(null)
    } catch {
      setSkills([])
      setLoadError(t('skills.loadFailed'))
    }
    // SKA-32: best-effort — an unreadable/absent status simply shows no notice (never blocks the list).
    try {
      const status = await window.api.getSkillReconcileStatus()
      setReconcileStatus(typeof status?.errorCount === 'number' ? status : null)
    } catch {
      setReconcileStatus(null)
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Load the auto-fire opt-in (S13c/D4). Best-effort: a failed read leaves `settings` null and the
  // toggle simply doesn't render (rather than implying a state we couldn't confirm). The `active`
  // guard avoids a setState after unmount if the read resolves late (audit FE-4).
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const s = await window.api?.getSettings?.()
        if (active && s) setSettings(s)
      } catch {
        if (active) setSettings(null)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  // Flip the auto-fire opt-in, persisting through the shared Settings patch path (the saved value
  // wins). Off by default; this is the ONLY control that makes S13b reachable for a user.
  async function setAutoFire(on: boolean): Promise<void> {
    try {
      const next = await window.api.updateSettings({ skillsAutoFireEnabled: on })
      setSettings(next)
      toast(on ? t('skills.autoFire.on') : t('skills.autoFire.off'))
    } catch {
      toast(t('skills.loadFailed'))
    }
  }

  // Keep the open drawer in step with the freshest row data after a mutation.
  useEffect(() => {
    if (!detail || !skills) return
    const fresh = skills.find((s) => s.installId === detail.installId)
    if (fresh && fresh !== detail) setDetail(fresh)
    else if (!fresh) setDetail(null)
  }, [skills, detail])

  // #46: consume a pending deep-link from the composer's info card ("Learn more") once the list has
  // loaded — one-shot, so later refreshes never re-open it. An id that no longer resolves (skill
  // removed meanwhile) simply opens nothing.
  useEffect(() => {
    if (!skills) return
    const requested = consumeSkillDetailRequest()
    if (!requested) return
    const target = skills.find((s) => s.installId === requested)
    if (target) setDetail(target)
  }, [skills])

  async function pick(mode: 'file' | 'folder'): Promise<void> {
    // pickSkillPackage is INSIDE the try (audit FE-2): a rejecting picker now surfaces a
    // friendly toast instead of an unhandled promise rejection. A user cancel resolves to a
    // falsy path and simply returns.
    try {
      const path = await window.api.pickSkillPackage(mode)
      if (!path) return
      const preview = await window.api.previewSkillPackage(path)
      setPending({ path, preview })
    } catch {
      toast(t('skills.import.failed'))
    }
  }

  async function doImport(): Promise<void> {
    if (!pending) return
    const { path } = pending
    setPending(null)
    try {
      await window.api.importSkill(path)
      await refresh()
      toast(t('skills.import.added'))
    } catch (e) {
      // SKA-33: the import throws the same STRUCTURAL reasons the preview localizes, but wrapped
      // in Electron's IPC error message — map it back through the code table so the toast names
      // the precise reason (downgrade race, vanished zip, locked folder…), as the preview does.
      const message = e instanceof Error ? e.message : String(e)
      const key = importErrorKeyForMessage(message)
      toast(key ? t(key) : t('skills.import.failed'))
    }
  }

  async function setEnabled(skill: SkillInfo, on: boolean): Promise<void> {
    // Enabling a duplicate-id skill replaces the active sibling (server enforces
    // one-active-per-id); surface that intent before flipping the switch.
    if (on && skill.duplicateId) {
      setConfirmReplace(skill)
      return
    }
    await applyEnabled(skill, on)
  }

  async function applyEnabled(skill: SkillInfo, on: boolean): Promise<void> {
    // Suppress a double-submit while a toggle for this skill is in flight (audit FE-3) — the
    // Switch is also disabled in the row, this is the belt-and-braces guard against a queued
    // event. `finally` clears it so the row is interactive again after refresh reconciles.
    if (toggling.has(skill.installId)) return
    setToggling((prev) => new Set(prev).add(skill.installId))
    try {
      if (on) await window.api.enableSkill(skill.installId)
      else await window.api.disableSkill(skill.installId)
      await refresh()
      toast(on ? t('skills.row.on') : t('skills.row.off'))
    } catch {
      // full-audit 2026-07-11 CODE-37: name the action that failed — the old "Skills couldn’t be
      // loaded." misdescribed a failed toggle (the list IS loaded and visible).
      toast(on ? t('skills.row.onFailed') : t('skills.row.offFailed'))
    } finally {
      setToggling((prev) => {
        const next = new Set(prev)
        next.delete(skill.installId)
        return next
      })
    }
  }

  async function doDelete(): Promise<void> {
    if (!confirmDelete) return
    const target = confirmDelete
    setConfirmDelete(null)
    try {
      await window.api.deleteSkill(target.installId)
      await refresh()
      toast(t('skills.delete.done'))
    } catch {
      toast(t('skills.delete.failed')) // CODE-37: per-action failure copy
    }
  }

  async function doExport(skill: SkillInfo): Promise<void> {
    try {
      const dest = await window.api.exportSkill(skill.installId)
      if (dest) toast(t('skills.export.done'))
    } catch {
      toast(t('skills.export.failed')) // CODE-37: per-action failure copy
    }
  }

  async function acknowledge(skill: SkillInfo): Promise<void> {
    try {
      await window.api.acknowledgeSkillWarning(skill.installId)
      await refresh()
    } catch {
      /* best-effort — the warning simply stays until the next try */
    }
  }

  return (
    <>
      <div className="card">
        <div className="skills-toolbar">
          <p className="hint skills-intro">{t('skills.intro')}</p>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button variant="primary" aria-label={t('skills.import.menuAria')}>
                {t('skills.import')} <span aria-hidden="true">▾</span>
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
                <DropdownMenu.Item className="menu-item" onSelect={() => void pick('file')}>
                  {t('skills.import.fromFile')}
                </DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" onSelect={() => void pick('folder')}>
                  {t('skills.import.fromFolder')}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
        {loadError && <Banner tone="error">{loadError}</Banner>}
        {/* SKA-32: reconcile errors were previously dropped silently — a drop-in with one YAML typo
            simply never appeared. Count only; the folder itself is user content and never named. */}
        {(reconcileStatus?.errorCount ?? 0) > 0 && (
          <Banner tone="warning">
            {tCount('skills.reconcile.folderErrors', reconcileStatus!.errorCount)}
          </Banner>
        )}
      </div>

      {/* S13c (D3/D4): the global auto-fire opt-in. Off by default — until this is on, the app never
          applies a skill on its own. App skills only; an auto-applied skill is always visible (the
          per-message glyph) and reversible (the per-turn "answer without it" undo). */}
      {settings && (
        <div className="card">
          <h2>{t('skills.autoFire.title')}</h2>
          <Switch
            checked={settings.skillsAutoFireEnabled}
            onChange={(on) => void setAutoFire(on)}
            label={t('skills.autoFire.toggle')}
          />
          <p className="hint">{t('skills.autoFire.hint')}</p>
        </div>
      )}

      {skills === null ? (
        <p className="hint" role="status">
          {t('skills.loading')}
        </p>
      ) : skills.length === 0 && !loadError ? (
        <div className="card">
          <div className="empty-state">
            <h2 className="empty-state-title">{t('skills.empty.title')}</h2>
            <p className="empty-state-line">{t('skills.empty.line')}</p>
          </div>
        </div>
      ) : (
        <div className="card skills-list" role="list">
          {skills.map((skill) => (
            <SkillRow
              key={skill.installId}
              skill={skill}
              pending={toggling.has(skill.installId)}
              onOpen={() => setDetail(skill)}
              onToggle={(on) => void setEnabled(skill, on)}
              onExport={() => void doExport(skill)}
              onDelete={() => setConfirmDelete(skill)}
            />
          ))}
        </div>
      )}

      <SkillDetail
        skill={detail}
        onClose={() => setDetail(null)}
        onAcknowledge={(s) => void acknowledge(s)}
      />

      {pending && (
        <ImportDialog
          state={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => void doImport()}
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t('skills.delete.title')}
        confirmLabel={t('skills.delete.confirm')}
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDelete(null)}
        t={t}
      >
        {t('skills.delete.body')}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmReplace !== null}
        title={t('skills.replace.title')}
        confirmLabel={t('skills.replace.confirm')}
        onConfirm={() => {
          const target = confirmReplace
          setConfirmReplace(null)
          if (target) void applyEnabled(target, true)
        }}
        onCancel={() => setConfirmReplace(null)}
        t={t}
      >
        {t('skills.replace.body')}
      </ConfirmDialog>
    </>
  )
}

const TRUST_LABEL: Record<SkillInfo['trustedLevel'], MessageKey> = {
  app: 'skills.trusted.app',
  user: 'skills.trusted.user'
}

function SkillRow({
  skill,
  pending,
  onOpen,
  onToggle,
  onExport,
  onDelete
}: {
  skill: SkillInfo
  /** A toggle for this skill is in flight — the Switch is disabled until it resolves (FE-3). */
  pending: boolean
  onOpen: () => void
  onToggle: (on: boolean) => void
  onExport: () => void
  onDelete: () => void
}): JSX.Element {
  const { t, lang } = useT()
  const needsReview = skill.source === 'user' && !skill.warningAck
  const isApp = skill.source === 'app'
  const rowTitle = localizedSkillTitle(skill, lang)
  const rowDesc = localizedSkillDescription(skill, lang)
  return (
    <div className="skill-row" role="listitem">
      <Icon name="brain" className="skill-row-icon" />
      <button type="button" className="skill-row-main" onClick={onOpen}>
        <span className="skill-row-title">{rowTitle}</span>
        {rowDesc && <span className="skill-row-desc">{rowDesc}</span>}
      </button>
      <div className="skill-row-trailing">
        <Badge tone="neutral">{t(TRUST_LABEL[skill.trustedLevel])}</Badge>
        {skill.unavailable && (
          <Badge tone="error" icon="⚠" title={t('skills.unavailable.title')}>
            {t('skills.unavailable.chip')}
          </Badge>
        )}
        {skill.incompatible && (
          <Badge tone="warning" icon="⚠" title={t('skills.incompatible.title')}>
            {t('skills.incompatible.chip')}
          </Badge>
        )}
        {skill.duplicateId && (
          <Badge tone="warning" icon="⚠" title={t('skills.dup.title')}>
            {t('skills.dup.chip')}
          </Badge>
        )}
        {needsReview && (
          <Badge tone="warning" icon="⚠" title={t('skills.warn.body')}>
            {t('skills.review.chip')}
          </Badge>
        )}
        <Switch
          checked={skill.enabled}
          disabled={skill.unavailable || skill.incompatible || pending}
          onChange={onToggle}
          label={t('skills.row.enableLabel')}
        />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="doc-row-menu-btn" aria-label={t('skills.menu.aria')}>
              ⋯
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
              <DropdownMenu.Item className="menu-item" onSelect={onExport}>
                {t('skills.menu.export')}
              </DropdownMenu.Item>
              {/* App skills are read-only product content — deletable only by removing the
                  drive's app-skills folder, never from the UI (§9.4). */}
              {!isApp && (
                <>
                  <DropdownMenu.Separator className="menu-sep" />
                  <DropdownMenu.Item className="menu-item danger" onSelect={onDelete}>
                    {t('skills.menu.delete')}
                  </DropdownMenu.Item>
                </>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
  )
}

/**
 * The calm capability block (skills plan §15). Derived from the ALREADY-CLAMPED permissions
 * (DS6, decided main-side) + the kind — the renderer only localises the result; it never
 * re-decides what a skill may do.
 */
function PermissionBlock({
  permissions,
  kind
}: {
  permissions: SkillPermissions
  kind: SkillKind
}): JSX.Element {
  const { t } = useT()
  const can: MessageKey[] = ['skills.perm.can.instructions']
  if (permissions.documents === 'selected_only') can.push('skills.perm.can.documents')
  if (kind === 'tool') can.push('skills.perm.can.tools')
  // v1 ceiling (DS6): network is always denied, the filesystem reaches no folder beyond the
  // skill's own bundled files, and there is no script tier — so all three "cannot" lines hold.
  const cannot: MessageKey[] = ['skills.perm.cannot.network', 'skills.perm.cannot.files', 'skills.perm.cannot.scripts']
  return (
    <div className="skill-perm">
      <p className="skill-perm-title">{t('skills.perm.canTitle')}</p>
      <ul className="skill-perm-list">
        {can.map((k) => (
          <li key={k}>
            <span className="skill-perm-mark can" aria-hidden="true">
              ✓
            </span>
            {t(k)}
          </li>
        ))}
      </ul>
      <p className="skill-perm-title">{t('skills.perm.cannotTitle')}</p>
      <ul className="skill-perm-list">
        {cannot.map((k) => (
          <li key={k}>
            <span className="skill-perm-mark cannot" aria-hidden="true">
              ✕
            </span>
            {t(k)}
          </li>
        ))}
      </ul>
    </div>
  )
}

function SkillDetail({
  skill,
  onClose,
  onAcknowledge
}: {
  skill: SkillInfo | null
  onClose: () => void
  onAcknowledge: (skill: SkillInfo) => void
}): JSX.Element | null {
  const { t, lang } = useT()
  if (!skill) return null
  const needsReview = skill.source === 'user' && !skill.warningAck
  const detailTitle = localizedSkillTitle(skill, lang)
  const detailDesc = localizedSkillDescription(skill, lang)
  return (
    <Modal open={skill !== null} onClose={onClose} title={detailTitle} ariaLabel={t('skills.detail.aria')} t={t}>
      {detailDesc && <p className="lead">{detailDesc}</p>}

      {needsReview && (
        <Banner
          tone="warning"
          action={
            <Button size="sm" onClick={() => onAcknowledge(skill)}>
              {t('skills.warn.ack')}
            </Button>
          }
        >
          <strong>{t('skills.warn.title')}</strong>
          <br />
          {t('skills.warn.body')}
        </Banner>
      )}

      <dl className="kv">
        <dt>{t('skills.detail.version')}</dt>
        <dd>{skill.version}</dd>
        <dt>{t('skills.detail.kind')}</dt>
        <dd>{t(skill.kind === 'tool' ? 'skills.kind.tool' : 'skills.kind.instruction')}</dd>
        {skill.author && (
          <>
            <dt>{t('skills.detail.author')}</dt>
            <dd>{skill.author}</dd>
          </>
        )}
        {skill.language && (
          <>
            <dt>{t('skills.detail.language')}</dt>
            <dd>{skill.language}</dd>
          </>
        )}
      </dl>

      {/* Tier-2 note (skills plan §13/§22-D1). A `kind:'tool'` skill (S11c flip) names its real,
          app-orchestrated tools; an instruction skill that merely RESERVES tools shows the honest
          "tools arrive with Tier-2" note. Either way the permission line below stays kind-gated. */}
      {skill.kind === 'tool' ? (
        <Banner tone="info">{t('skills.tool.note.active')}</Banner>
      ) : (
        skill.reservesTools && <Banner tone="info">{t('skills.tool.note')}</Banner>
      )}

      <h3 className="skill-perm-heading">{t('skills.perm.heading')}</h3>
      <PermissionBlock permissions={skill.permissions} kind={skill.kind} />

      {/* Raw structural metadata (skills plan §15 / DS16) — NOT the assembled prompt fence,
          which is developer-mode only and lives in Diagnostics (S6+). */}
      <details className="tech-details">
        <summary>{t('skills.tech.summary')}</summary>
        <div className="tech-details-body">
          <dl className="kv">
            <dt>{t('skills.tech.id')}</dt>
            <dd>{skill.id}</dd>
            <dt>{t('skills.tech.installId')}</dt>
            <dd>{skill.installId}</dd>
            <dt>{t('skills.tech.source')}</dt>
            <dd>{t(TRUST_LABEL[skill.trustedLevel])}</dd>
            <dt>{t('skills.tech.permissions')}</dt>
            <dd>
              <code>
                documents: {skill.permissions.documents}; network: {skill.permissions.network};
                filesystem: {skill.permissions.filesystem}
              </code>
            </dd>
          </dl>
        </div>
      </details>
    </Modal>
  )
}

function ImportDialog({
  state,
  onCancel,
  onConfirm
}: {
  state: NonNullable<ImportState>
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  const { t } = useT()
  const { preview } = state
  const blocked = !preview.ok || preview.downgradeBlocked === true
  return (
    <ConfirmDialog
      open
      title={preview.ok ? t('skills.import.title') : t('skills.import.failedTitle')}
      confirmLabel={t('skills.import.confirm')}
      confirmDisabled={blocked}
      onConfirm={onConfirm}
      onCancel={onCancel}
      t={t}
    >
      <div className="skill-import">
        {preview.ok && preview.title && <p className="lead">{preview.title}</p>}
        {preview.ok && preview.permissions && (
          <PermissionBlock permissions={preview.permissions} kind={preview.kind ?? 'instruction'} />
        )}

        {/* Structural, content-free reasons computed main-side (§22-M1) — shown localized via the
            parallel reason code, falling back to the (English) structural message if unmapped (I2). */}
        {preview.errors.map((msg, i) => {
          const code = preview.errorCodes?.[i]
          const key = code ? IMPORT_ERROR_KEY[code] : undefined
          return (
            <Banner key={`e${i}`} tone="error">
              {key ? t(key) : msg}
            </Banner>
          )
        })}
        {/* SKA-35: advisories are localized via their stable note CODE + app-fixed params (the
            error-code precedent); an entry with no known code falls back to the structural text. */}
        {preview.notes.map((msg, i) => (
          <Banner key={`n${i}`} tone="info">
            {localizeSkillNote(t, msg, preview.noteCodes?.[i])}
          </Banner>
        ))}

        {/* Lifecycle flags (collision / upgrade / downgrade) — what confirming will do. */}
        {preview.collisionWith === 'app' && <Banner tone="warning">{t('skills.import.collisionApp')}</Banner>}
        {preview.collision && preview.collisionWith !== 'app' && preview.isUpgrade !== true && preview.isDowngrade !== true && (
          <Banner tone="info">{t('skills.import.collision')}</Banner>
        )}
        {preview.isUpgrade && preview.installedVersion && preview.version && (
          <Banner tone="info">
            {t('skills.import.upgrade', { from: preview.installedVersion, to: preview.version })}
          </Banner>
        )}
        {preview.isReplace && preview.version && (
          <Banner tone="info">{t('skills.import.replace', { version: preview.version })}</Banner>
        )}
        {preview.isDowngrade && !preview.downgradeBlocked && preview.installedVersion && (
          <Banner tone="warning">{t('skills.import.downgrade', { installed: preview.installedVersion })}</Banner>
        )}
        {preview.downgradeBlocked && <Banner tone="warning">{t('skills.import.downgradeBlocked')}</Banner>}
      </div>
    </ConfirmDialog>
  )
}
