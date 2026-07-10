// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { HomeScreen, __homeScreenRenderCount } from '../../src/renderer/screens/HomeScreen'
import { RUNTIME_POLL_MS } from '../../src/renderer/lib/polling'
import type { AppStatus, PreflightResult, RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// PF-7a (full-audit 2026-07-10): the Home runtime poll used to run forever and set a fresh
// RuntimeStatus object per 2.5 s tick — re-rendering the whole screen ~24×/min while idle.
// Now an unchanged tick keeps the previous state object (React bails out of the re-render),
// and once the model is running the interval stops, with a window-focus re-check instead.

const APP_STATUS = {
  workspaceMode: 'plaintext_dev',
  activeModelId: 'qwen3-chat'
} as unknown as AppStatus

const PREFLIGHT = { ok: true, problems: [], slowDriveWarning: null } as unknown as PreflightResult

function runtimeStatus(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return { running: false, modelId: null, port: null, healthy: false, message: '', ...over }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** Render Home and settle the mount fetches (status/docs/preflight/runtime — all microtasks). */
async function renderSettled(): Promise<void> {
  render(<HomeScreen onNavigate={() => {}} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe('HomeScreen — runtime poll gate (PF-7a)', () => {
  it('an unchanged poll tick does not re-render the screen', async () => {
    // A FRESH object per poll with identical consumed fields — the reference can never match.
    const getRuntimeStatus = vi.fn(async () => runtimeStatus())
    stubApi({
      getAppStatus: vi.fn(async () => APP_STATUS),
      listDocuments: vi.fn(async () => []),
      runPreflight: vi.fn(async () => PREFLIGHT),
      getRuntimeStatus
    } as never)
    await renderSettled()

    // One warm-up tick: React renders a component ONCE more to confirm a bailed-out state
    // update before it can eagerly skip the following ones — absorb that one-time render so
    // the assertion below isolates the steady-state churn the gate must eliminate.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNTIME_POLL_MS)
    })
    const callsBefore = getRuntimeStatus.mock.calls.length
    const rendersBefore = __homeScreenRenderCount.value
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNTIME_POLL_MS * 3)
    })
    // The poll DID run (not-running keeps the interval alive) …
    expect(getRuntimeStatus.mock.calls.length).toBeGreaterThan(callsBefore)
    // … but identical ticks kept the previous state object — zero re-renders.
    expect(__homeScreenRenderCount.value).toBe(rendersBefore)
  })

  it('stops polling once the model runs; a window focus re-checks instead', async () => {
    const getRuntimeStatus = vi.fn(async () => runtimeStatus({ running: true, modelId: 'm1', healthy: true }))
    stubApi({
      getAppStatus: vi.fn(async () => APP_STATUS),
      listDocuments: vi.fn(async () => []),
      runPreflight: vi.fn(async () => PREFLIGHT),
      getRuntimeStatus
    } as never)
    await renderSettled()

    const callsAfterMount = getRuntimeStatus.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNTIME_POLL_MS * 3)
    })
    expect(getRuntimeStatus.mock.calls.length).toBe(callsAfterMount) // no interval while running

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(getRuntimeStatus.mock.calls.length).toBe(callsAfterMount + 1) // focus re-checks
  })
})
