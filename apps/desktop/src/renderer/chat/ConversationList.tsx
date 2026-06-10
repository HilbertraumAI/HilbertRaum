import { useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { Conversation } from '@shared/types'
import { Button, ConfirmDialog } from '../components'

// Conversation list (Phase 25, guidelines §3): the collapsible second column.
// Date-grouped by last activity; row actions live behind a hover/focus "⋯" menu
// (Radix DropdownMenu, also opened by right-click) — never permanent ✕ buttons.
// Delete confirms through ConfirmDialog (the last browser confirm() is gone).

export interface ConversationGroup {
  label: string
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
    { label: 'Today', conversations: [] },
    { label: 'Yesterday', conversations: [] },
    { label: 'Last 7 days', conversations: [] },
    { label: 'Earlier', conversations: [] }
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
  /** Mid-stream the list locks (M2): selecting/deleting other conversations corrupts views. */
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
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null)
  // One controlled menu so right-click (context menu) can open the same "⋯" menu.
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)

  return (
    <aside className="chat-sidebar">
      <div className="chat-sidebar-head">
        <Button size="sm" variant="primary" className="chat-new" disabled={streaming} onClick={onNew}>
          + New {mode === 'documents' ? 'document Q&A' : 'chat'}
        </Button>
        <Button size="sm" variant="ghost" aria-label="Hide conversation list" title="Hide conversation list" onClick={onCollapse}>
          «
        </Button>
      </div>
      <div className="chat-conv-list">
        {conversations.length === 0 && <p className="hint">No conversations yet.</p>}
        {groupConversations(conversations).map((group) => (
          <div key={group.label} className="chat-conv-group" role="group" aria-label={group.label}>
            <div className="chat-conv-group-label">{group.label}</div>
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
                  {c.mode === 'documents' && <span className="chat-conv-badge">DOC</span>}
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
                      aria-label={`Options for conversation "${c.title}"`}
                      title="Conversation options"
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
                        Delete conversation
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            ))}
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete this conversation?"
        confirmLabel="Delete"
        onConfirm={() => {
          if (pendingDelete) onDelete(pendingDelete)
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      >
        <p>
          “{pendingDelete?.title}” and its messages will be permanently removed from this drive.
        </p>
      </ConfirmDialog>
    </aside>
  )
}
