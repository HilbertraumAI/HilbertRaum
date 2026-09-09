// The Documents left section-rail / sub-nav (DX-3 split, full-audit-2026-06-29 follow-up
// Phase 8; regrouped by the §11.16 declutter, 2026-09-09).

import { useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { Collection } from '@shared/types'
import type { I18n } from '../../i18n'
import { LOCATIONS_MORE_KEY, type DocSection, type LocationKind, type RailCounts } from './types'

/**
 * Left section rail / Documents sub-nav (plan §12.1; regrouped §11.6, decluttered §11.16). The
 * rail shows what the user HAS, not every bucket that could exist:
 *
 *   All documents · Recently added · Needs attention (only while > 0)
 *   PROJECTS  (+) — each project with its count; "Unfiled" as the last row once a project exists;
 *                   with no project at all, ONE quiet "+ New project" row instead of a header,
 *                   a hint and a "+"
 *   More ▾    — the system locations (Library / Temporary / Generated / Archived) behind a
 *               remembered disclosure, each shown only while it holds something
 *
 * Every entry carries its document count (visual — the count is aria-hidden so the accessible
 * name stays the plain label the list itself repeats). The whole panel is collapsible (the "«"
 * handle ⇒ `onCollapse`; the list then takes the full width — mirrors the chat ConversationList
 * collapse pattern). Responsive collapse to a horizontal strip still rides on the 760px
 * breakpoint (CSS, plan §12 L4).
 */
export function SectionRail({
  section,
  onSelect,
  activeProjects,
  archivedProjects,
  counts,
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
  activeProjects: Collection[]
  archivedProjects: Collection[]
  counts: RailCounts
  busy: boolean
  onCollapse: () => void
  onNewProject: () => void
  onRenameProject: (p: Collection) => void
  onArchiveProject: (p: Collection) => void
  onDeleteProject: (p: Collection) => void
  t: I18n['t']
}): JSX.Element {
  // The "More" disclosure (the system locations) — a real <button> with aria-expanded,
  // collapsed by default, remembered across sessions (§9 / WCAG 2.2 AA disclosure).
  const [moreOpen, setMoreOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(LOCATIONS_MORE_KEY) === '1'
    } catch {
      return false
    }
  })
  function toggleMore(): void {
    setMoreOpen((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(LOCATIONS_MORE_KEY, next ? '1' : '0')
      } catch {
        // best-effort
      }
      return next
    })
  }
  const is = (s: DocSection): boolean =>
    section.kind === s.kind && (s.kind !== 'project' || (s as { id: string }).id === (section as { id: string }).id)
  const railBtn = (s: DocSection, label: string, count?: number, title?: string): JSX.Element => (
    <button
      type="button"
      className={`docs-rail-item ${is(s) ? 'active' : ''}`}
      aria-current={is(s) ? 'true' : undefined}
      title={title}
      onClick={() => onSelect(s)}
    >
      <span className="docs-rail-label">{label}</span>
      {count != null && (
        <span className="docs-rail-count" aria-hidden="true">
          {count}
        </span>
      )}
    </button>
  )
  const projectMenu = (p: Collection, archived: boolean): JSX.Element => (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="docs-rail-project-menu" disabled={busy} aria-label={t('docs.project.options')}>
          ⋯
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
          {!archived && (
            <DropdownMenu.Item className="menu-item" onSelect={() => onRenameProject(p)}>
              {t('docs.project.rename')}
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item className="menu-item" onSelect={() => onArchiveProject(p)}>
            {t(archived ? 'docs.project.unarchive' : 'docs.project.archive')}
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item danger" onSelect={() => onDeleteProject(p)}>
            {t('docs.project.delete')}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
  const hasProjects = activeProjects.length > 0 || archivedProjects.length > 0
  // A location is offered while it holds something OR is the current section (never hide the
  // active section out from under the user).
  const locations: Array<{ kind: LocationKind; label: string }> = [
    { kind: 'library', label: t('docs.section.library') },
    { kind: 'temporary', label: t('docs.section.temporary') },
    { kind: 'generated', label: t('docs.section.generated') },
    { kind: 'archived', label: t('docs.section.archived') }
  ]
  const visibleLocations = locations.filter((l) => counts[l.kind] > 0 || section.kind === l.kind)
  const showAttention = counts.attention > 0 || section.kind === 'attention'

  return (
    <nav className="docs-rail" aria-label={t('docs.section.heading')}>
      {/* Panel head: only the quiet "«" collapse handle — the rail needs no title (§11.16). */}
      <div className="docs-rail-head">
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

      {railBtn({ kind: 'all' }, t('docs.section.all'), counts.all)}
      {railBtn({ kind: 'recent' }, t('docs.smart.recentlyAdded'))}
      {showAttention &&
        railBtn({ kind: 'attention' }, t('docs.smart.attention'), counts.attention, t('docs.smart.attentionTitle'))}

      {/* PROJECTS — user-primary. */}
      <div className="docs-rail-group">
        {hasProjects ? (
          <>
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
            {activeProjects.map((p) => (
              <div key={p.id} className={`docs-rail-project ${is({ kind: 'project', id: p.id }) ? 'active' : ''}`}>
                {railBtn({ kind: 'project', id: p.id }, p.name, counts.projects[p.id] ?? 0)}
                {projectMenu(p, false)}
              </div>
            ))}
            {archivedProjects.map((p) => (
              // DR-6: an archived project can be the current section too, so it carries the
              // `active` class + `aria-current` like the active-project branch.
              <div
                key={p.id}
                className={`docs-rail-project archived ${is({ kind: 'project', id: p.id }) ? 'active' : ''}`}
              >
                {railBtn({ kind: 'project', id: p.id }, p.name, counts.projects[p.id] ?? 0, t('docs.project.archivedNote'))}
                {projectMenu(p, true)}
              </div>
            ))}
            {railBtn({ kind: 'unfiled' }, t('docs.smart.unfiled'), counts.unfiled)}
          </>
        ) : (
          // No project yet: one quiet row IS the affordance (no header, no hint, no "+").
          <button
            type="button"
            className="docs-rail-item docs-rail-new-project"
            disabled={busy}
            aria-label={t('docs.section.newProject')}
            onClick={onNewProject}
          >
            <span className="docs-rail-label">
              <span aria-hidden="true">+ </span>
              {t('docs.section.newProject')}
            </span>
          </button>
        )}
      </div>

      {/* MORE — the system locations, folded (presentation only; the underlying data model /
          exclusivity is untouched, see the location-taxonomy note in BUILD_STATE.md). */}
      {visibleLocations.length > 0 && (
        <div className="docs-rail-group">
          <button type="button" className="docs-rail-more" aria-expanded={moreOpen} onClick={toggleMore}>
            <span>{t('docs.smart.more')}</span>
            <span className="docs-rail-more-caret" aria-hidden="true">
              {moreOpen ? '▴' : '▾'}
            </span>
          </button>
          {moreOpen && visibleLocations.map((l) => railBtn({ kind: l.kind }, l.label, counts[l.kind]))}
        </div>
      )}
    </nav>
  )
}
