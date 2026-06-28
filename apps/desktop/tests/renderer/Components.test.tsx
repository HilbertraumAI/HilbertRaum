// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ConfirmDialog,
  PasswordStrengthMeter,
  passwordStrength,
  SegmentedControl,
  Switch,
  ToastProvider,
  useToast,
  TOAST_DURATION_MS
} from '../../src/renderer/components'

// Phase 24 shared component layer (guidelines §6): the behaviors that are easy to get
// wrong — the ConfirmDialog's focus trap / Esc / focus return (via Radix, decision
// D-UI1), the SegmentedControl's roving tabindex + arrow keys, the Toast host's polite
// live region + auto-dismiss, and the Switch's keyboard toggling.

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// ---- ConfirmDialog ---------------------------------------------------------------

function DialogHarness({ onConfirm }: { onConfirm?: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>open dialog</button>
      <ConfirmDialog
        open={open}
        title="Delete this document?"
        confirmLabel="Delete"
        onConfirm={() => {
          onConfirm?.()
          setOpen(false)
        }}
        onCancel={() => setOpen(false)}
      >
        <p>This permanently removes it.</p>
      </ConfirmDialog>
    </>
  )
}

describe('ConfirmDialog', () => {
  it('traps focus inside the dialog while open', async () => {
    const user = userEvent.setup()
    render(<DialogHarness />)
    await user.click(screen.getByRole('button', { name: 'open dialog' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeInTheDocument()
    // Focus moved into the dialog on open.
    expect(dialog.contains(document.activeElement)).toBe(true)

    // Tabbing past the last control loops back — focus never escapes the dialog.
    for (let i = 0; i < 4; i++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  it('puts the primary (confirm) button on the right and confirms', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<DialogHarness onConfirm={onConfirm} />)
    await user.click(screen.getByRole('button', { name: 'open dialog' }))

    const dialog = await screen.findByRole('dialog')
    const buttons = Array.from(dialog.querySelectorAll('button'))
    // DOM order within the action row: Cancel first, Delete (primary) last/right.
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Delete'])
    expect(buttons[1].className).toContain('primary')

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('closes on Esc and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    render(<DialogHarness />)
    const trigger = screen.getByRole('button', { name: 'open dialog' })
    await user.click(trigger)
    await screen.findByRole('dialog')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // Radix restores focus to the previously focused element asynchronously.
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  // L12: the body must be associated via aria-describedby so a screen reader announces
  // "This permanently removes it.", not just the title.
  it('associates the body via aria-describedby (L12)', async () => {
    render(
      <ConfirmDialog open title="Delete this document?" confirmLabel="Delete" onConfirm={() => {}} onCancel={() => {}}>
        <p>This permanently removes it.</p>
      </ConfirmDialog>
    )
    const dialog = await screen.findByRole('dialog')
    const describedBy = dialog.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const body = document.getElementById(describedBy!)
    expect(body?.textContent).toBe('This permanently removes it.')
  })

  it('leaves aria-describedby unset when there is no body', async () => {
    render(
      <ConfirmDialog open title="Proceed?" confirmLabel="Yes" onConfirm={() => {}} onCancel={() => {}} />
    )
    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('aria-describedby')).toBeNull()
  })

  it('disables the confirm button when confirmDisabled is set', async () => {
    render(
      <ConfirmDialog
        open
        title="Download?"
        confirmLabel="Start download"
        confirmDisabled
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    )
    expect(await screen.findByRole('button', { name: 'Start download' })).toBeDisabled()
  })
})

// ---- SegmentedControl ------------------------------------------------------------

function SegHarness(): JSX.Element {
  const [value, setValue] = useState('system')
  return (
    <SegmentedControl
      ariaLabel="Theme"
      options={[
        { value: 'system', label: 'System' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' }
      ]}
      value={value}
      onChange={setValue}
    />
  )
}

describe('SegmentedControl', () => {
  it('renders radio-group semantics with a roving tabindex (only the selected segment is tabbable)', () => {
    render(<SegHarness />)
    const group = screen.getByRole('radiogroup', { name: 'Theme' })
    expect(group).toBeInTheDocument()
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    expect(radios[0]).toHaveAttribute('aria-checked', 'true')
    expect(radios[0]).toHaveAttribute('tabindex', '0')
    expect(radios[1]).toHaveAttribute('tabindex', '-1')
    expect(radios[2]).toHaveAttribute('tabindex', '-1')
  })

  it('arrow keys move focus AND selection, wrapping at the ends', async () => {
    const user = userEvent.setup()
    render(<SegHarness />)
    const radios = (): HTMLElement[] => screen.getAllByRole('radio')

    radios()[0].focus()
    await user.keyboard('{ArrowRight}')
    expect(radios()[1]).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(radios()[1])

    await user.keyboard('{ArrowRight}{ArrowRight}') // dark → wraps to system
    expect(radios()[0]).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(radios()[0])

    await user.keyboard('{ArrowLeft}') // wraps backwards to dark
    expect(radios()[2]).toHaveAttribute('aria-checked', 'true')

    await user.keyboard('{Home}')
    expect(radios()[0]).toHaveAttribute('aria-checked', 'true')
    await user.keyboard('{End}')
    expect(radios()[2]).toHaveAttribute('aria-checked', 'true')
  })

  it('click selects a segment', async () => {
    const user = userEvent.setup()
    render(<SegHarness />)
    await user.click(screen.getByRole('radio', { name: 'Light' }))
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true')
  })

  // FE-9: Home/End land on the FIRST/LAST ENABLED segment directly, skipping disabled ends —
  // not as a side effect of the arrow-key modulo wrap. Disabled segments bracket the row.
  it('Home/End jump to the first/last ENABLED segment, skipping disabled ends', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    function EdgeHarness(): JSX.Element {
      const [value, setValue] = useState('b')
      return (
        <SegmentedControl
          ariaLabel="Edge"
          options={[
            { value: 'a', label: 'A', disabled: true },
            { value: 'b', label: 'B' },
            { value: 'c', label: 'C' },
            { value: 'd', label: 'D', disabled: true }
          ]}
          value={value}
          onChange={(v) => {
            setValue(v)
            onChange(v)
          }}
        />
      )
    }
    render(<EdgeHarness />)
    screen.getByRole('radio', { name: 'B' }).focus()

    await user.keyboard('{End}')
    // Last ENABLED is C (index 2) — NOT the disabled D at the end.
    expect(onChange).toHaveBeenLastCalledWith('c')
    expect(screen.getByRole('radio', { name: 'C' })).toHaveAttribute('aria-checked', 'true')

    await user.keyboard('{Home}')
    // First ENABLED is B (index 1) — NOT the disabled A at the start.
    expect(onChange).toHaveBeenLastCalledWith('b')
    expect(screen.getByRole('radio', { name: 'B' })).toHaveAttribute('aria-checked', 'true')
  })
})

// ---- Toast -----------------------------------------------------------------------

function SaveButton(): JSX.Element {
  const toast = useToast()
  return <button onClick={() => toast('Saved')}>save</button>
}

describe('Toast', () => {
  it('announces over an always-mounted polite live region and auto-dismisses', () => {
    vi.useFakeTimers()
    render(
      <ToastProvider>
        <SaveButton />
      </ToastProvider>
    )
    // The live region exists BEFORE any toast (so screen readers announce additions).
    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    const toast = screen.getByText('Saved')
    expect(region.contains(toast)).toBe(true)

    // Auto-dismisses within the 3–5 s window (guidelines §6).
    expect(TOAST_DURATION_MS).toBeGreaterThanOrEqual(3000)
    expect(TOAST_DURATION_MS).toBeLessThanOrEqual(5000)
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS + 50)
    })
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })

  it('is a safe no-op without a provider (screens render standalone in tests)', () => {
    render(<SaveButton />)
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })

  // FE-7: the auto-dismiss setTimeout is tracked and cancelled on unmount, so a provider that
  // unmounts within the 4 s window leaves no pending timer firing setState on a dead tree.
  it('cancels the pending auto-dismiss timer when the provider unmounts', () => {
    vi.useFakeTimers()
    const { unmount } = render(
      <ToastProvider>
        <SaveButton />
      </ToastProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    expect(vi.getTimerCount()).toBe(1) // the 4 s dismiss timer is pending
    unmount()
    expect(vi.getTimerCount()).toBe(0) // …and the cleanup cancelled it
  })
})

// ---- Switch ----------------------------------------------------------------------

function SwitchHarness({ onChange }: { onChange: (v: boolean) => void }): JSX.Element {
  const [on, setOn] = useState(false)
  return (
    <Switch
      checked={on}
      onChange={(v) => {
        setOn(v)
        onChange(v)
      }}
      label="Use GPU acceleration"
    />
  )
}

describe('Switch', () => {
  it('exposes switch semantics and toggles with the keyboard (Space)', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SwitchHarness onChange={onChange} />)

    const input = screen.getByRole('switch', { name: 'Use GPU acceleration' }) as HTMLInputElement
    expect(input.checked).toBe(false)

    input.focus()
    await user.keyboard(' ')
    expect(onChange).toHaveBeenLastCalledWith(true)
    expect(input.checked).toBe(true)

    await user.keyboard(' ')
    expect(onChange).toHaveBeenLastCalledWith(false)
    expect(input.checked).toBe(false)
  })

  it('toggles via its clickable label', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SwitchHarness onChange={onChange} />)
    await user.click(screen.getByText('Use GPU acceleration'))
    expect(onChange).toHaveBeenLastCalledWith(true)
  })
})

// ---- PasswordStrengthMeter -------------------------------------------------------

describe('PasswordStrengthMeter (L13)', () => {
  it('does not put role="status" on the visible meter (no per-keystroke re-announce)', () => {
    const { container } = render(<PasswordStrengthMeter strength={passwordStrength('aaaaaaaa')} />)
    // The visible word is plain text; the meter container is not a live region.
    expect(container.querySelector('.strength')?.getAttribute('role')).toBeNull()
    expect(screen.getByText('Weak')).toBeInTheDocument()
  })

  it('announces the strength word in an sr-only region only after a debounce', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(<PasswordStrengthMeter strength={passwordStrength('aaaaaaaa')} />)
      const status = screen.getByRole('status')
      expect(status).toHaveClass('sr-only')
      expect(status).toBeEmptyDOMElement() // nothing announced yet (still typing)

      // Keep "typing" before the debounce elapses → still nothing announced.
      act(() => vi.advanceTimersByTime(300))
      rerender(<PasswordStrengthMeter strength={passwordStrength('aaaaaaaaaaaa')} />)
      expect(screen.getByRole('status')).toBeEmptyDOMElement()

      // Typing settles → the latest word is announced once.
      act(() => vi.advanceTimersByTime(700))
      expect(screen.getByRole('status')).toHaveTextContent('Okay')
    } finally {
      vi.useRealTimers()
    }
  })
})
