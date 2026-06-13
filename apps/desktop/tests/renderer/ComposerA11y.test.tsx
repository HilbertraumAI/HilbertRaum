// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Composer } from '../../src/renderer/chat/Composer'

// Composer accessible name (audit L8): the textarea had only a placeholder, which is
// not an accessible name (it vanishes on input and accname support is inconsistent).
// It now mirrors the PasswordField pattern — aria-label = the mode-specific prompt.

afterEach(cleanup)

function noop(): void {}

describe('Composer accessible name (L8)', () => {
  it('names the textarea after its mode-specific placeholder', () => {
    render(
      <Composer
        value=""
        onChange={noop}
        onSend={noop}
        onStop={noop}
        streaming={false}
        placeholder="Ask about your documents…"
        sendLabel="Ask"
      />
    )
    // getByRole('textbox', { name }) resolves the accessible name — placeholder alone
    // does not satisfy this; aria-label does.
    const input = screen.getByRole('textbox', { name: 'Ask about your documents…' })
    expect(input.tagName).toBe('TEXTAREA')
    expect(input).toHaveAttribute('aria-label', 'Ask about your documents…')
  })
})
