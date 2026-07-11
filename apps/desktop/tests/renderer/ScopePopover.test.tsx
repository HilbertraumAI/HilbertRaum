// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScopePopover } from '../../src/renderer/chat/ScopePopover'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { t } from '../../src/shared/i18n'
import type { Collection, DocumentInfo } from '../../src/shared/types'

function indexedDoc(over: Partial<DocumentInfo> = {}): DocumentInfo {
  return {
    id: 'd1',
    title: 'contract.pdf',
    originalPath: null,
    mimeType: 'application/pdf',
    sizeBytes: 1,
    status: 'indexed',
    errorMessage: null,
    chunkCount: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over
  } as DocumentInfo
}

// Audit FE-6 — the pending-attachment chips are keyed by name+index so each chip's key is unique
// (two cross-folder files can share a base name) AND content-aware. The teeth test below pins the
// uniqueness: a name-ONLY key (the regression a literal reading of FE-6 invites) collides on
// duplicate base names and trips React's duplicate-key warning.

function libraryCollection(): Collection {
  return {
    id: 'lib',
    name: 'Library',
    type: 'library',
    description: null,
    builtin: true,
    color: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    archivedAt: null
  } as Collection
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('ScopePopover — pending attachment chips (FE-6)', () => {
  it('renders a chip per pending attachment', async () => {
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[]}
          collections={[]}
          scope={null}
          onChangeScope={() => {}}
          pendingAttachmentNames={['a.pdf', 'b.pdf']}
        />
      </I18nProvider>
    )
    // The chips live in the popover's portal content — open it first.
    await user.click(screen.getByRole('button'))
    expect(await screen.findByText('Processing a.pdf…')).toBeInTheDocument()
    expect(screen.getByText('Processing b.pdf…')).toBeInTheDocument()
  })

  it('keeps chip keys unique for duplicate base names (no React duplicate-key warning)', async () => {
    // Two cross-folder files (C:\a\report.pdf, D:\b\report.pdf) reduce to the same base name. A
    // name-only key would emit "Encountered two children with the same key, `pending-report.pdf`".
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[]}
          collections={[]}
          scope={null}
          onChangeScope={() => {}}
          pendingAttachmentNames={['report.pdf', 'report.pdf']}
        />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button'))
    expect(await screen.findAllByText('Processing report.pdf…')).toHaveLength(2)
    const sawKeyWarning = errSpy.mock.calls.some((c) =>
      c.some((arg) => typeof arg === 'string' && arg.includes('same key'))
    )
    expect(sawKeyWarning).toBe(false)
    errSpy.mockRestore()
  })
})

// full-audit 2026-07-11 CODE-31 (owner decision: relabel truthfully; emitted scope unchanged).
// In a chat WITH attachments the reset's empty explicit scope means "just the attached files"
// (main-side resolveScope unions them in — D71), the OPPOSITE of "All documents".
describe('ScopePopover — attach-chat reset label (CODE-31)', () => {
  it('labels the reset truthfully in an attach-chat and still emits the empty explicit scope', async () => {
    const user = userEvent.setup()
    const onChangeScope = vi.fn()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[indexedDoc({ id: 'a' })]}
          collections={[libraryCollection()]}
          scope={{ collectionIds: ['lib'], documentIds: [] }}
          onChangeScope={onChangeScope}
          attachments={[indexedDoc({ id: 'att1', title: 'statement.pdf' })]}
        />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button')) // open the picker
    // TEETH: pre-fix the reset read "All documents" while emitting the attachments-only scope.
    const reset = await screen.findByRole('button', {
      name: t('en', 'chat.scope.attachmentsOnlyTap')
    })
    expect(
      screen.queryByRole('button', { name: t('en', 'chat.scope.allTap') })
    ).not.toBeInTheDocument()
    // The emitted scope is UNCHANGED by the relabel (the owner-decided half of CODE-31): an
    // empty explicit scope, which resolveScope narrows to the chat's attachments.
    await user.click(reset)
    expect(onChangeScope).toHaveBeenCalledWith({ collectionIds: [], documentIds: [] })
  })

  it('keeps the "All documents" label when the chat has no attachments', async () => {
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[indexedDoc({ id: 'a' })]}
          collections={[libraryCollection()]}
          scope={{ collectionIds: ['lib'], documentIds: [] }}
          onChangeScope={() => {}}
        />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button'))
    expect(
      await screen.findByRole('button', { name: t('en', 'chat.scope.allTap') })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: t('en', 'chat.scope.attachmentsOnlyTap') })
    ).not.toBeInTheDocument()
  })
})

describe('ScopePopover — "Answering from:" scope chip (#26, D71)', () => {
  // The always-visible chip near the composer reframes the scope popover's trigger so the active
  // retrieval scope is legible BEFORE asking. It IS the popover trigger — one click opens the picker.
  it('names the single attached file when the composed scope is empty (scoped to that file, NOT the whole corpus)', () => {
    render(
      <I18nProvider>
        <ScopePopover
          docs={[]}
          collections={[]}
          scope={{ collectionIds: [], documentIds: [] }}
          onChangeScope={() => {}}
          pendingAttachmentNames={['statement.pdf']}
        />
      </I18nProvider>
    )
    const trigger = screen.getByRole('button')
    expect(trigger.textContent).toContain(t('en', 'chat.scope.answeringFrom', { source: 'statement.pdf' }))
    expect(trigger.textContent).not.toMatch(/using all documents/i)
  })

  it('shows the doc name for a single-document scope (the #26 "ask exactly this one document" case)', () => {
    render(
      <I18nProvider>
        <ScopePopover
          docs={[indexedDoc({ id: 'd1', title: 'contract.pdf' })]}
          collections={[]}
          scope={{ collectionIds: [], documentIds: ['d1'] }}
          onChangeScope={() => {}}
        />
      </I18nProvider>
    )
    expect(screen.getByRole('button').textContent).toContain(
      t('en', 'chat.scope.answeringFrom', { source: 'contract.pdf' })
    )
  })

  it('shows "your whole library — N documents" for an empty scope with no attachments', () => {
    render(
      <I18nProvider>
        <ScopePopover
          docs={[indexedDoc({ id: 'a' }), indexedDoc({ id: 'b' })]}
          collections={[]}
          scope={{ collectionIds: [], documentIds: [] }}
          onChangeScope={() => {}}
        />
      </I18nProvider>
    )
    const source = t('en', 'chat.scope.wholeLibrary.other', { count: 2 })
    expect(screen.getByRole('button').textContent).toContain(
      t('en', 'chat.scope.answeringFrom', { source })
    )
  })

  it('treats a Library-only scope as the whole library, naming the corpus size (not the bare word "Library")', () => {
    render(
      <I18nProvider>
        <ScopePopover
          docs={[indexedDoc({ id: 'a' })]}
          collections={[libraryCollection()]}
          scope={{ collectionIds: ['lib'], documentIds: [] }}
          onChangeScope={() => {}}
        />
      </I18nProvider>
    )
    const source = t('en', 'chat.scope.wholeLibrary.one', { count: 1 })
    expect(screen.getByRole('button').textContent).toContain(
      t('en', 'chat.scope.answeringFrom', { source })
    )
  })

  it('one click on the chip opens the source picker', async () => {
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[indexedDoc({ id: 'd1', title: 'contract.pdf' })]}
          collections={[]}
          scope={{ collectionIds: [], documentIds: ['d1'] }}
          onChangeScope={() => {}}
        />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button'))
    expect(await screen.findByText(t('en', 'chat.scope.sourcesTitle'))).toBeInTheDocument()
  })

  it('renders the German chip label (forced via the localStorage mirror, D-L8)', () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    render(
      <I18nProvider>
        <ScopePopover
          docs={[indexedDoc({ id: 'd1', title: 'Vollmacht.docx' })]}
          collections={[]}
          scope={{ collectionIds: [], documentIds: ['d1'] }}
          onChangeScope={() => {}}
        />
      </I18nProvider>
    )
    expect(screen.getByRole('button').textContent).toContain(
      t('de', 'chat.scope.answeringFrom', { source: 'Vollmacht.docx' })
    )
  })
})
