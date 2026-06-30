// The Documents left section-rail / sub-nav, extracted to its own sibling file (DX-3 split,
// full-audit-2026-06-29 follow-up Phase 8). Relocated VERBATIM from `DocumentsScreen.tsx`;
// the markup, the remembered "More" disclosure, and the project menus are byte-identical.

import { useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { Collection } from '@shared/types'
import type { I18n } from '../../i18n'
import { VIEWS_MORE_KEY, type DocSection, type RareViewKind } from './types'

/**
 * Left section rail / Documents sub-nav (plan §12.1; regrouped §11.6). Four headed groups in
 * order — **All documents** (default landing, no header) · **Projects** (user-primary, with a
 * "+" add + per-project "⋯") · **Locations** (the system buckets Library / Temporary /
 * Generated / Archived, grouped so they read as one set) · **Views** (the common smart filters
 * always visible, the rare diagnostics behind a remembered "More" disclosure). The whole panel
 * is collapsible (the "«" handle ⇒ `onCollapse`; the list then takes the full width — mirrors
 * the chat ConversationList collapse pattern). Responsive collapse to a horizontal strip still
 * rides on the 760px breakpoint (CSS, plan §12 L4).
 */
export function SectionRail({
  section,
  onSelect,
  activeProjects,
  archivedProjects,
  rareCounts,
  busy,
  onCollapse,
  onNewProject,
  onRenameProject,
  onArchiveProject,
  onDeleteProject,
  t
}: {
  section: DocSection
  onSelect: (s: DocSection) => void
  collections: Collection[]
  activeProjects: Collection[]
  archivedProjects: Collection[]
  /** Document count per rare view, so an empty diagnostic view is hidden (presentation only). */
  rareCounts: Record<RareViewKind, number>
  busy: boolean
  onCollapse: () => void
  onNewProject: () => void
  onRenameProject: (p: Collection) => void
  onArchiveProject: (p: Collection) => void
  onDeleteProject: (p: Collection) => void
  t: I18n['t']
}): JSX.Element {
  // The "More" disclosure (rare diagnostic views) — a real <button> with aria-expanded,
  // collapsed by default, remembered across sessions (§9 / WCAG 2.2 AA disclosure).
  const [moreOpen, setMoreOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(VIEWS_MORE_KEY) === '1'
    } catch {
      return false
    }
  })
  function toggleMore(): void {
    setMoreOpen((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(VIEWS_MORE_KEY, next ? '1' : '0')
      } catch {
        // best-effort
      }
      return next
    })
  }
  const is = (s: DocSection): boolean =>
    section.kind === s.kind && (s.kind !== 'project' || (s as { id: string }).id === (section as { id: string }).id)
  const railBtn = (s: DocSection, label: string): JSX.Element => (
    <button
      type="button"
      className={`docs-rail-item ${is(s) ? 'active' : ''}`}
      aria-current={is(s) ? 'true' : undefined}
      onClick={() => onSelect(s)}
    >
      {label}
    </button>
  )
  // Rare diagnostic views: shown only when non-empty (empty diagnostics don't clutter the
  // panel) OR when currently selected (never hide the active section out from under the user).
  const rareViews: Array<{ kind: RareViewKind; label: string }> = [
    { kind: 'large', label: t('docs.smart.largeFiles') },
    { kind: 'failed', label: t('docs.smart.failed') },
    { kind: 'audio', label: t('docs.smart.audio') },
    { kind: 'ocr', label: t('docs.smart.ocr') }
  ]
  const visibleRare = rareViews.filter((v) => rareCounts[v.kind] > 0 || section.kind === v.kind)
  return (
    <nav className="docs-rail" aria-label={t('docs.section.heading')}>
      {/* Panel header: a quiet title + the "«" collapse handle (§11.6). */}
      <div className="docs-rail-head">
        <span className="docs-rail-title">{t('docs.section.heading')}</span>
        <button
          type="button"
          className="docs-rail-collapse"
          aria-label={t('docs.rail.hide')}
          title={t('docs.rail.hide')}
          onClick={onCollapse}
        >
          «
        </button>
      </div>

      {/* All documents — the default landing, slightly emphasized; no group header. */}
      {railBtn({ kind: 'all' }, t('docs.section.all'))}

      {/* PROJECTS — user-primary, kept near the top (header + "+"). */}
      <div className="docs-rail-group">
        <div className="docs-rail-group-head">
          <span className="docs-rail-group-label">{t('docs.section.projects')}</span>
          <button
            type="button"
            className="docs-rail-add"
            disabled={busy}
            aria-label={t('docs.section.newProject')}
            title={t('docs.section.newProject')}
            onClick={onNewProject}
          >
            +
          </button>
        </div>
        {activeProjects.length === 0 && <p className="docs-rail-empty hint">{t('docs.section.noProjects')}</p>}
        {activeProjects.map((p) => (
          <div key={p.id} className={`docs-rail-project ${is({ kind: 'project', id: p.id }) ? 'active' : ''}`}>
            <button
              type="button"
              className="docs-rail-item docs-rail-project-name"
              aria-current={is({ kind: 'project', id: p.id }) ? 'true' : undefined}
              onClick={() => onSelect({ kind: 'project', id: p.id })}
            >
              {p.name}
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" className="docs-rail-project-menu" disabled={busy} aria-label={t('docs.project.options')}>
                  ⋯
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
                  <DropdownMenu.Item className="menu-item" onSelect={() => onRenameProject(p)}>
                    {t('docs.project.rename')}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" onSelect={() => onArchiveProject(p)}>
                    {t('docs.project.archive')}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item danger" onSelect={() => onDeleteProject(p)}>
                    {t('docs.project.delete')}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        ))}
        {archivedProjects.map((p) => (
          <div key={p.id} className="docs-rail-project archived">
            <button
              type="button"
              className="docs-rail-item docs-rail-project-name"
              title={t('docs.project.archivedNote')}
              onClick={() => onSelect({ kind: 'project', id: p.id })}
            >
              {p.name}
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" className="docs-rail-project-menu" disabled={busy} aria-label={t('docs.project.options')}>
                  ⋯
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
                  <DropdownMenu.Item className="menu-item" onSelect={() => onArchiveProject(p)}>
                    {t('docs.project.unarchive')}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item danger" onSelect={() => onDeleteProject(p)}>
                    {t('docs.project.delete')}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        ))}
      </div>
      {/* LOCATIONS — the system buckets, grouped under one header so they read as one set
          (presentation only; the underlying data model / exclusivity is untouched, see the
          location-taxonomy note in BUILD_STATE.md). */}
      <div className="docs-rail-group">
        <div className="docs-rail-group-head">
          <span className="docs-rail-group-label">{t('docs.section.locations')}</span>
        </div>
        {railBtn({ kind: 'library' }, t('docs.section.library'))}
        {railBtn({ kind: 'temporary' }, t('docs.section.temporary'))}
        {railBtn({ kind: 'generated' }, t('docs.section.generated'))}
        {railBtn({ kind: 'archived' }, t('docs.section.archived'))}
      </div>

      {/* VIEWS — query-time smart filters (plan §7.6/§12.1). The common ones stay visible; the
          rare diagnostics fold behind a remembered "More" disclosure (and an empty diagnostic
          view is hidden entirely). */}
      <div className="docs-rail-group">
        <div className="docs-rail-group-head">
          <span className="docs-rail-group-label">{t('docs.smart.heading')}</span>
        </div>
        {railBtn({ kind: 'recent' }, t('docs.smart.recentlyAdded'))}
        {railBtn({ kind: 'unfiled' }, t('docs.smart.unfiled'))}
        {railBtn({ kind: 'needsReindex' }, t('docs.smart.needsReindex'))}
        {visibleRare.length > 0 && (
          <>
            <button
              type="button"
              className="docs-rail-more"
              aria-expanded={moreOpen}
              onClick={toggleMore}
            >
              <span>{t('docs.smart.more')}</span>
              <span className="docs-rail-more-caret" aria-hidden="true">
                {moreOpen ? '▴' : '▾'}
              </span>
            </button>
            {moreOpen && visibleRare.map((v) => railBtn({ kind: v.kind }, v.label))}
          </>
        )}
      </div>
    </nav>
  )
}
