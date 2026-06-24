// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { I18nProvider } from '../../src/renderer/i18n'
import { ConversationList, groupByProject, CONV_LIST_VIEW_KEY } from '../../src/renderer/chat/ConversationList'
import type { Collection, Conversation } from '../../src/shared/types'

// Conversation folders (plan §13.4): groupByProject now surfaces EVERY live project as a section —
// including empty ones — and activates whenever a project exists (not only when a chat is anchored),
// so a just-created folder is visible and droppable into. Date grouping stays the fallback when there
// are no projects. The pure grouping is the breakable part; we test it directly + one render smoke.

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function conv(id: string, collectionId: string | null = null): Conversation {
  return {
    id,
    title: `Chat ${id}`,
    createdAt: '2026-06-24T00:00:00Z',
    updatedAt: '2026-06-24T00:00:00Z',
    modelId: null,
    mode: 'chat',
    scopeDocumentIds: null,
    collectionId,
    scope: null
  }
}

function project(id: string, name: string, archived = false): Collection {
  return {
    id,
    name,
    type: 'project',
    description: null,
    builtin: false,
    color: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    archivedAt: archived ? '2026-02-01T00:00:00Z' : null,
    parentId: null
  }
}

describe('groupByProject (conversation folders)', () => {
  it('returns null when there are no live projects (→ date grouping)', () => {
    expect(groupByProject([conv('a')], [])).toBeNull()
  })

  it('surfaces every live project as a section, including empty ones', () => {
    const sections = groupByProject([conv('a', 'p1')], [project('p1', 'Alpha'), project('p2', 'Beta')])
    expect(sections).not.toBeNull()
    const byName = new Map(sections!.map((s) => [s.project?.name ?? '__other__', s]))
    expect(byName.get('Alpha')!.conversations.map((c) => c.id)).toEqual(['a'])
    expect(byName.get('Beta')!.conversations).toEqual([]) // empty folder still shown
  })

  it('activates with zero anchored conversations (so new folders are droppable)', () => {
    const sections = groupByProject([conv('a'), conv('b')], [project('p1', 'Alpha')])
    expect(sections).not.toBeNull()
    expect(sections!.find((s) => s.project?.id === 'p1')!.conversations).toEqual([])
    // Unanchored chats fall into the "Other / Library" catch-all.
    expect(sections!.find((s) => s.project === null)!.conversations.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('routes archived/dangling anchors to Other, not a missing section', () => {
    const sections = groupByProject(
      [conv('a', 'archived'), conv('b', 'gone')],
      [project('archived', 'Old', true), project('p1', 'Alpha')]
    )
    const other = sections!.find((s) => s.project === null)!
    expect(other.conversations.map((c) => c.id).sort()).toEqual(['a', 'b'])
  })
})

function renderList(): void {
  render(
    <I18nProvider>
      <ConversationList
        conversations={[conv('a', 'p1')]}
        activeId={null}
        streaming={false}
        mode="chat"
        collections={[project('p1', 'Alpha'), project('p2', 'Beta')]}
        onSelect={() => {}}
        onNew={() => {}}
        onDelete={() => {}}
        onMove={() => {}}
        onNewFolder={() => {}}
        onNewInFolder={() => {}}
        onOpenFolderFiles={() => {}}
        onCollapse={() => {}}
      />
    </I18nProvider>
  )
}

describe('ConversationList — Recent vs Folders views', () => {
  it('Recent (default) tags each row with its folder; no project sections / empty folders', () => {
    renderList() // localStorage cleared by afterEach → defaults to 'recent'
    expect(screen.getByText('Alpha')).toBeInTheDocument() // the anchored row's folder tag
    expect(screen.queryByText('Beta')).not.toBeInTheDocument() // empty folder has no row → no tag
  })

  it('Folders view shows a folder card for every live project, including empty ones', () => {
    localStorage.setItem(CONV_LIST_VIEW_KEY, 'byProject')
    renderList()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument() // empty folder still gets a card
  })

  it('Folders view drills into a folder card to reveal its conversations + a Back control', () => {
    localStorage.setItem(CONV_LIST_VIEW_KEY, 'byProject')
    renderList()
    // The overview shows cards, not conversation rows yet.
    expect(screen.queryByText('Chat a')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Alpha'))
    // Drilled in: the folder's conversation row + a back-to-folders control appear.
    expect(screen.getByText('Chat a')).toBeInTheDocument()
    expect(screen.getByLabelText('Back to folders')).toBeInTheDocument()
  })
})
