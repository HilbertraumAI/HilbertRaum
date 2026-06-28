// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScopePopover } from '../../src/renderer/chat/ScopePopover'
import { I18nProvider } from '../../src/renderer/i18n'

// Audit FE-6 — the pending-attachment chips are keyed by file name, not array index, so a chip
// keeps its identity when another pending item resolves out of order. Light render check that
// the name-keyed list renders one chip per pending attachment.

afterEach(cleanup)

describe('ScopePopover — pending attachment chips (FE-6)', () => {
  it('renders a name-keyed chip per pending attachment', async () => {
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
})
