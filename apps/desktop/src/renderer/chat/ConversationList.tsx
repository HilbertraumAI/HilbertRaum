import { memo, useCallback, useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  type Collection,
  type Conversation,
  type ConversationSearchResult
} from '@shared/types'
import { Button, ConfirmDialog, Icon } from '../components'
import { useT, type I18n } from '../i18n'
import { localizeServerCopy } from '../lib/displayMap'
import type { MessageKey } from '@shared/i18n'

// Conversation list (guidelines §3): the collapsible second column.
// Date-grouped by last activity; row actions live behind a hover/focus "⋯" menu
// (Radix DropdownMenu, also opened by right-click) — never permanent ✕ buttons.
// Delete confirms through ConfirmDialog (never browser confirm()).
// A search box on top — typing switches the column to full-text results
// across all conversations (matched terms highlighted); picking one opens it.

/** Debounce between keystroke and the search IPC round-trip. */
const SEARCH_DEBOUNCE_MS = 150

/** Snippets shown per matching conversation (more hits exist; the best ones lead). */
const SNIPPETS_PER_RESULT = 2

/**
 * Split a snippet on the SEARCH_MARK_* markers from FTS5's snippet() into plain and
 * matched parts, so matches render as <mark> without ever parsing HTML. Pure — tested
 * directly. Markers are control characters and cannot occur in real message text.
 */
export function splitSnippet(snippet: string): Array<{ text: string; match: boolean }> {
  const parts: Array<{ text: string; match: boolean }> = []
  let rest = snippet
  while (rest.length > 0) {
    const start = rest.indexOf(SEARCH_MARK_START)
    if (start === -1) {
      parts.push({ text: rest, match: false })
      break
    }
    if (start > 0) parts.push({ text: rest.slice(0, start), match: false })
    const end = rest.indexOf(SEARCH_MARK_END, start + 1)
    if (end === -1) {
      // Unterminated marker (defensive) — treat the tail as plain text.
      parts.push({ text: rest.slice(start + 1), match: false })
      break
    }
    parts.push({ text: rest.slice(start + 1, end), match: true })
    rest = rest.slice(end + 1)
  }
  return parts.filter((p) => p.text.length > 0)
}

export interface ConversationGroup {
  /** Resolved at render via t() — label maps keep their structure (i18n record §5). */
  labelKey: MessageKey
  conversations: Conversation[]
}

/**
 * Group conversations by recency of `updatedAt` (the backend already sorts newest-first;
 * order within groups is preserved). Unparseable dates land in "Earlier".
 */
export function groupConversations(conversations: Conversation[], now: Date = new Date()): ConversationGroup[] {
  const dayMs = 24 * 60 * 60 * 1000
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const groups: ConversationGroup[] = [
    { labelKey: 'chat.group.today', conversations: [] },
    { labelKey: 'chat.group.yesterday', conversations: [] },
    { labelKey: 'chat.group.last7days', conversations: [] },
    { labelKey: 'chat.group.earlier', conversations: [] }
  ]
  for (const c of conversations) {
    const t = Date.parse(c.updatedAt)
    if (Number.isNaN(t)) groups[3].conversations.push(c)
    else if (t >= todayStart) groups[0].conversations.push(c)
    else if (t >= todayStart - dayMs) groups[1].conversations.push(c)
    else if (t >= todayStart - 7 * dayMs) groups[2].conversations.push(c)
    else groups[3].conversations.push(c)
  }
  return groups.filter((g) => g.conversations.length > 0)
}

/**
 * A creation-anchor project section (document-organization plan §13.4/N8): conversations
 * grouped by their `collection_id` anchor. A chat whose composite scope spans several
 * sources still groups under its single anchor; unanchored/dangling chats fall into the
 * "Other / Library" section. Exported for tests.
 */
export interface ProjectSection {
  /** The anchor project, or null for the "Other / Library" catch-all. */
  project: Collection | null
  conversations: Conversation[]
}

/**
 * Group conversations by their creation-anchor project (plan §13.4). A `collection_id` that
 * references a missing or archived project (or no anchor at all) lands in "Other / Library".
 * Returns null when NO conversation is anchored to a live project — the caller then falls
 * back to plain date grouping (the common, project-free case; keeps the existing UX intact).
 */
export function groupByProject(
  conversations: Conversation[],
  collections: Collection[]
): ProjectSection[] | null {
  const liveProjects = new Map(
    collections.filter((c) => c.type === 'project' && c.archivedAt == null).map((c) => [c.id, c])
  )
  const anchored = conversations.some((c) => c.collectionId != null && liveProjects.has(c.collectionId))
  if (!anchored) return null
  const byProject = new Map<string, Conversation[]>()
  const other: Conversation[] = []
  for (const c of conversations) {
    if (c.collectionId != null && liveProjects.has(c.collectionId)) {
      const list = byProject.get(c.collectionId) ?? []
      list.push(c)
      byProject.set(c.collectionId, list)
    } else {
      other.push(c)
    }
  }
  const sections: ProjectSection[] = [...byProject.entries()]
    .map(([id, convs]) => ({ project: liveProjects.get(id)!, conversations: convs }))
    .sort((a, b) => a.project!.name.localeCompare(b.project!.name))
  if (other.length > 0) sections.push({ project: null, conversations: other })
  return sections
}

interface Props {
  conversations: Conversation[]
  activeId: string | null
  /** Mid-stream the list locks: selecting/deleting other conversations corrupts views. */
  streaming: boolean
  /** Labels the "+ New …" button for the composer's current mode. */
  mode: 'chat' | 'documents'
  /** Projects/built-ins — drives the creation-anchor project sections (plan §13.4). */
  collections?: Collection[]
  onSelect: (c: Conversation) => void
  onNew: () => void
  /** Called after the user confirms deletion. */
  onDelete: (c: Conversation) => void
  onCollapse: () => void
}

// Memoized (perf audit FE-3): ChatScreen re-renders on every keystroke + streaming flush. With
// stable props from the parent (useCallback'd onSelect/onNew/onDelete/onCollapse), the list — and
// its groupByProject/groupConversations passes — is skipped on a keystroke.
export const ConversationList = memo(function ConversationList({
  conversations,
  activeId,
  streaming,
  mode,
  collections = [],
  onSelect,
  onNew,
  onDelete,
  onCollapse
}: Props): JSX.Element {
  const { t, tCount } = useT()
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null)
  // D-2 (EP-1 plan §7.6, spec §25.4): how many evidence reviews the delete would cascade
  // away. null = not fetched / none pending; 'unknown' = the count could not be read —
  // then the confirm still warns generically (never silent about a cascade).
  const [pendingDeleteReviews, setPendingDeleteReviews] = useState<number | 'unknown' | null>(null)
  useEffect(() => {
    if (!pendingDelete) {
      setPendingDeleteReviews(null)
      return
    }
    let cancelled = false
    // Promise.resolve-wrapped: an older preload bridge without the channel (or a partial
    // test stub) yields a non-number — then the confirm warns GENERICALLY rather than
    // guessing 0 (never silent about a cascade). A number is the real count.
    Promise.resolve(
      window.api.countEvidenceReviewsForConversation?.(pendingDelete.id)
    )
      .then((n) => {
        if (!cancelled) setPendingDeleteReviews(typeof n === 'number' ? n : 'unknown')
      })
      .catch(() => {
        if (!cancelled) setPendingDeleteReviews('unknown')
      })
    return () => {
      cancelled = true
    }
  }, [pendingDelete])
  // One controlled menu so right-click (context menu) can open the same "⋯" menu.
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  // Search: a non-empty query swaps the column to results. `results` is null
  // while a search is still in flight (→ quiet, no flicker), [] when nothing matched.
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ConversationSearchResult[] | null>(null)

  const searching = query.trim().length > 0

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      window.api
        .searchConversations(q)
        .then((r) => {
          if (!cancelled) setResults(r)
        })
        .catch(() => {
          if (!cancelled) setResults([])
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  function openResult(r: ConversationSearchResult): void {
    const conv = conversations.find((c) => c.id === r.conversationId)
    if (!conv) return
    onSelect(conv)
    setQuery('')
  }

  // Stable row callbacks so a ConvRow's React.memo holds when an UNRELATED row's menu opens
  // (menuOpenId is local state): opening one ⋯ menu no longer re-renders every row (FE-4).
  const handleMenuOpenChange = useCallback((id: string, open: boolean): void => {
    setMenuOpenId(open ? id : null)
  }, [])
  const handleRequestDelete = useCallback((c: Conversation): void => setPendingDelete(c), [])

  // One conversation row (title + doc-meta + the ⋯ menu). Shared by date and project groups.
  const renderRow = (c: Conversation): JSX.Element => (
    <ConvRow
      key={c.id}
      c={c}
      active={c.id === activeId}
      streaming={streaming}
      menuOpen={menuOpenId === c.id}
      onMenuOpenChange={handleMenuOpenChange}
      onSelect={onSelect}
      onRequestDelete={handleRequestDelete}
      t={t}
    />
  )

  // Date-grouped rows (Today / Yesterday / …) — the existing grouping, reused inside each
  // project section when project grouping is active.
  const renderDateGroups = (convs: Conversation[]): JSX.Element[] =>
    groupConversations(convs).map((group) => (
      <div key={group.labelKey} className="chat-conv-group" role="group" aria-label={t(group.labelKey)}>
        <div className="chat-conv-group-label">{t(group.labelKey)}</div>
        {group.conversations.map(renderRow)}
      </div>
    ))

  // Project sections when any conversation is anchored to a live project (plan §13.4/N8),
  // else null ⇒ plain date grouping (the common project-free case, unchanged UX).
  const projectSections = groupByProject(conversations, collections)

  return (
    <aside className="chat-sidebar" aria-label={t('chat.list.aria')}>
      <div className="chat-sidebar-head">
        <span className="chat-sidebar-title">{t('chat.list.title')}</span>
        <button
          type="button"
          className="chat-sidebar-collapse"
          aria-label={t('chat.list.hide')}
          title={t('chat.list.hide')}
          onClick={onCollapse}
        >
          «
        </button>
      </div>
      <Button size="sm" variant="primary" className="chat-new" disabled={streaming} onClick={onNew}>
        {mode === 'documents' ? t('chat.list.newDocQa') : t('chat.list.newChat')}
      </Button>
      <input
        type="search"
        className="chat-search-input"
        placeholder={t('chat.search.placeholder')}
        aria-label={t('chat.search.aria')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setQuery('')
        }}
      />
      {searching && (
        <div
          className="chat-conv-list"
          role="region"
          aria-label={t('chat.search.resultsAria')}
          aria-live="polite"
        >
          {/* Contextual header: a calm "Results for 'x'" label so it's obvious the column
              is showing search hits, not the normal grouped list. The sr-only count rides
              alongside so a screen reader still hears "3 results" (audit L14). */}
          {results != null && results.length > 0 && (
            <div className="chat-search-head">
              <span className="chat-search-label">
                {t('chat.search.resultsFor', { query: query.trim() })}
              </span>
              <span className="sr-only">{tCount('chat.search.count', results.length)}</span>
            </div>
          )}
          {results != null && results.length === 0 && (
            <p className="chat-search-empty">{t('chat.search.noMatches')}</p>
          )}
          {(results ?? []).map((r) => (
            <button
              key={r.conversationId}
              className="chat-search-result"
              disabled={streaming && r.conversationId !== activeId}
              onClick={() => openResult(r)}
              title={localizeServerCopy(t, r.conversationTitle)}
            >
              <span className="chat-search-result-title">{localizeServerCopy(t, r.conversationTitle)}</span>
              {r.hits.slice(0, SNIPPETS_PER_RESULT).map((h) => (
                <span key={h.messageId} className="chat-search-snippet">
                  {splitSnippet(h.snippet).map((part, i) =>
                    part.match ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>
                  )}
                </span>
              ))}
            </button>
          ))}
        </div>
      )}
      {!searching && (
        <div className="chat-conv-list">
          {conversations.length === 0 && <p className="hint">{t('chat.list.empty')}</p>}
          {projectSections
            ? projectSections.map((section) => (
                <div
                  key={section.project?.id ?? '__other__'}
                  className="chat-proj-group"
                  role="group"
                  aria-label={section.project ? section.project.name : t('chat.list.otherGroup')}
                >
                  <div className="chat-proj-group-label">
                    {section.project ? section.project.name : t('chat.list.otherGroup')}
                  </div>
                  {renderDateGroups(section.conversations)}
                </div>
              ))
            : renderDateGroups(conversations)}
        </div>
      )}
      <ConfirmDialog
        open={pendingDelete != null}
        title={t('chat.delete.title')}
        confirmLabel={t('chat.delete.confirm')}
        t={t}
        onConfirm={() => {
          if (pendingDelete) onDelete(pendingDelete)
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      >
        <p>{t('chat.delete.body', { title: localizeServerCopy(t, pendingDelete?.title ?? '') })}</p>
        {/* D-2 (spec §25.4): deletion cascades attached evidence reviews — say so, with the
            count when known; an unreadable count still warns (the honest fallback). */}
        {pendingDeleteReviews === 'unknown' && (
          <p>{t('review.deleteWithConversation.unknown')}</p>
        )}
        {typeof pendingDeleteReviews === 'number' && pendingDeleteReviews > 0 && (
          <p>{tCount('review.deleteWithConversation', pendingDeleteReviews)}</p>
        )}
      </ConfirmDialog>
    </aside>
  )
})

/**
 * One conversation row (title + doc-meta + the ⋯ menu), memoized (perf audit FE-4). With stable
 * callbacks from the parent, a row re-renders only when ITS own props change — so opening one
 * row's overflow menu (which flips the parent's `menuOpenId`) no longer re-renders every row.
 */
const ConvRow = memo(function ConvRow({
  c,
  active,
  streaming,
  menuOpen,
  onMenuOpenChange,
  onSelect,
  onRequestDelete,
  t
}: {
  c: Conversation
  active: boolean
  streaming: boolean
  menuOpen: boolean
  onMenuOpenChange: (id: string, open: boolean) => void
  onSelect: (c: Conversation) => void
  onRequestDelete: (c: Conversation) => void
  t: I18n['t']
}): JSX.Element {
  return (
    <div
      className={`chat-conv-row ${active ? 'active' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault()
        if (!streaming) onMenuOpenChange(c.id, true)
      }}
    >
      <button
        className={`chat-conv ${active ? 'active' : ''}`}
        aria-current={active ? 'true' : undefined}
        disabled={streaming && !active}
        onClick={() => onSelect(c)}
        title={localizeServerCopy(t, c.title)}
      >
        {/* Titles are user data, but the persisted DEFAULT title is canonical English
            (D-L4) — the display map translates it, all else passes. */}
        <span className="chat-conv-title">{localizeServerCopy(t, c.title)}</span>
        {/* Quiet metadata line: a small document glyph + "Documents" for a document Q&A
            thread (replacing the loud DOC badge), else nothing. Never color-only
            (WCAG 1.4.1) — the glyph pairs with the word. */}
        {c.mode === 'documents' && (
          <span className="chat-conv-meta">
            <Icon name="file" className="chat-conv-meta-icon" /> {t('chat.list.docMeta')}
          </span>
        )}
      </button>
      <DropdownMenu.Root open={menuOpen} onOpenChange={(open) => onMenuOpenChange(c.id, open)}>
        <DropdownMenu.Trigger asChild>
          <button
            className="chat-conv-menu-btn"
            disabled={streaming}
            aria-label={t('chat.list.rowOptionsAria', { title: localizeServerCopy(t, c.title) })}
            title={t('chat.convOptions')}
          >
            ⋯
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
            <DropdownMenu.Item className="menu-item danger" onSelect={() => onRequestDelete(c)}>
              {t('chat.delete.menuItem')}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  )
})
