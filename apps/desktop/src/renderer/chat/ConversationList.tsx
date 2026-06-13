import { useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  type Conversation,
  type ConversationSearchResult
} from '@shared/types'
import { Button, ConfirmDialog } from '../components'
import { useT } from '../i18n'
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
  /** Resolved at render via t() — label maps keep their structure (i18n-plan §5). */
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

interface Props {
  conversations: Conversation[]
  activeId: string | null
  /** Mid-stream the list locks: selecting/deleting other conversations corrupts views. */
  streaming: boolean
  /** Labels the "+ New …" button for the composer's current mode. */
  mode: 'chat' | 'documents'
  onSelect: (c: Conversation) => void
  onNew: () => void
  /** Called after the user confirms deletion. */
  onDelete: (c: Conversation) => void
  onCollapse: () => void
}

export function ConversationList({
  conversations,
  activeId,
  streaming,
  mode,
  onSelect,
  onNew,
  onDelete,
  onCollapse
}: Props): JSX.Element {
  const { t } = useT()
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null)
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

  return (
    <aside className="chat-sidebar">
      <div className="chat-sidebar-head">
        <Button size="sm" variant="primary" className="chat-new" disabled={streaming} onClick={onNew}>
          {mode === 'documents' ? t('chat.list.newDocQa') : t('chat.list.newChat')}
        </Button>
        <Button size="sm" variant="ghost" aria-label={t('chat.list.hide')} title={t('chat.list.hide')} onClick={onCollapse}>
          «
        </Button>
      </div>
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
        <div className="chat-conv-list" role="region" aria-label={t('chat.search.resultsAria')}>
          {results != null && results.length === 0 && (
            <p className="hint">{t('chat.search.noMatches')}</p>
          )}
          {(results ?? []).map((r) => (
            <button
              key={r.conversationId}
              className="chat-search-result"
              disabled={streaming && r.conversationId !== activeId}
              onClick={() => openResult(r)}
              title={r.conversationTitle}
            >
              <span className="chat-search-result-title">{r.conversationTitle}</span>
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
          {groupConversations(conversations).map((group) => (
            <div
              key={group.labelKey}
              className="chat-conv-group"
              role="group"
              aria-label={t(group.labelKey)}
            >
              <div className="chat-conv-group-label">{t(group.labelKey)}</div>
              {group.conversations.map((c) => (
                <div
                  key={c.id}
                  className={`chat-conv-row ${c.id === activeId ? 'active' : ''}`}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    if (!streaming) setMenuOpenId(c.id)
                  }}
                >
                  <button
                    className={`chat-conv ${c.id === activeId ? 'active' : ''}`}
                    disabled={streaming && c.id !== activeId}
                    onClick={() => onSelect(c)}
                    title={c.title}
                  >
                    {c.mode === 'documents' && (
                      <span className="chat-conv-badge">{t('chat.list.docBadge')}</span>
                    )}
                    {c.title}
                  </button>
                  <DropdownMenu.Root
                    open={menuOpenId === c.id}
                    onOpenChange={(open) => setMenuOpenId(open ? c.id : null)}
                  >
                    <DropdownMenu.Trigger asChild>
                      <button
                        className="chat-conv-menu-btn"
                        disabled={streaming}
                        aria-label={t('chat.list.rowOptionsAria', { title: c.title })}
                        title={t('chat.convOptions')}
                      >
                        ⋯
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
                        <DropdownMenu.Item
                          className="menu-item danger"
                          onSelect={() => setPendingDelete(c)}
                        >
                          {t('chat.delete.menuItem')}
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
              ))}
            </div>
          ))}
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
        <p>{t('chat.delete.body', { title: pendingDelete?.title ?? '' })}</p>
      </ConfirmDialog>
    </aside>
  )
}
