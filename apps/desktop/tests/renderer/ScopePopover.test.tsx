// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen, cleanup, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { ScopePopover } from '../../src/renderer/chat/ScopePopover'
import { t, type UiLanguage } from '../../src/shared/i18n'
import type { Collection } from '../../src/shared/types'
import { makeDocumentInfo } from '../helpers/chat-fixtures'
import { renderInLanguage } from '../helpers/render-language'

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
  }
}

/** The popover over an empty library and the legacy (null) scope; override per row. */
const renderPopover = (
  props: Partial<ComponentProps<typeof ScopePopover>> = {},
  lang: UiLanguage = 'en'
): RenderResult =>
  renderInLanguage(
    <ScopePopover docs={[]} collections={[]} scope={null} onChangeScope={() => {}} {...props} />,
    lang
  )

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('ScopePopover — pending attachment chips (FE-6)', () => {
  it('renders a chip per pending attachment', async () => {
    const user = userEvent.setup()
    renderPopover({ pendingAttachmentNames: ['a.pdf', 'b.pdf'] })
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
    renderPopover({ pendingAttachmentNames: ['report.pdf', 'report.pdf'] })
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
    renderPopover({
      docs: [makeDocumentInfo({ id: 'a' })],
      collections: [libraryCollection()],
      scope: { collectionIds: ['lib'], documentIds: [] },
      onChangeScope,
      attachments: [makeDocumentInfo({ id: 'att1', title: 'statement.pdf' })]
    })
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
    renderPopover({
      docs: [makeDocumentInfo({ id: 'a' })],
      collections: [libraryCollection()],
      scope: { collectionIds: ['lib'], documentIds: [] }
    })
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
  // retrieval scope is legible BEFORE asking. It IS the popover trigger — one click opens the picker
  // (every row above that opens the picker proves the click).
  it('names the single attached file when the composed scope is empty (scoped to that file, NOT the whole corpus)', () => {
    renderPopover({ scope: { collectionIds: [], documentIds: [] }, pendingAttachmentNames: ['statement.pdf'] })
    const trigger = screen.getByRole('button')
    expect(trigger.textContent).toContain(t('en', 'chat.scope.answeringFrom', { source: 'statement.pdf' }))
    expect(trigger.textContent).not.toContain(t('en', 'chat.scope.wholeLibrary.other', { count: 0 }))
  })

  it('shows the doc name for a single-document scope (the #26 "ask exactly this one document" case)', () => {
    renderPopover({
      docs: [makeDocumentInfo({ id: 'd1', title: 'contract.pdf' })],
      scope: { collectionIds: [], documentIds: ['d1'] }
    })
    expect(screen.getByRole('button').textContent).toContain(
      t('en', 'chat.scope.answeringFrom', { source: 'contract.pdf' })
    )
  })

  it('shows "your whole library — N documents" for an empty scope with no attachments', () => {
    renderPopover({
      docs: [makeDocumentInfo({ id: 'a' }), makeDocumentInfo({ id: 'b' })],
      scope: { collectionIds: [], documentIds: [] }
    })
    const source = t('en', 'chat.scope.wholeLibrary.other', { count: 2 })
    expect(screen.getByRole('button').textContent).toContain(
      t('en', 'chat.scope.answeringFrom', { source })
    )
  })

  it('treats a Library-only scope as the whole library, naming the corpus size (not the bare word "Library")', () => {
    renderPopover({
      docs: [makeDocumentInfo({ id: 'a' })],
      collections: [libraryCollection()],
      scope: { collectionIds: ['lib'], documentIds: [] }
    })
    const source = t('en', 'chat.scope.wholeLibrary.one', { count: 1 })
    expect(screen.getByRole('button').textContent).toContain(
      t('en', 'chat.scope.answeringFrom', { source })
    )
  })

  it('renders the German chip label (forced via the localStorage mirror, D-L8)', () => {
    renderPopover(
      {
        docs: [makeDocumentInfo({ id: 'd1', title: 'Vollmacht.docx' })],
        scope: { collectionIds: [], documentIds: ['d1'] }
      },
      'de'
    )
    expect(screen.getByRole('button').textContent).toContain(
      t('de', 'chat.scope.answeringFrom', { source: 'Vollmacht.docx' })
    )
  })
})

// #571: an attachment that failed (a scan, a damaged file) still scopes its chat — main counts the
// unfiled file — so the chip must name it as NOT READABLE YET, never bare (as if it were in use)
// and never "your whole library" (what the chat used to fall back to).
describe('ScopePopover — a failed attachment (#571)', () => {
  const failed = makeDocumentInfo({ id: 'scan', title: 'scan.pdf', status: 'failed', chunkCount: 0 })

  it('the chip names the file as not readable yet — not bare, not the whole library', () => {
    renderPopover({
      docs: [makeDocumentInfo({ id: 'a' }), makeDocumentInfo({ id: 'b' })],
      scope: { collectionIds: [], documentIds: [] },
      attachments: [failed]
    })
    const source = t('en', 'chat.scope.attachmentNotReadable', { name: 'scan.pdf' })
    const trigger = screen.getByRole('button')
    expect(trigger.textContent).toContain(t('en', 'chat.scope.answeringFrom', { source }))
    expect(trigger.textContent).not.toContain(t('en', 'chat.scope.wholeLibrary.other', { count: 2 }))
  })

  it('"Files in this chat" marks it and says it adds nothing yet; a readable file stays bare', async () => {
    renderPopover({
      scope: { collectionIds: [], documentIds: [] },
      attachments: [failed, makeDocumentInfo({ id: 'ok', title: 'invoice.pdf' })]
    })
    await userEvent.click(screen.getByRole('button'))
    const chip = (await screen.findAllByText(t('en', 'chat.scope.attachmentNotReadable', { name: 'scan.pdf' }))).find(
      (el) => el.classList.contains('scope-attachment')
    )
    expect(chip).toHaveClass('failed')
    expect(screen.getByText('invoice.pdf')).not.toHaveClass('failed')
    expect(screen.getByText(t('en', 'chat.scope.attachmentFailedHint'))).toBeInTheDocument()
  })

  it('renders the marker and the hint from the German catalog', async () => {
    renderPopover({ scope: { collectionIds: [], documentIds: [] }, attachments: [failed] }, 'de')
    const source = t('de', 'chat.scope.attachmentNotReadable', { name: 'scan.pdf' })
    expect(screen.getByRole('button').textContent).toContain(t('de', 'chat.scope.answeringFrom', { source }))
    await userEvent.click(screen.getByRole('button'))
    expect(await screen.findByText(t('de', 'chat.scope.attachmentFailedHint'))).toBeInTheDocument()
  })

  it('no hint while every attachment is readable', async () => {
    renderPopover({
      scope: { collectionIds: [], documentIds: [] },
      attachments: [makeDocumentInfo({ id: 'ok', title: 'invoice.pdf' })]
    })
    await userEvent.click(screen.getByRole('button'))
    await screen.findByText(t('en', 'chat.scope.filesInChatLine'))
    expect(screen.queryByText(t('en', 'chat.scope.attachmentFailedHint'))).not.toBeInTheDocument()
  })
})
