// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ErrorBanner } from '../../src/renderer/components'

// Error announcement gap (audit M-U1): the error Banner mounted role="alert" only when
// the error appeared, so assistive tech — which announces an alert reliably only when
// text changes inside an already-present region — missed it. ErrorBanner keeps the
// role="alert" region mounted at all times and swaps its text.

afterEach(cleanup)

describe('ErrorBanner persistent alert region (M-U1)', () => {
  it('keeps the role="alert" region mounted even with no error', () => {
    render(<ErrorBanner message={null} />)
    const region = screen.getByRole('alert')
    expect(region).toBeInTheDocument()
    // No visible banner / message inside it yet.
    expect(region).toBeEmptyDOMElement()
  })

  it('swaps text inside the SAME region when the error appears (not a fresh alert)', () => {
    function Harness(): JSX.Element {
      const [msg, setMsg] = useState<string | null>(null)
      return (
        <>
          <button onClick={() => setMsg('Import failed')}>fail</button>
          <ErrorBanner message={msg} />
        </>
      )
    }
    render(<Harness />)
    const before = screen.getByRole('alert')
    expect(before).toBeEmptyDOMElement()

    fireEvent.click(screen.getByRole('button', { name: 'fail' }))

    // Same region element instance — the alert was present all along; only its text changed.
    const after = screen.getByRole('alert')
    expect(after).toBe(before)
    expect(after).toHaveTextContent('Import failed')
    // The inner Banner does not nest a second alert role.
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('calls onDismiss from the inner Banner dismiss button', () => {
    const onDismiss = vi.fn()
    render(<ErrorBanner message="Something broke" onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
