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
import type { MessageKey } from '@shared/i18n'
import type { SkillKind, SkillPermissions } from '@shared/skill-manifest'
import type { SkillInfo, SkillPreview } from '@shared/types'

// Settings → Skills (skills plan §15 + §18.1). The one place to see and add skills.
// Everything destructive/file-touching is resolved MAIN-side (S4): the renderer hands a
// chosen path to previewSkillPackage/importSkill and otherwise reads SkillInfo. No fs,
// no dialog, no validation here. Copy is calm (guidelines §1), every status is icon+word
// (never colour-only, §9), and the warning for imported skills is reassuring, not alarming.

type ImportState = { path: string; preview: SkillPreview } | null

// Import-error reason CODE (content-free, computed main-side — I2) → localized copy key, so a
// German user never sees the English structural string. An unmapped code falls back to the raw
// (English, structural) message the preview carried.
const IMPORT_ERROR_KEY: Record<string, MessageKey> = {
  notFound: 'skills.import.error.notFound',
  notZipOrFolder: 'skills.import.error.notZipOrFolder',
  unreadableZip: 'skills.import.error.unreadableZip',
  encryptedZip: 'skills.import.error.encryptedZip',
  unsupportedCompression: 'skills.import.error.unsupportedCompression',
  pathTraversal: 'skills.import.error.pathTraversal',
  absolutePath: 'skills.import.error.absolutePath',
  symlink: 'skills.import.error.symlink',
  tooDeep: 'skills.import.error.tooDeep',
  pathTooLong: 'skills.import.error.pathTooLong',
  tooManyFiles: 'skills.import.error.tooManyFiles',
  tooLarge: 'skills.import.error.tooLarge',
  fileTooLarge: 'skills.import.error.fileTooLarge',
  badExtension: 'skills.import.error.badExtension',
  nestedArchive: 'skills.import.error.nestedArchive',
  noSkillMd: 'skills.import.error.noSkillMd',
  invalidManifest: 'skills.import.error.invalidManifest',
  idMismatch: 'skills.import.error.idMismatch',
  downgradeBlocked: 'skills.import.error.downgradeBlocked',
  appReadOnly: 'skills.import.error.appReadOnly',
  locked: 'skills.import.error.locked'
}

export function SkillsTab(): JSX.Element {
  const { t } = useT()
  const toast = useToast()
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [detail, setDetail] = useState<SkillInfo | null>(null)
  const [pending, setPending] = useState<ImportState>(null)
  const [confirmDelete, setConfirmDelete] = useState<SkillInfo | null>(null)
  // DS12: enabling a skill whose name is shared turns the other one off — confirm first.
  const [confirmReplace, setConfirmReplace] = useState<SkillInfo | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await window.api.listSkills()
      setSkills(list)
      setLoadError(null)
    } catch {
      setSkills([])
      setLoadError(t('skills.loadFailed'))
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Keep the open drawer in step with the freshest row data after a mutation.
  useEffect(() => {
    if (!detail || !skills) return
    const fresh = skills.find((s) => s.installId === detail.installId)
    if (fresh && fresh !== detail) setDetail(fresh)
    else if (!fresh) setDetail(null)
  }, [skills, detail])

  async function pick(mode: 'file' | 'folder'): Promise<void> {
    const path = await window.api.pickSkillPackage(mode)
    if (!path) return
    try {
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
    } catch {
      toast(t('skills.import.failed'))
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
    try {
      if (on) await window.api.enableSkill(skill.installId)
      else await window.api.disableSkill(skill.installId)
      await refresh()
      toast(on ? t('skills.row.on') : t('skills.row.off'))
    } catch {
      toast(t('skills.loadFailed'))
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
      toast(t('skills.loadFailed'))
    }
  }

  async function doExport(skill: SkillInfo): Promise<void> {
    try {
      const dest = await window.api.exportSkill(skill.installId)
      if (dest) toast(t('skills.export.done'))
    } catch {
      toast(t('skills.loadFailed'))
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
      </div>

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
  onOpen,
  onToggle,
  onExport,
  onDelete
}: {
  skill: SkillInfo
  onOpen: () => void
  onToggle: (on: boolean) => void
  onExport: () => void
  onDelete: () => void
}): JSX.Element {
  const { t } = useT()
  const needsReview = skill.source === 'user' && !skill.warningAck
  const isApp = skill.source === 'app'
  return (
    <div className="skill-row" role="listitem">
      <Icon name="brain" className="skill-row-icon" />
      <button type="button" className="skill-row-main" onClick={onOpen}>
        <span className="skill-row-title">{skill.title}</span>
        {skill.description && <span className="skill-row-desc">{skill.description}</span>}
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
          disabled={skill.unavailable || skill.incompatible}
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
  const { t } = useT()
  if (!skill) return null
  const needsReview = skill.source === 'user' && !skill.warningAck
  return (
    <Modal open={skill !== null} onClose={onClose} title={skill.title} ariaLabel={t('skills.detail.aria')} t={t}>
      {skill.description && <p className="lead">{skill.description}</p>}

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
        {preview.notes.map((msg, i) => (
          <Banner key={`n${i}`} tone="info">
            {msg}
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
