// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ErrorBoundary } from '../../src/renderer/components'

// Audit FE-1 — the generic render-error boundary. It must (a) show the fallback instead of
// unmounting the whole tree on a child throw, (b) log LOCALLY only (console.error — never a
// network/remote report, CLAUDE.md hard rule), and (c) let `reset` re-mount the subtree.

afterEach(cleanup)

// React itself logs a caught render error to console.error; silence that noise and let us
// assert OUR local-only log fired.
let errSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => errSpy.mockRestore())

function Bomb({ boom }: { boom: { current: boolean } }): JSX.Element {
  if (boom.current) throw new Error('render boom')
  return <div>recovered subtree</div>
}

describe('ErrorBoundary (component)', () => {
  it('renders children unchanged when nothing throws', () => {
    render(
      <ErrorBoundary fallback={() => <div>fallback shown</div>}>
        <div>healthy child</div>
      </ErrorBoundary>
    )
    expect(screen.getByText('healthy child')).toBeInTheDocument()
    expect(screen.queryByText('fallback shown')).not.toBeInTheDocument()
  })

  it('shows the fallback on a child throw, logs locally, and calls onError (no network)', () => {
    const onError = vi.fn()
    render(
      <ErrorBoundary fallback={() => <div>screen fallback</div>} onError={onError}>
        <Bomb boom={{ current: true }} />
      </ErrorBoundary>
    )
    expect(screen.getByText('screen fallback')).toBeInTheDocument()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
    // The boundary's local sink is console.error — assert it fired with our marker, the only
    // channel used (there is no renderer→main log IPC, and never a network call).
    const logged = errSpy.mock.calls.flat().join(' ')
    expect(logged).toContain('[renderer] uncaught render error')
  })

  it('reset clears the captured error and re-mounts the subtree', async () => {
    const user = userEvent.setup()
    const boom = { current: true }
    render(
      <ErrorBoundary
        fallback={(reset) => (
          <button
            onClick={() => {
              boom.current = false
              reset()
            }}
          >
            try again
          </button>
        )}
      >
        <Bomb boom={boom} />
      </ErrorBoundary>
    )
    // Threw → fallback.
    expect(screen.getByRole('button', { name: 'try again' })).toBeInTheDocument()
    // Recover the child, then reset → the subtree re-mounts and renders normally.
    await user.click(screen.getByRole('button', { name: 'try again' }))
    expect(await screen.findByText('recovered subtree')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'try again' })).not.toBeInTheDocument()
  })
})
