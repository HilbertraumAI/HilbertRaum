// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScopePopover } from '../../src/renderer/chat/ScopePopover'
import { I18nProvider } from '../../src/renderer/i18n'
import type { DocumentInfo } from '../../src/shared/types'

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

afterEach(cleanup)

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

describe('ScopePopover — footer label reflects chat attachments (empty composed scope)', () => {
  // Regression: unchecking the Library (→ an empty composed scope) with a file attached to the chat
  // still showed "Using all documents", making it look like the narrowing had no effect. But main-side
  // `resolveScope` unions chat attachments in, so the query IS scoped to those files. The footer must
  // say so, not claim the whole corpus.
  it('shows the chat file(s) as the scope, NOT "using all documents", when the composed scope is empty', () => {
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
    expect(trigger.textContent).toContain('1 file in this chat')
    expect(trigger.textContent).not.toMatch(/using all documents/i)
  })

  it('still says "using all documents" for an empty scope with NO chat attachments', () => {
    render(
      <I18nProvider>
        <ScopePopover
          docs={[indexedDoc()]}
          collections={[]}
          scope={{ collectionIds: [], documentIds: [] }}
          onChangeScope={() => {}}
        />
      </I18nProvider>
    )
    expect(screen.getByRole('button').textContent).toMatch(/using all documents/i)
  })
})
