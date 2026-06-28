// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScopePopover } from '../../src/renderer/chat/ScopePopover'
import { I18nProvider } from '../../src/renderer/i18n'

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
