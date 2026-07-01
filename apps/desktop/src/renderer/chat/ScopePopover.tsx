import { useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import type { Collection, DocumentInfo, DocumentScope } from '@shared/types'
import { Button, Chip, Icon } from '../components'
import { useT, type I18n } from '../i18n'

// "📄 Using Library + Project: Tax 2025 ▾" (guidelines §3): the composer-footer affordance
// for the documents-mode retrieval scope. The popover is a MULTI-SELECT source picker
// (document-organization plan §13.2/D1): tick Library and/or any project, add specific
// documents, or tap "All documents". Underneath, the composed `DocumentScope` is the UNION
// of the ticked collections + the specific documents; an empty scope = the whole corpus.
//
// Temporary and Generated are NOT pickable sources (N10/D3): a generated/temporary doc is
// reached only via "Specific documents…". Chat attachments (Phase C) are shown read-only.

interface ScopePopoverProps {
  /** All imported documents; only indexed ones are offered. */
  docs: DocumentInfo[]
  /** All collections; only the Library built-in + non-archived projects are pickable. */
  collections: Collection[]
  /** Current composite scope; null/empty = the whole corpus. */
  scope: DocumentScope | null
  disabled?: boolean
  /** Receives the next composite scope (empty `{collectionIds:[],documentIds:[]}` = all). */
  onChangeScope: (next: DocumentScope) => void
  /** Jump to the Documents screen — used by the empty-corpus "Add documents" affordance. */
  onAddDocuments?: () => void
  /**
   * Temporary chat attachments linked to this conversation (plan C3/§13.1): shown as a
   * read-only "Files in this chat" line, ALWAYS unioned into retrieval — NOT removable
   * selection chips, distinct from the multi-select sources.
   */
  attachments?: DocumentInfo[]
  /** File names of attachments still being processed (N4): non-removable pending chips. */
  pendingAttachmentNames?: string[]
}

/** Localize a built-in collection's display name by type; projects keep their stored name. */
export function collectionLabel(c: Collection, t: I18n['t']): string {
  if (c.type === 'library') return t('docs.section.library')
  if (c.type === 'temporary') return t('docs.section.temporary')
  return c.name
}

/** Compose the footer label from a resolved scope (plan §13.1). Exported for tests. */
export function scopeFooterLabel(
  scope: DocumentScope | null,
  collections: Collection[],
  t: I18n['t'],
  tCount: I18n['tCount']
): string {
  const collIds = scope?.collectionIds ?? []
  const docIds = scope?.documentIds ?? []
  if (collIds.length === 0 && docIds.length === 0) return t('chat.scope.usingAll')

  const parts: string[] = []
  const picked = collIds
    .map((id) => collections.find((c) => c.id === id))
    .filter((c): c is Collection => c != null)
  const library = picked.find((c) => c.type === 'library')
  const projects = picked.filter((c) => c.type === 'project')
  if (library) parts.push(t('chat.scope.library'))
  if (projects.length === 1) parts.push(t('chat.scope.projectNamed', { name: projects[0].name }))
  else if (projects.length > 1) parts.push(tCount('chat.scope.projectCount', projects.length))
  if (docIds.length > 0) parts.push(tCount('chat.scope.docCount', docIds.length))

  if (parts.length === 0) return t('chat.scope.usingAll')
  return t('chat.scope.using', { sources: parts.join(' + ') })
}

export function ScopePopover({
  docs,
  collections,
  scope,
  disabled,
  onChangeScope,
  onAddDocuments,
  attachments = [],
  pendingAttachmentNames = []
}: ScopePopoverProps): JSX.Element {
  const { t, tCount } = useT()
  const [showDocs, setShowDocs] = useState(false)
  const indexed = docs.filter((d) => d.status === 'indexed')
  const fileCount = attachments.length + pendingAttachmentNames.length

  const collIds = scope?.collectionIds ?? []
  const docIds = scope?.documentIds ?? []
  // Pickable sources: Library + non-archived projects (archived projects drop out — C1).
  const library = collections.find((c) => c.type === 'library')
  const projects = collections.filter((c) => c.type === 'project' && c.archivedAt == null)

  // Truthful footer copy (guidelines §7): with no indexed documents AND no chat attachments
  // the affordance becomes a direct "Add documents" jump, not a scope picker. (Attachments —
  // live or still processing — keep the picker, so a freshly dropped file is visible.)
  if (indexed.length === 0 && fileCount === 0) {
    return (
      <button type="button" className="footer-menu-btn" disabled={disabled} onClick={onAddDocuments}>
        <Icon name="file" className="footer-menu-icon" /> {t('chat.scope.none')}
      </button>
    )
  }

  function emit(nextColl: string[], nextDocs: string[]): void {
    onChangeScope({ collectionIds: nextColl, documentIds: nextDocs })
  }

  function toggleCollection(id: string): void {
    emit(collIds.includes(id) ? collIds.filter((x) => x !== id) : [...collIds, id], docIds)
  }

  function title(id: string): string {
    return docs.find((d) => d.id === id)?.title ?? t('chat.scope.removedDoc')
  }

  const addableDocs = indexed.filter((d) => !docIds.includes(d.id))
  // When the composed scope is empty (Library unchecked, no projects/docs picked) but the chat HAS
  // attachments, retrieval is actually scoped to THOSE files — main-side `resolveScope` unions the chat
  // attachments in, so the query never touches the whole corpus. The footer must therefore NOT say
  // "Nutzt alle Dokumente" (which made unchecking the Library look like a no-op); show the files as the
  // scope instead. Only a truly empty scope with NO attachments is the whole-corpus "all documents".
  const composedEmpty = collIds.length === 0 && docIds.length === 0
  const label =
    composedEmpty && fileCount > 0
      ? tCount('chat.scope.filesInChat', fileCount)
      : scopeFooterLabel(scope, collections, t, tCount)
  // Chat attachments (live + pending) are always included; surfaced as a quiet count alongside the
  // composed sources (plan §13.1), never as removable selection chips. Not appended in the
  // empty-composed-scope case above, where the file count is already the primary label (no double count).
  const filesSuffix = fileCount > 0 && !composedEmpty ? ` · ${tCount('chat.scope.filesInChat', fileCount)}` : ''

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="footer-menu-btn" disabled={disabled}>
          <Icon name="file" className="footer-menu-icon" /> {label}
          {filesSuffix} <span aria-hidden="true">▾</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="popover"
          align="start"
          sideOffset={6}
          aria-label={t('chat.scope.sourcesTitle')}
        >
          <p className="popover-line">{t('chat.scope.sourcesTitle')}</p>
          <div className="scope-sources">
            {library && (
              <label className="scope-source-row">
                <input
                  type="checkbox"
                  checked={collIds.includes(library.id)}
                  disabled={disabled}
                  onChange={() => toggleCollection(library.id)}
                />
                <span className="scope-source-name">{t('chat.scope.librarySource')}</span>
                <span className="scope-source-hint">{t('chat.scope.librarySourceHint')}</span>
              </label>
            )}
            {projects.length === 0 && (
              <p className="popover-line popover-line-add hint">{t('chat.scope.noProjects')}</p>
            )}
            {projects.map((p) => (
              <label className="scope-source-row" key={p.id}>
                <input
                  type="checkbox"
                  checked={collIds.includes(p.id)}
                  disabled={disabled}
                  onChange={() => toggleCollection(p.id)}
                />
                <span className="scope-source-name">{p.name}</span>
              </label>
            ))}
          </div>

          {/* Specific documents — the explicit-doc branch of the union (and the only way to
              reach a generated/temporary doc, D3/N10). Selected docs render as removable chips. */}
          <button
            type="button"
            className="popover-line popover-line-add scope-specific-toggle"
            aria-expanded={showDocs}
            onClick={() => setShowDocs((v) => !v)}
          >
            {t('chat.scope.specificToggle')} <span aria-hidden="true">{showDocs ? '▾' : '▸'}</span>
          </button>
          {docIds.length > 0 && (
            <div className="popover-chips">
              {docIds.map((id) => (
                <Chip
                  key={id}
                  title={title(id)}
                  onRemove={() => emit(collIds, docIds.filter((x) => x !== id))}
                  removeLabel={t('chat.scope.stopAsking', { title: title(id) })}
                  disabled={disabled}
                >
                  {title(id)}
                </Chip>
              ))}
            </div>
          )}
          {showDocs && addableDocs.length > 0 && (
            <div className="popover-chips">
              {addableDocs.map((d) => (
                <Chip
                  key={d.id}
                  title={t('chat.scope.askToo', { title: d.title })}
                  disabled={disabled}
                  onClick={() => emit(collIds, [...docIds, d.id])}
                >
                  + {d.title}
                </Chip>
              ))}
            </div>
          )}

          {/* Files in this chat (plan §13.1/§13.3): the conversation's temporary attachments,
              ALWAYS included and NOT removable (distinct from the multi-select sources). A
              still-processing attachment shows as a pending chip (N4). */}
          {fileCount > 0 && (
            <div className="scope-attachments">
              <p className="popover-line">{t('chat.scope.filesInChatLine')}</p>
              <div className="popover-chips">
                {attachments.map((d) => (
                  <span className="doc-chip scope-attachment" key={d.id} title={d.title}>
                    {d.title}
                  </span>
                ))}
                {pendingAttachmentNames.map((name, i) => (
                  // Key by name AND index (audit FE-6): the name makes the key content-aware (a new
                  // import with a different file at the same slot re-mounts the chip rather than
                  // reusing a stale node), while the index keeps it unique — two cross-folder files
                  // can share a base name (`fileBaseName` keeps only the last segment), so a
                  // name-only key would collide and trip React's duplicate-key warning. The list is
                  // set/cleared wholesale (never reordered item-by-item), so the index is stable.
                  <span className="doc-chip scope-attachment pending" key={`pending-${i}-${name}`}>
                    {t('chat.attach.processing', { name })}
                  </span>
                ))}
              </div>
            </div>
          )}

          {(collIds.length > 0 || docIds.length > 0) && (
            <Button
              size="sm"
              className="popover-reset"
              disabled={disabled}
              onClick={() => emit([], [])}
            >
              {t('chat.scope.allTap')}
            </Button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
