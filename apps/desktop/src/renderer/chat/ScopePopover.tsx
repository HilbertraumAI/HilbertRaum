import { useMemo, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import type { Collection, DocumentInfo, DocumentScope, KnowledgePack } from '@shared/types'
import { MAX_SELECTED_PACKS } from '@shared/types'
import { Button, Chip, Icon } from '../components'
import { useT, type I18n } from '../i18n'

// "📄 Using Library + Project: Tax 2025 ▾" (guidelines §3): the composer-footer affordance
// for the documents-mode retrieval scope. The popover is a MULTI-SELECT source picker
// (document-organization plan §13.2/D1): tick Library and/or any project, add specific
// documents, or tap "All documents". Underneath, the composed `DocumentScope` is the UNION
// of the ticked collections + the specific documents. RD-2 (#151): an empty explicit scope
// is "the whole corpus" ONLY in a chat with no attachments — with attachments, main-side
// resolveScope unions them in and the empty scope means JUST the attached files (D71 /
// CODE-31; see the reset button's label branch below).
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
  /**
   * Knowledge packs (ZIM wave): registered, non-removed packs offered as additional
   * sources. Absent/empty => the section never renders (byte-identical popover). An
   * unavailable pack (file missing) is shown but not tickable - honest state.
   */
  packs?: KnowledgePack[]
}

/** Stable empty-id list for a null scope (PF-7d) — a fresh `[]` per render would bust the memos. */
const EMPTY_IDS: string[] = []

/**
 * The composed sources phrase for a resolved scope — e.g. "Library + 2 documents" — or null
 * when the scope is empty (= the whole corpus). The single source of truth for both the footer
 * label and the "Answering from:" chip (D71), so they never drift.
 */
export function scopeSources(
  scope: DocumentScope | null,
  collections: Collection[],
  t: I18n['t'],
  tCount: I18n['tCount'],
  packs: KnowledgePack[] = []
): string | null {
  // Documents off (#301 P4, finding M10): main-side `resolveScope` DROPS the ticked
  // collections and hand-picked documents under the flag, so the phrase must too — otherwise
  // the chip would name sources the ask never reads. Attachments are handled by the caller
  // (they survive the flag and are counted separately in the "N files in this chat" suffix).
  const documentsOff = scope?.documentsOff === true
  const collIds = documentsOff ? [] : (scope?.collectionIds ?? [])
  const docIds = documentsOff ? [] : (scope?.documentIds ?? [])
  const packIds = scope?.packIds ?? []
  if (!documentsOff && collIds.length === 0 && docIds.length === 0 && packIds.length === 0) return null

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
  // Knowledge packs: name a single pack, count several (the projects pattern).
  if (packIds.length === 1) {
    const pack = packs.find((k) => k.id === packIds[0])
    parts.push(pack ? t('chat.scope.packNamed', { name: pack.title }) : tCount('chat.scope.packCount', 1))
  } else if (packIds.length > 1) {
    parts.push(tCount('chat.scope.packCount', packIds.length))
  }

  if (documentsOff) {
    // The packs phrase plus the honest "documents off" tail — and, with nothing ticked, the
    // state that says so and how to leave it (an explicit reset is the only way back).
    return parts.length === 0
      ? t('chat.scope.documentsOffNoPacks')
      : `${parts.join(' + ')} · ${t('chat.scope.documentsOffSuffix')}`
  }
  return parts.length === 0 ? null : parts.join(' + ')
}

/** Compose the footer label from a resolved scope (plan §13.1). Exported for tests. */
export function scopeFooterLabel(
  scope: DocumentScope | null,
  collections: Collection[],
  t: I18n['t'],
  tCount: I18n['tCount'],
  packs: KnowledgePack[] = []
): string {
  const sources = scopeSources(scope, collections, t, tCount, packs)
  return sources ? t('chat.scope.using', { sources }) : t('chat.scope.usingAll')
}

export function ScopePopover({
  docs,
  collections,
  scope,
  disabled,
  onChangeScope,
  onAddDocuments,
  attachments = [],
  pendingAttachmentNames = [],
  packs = []
}: ScopePopoverProps): JSX.Element {
  const { t, tCount } = useT()
  const [showDocs, setShowDocs] = useState(false)
  // PF-7d (full-audit 2026-07-10): memo the list derivations — this popover sits in the composer
  // footer, so it re-renders on every keystroke and stream flush (usually CLOSED), and re-filtering
  // the full docs list each time was pure churn. Keyed on the inputs that actually change them.
  const indexed = useMemo(() => docs.filter((d) => d.status === 'indexed'), [docs])
  const fileCount = attachments.length + pendingAttachmentNames.length

  const collIds = scope?.collectionIds ?? EMPTY_IDS
  const docIds = scope?.documentIds ?? EMPTY_IDS
  const packIds = scope?.packIds ?? EMPTY_IDS
  // Documents off (#301 P4, finding M10, ruling D4): the explicit "answer from the ticked
  // packs, not from my documents" choice — additive, never derived from an empty selection.
  const documentsOff = scope?.documentsOff === true
  // Pickable sources: Library + non-archived projects (archived projects drop out — C1).
  const library = useMemo(() => collections.find((c) => c.type === 'library'), [collections])
  const projects = useMemo(
    () => collections.filter((c) => c.type === 'project' && c.archivedAt == null),
    [collections]
  )
  // Hoisted above the empty-corpus early return below — hooks must run unconditionally.
  const addableDocs = useMemo(() => indexed.filter((d) => !docIds.includes(d.id)), [indexed, docIds])
  // D6 (#301 P4, plan §9.21 (e)8): selected ids with NO matching pack row — the pack was removed
  // from the registry while this chat still carries it in its stored scope. They render as
  // synthetic ticked "Removed pack" rows rather than disappearing from the picker: an id the
  // user cannot see is an id the user cannot clear.
  const removedPackIds = useMemo(
    () => packIds.filter((id) => !packs.some((k) => k.id === id)),
    [packIds, packs]
  )
  // The chat is at the selection cap: every UNSELECTED tickable pack goes disabled and the cap
  // line shows once. Counts what is SELECTED (the intended set), including removed ids — they
  // occupy a slot in the stored scope exactly like a live pack does.
  const atPackLimit = packIds.length >= MAX_SELECTED_PACKS

  // Truthful footer copy (guidelines §7): with no indexed documents AND no chat attachments
  // the affordance becomes a direct "Add documents" jump, not a scope picker. (Attachments —
  // live or still processing — keep the picker, so a freshly dropped file is visible.)
  // Knowledge packs (ZIM wave): registered packs are pickable sources too, so a pack-only
  // corpus (fresh workspace, offline Wikipedia added, nothing imported yet) MUST keep the
  // picker — the early return used to swallow the packs section entirely in that state.
  // (A persisted-but-removed pack id also keeps the picker: the user must be able to clear it.)
  if (indexed.length === 0 && fileCount === 0 && packs.length === 0 && removedPackIds.length === 0) {
    return (
      <button type="button" className="footer-menu-btn" disabled={disabled} onClick={onAddDocuments}>
        <Icon name="file" className="footer-menu-icon" /> {t('chat.scope.none')}
      </button>
    )
  }

  function emit(
    nextColl: string[],
    nextDocs: string[],
    nextPacks: string[] = packIds,
    nextDocumentsOff: boolean = documentsOff
  ): void {
    // packIds ride every emit (spread-preservation): a doc/project toggle must never
    // silently drop the chat's selected knowledge packs. documentsOff rides the same way,
    // with ONE rule (#301 P4, M10): an emit never carries the flag together with a document
    // source, so ticking a collection or adding a specific document turns documents back on
    // by construction — no separate handler can forget it.
    const off = nextDocumentsOff && nextColl.length === 0 && nextDocs.length === 0
    onChangeScope({
      collectionIds: nextColl,
      documentIds: nextDocs,
      ...(nextPacks.length > 0 ? { packIds: nextPacks } : {}),
      ...(off ? { documentsOff: true as const } : {})
    })
  }

  function toggleCollection(id: string): void {
    emit(collIds.includes(id) ? collIds.filter((x) => x !== id) : [...collIds, id], docIds)
  }

  function togglePack(id: string): void {
    // The 13th tick is REFUSED, not silently accepted and trimmed later (#301 P4, finding M8,
    // ruling §7): the cap belongs to the chat's selection, so the popover is where the user
    // learns about it. Unticking is always allowed — that is how you get back under the cap.
    if (!packIds.includes(id) && packIds.length >= MAX_SELECTED_PACKS) return
    emit(collIds, docIds, packIds.includes(id) ? packIds.filter((x) => x !== id) : [...packIds, id])
  }

  /** The Documents toggle: unticking clears the document sources and sets the flag; ticking
   *  emits the legacy empty scope (= all documents), keeping the ticked packs either way. */
  function toggleDocuments(): void {
    emit([], [], packIds, !documentsOff)
  }

  function title(id: string): string {
    return docs.find((d) => d.id === id)?.title ?? t('chat.scope.removedDoc')
  }

  // The active retrieval scope, framed as an always-visible "Answering from: {source}" chip (D71).
  // The chip IS the popover trigger, so it stays visible before asking and one click opens the picker.
  const composedEmpty = collIds.length === 0 && docIds.length === 0 && packIds.length === 0
  const source = ((): string => {
    // Documents off (#301 P4, M10) decides the phrase first: whatever else the stored scope
    // still carries, main-side `resolveScope` answers from the ticked packs plus the chat's
    // attachments and nothing else. With no pack ticked the attachments ARE the scope, so name
    // them (the #26 single-file phrasing) and append the honest tail; with neither, the chip
    // says there is no source and how to get one back.
    if (documentsOff) {
      if (packIds.length === 0 && fileCount > 0) {
        const names = [...attachments.map((d) => d.title), ...pendingAttachmentNames]
        const named = names.length === 1 ? names[0] : tCount('chat.scope.filesInChat', fileCount)
        return `${named} · ${t('chat.scope.documentsOffSuffix')}`
      }
      return (
        scopeSources(scope, collections, t, tCount, packs) ?? t('chat.scope.documentsOffNoPacks')
      )
    }
    // Empty composed scope + attachments: main-side `resolveScope` unions the chat attachments in, so
    // retrieval is scoped to THOSE files — never the whole corpus. Name the single file, else count them
    // (this is the single-document workflow #26 targets, so the file name is the honest answer).
    if (composedEmpty && fileCount > 0) {
      const names = [...attachments.map((d) => d.title), ...pendingAttachmentNames]
      return names.length === 1 ? names[0] : tCount('chat.scope.filesInChat', fileCount)
    }
    // A single specific document → name it (the #26 "ask exactly this one document" case).
    if (collIds.length === 0 && docIds.length === 1 && packIds.length === 0) return title(docIds[0])
    // Whole library: the explicit "All documents" (empty) OR the Library-only default — both answer
    // from everything, so state the corpus size instead of the bare word "Library".
    const pickedTypes = collIds.map((id) => collections.find((c) => c.id === id)?.type)
    if (
      docIds.length === 0 &&
      packIds.length === 0 &&
      (composedEmpty || pickedTypes.every((tp) => tp === 'library'))
    ) {
      return tCount('chat.scope.wholeLibrary', indexed.length)
    }
    // Projects / multi-doc / packs / mixed → the composed sources phrase (single-sourced with the footer).
    return (
      scopeSources(scope, collections, t, tCount, packs) ?? tCount('chat.scope.wholeLibrary', indexed.length)
    )
  })()
  const label = t('chat.scope.answeringFrom', { source })
  // Chat attachments (live + pending) are always included; surfaced as a quiet count alongside the
  // composed sources (plan §13.1), never as removable selection chips. Not appended in the
  // empty-composed-scope case above, where the file(s) already ARE the named scope (no double count).
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
          {/* Documents toggle (#301 P4, finding M10, ruling D4): the explicit way to answer from
              knowledge packs WITHOUT the document corpus. Rendered only where the packs section
              renders — a chat with no registered pack has nothing to turn documents off FOR, and
              the popover stays byte-identical there. Unticking clears the document sources and
              sets the flag; ticking it (or any collection / specific document) turns documents
              back on. Chat attachments stay in retrieval either way — the hint says so. */}
          {packs.length > 0 && (
            <div className="scope-sources scope-documents-toggle">
              <label className="scope-source-row">
                <input
                  type="checkbox"
                  checked={!documentsOff}
                  disabled={disabled}
                  onChange={() => toggleDocuments()}
                />
                <span className="scope-source-name">{t('chat.scope.documentsToggle')}</span>
                <span className="scope-source-hint">{t('chat.scope.documentsToggleHint')}</span>
              </label>
            </div>
          )}
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

          {/* Knowledge packs (ZIM wave): offline reference archives as additional sources.
              D6 (#301 P4, ruling §7; plan §9.21 (e)8) — NOTHING IS HIDDEN and nothing the user
              ticked becomes un-untickable:
                • a SELECTED pack that is unavailable / disabled / over the cap keeps its box
                  ENABLED (it must be possible to clear a choice that is doing nothing) and shows
                  the reason beside it;
                • an UNSELECTED ineligible pack stays unticked-and-disabled with the same hint;
                • at MAX_SELECTED_PACKS every unselected tickable pack is disabled and the cap
                  line shows once, so the refusal is visible rather than a dead click;
                • a persisted id with NO matching pack row still renders — as a ticked "Removed
                  pack" row the user can untick — instead of vanishing from the picker while
                  staying in the stored scope. */}
          {(packs.length > 0 || removedPackIds.length > 0) && (
            <div className="scope-sources scope-packs">
              <p className="popover-line">{t('chat.scope.packsTitle')}</p>
              {atPackLimit && (
                <p className="popover-line hint scope-pack-limit">
                  {tCount('chat.scope.packLimit', MAX_SELECTED_PACKS)}
                </p>
              )}
              {packs.map((k) => {
                const selected = packIds.includes(k.id)
                // Why this pack cannot take part in an ask, or null when it can. Order mirrors
                // the arm's classification: removal/disabled before availability.
                const ineligible = !k.enabled
                  ? t('chat.scope.packDisabled')
                  : !k.available
                    ? t('chat.scope.packUnavailable')
                    : null
                return (
                  <label className="scope-source-row" key={k.id}>
                    <input
                      type="checkbox"
                      checked={selected}
                      // A selected pack is ALWAYS deselectable (D6). An unselected one is
                      // tickable only when it is eligible and the cap has room.
                      disabled={disabled || (!selected && (ineligible != null || atPackLimit))}
                      onChange={() => togglePack(k.id)}
                    />
                    <span className="scope-source-name">{k.title}</span>
                    {ineligible && <span className="scope-source-hint">{ineligible}</span>}
                  </label>
                )
              })}
              {removedPackIds.map((id) => (
                <label className="scope-source-row" key={id}>
                  <input
                    type="checkbox"
                    checked
                    disabled={disabled}
                    onChange={() => togglePack(id)}
                  />
                  <span className="scope-source-name">{t('chat.scope.packRemoved')}</span>
                </label>
              ))}
            </div>
          )}

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

          {(collIds.length > 0 || docIds.length > 0 || packIds.length > 0 || documentsOff) && (
            <Button
              size="sm"
              className="popover-reset"
              disabled={disabled}
              // The reset clears documentsOff too (#301 P4, M10): an explicit reset is the ONE
              // way back to all-documents once the last pack and attachment are gone.
              onClick={() => emit([], [], [], false)}
            >
              {/* full-audit 2026-07-11 CODE-31 (owner decision: relabel truthfully — the emitted
                  scope stays the empty explicit one). In a chat WITH attachments, main-side
                  resolveScope reads that empty scope as "no collections" + the unioned attachments
                  (D71), i.e. JUST the attached files — the opposite of "All documents". The label
                  keys on the same `fileCount` the "Answering from:" chip uses, so the pair stays
                  coherent after the tap. */}
              {fileCount > 0 ? t('chat.scope.attachmentsOnlyTap') : t('chat.scope.allTap')}
            </Button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
