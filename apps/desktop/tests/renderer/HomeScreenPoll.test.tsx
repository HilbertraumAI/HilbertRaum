// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { screen, cleanup, act } from '@testing-library/react'
import { RUNTIME_POLL_MS } from '../../src/renderer/lib/polling'
import type { RuntimeStatus } from '../../src/shared/types'
import { renderHome, stubHomeApi } from '../helpers/home-screen'
import { assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { runtimeStatus } from '../helpers/status'

// PF-7a (full-audit 2026-07-10): the Home runtime poll used to run forever and set a fresh
// RuntimeStatus object per 2.5 s tick — re-rendering the whole screen ~24×/min while idle.
// Now an unchanged tick keeps the previous state object (React bails out of the re-render),
// and once the model is running the interval stops, with a window-focus re-check instead.

/** A stopped runtime, a FRESH object each call: the reference can never match. */
function stopped(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return runtimeStatus({ running: false, modelId: null, port: null, healthy: false, message: '', ...over })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  try {
    assertNoUnexpectedApiCalls()
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

/** Settle the mount fetches (status/docs/preflight/runtime — all microtasks). */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('HomeScreen — runtime poll gate (PF-7a)', () => {
  it('an unchanged poll tick does not re-render the screen', async () => {
    const getRuntimeStatus = vi.fn(async () => stopped())
    stubHomeApi({ getRuntimeStatus })
    let commits = 0
    renderHome({ onRender: () => { commits += 1 } })
    await settle()

    // One warm-up tick: React renders a component ONCE more to confirm a bailed-out state
    // update before it can eagerly skip the following ones — absorb that one-time render so
    // the assertion below isolates the steady-state churn the gate must eliminate.
    await advance(RUNTIME_POLL_MS)
    const callsBefore = getRuntimeStatus.mock.calls.length
    const commitsBefore = commits
    await advance(RUNTIME_POLL_MS * 3)
    // The poll DID run (not-running keeps the interval alive) …
    expect(getRuntimeStatus.mock.calls.length).toBeGreaterThan(callsBefore)
    // … but identical ticks kept the previous state object — zero re-renders.
    expect(commits).toBe(commitsBefore)
  })

  // The premise of the row above: a gate that matched everything would pass it, and Home would never
  // flip to running, the poll's whole purpose. Each row below changes ONE field `sameRuntime` compares.
  it('a tick that finds the model running re-renders: the row flips and the interval stops', async () => {
    const getRuntimeStatus = vi.fn(async () => stopped({ modelId: 'qwen3-chat' }))
    stubHomeApi({ getRuntimeStatus })
    let commits = 0
    renderHome({ onRender: () => { commits += 1 } })
    await settle()
    expect(screen.getByText('qwen3-chat is selected — it may still be loading')).toBeInTheDocument()

    const commitsBefore = commits
    getRuntimeStatus.mockImplementation(async () => runtimeStatus({ modelId: 'qwen3-chat' }))
    await advance(RUNTIME_POLL_MS)
    expect(screen.getByText('qwen3-chat is running on this device')).toBeInTheDocument()
    expect(commits).toBeGreaterThan(commitsBefore)

    const callsAfterFlip = getRuntimeStatus.mock.calls.length
    await advance(RUNTIME_POLL_MS * 3)
    expect(getRuntimeStatus.mock.calls.length).toBe(callsAfterFlip)
  })

  // While running the interval is stopped, so these two changes can only arrive on the focus re-check.
  const FOCUS_CHANGES: [string, { from: RuntimeStatus; to: RuntimeStatus; before: string; after: string }][] = [
    [
      'the backend changed (the demo runtime gave way to a real one, #530)',
      {
        from: runtimeStatus({ modelId: 'qwen3-chat', backend: 'mock' }),
        to: runtimeStatus({ modelId: 'qwen3-chat', backend: 'cpu' }),
        before: 'qwen3-chat is running in demo mode — replies are simulated',
        after: 'qwen3-chat is running on this device'
      }
    ],
    [
      'another model running',
      {
        from: runtimeStatus({ modelId: 'm1' }),
        to: runtimeStatus({ modelId: 'm2' }),
        before: 'm1 is running on this device',
        after: 'm2 is running on this device'
      }
    ]
  ]

  it.each(FOCUS_CHANGES)('a focus re-check that finds %s re-renders the row', async (_what, change) => {
    const getRuntimeStatus = vi.fn(async () => change.from)
    stubHomeApi({ getRuntimeStatus })
    renderHome()
    await settle()
    expect(screen.getByText(change.before)).toBeInTheDocument()

    getRuntimeStatus.mockImplementation(async () => change.to)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText(change.after)).toBeInTheDocument()
    expect(screen.queryByText(change.before)).not.toBeInTheDocument()
  })

  it('stops polling once the model runs; a window focus re-checks instead', async () => {
    const getRuntimeStatus = vi.fn(async () => runtimeStatus())
    stubHomeApi({ getRuntimeStatus })
    renderHome()
    await settle()

    const callsAfterMount = getRuntimeStatus.mock.calls.length
    await advance(RUNTIME_POLL_MS * 3)
    expect(getRuntimeStatus.mock.calls.length).toBe(callsAfterMount) // no interval while running

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(getRuntimeStatus.mock.calls.length).toBe(callsAfterMount + 1) // focus re-checks
  })
})
